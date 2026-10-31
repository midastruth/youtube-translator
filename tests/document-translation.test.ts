import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import {
  advanceDocument, chapterCues, documentTool, finalDocumentCues, initialDocumentState,
  callDocumentModel, inputBudget, modelConfig, outputBudget, outputEstimate, tokenEstimate, validateChapters,
} from "../worker/document-translation.js";
import type { DocumentInput, DocumentState, ModelRequest } from "../worker/document-translation.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { createWorkerServer } from "../worker/server.js";
import { SubtitleJobDoc } from "../worker/task-definition.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { endModelStream, modelChunk, sendModelJson } from "./support/model-stream.js";

const cues = [
  { cue_id: "a", start: 123, end: 1200, text: "The transaction was rejected." },
  { cue_id: "b", start: 1200, end: 2500, text: "By transaction, I mean a database transaction, not a payment." },
];
const note = { summary: "Database transactions, not financial payments; rejection refers to database failure.", glossary: [{ term: "transaction", meaning: "database operation", translation: "事务" }] };
function input(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return { jobId: "test", jobKey: "key", videoId: "video", title: "Transactions", fromLang: "en", toLang: "zh-CN",
    cues, config: modelConfig(), budgetLimit: 128, ...overrides };
}
function chapters(source: typeof cues, config = modelConfig()) {
  const result: { start_id: string; end_id: string; title: string }[] = [];
  let group: typeof cues = [];
  for (const cue of source) {
    if (group.length && (outputEstimate([...group, cue]) > outputBudget(config) ||
        tokenEstimate([...group, cue]) + outputEstimate([...group, cue]) > inputBudget(config) * 0.6)) {
      result.push({ start_id: group[0].cue_id, end_id: group.at(-1)!.cue_id, title: "Semantic topic" }); group = [];
    }
    group.push(cue);
  }
  if (group.length) result.push({ start_id: group[0].cue_id, end_id: group.at(-1)!.cue_id, title: "Semantic topic" });
  return result;
}
function result(request: ModelRequest, config = modelConfig()): unknown {
  const data = request.data as { source: typeof cues; notes?: unknown[] };
  switch (request.operation) {
    case "analyze": return { ...note, chapters: chapters(data.source, config) };
    case "brief": case "consolidate": case "audit_consolidate": case "final_audit_consolidate": return note;
    case "translate": return { ...note, translations: data.source.map(c => ({ cue_id: c.cue_id, translation: `数据库事务：${c.cue_id}` })) };
    case "audit": return { guidance: "Use 事务, not financial 交易; verify rejection refers to database operations." };
    case "review": return { ...note, passed: true, issues: [], corrections: [] };
    case "final_audit": return { passed: true, guidance: "All corrected translation choices are globally consistent." };
    default: throw new Error(`Unexpected operation ${request.operation}`);
  }
}
async function run(document: DocumentInput, call: (request: ModelRequest) => Promise<unknown>) {
  let state = initialDocumentState(document);
  for (let step = 0; step < 200 && state.stage !== "publish"; step++) state = await advanceDocument(document, state, call);
  assert.equal(state.stage, "publish"); return state;
}

test("short document is translated together, then reviewed with later definitions and corrected before publication", async () => {
  const document = input(); const calls: ModelRequest[] = []; let reviews = 0;
  const state = await run(document, async request => {
    calls.push(request);
    if (request.operation === "translate") {
      assert.deepEqual((request.data as { source: unknown }).source, cues);
      return { ...note, translations: [{ cue_id: "a", translation: "这笔交易被拒绝了。" }, { cue_id: "b", translation: "这里指数据库事务，而非付款。" }] };
    }
    if (request.operation === "review" && reviews++ === 0) {
      assert.match(JSON.stringify(request.data), /database transaction/);
      return { passed: false, issues: ["a uses the financial sense"], corrections: [{ cue_id: "a", translation: "该事务被拒绝了。" }] };
    }
    return result(request);
  });
  assert.equal(calls.filter(c => c.operation === "translate").length, 1);
  assert.equal(reviews, 2);
  assert.deepEqual(finalDocumentCues(document, state)[0], { ...cues[0], index: 0, translation: "该事务被拒绝了。" });
});

test("post-revision global audit can send the reviewed document back for consistency repair", async () => {
  const document = input(); let audits = 0, reviews = 0;
  const state = await run(document, async request => {
    if (request.operation === "final_audit" && audits++ === 0) {
      return { passed: false, guidance: "Use the same database sense in every chapter after revisions." };
    }
    if (request.operation === "review") {
      if (reviews++ > 0) assert.match(JSON.stringify(request.data), /after revisions/);
    }
    return result(request);
  });
  assert.equal(audits, 2); assert.equal(reviews, 2); assert.equal(state.auditRounds, 1);
});

test("large output uses semantic chapters, shared global context and whole-source context when input fits", async () => {
  const config = modelConfig({ contextTokens: 12000, outputTokens: 512 });
  const source = Array.from({ length: 9 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Topic ${i}. This is a database transaction.` }));
  const document = input({ cues: source, config });
  const calls: ModelRequest[] = [];
  const state = await run(document, async request => { calls.push(request); return result(request, config); });
  const translations = calls.filter(c => c.operation === "translate");
  assert.ok(translations.length > 1);
  for (const request of translations) {
    const data = request.data as { global_context: unknown; full_source: unknown; source: typeof cues };
    assert.deepEqual(data.global_context, note); assert.deepEqual(data.full_source, source);
    assert.ok(outputEstimate(data.source) <= outputBudget(config));
  }
  assert.deepEqual(finalDocumentCues(document, state).map(c => c.cue_id), source.map(c => c.cue_id));
  assert.ok(calls.filter(c => c.operation === "review").length > 1);
});

test("reading windows are consolidated hierarchically without losing source coverage", async () => {
  const config = modelConfig({ contextTokens: 10000, outputTokens: 512 });
  const source = Array.from({ length: 100 }, (_, i) => ({ cue_id: `x${i}`, start: i * 1000, end: i * 1000 + 900, text: "A complete sentence about transactions." }));
  const document = input({ cues: source, config });
  assert.ok(initialDocumentState(document).reads.length > 1);
  const calls: ModelRequest[] = [];
  const state = await run(document, async request => { calls.push(request); return result(request, config); });
  assert.ok(calls.some(c => c.operation === "audit_consolidate"));
  assert.equal(Object.keys(state.draft).length, source.length);
});

test("chapter plans and translations reject omissions, duplicates and out-of-range IDs instead of positional fallback", async () => {
  const document = input();
  for (const plan of [[], [{ start_id: "b", end_id: "b", title: "missing a" }], [
    { start_id: "a", end_id: "b", title: "all" }, { start_id: "a", end_id: "a", title: "duplicate" },
  ]]) assert.throws(() => validateChapters(cues, plan, document.config));
  let state = initialDocumentState(document);
  while (state.stage !== "translate") state = await advanceDocument(document, state, async request => result(request));
  for (const mappings of [[{ cue_id: "a", translation: "事务" }], [{ cue_id: "z", translation: "事务" }], [
    { cue_id: "a", translation: "事务" }, { cue_id: "a", translation: "事务" },
  ]]) {
    await assert.rejects(advanceDocument(document, state, async () => ({ ...note, translations: mappings })));
    assert.deepEqual(state.draft, {});
  }
  assert.throws(() => initialDocumentState(input({ cues: [cues[0], cues[0]] })));
  assert.throws(() => initialDocumentState(input({ cues: [{ ...cues[0], end: 0 }] })));
});

test("read-only retrieval finds a definition anywhere and cannot read host files or alter timing", () => {
  const document = input(), state = initialDocumentState(document);
  assert.deepEqual(documentTool(document, state, "read_transcript", { start_id: "b", count: 1 }), { source: [{ ...cues[1], translation: "" }], next_id: undefined });
  const hits = documentTool(document, state, "search_transcript", { query: "not a payment" }) as { total: number; source: typeof cues };
  assert.equal(hits.total, 1); assert.equal(hits.source[0].cue_id, "b");
  assert.throws(() => documentTool(document, state, "bash", { command: "pwd" }));
  assert.deepEqual(chapterCues(cues, { start_id: "a", end_id: "b", title: "all" }), cues);
});

async function fixture(handler: (request: ModelRequest, authorization: string | undefined) => Promise<unknown>, failures: number[] = []) {
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    try {
      assert.equal(payload.stream, true);
      assert.equal(payload.response_format, undefined);
      if (failures.length) { res.writeHead(failures.shift()!); res.end("private transient provider error"); return; }
      const request = JSON.parse(payload.messages.find((m: { role: string }) => m.role === "user").content);
      const answer = await handler(request, req.headers.authorization);
      if (answer === "unauthorized") { res.writeHead(401); res.end("private provider body"); return; }
      sendModelJson(res, answer);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1`;
  const restoreEndpoint = trustModelEndpoint(url);
  return { url, close: async () => {
    restoreEndpoint(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("durable background job publishes only reviewed output, reattaches after lookup, and never persists API credentials", { timeout: 15000 }, async () => {
  let release!: () => void, reviewing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reachedReview = new Promise<void>(resolve => { reviewing = resolve; });
  const requests: ModelRequest[] = [];
  const model = await fixture(async (request, authorization) => {
    assert.equal(authorization, "Bearer ephemeral-fixture-key"); requests.push(request);
    if (request.operation === "review") { reviewing(); await gate; }
    return result(request);
  });
  const directory = await fs.mkdtemp("./tmp/document-worker-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const options = { engine: "document", cues, title: "Transactions", baseUrl: model.url, apiKey: "ephemeral-fixture-key" };
    const job = await worker.submitOrAttachJob(options);
    await reachedReview;
    const snapshot = await worker.snapshotJob(job);
    assert.equal(snapshot.status, "running"); assert.deepEqual(snapshot.published_cues, []);
    assert.equal(await worker.submitOrAttachJob(options), job);
    const stream = worker.observeJobStream(job, { heartbeatIntervalMs: 1 });
    assert.equal((await stream.next()).value?.type, "meta");
    await stream.next(); await stream.next();
    assert.equal((await stream.next()).value?.type, "progress");
    release(); await job.taskPromise;
    assert.equal(job.status, "succeeded");
    const events = []; for await (const event of stream) events.push(event);
    assert.equal(events.filter(e => e.type === "cue").length, cues.length);
    assert.equal(events.at(-1)?.type, "done");
    const count = requests.length;
    await worker.close();
    worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
    const restored = await worker.submitOrAttachJob(options);
    assert.equal(restored.jobId, job.jobId); assert.equal(restored.status, "succeeded");
    assert.equal((await worker.getJob(job.jobId))?.jobKey, job.jobKey);
    const doc = await worker.harness!.snapshot(SubtitleJobDoc, restored.conversationId, worker.context);
    assert.equal(doc?.published_cues.a.start, 123);
    assert.equal(requests.length, count);
    assert.equal(JSON.stringify(doc).includes("ephemeral-fixture-key"), false);
    for (const name of await fs.readdir(directory)) {
      if (name.includes("state.db")) assert.equal((await fs.readFile(`${directory}/${name}`)).includes(Buffer.from("ephemeral-fixture-key")), false);
    }
  } finally { release(); await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("real Worker HTTP submission and SSE return only reviewed document cues", { timeout: 10000 }, async () => {
  const model = await fixture(async request => result(request));
  const directory = await fs.mkdtemp("./tmp/document-http-");
  const { server, worker } = await createWorkerServer({ storagePath: `${directory}/state.db`, port: 0 });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const payload = Buffer.from(JSON.stringify({ engine: "document", cues, title: "数据库", baseUrl: model.url, apiKey: "http-key" }));
    const split = payload.indexOf(Buffer.from("数")) + 1;
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(`${url}/internal/jobs`, { method: "POST", headers: { "Content-Type": "application/json" } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      request.on("error", reject); request.write(payload.subarray(0, split));
      setTimeout(() => request.end(payload.subarray(split)), 5);
    });
    assert.equal(response.status, 200);
    const job = JSON.parse(response.body);
    assert.equal((await worker.getJob(job.job_id))?.title, "数据库");
    const stream = await fetch(`${url}/internal/jobs/${job.job_id}/stream`);
    assert.equal(stream.status, 200);
    const events = (await stream.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).type, "done");
    assert.deepEqual(events.filter(e => e.type === "cue").map(e => [e.index, e.start]), [[0, 123], [1, 1200]]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true });
  }
});

test("interrupted jobs resume the last committed phase and can receive browser credentials again", { timeout: 15000 }, async () => {
  let release!: () => void, reviewing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { reviewing = resolve; });
  const calls: string[] = []; let review = 0;
  const model = await fixture(async request => {
    calls.push(request.operation);
    if (request.operation === "review" && review++ === 0) { reviewing(); await gate; }
    return result(request);
  });
  const directory = await fs.mkdtemp("./tmp/document-resume-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const options = { engine: "document", cues, baseUrl: model.url, apiKey: "browser-key" };
    const job = await worker.submitOrAttachJob(options); await reached;
    await worker.close(); release();
    worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
    const restored = await worker.submitOrAttachJob(options);
    assert.equal(restored.jobId, job.jobId);
    const events = []; for await (const event of worker.observeJobStream(restored, { heartbeatIntervalMs: 1 })) events.push(event);
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(calls.filter(c => c === "analyze").length, 1);
    assert.equal(calls.filter(c => c === "translate").length, 1);
  } finally { release(); await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("malformed mappings regenerate even when the missing cue ID contains budget", { timeout: 10000 }, async () => {
  const budgetCues = [cues[0], { ...cues[1], cue_id: "budget" }];
  let translations = 0;
  const model = await fixture(async request => {
    if (request.operation === "translate" && translations++ === 0) return { ...note, translations: [{ cue_id: "a", translation: "遗漏另一条" }] };
    if (request.operation === "translate") assert.match(JSON.stringify(request), /Missing translation/);
    return result(request);
  });
  const directory = await fs.mkdtemp("./tmp/document-format-");
  const worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues: budgetCues, baseUrl: model.url, apiKey: "key" });
    await job.taskPromise;
    assert.equal(job.status, "succeeded"); assert.equal(translations, 2);
    assert.equal(job.finalResult?.cues.length, cues.length);
    const doc = await worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
    assert.equal(doc?.network_attempts, 7);
  } finally { await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("explicit cancellation interrupts model I/O and never publishes a partial draft", { timeout: 10000 }, async () => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = await fixture(async request => { reached(); await gate; return result(request); });
  const directory = await fs.mkdtemp("./tmp/document-cancel-");
  const worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues, baseUrl: model.url, apiKey: "key" });
    await started; await worker.abortJob(job.jobId); await job.taskPromise;
    const snapshot = await worker.snapshotJob(job);
    assert.equal(snapshot.status, "cancelled"); assert.deepEqual(snapshot.published_cues, []);
    const events = []; for await (const event of worker.observeJobStream(job)) events.push(event);
    assert.equal(events.at(-1)?.code, "task_cancelled");
  } finally { release(); await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("every real model turn reserves budget; exhaustion cannot produce success or exceed the limit", { timeout: 10000 }, async () => {
  let calls = 0;
  const model = await fixture(async request => { calls++; return result(request); });
  const directory = await fs.mkdtemp("./tmp/document-budget-");
  const worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues, baseUrl: model.url, apiKey: "key", budgetLimit: 1 });
    await job.taskPromise;
    assert.equal(job.status, "failed"); assert.equal(calls, 1);
    const doc = await worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
    assert.equal(doc?.network_attempts, 1); assert.deepEqual(doc?.published_cues, {});
  } finally { await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("model tool calls retrieve distant context with a per-turn budget and no filesystem tools", { timeout: 10000 }, async () => {
  let turns = 0, reservations = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); turns++;
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.tools.map((t: { function: { name: string } }) => t.function.name), ["read_transcript", "search_transcript"]);
    if (turns === 1) {
      modelChunk(res, { tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "search_transcript", arguments: '{"query":"not' } }] });
      modelChunk(res, { tool_calls: [{ index: 0, function: { arguments: ' a payment"}' } }] });
      endModelStream(res, "tool_calls");
    } else {
      const tool = payload.messages.find((m: { role: string }) => m.role === "tool");
      assert.match(tool.content, /not a payment/);
      sendModelJson(res, { found: true });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const restoreEndpoint = trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`);
  try {
    const document = input({ config: modelConfig({ baseUrl: `http://127.0.0.1:${address.port}/v1` }) });
    const answer = await callDocumentModel(document, initialDocumentState(document), { operation: "test", instructions: "Find the term definition", data: {} }, { apiKey: "key", reserve: async () => { reservations++; } });
    assert.deepEqual(answer, { found: true }); assert.equal(reservations, 2);
  } finally { restoreEndpoint(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("transient 499 and 502 retry through the durable budget before reviewed publication", { timeout: 15000 }, async () => {
  const failures = [499, 502]; let calls = 0;
  const model = await fixture(async request => { calls++; return result(request); }, failures);
  const directory = await fs.mkdtemp("./tmp/document-transient-");
  const worker = new AgentWorker({ storagePath: `${directory}/db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues, baseUrl: model.url, apiKey: "key" });
    await job.taskPromise;
    assert.equal(job.status, "succeeded"); assert.equal(failures.length, 0);
    const doc = await worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
    assert.equal(doc?.network_attempts, calls + 2);
    assert.equal(job.finalResult?.cues.length, cues.length);
    assert.equal(JSON.stringify(doc).includes("private transient provider error"), false);
  } finally { await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("persistent 499 stops after two retries and never publishes partial subtitles", { timeout: 15000 }, async () => {
  const failures = [499, 499, 499, 499];
  const model = await fixture(async request => result(request), failures);
  const directory = await fs.mkdtemp("./tmp/document-persistent-");
  const worker = new AgentWorker({ storagePath: `${directory}/db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues, baseUrl: model.url, apiKey: "key" });
    await job.taskPromise;
    assert.equal(job.status, "failed"); assert.equal(failures.length, 1);
    const doc = await worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
    assert.equal(doc?.network_attempts, 3); assert.deepEqual(doc?.published_cues, {});
    assert.equal(doc?.error, "Model API HTTP 499");
  } finally { await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("authentication failures terminate explicitly without scripted or sentence fallback", { timeout: 10000 }, async () => {
  let calls = 0;
  const model = await fixture(async () => { calls++; return "unauthorized"; });
  const directory = await fs.mkdtemp("./tmp/document-auth-");
  const worker = new AgentWorker({ storagePath: `${directory}/db` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ engine: "document", cues, baseUrl: model.url, apiKey: "invalid-fixture" });
    await job.taskPromise;
    assert.equal(job.status, "failed"); assert.equal(calls, 1);
    const events = []; for await (const event of worker.observeJobStream(job)) events.push(event);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(events.some(e => e.type === "cue" || e.type === "done"), false);
    assert.equal(JSON.stringify(events).includes("private provider body"), false);
  } finally { await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("restored running document jobs reconcile persisted failure before a corrected retry", { timeout: 15000 }, async () => {
  let reached!: () => void, release!: () => void, first = true;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = await fixture(async (request, authorization) => {
    if (first) { first = false; reached(); await gate; }
    return authorization === "Bearer invalid-key" ? "unauthorized" : result(request);
  });
  const directory = await fs.mkdtemp("./tmp/document-restored-failure-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` });
  try {
    await worker.start();
    const options = { engine: "document", cues, baseUrl: model.url, apiKey: "invalid-key" };
    const original = await worker.submitOrAttachJob(options);
    await entered; await worker.close(); release();
    worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
    const restored = await worker.submitOrAttachJob(options);
    assert.equal(restored.jobId, original.jobId);
    assert.equal(restored.status, "running");
    for await (const _event of worker.observeJobStream(restored, { heartbeatIntervalMs: 1 })) { /* wait for persisted terminal status */ }
    assert.equal((await worker.snapshotJob(restored)).status, "failed");
    assert.equal(restored.status, "running", "restored records intentionally have no completion watcher");
    const retry = await worker.submitOrAttachJob({ ...options, apiKey: "corrected-key" });
    assert.notEqual(retry.jobId, restored.jobId);
    await retry.taskPromise;
    assert.equal(retry.status, "succeeded");
  } finally { release(); await worker.close(); await model.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
