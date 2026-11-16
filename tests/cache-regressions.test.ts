import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { SubtitleCache, getTranslationProfile } from "../server/src/cache.js";
import { createApp, type AppDependencies } from "../server/src/app.js";
import { attachWebSocket } from "../server/src/websocket.js";
import { TranslationCheckpoint } from "../server/src/translation-checkpoint.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { SubtitleJobDoc } from "../worker/job-document.js";
import { JobIndexDoc } from "../worker/job-index.js";
import { contentVersion } from "../worker/cache-version.js";
import { calculateJobKey } from "../worker/keys.js";
import { TRANSLATION_TEAM_CONTRACT, TRANSLATION_TEAM_VERSION } from "../worker/translation-team.js";
import { LEGACY_TRANSLATION_VERSION, OPENAI_TRANSLATE_SYSTEM_PROMPT, WHOLE_TRANSLATE_SYSTEM_PROMPT, type translateStream } from "../server/src/translate.js";
import { respondAsSubtitleAgent } from "./support/subtitle-agent-model.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";

const source = [
  { cue_id: "c0", start: 0, end: 1000, text: "Hello." },
  { cue_id: "c1", start: 1000, end: 2000, text: "The transaction failed." },
];
const body = {
  url: "https://www.youtube.com/watch?v=cache_probe", source_video_id: "cache_probe",
  source_title: "Probe", source_language: "en", source_cues: source,
  translate_to: "zh-CN", translate_engine: "legacy", translate_provider: "openai",
};
async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yts-cache-regression-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  return `http://127.0.0.1:${addr.port}`;
}
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function fixture(t: TestContext, deps: Partial<AppDependencies> & { translateStream?: typeof translateStream } = {}) {
  const dir = await directory(t);
  const cache = new SubtitleCache(path.join(dir, "cache")); await cache.maintain();
  const storagePath = path.join(dir, "state.db");
  const worker = new AgentWorker({ storagePath }); await worker.start();
  const supplied = { cache, worker, ...deps };
  const server = http.createServer(createApp(supplied)), cleanupWs = attachWebSocket(server, supplied);
  const base = await listen(server);
  t.after(async () => { await cleanupWs(); await close(server); await worker.close(); });
  return { dir, storagePath, cache, worker, base };
}
async function post(base: string, route: string, value: unknown) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
async function websocket(base: string, value: unknown) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws/subtitle/process`), events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify(value)));
    ws.on("message", raw => events.push(JSON.parse(raw.toString())));
    ws.once("close", () => resolve()); ws.once("error", reject);
  });
  return events;
}
async function mockModel(t: TestContext) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      calls++;
      if (!respondAsSubtitleAgent(JSON.parse(raw), res)) throw new Error("unexpected model request");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  const baseUrl = `${await listen(server)}/v1`, restore = trustModelEndpoint(baseUrl);
  t.after(async () => { restore(); await close(server); });
  return { baseUrl, calls: () => calls };
}
async function finish(worker: AgentWorker, options: Parameters<AgentWorker["submitOrAttachJob"]>[0]) {
  const job = await worker.submitOrAttachJob(options); await job.taskPromise;
  assert.equal((await worker.snapshotJob(job)).status, "succeeded", String(job.error));
  return job;
}

test("cache deletion uses explicit video ownership and TTL kind, including profiled metadata", async t => {
  const dir = await directory(t), cache = new SubtitleCache(dir, { translationTtlSeconds: 0, whisperTtlSeconds: 1 });
  await cache.maintain();
  await cache.putMetadata("abc-metadata-profile", { id: "abc" });
  for (const id of ["abc", "abc_2", "abc_en"]) await cache.putCues(id, "en", "rule", null, source);
  assert.equal(await cache.clearVideo("abc"), 2);
  assert.equal(await cache.getMetadata("abc-metadata-profile"), null);
  for (const id of ["abc_2", "abc_en"]) assert.deepEqual(await cache.getCues(id, "en", "rule", null), source);
  await cache.putTranslation("abc_whisper-x", "en", "rule", "zh-CN", "profile", source);
  const translation = cache._path("abc_whisper-x", "en", "rule", "zh-CN", "profile.cues.json");
  const old = new Date(Date.now() - 7200_000); await fs.utimes(translation, old, old);
  await cache.purgeExpired();
  assert.deepEqual(await cache.getTranslation("abc_whisper-x", "en", "rule", "zh-CN", "profile"), source);
});

test("legacy raw files remain readable and clearVideo does not prefix-delete neighboring IDs", async t => {
  const dir = await directory(t), cache = new SubtitleCache(dir); await cache.maintain();
  await fs.writeFile(cache._path("abc-metadata-0123456789abcdef", "metadata.json"), JSON.stringify({ id: "abc" }));
  for (const id of ["abc", "abc_2", "abc_en"]) await fs.writeFile(cache._path(id, "en", "rule", "none_segment-v1.cues.json"), JSON.stringify(source));
  assert.deepEqual(await cache.getCues("abc", "en", "rule", null, { profile: "segment-v1" }), source);
  assert.equal(await cache.clearVideo("abc"), 2);
  for (const id of ["abc_2", "abc_en"]) assert.deepEqual(await cache.getCues(id, "en", "rule", null, { profile: "segment-v1" }), source);
});

test("orphan temp cleanup preserves fresh writes and unrelated SQLite files", async t => {
  const dir = await directory(t), cache = new SubtitleCache(dir); await cache.maintain();
  for (const file of [".cache-tmp-old", ".cache-tmp-fresh", "durable-storage.db"]) await fs.writeFile(path.join(dir, file), "data");
  const old = new Date(Date.now() - 7200_000); await fs.utimes(path.join(dir, ".cache-tmp-old"), old, old);
  assert.equal(await cache.purgeExpired(), 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), [".cache-tmp-fresh", "durable-storage.db"]);
});

test("100 hot writes in a 5000-file directory never scan or stat the directory", async t => {
  const dir = await directory(t), cache = new SubtitleCache(dir); await cache.maintain();
  for (let i = 0; i < 5000; i += 100) await Promise.all(Array.from({ length: 100 }, (_, j) => fs.writeFile(cache._path(`f${i+j}`, "en", "json3.txt"), "{}")));
  const readdir = t.mock.method(fs, "readdir", async () => { throw new Error("unexpected hot-path scan"); });
  const stat = t.mock.method(fs, "stat", async () => { throw new Error("unexpected hot-path stat"); });
  for (let i = 0; i < 100; i++) await cache.putCues("probe", "en", "rule", null, source);
  assert.equal(readdir.mock.callCount(), 0); assert.equal(stat.mock.callCount(), 0);
  readdir.mock.restore(); stat.mock.restore();
});

test("read access-time updates are throttled without altering freshness", async t => {
  const dir = await directory(t), cache = new SubtitleCache(dir); await cache.maintain();
  await cache.putJson3("probe", "en", "{}");
  const file = cache._path("probe", "en", "json3.txt"), before = await fs.stat(file), utimes = t.mock.method(fs, "utimes");
  for (let i = 0; i < 10; i++) assert.equal(await cache.getJson3("probe", "en"), "{}");
  assert.equal(utimes.mock.callCount(), 1); assert.ok(Math.abs((await fs.stat(file)).mtimeMs - before.mtimeMs) < 0.001);
});

test("checkpoint thresholds flush once at completion and retain dirty state after storage failure", async () => {
  let writes = 0;
  const checkpoint = new TranslationCheckpoint(async () => { writes++; });
  for (let i = 0; i < 25; i++) await checkpoint.update();
  assert.equal(writes, 2); await checkpoint.flush(); await checkpoint.flush(); assert.equal(writes, 3);
  const timed = new TranslationCheckpoint(async () => { writes++; }, 10, 0);
  await timed.update(); assert.equal(writes, 4);
  let fail = true;
  const retry = new TranslationCheckpoint(async () => { if (fail) throw new Error("disk full"); writes++; });
  await retry.update(); await assert.rejects(retry.flush(), /disk full/); fail = false; await retry.flush(); assert.equal(writes, 5);
});

test("REST, SSE and WS share cache in either direction but keep whole/batch isolated", async t => {
  const calls: string[][] = [];
  const { base } = await fixture(t, {
    translateSubtitles: async cues => { calls.push(cues.map(c => c.text)); return cues.map(c => ({ ...c, translation: "译文" })); },
    translateStream: async function* (text) { calls.push([text]); yield "译文"; },
  });
  for (const whole of [false, true]) {
    const value = { ...body, translate_whole: whole };
    const before = calls.length;
    await (await post(base, "/api/subtitle/process", value)).json();
    assert.equal(calls.length, before + 1);
    const sse = await (await post(base, "/api/subtitle/stream", value)).text(); assert.match(sse, /"cached":true/);
    const events = await websocket(base, value); assert.equal(events.at(-1).type, "done");
    assert.ok(events.filter(e => e.type === "cue").every(e => e.cached)); assert.equal(calls.length, before + 1);
  }
  for (const transport of ["sse", "ws"]) {
    const value = { ...body, source_video_id: transport, url: `https://youtu.be/${transport}` };
    if (transport === "sse") await (await post(base, "/api/subtitle/stream", value)).text();
    else assert.equal((await websocket(base, value)).at(-1).type, "done");
    const before = calls.length; await (await post(base, "/api/subtitle/process", value)).json(); assert.equal(calls.length, before);
  }
});

test("SSE never silently switches to whole prompts at 100 cues", async t => {
  let calls = 0;
  const { base } = await fixture(t, {
    translateSubtitles: async (cues, _from, _to, options) => {
      calls++; assert.equal(options?.whole, false);
      return cues.map(c => ({ ...c, translation: "译文" }));
    },
  });
  const cues = Array.from({ length: 100 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, text: `Line ${i}.` }));
  await (await post(base, "/api/subtitle/stream", { ...body, source_cues: cues })).text(); assert.equal(calls, 10);
  await (await post(base, "/api/subtitle/process", { ...body, source_cues: cues })).json(); assert.equal(calls, 10);
});

test("partial REST results are persisted and only missing cues are retried, also from whole WS", async t => {
  let partial = true;
  const calls: string[][] = [];
  const { base } = await fixture(t, {
    translateSubtitles: async cues => {
      calls.push(cues.map(c => c.text)); const first = partial; partial = false;
      return cues.map((c, i) => ({ ...c, translation: first && i ? "" : "译文" }));
    },
  });
  const value = { ...body, translate_whole: true };
  assert.equal((await (await post(base, "/api/subtitle/process", value)).json()).translation_status, "partial");
  const retry = await (await post(base, "/api/subtitle/process", value)).json();
  assert.equal(retry.translation_status, "succeeded"); assert.deepEqual(calls, [source.map(c => c.text), [source[1].text]]);
  partial = true;
  const other = { ...value, source_video_id: "ws_partial", url: "https://youtu.be/ws_partial" };
  await (await post(base, "/api/subtitle/process", other)).json();
  const events = await websocket(base, other); assert.equal(events.at(-1).type, "done");
  assert.deepEqual(calls.at(-1), [source[1].text]); assert.ok(events.some(e => e.type === "cue" && e.index === 0 && e.cached));
});

test("WS/SSE batch full-array writes and WS provider failure preserves completed cues", async t => {
  const calls: string[] = []; let fail = false;
  const { base, cache } = await fixture(t, {
    translateSubtitles: async cues => cues.map(c => ({ ...c, translation: "译文" })),
    translateStream: async function* (text) { calls.push(text); if (fail && text === "Line 3.") throw new Error("provider interrupted"); yield "译文"; },
  });
  const many = Array.from({ length: 25 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, text: `Line ${i}.` }));
  const put = t.mock.method(cache, "putTranslation");
  assert.equal((await websocket(base, { ...body, source_cues: many })).at(-1).type, "done"); assert.equal(put.mock.callCount(), 3);
  await (await post(base, "/api/subtitle/stream", { ...body, source_cues: many, source_video_id: "sse_many", url: "https://youtu.be/sse_many" })).text();
  assert.equal(put.mock.callCount(), 6);
  fail = true;
  const value = { ...body, source_cues: many, source_video_id: "interrupted", url: "https://youtu.be/interrupted" };
  assert.equal((await websocket(base, value)).at(-1).type, "error");
  const before = calls.length; fail = false;
  const events = await websocket(base, value); assert.equal(events.at(-1).type, "done");
  assert.equal(calls.length - before, 22); assert.equal(events.filter(e => e.type === "cue" && e.cached).length, 3);
});

test("WS disconnect flushes completed cues but never reuses the interrupted cue", { timeout: 10000 }, async t => {
  let pause = true, calls = 0, saved!: () => void;
  const flushed = new Promise<void>(resolve => { saved = resolve; });
  const { base, cache } = await fixture(t, {
    translateStream: async function* (text, _from, _to, options) {
      calls++;
      if (pause && text === "Line 3.") {
        yield "unfinished";
        await new Promise<void>((_resolve, reject) => {
          const signal = options!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      yield "译文";
    },
  });
  const original = cache.putTranslation.bind(cache);
  t.mock.method(cache, "putTranslation", async (...args: Parameters<typeof original>) => { await original(...args); saved(); });
  const cues = Array.from({ length: 5 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, text: `Line ${i}.` }));
  const value = { ...body, source_video_id: "disconnect", source_cues: cues, url: "https://youtu.be/disconnect" };
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws/subtitle/process`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify(value)));
    ws.on("message", raw => { const event = JSON.parse(raw.toString()); if (event.type === "cue_chunk" && event.index === 3) ws.close(); });
    ws.once("close", () => resolve()); ws.once("error", reject);
  });
  await flushed;
  const profile = getTranslationProfile({ cues, strategy: "batch", fromLang: "en", toLang: "zh-CN", segmentation: "rule" });
  const cached = await cache.getTranslation("disconnect", "en", "rule", "zh-CN", profile);
  assert.equal(cached?.filter(c => c.translation).length, 3); assert.ok(!cached?.[3].translation);
  const before = calls; pause = false;
  const events = await websocket(base, value);
  assert.equal(events.at(-1).type, "done"); assert.equal(calls - before, 2);
  assert.equal(events.filter(e => e.type === "cue" && e.cached).length, 3);
});

test("document identity ignores title/token capacities but explicitly includes model, endpoint and reasoning", async t => {
  const model = await mockModel(t), { worker } = await fixture(t);
  const options = { videoId: "identity", title: "A", cues: source, baseUrl: model.baseUrl, apiKey: "fake-key", budgetLimit: 100 };
  const first = await finish(worker, options), before = model.calls();
  for (const change of [{ title: "A " }, { contextTokens: 64000 }, { outputTokens: 8192 }]) assert.equal((await finish(worker, { ...options, ...change })).jobId, first.jobId);
  assert.equal(model.calls(), before);
  const key = { videoId: "identity", sourceCues: source, workflowVersion: TRANSLATION_TEAM_VERSION };
  for (const change of [{ model: "other" }, { baseUrl: "https://other.example/v1" }, { reasoningConfig: "high" }, { workflowVersion: "other" }]) assert.notEqual(calculateJobKey(key), calculateJobKey({ ...key, ...change }));
});

test("durable cache deletion forces fresh model work, including after a worker restart", async t => {
  const model = await mockModel(t), { worker, cache, base, storagePath } = await fixture(t);
  const options = { videoId: "clear_me", cues: source, baseUrl: model.baseUrl, apiKey: "fake-key", budgetLimit: 100 };
  const first = await finish(worker, options);
  const other = await finish(worker, { ...options, videoId: "keep_me" });
  const deleted = await fetch(`${base}/api/cache/clear_me`, { method: "DELETE" });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).jobs_removed, 1);
  assert.equal(await worker.getJob(first.jobId), null);
  assert.equal(await worker.harness!.snapshot(SubtitleJobDoc, first.conversationId, worker.context), undefined);
  assert.equal((await worker.getJob(other.jobId))?.jobId, other.jobId);
  await worker.close();
  const restarted = new AgentWorker({ storagePath }); await restarted.start(); t.after(() => restarted.close());
  const before = model.calls(), second = await finish(restarted, options);
  assert.notEqual(second.jobId, first.jobId); assert.ok(model.calls() > before);
  const server = http.createServer(createApp({ cache, worker: restarted })), restartedBase = await listen(server);
  t.after(() => close(server));
  const all = await fetch(`${restartedBase}/api/cache`, { method: "DELETE" });
  assert.equal(all.status, 200); assert.equal((await all.json()).jobs_removed, 2);
  const third = await finish(restarted, options); assert.notEqual(third.jobId, second.jobId);
});

test("clearing an active durable job drains its writers before retiring the cache", { timeout: 10000 }, async t => {
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const model = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the request, but keep its response in flight. */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": keepalive\n\n"); entered();
  });
  const baseUrl = `${await listen(model)}/v1`, restore = trustModelEndpoint(baseUrl);
  t.after(async () => { restore(); await close(model); });
  const { worker } = await fixture(t);
  const options = { videoId: "active", cues: source, apiKey: "fake-key", baseUrl, budgetLimit: 100 };
  const first = await worker.submitOrAttachJob(options); await requested;
  assert.equal(await worker.clearJobs("active"), 1);
  assert.equal(await worker.getJob(first.jobId), null);
  assert.equal(await worker.harness!.snapshot(SubtitleJobDoc, first.conversationId, worker.context), undefined);
  const second = await worker.submitOrAttachJob(options); assert.notEqual(second.jobId, first.jobId);
  assert.equal(await worker.clearJobs("active"), 1);
});

test("prompt/tool content changes alter versions; changing the actual prompt invalidates a persisted job", async t => {
  assert.equal(TRANSLATION_TEAM_VERSION, contentVersion("subtitle-team", TRANSLATION_TEAM_CONTRACT));
  for (const field of ["main", "child", "opening"] as const) assert.notEqual(TRANSLATION_TEAM_VERSION, contentVersion("subtitle-team", { ...TRANSLATION_TEAM_CONTRACT, [field]: `${TRANSLATION_TEAM_CONTRACT[field]}!` }));
  assert.notEqual(TRANSLATION_TEAM_VERSION, contentVersion("subtitle-team", { ...TRANSLATION_TEAM_CONTRACT, mainTools: [...TRANSLATION_TEAM_CONTRACT.mainTools, { name: "new_tool" }] }));
  assert.equal(LEGACY_TRANSLATION_VERSION, contentVersion("legacy", { single: OPENAI_TRANSLATE_SYSTEM_PROMPT, whole: WHOLE_TRANSLATE_SYSTEM_PROMPT, workflow: "legacy-v3" }));
  assert.notEqual(getTranslationProfile({ cues: source }), getTranslationProfile({ cues: source, promptVersion: `${LEGACY_TRANSLATION_VERSION}!` }));
  const model = await mockModel(t), dir = await directory(t), storagePath = path.join(dir, "state.db");
  let worker = new AgentWorker({ storagePath }); await worker.start(); t.after(() => worker.close());
  const options = { videoId: "prompt_change", cues: source, baseUrl: model.baseUrl, apiKey: "fake-key", budgetLimit: 100 };
  const first = await finish(worker, options), before = model.calls(); await worker.close();
  const copy = await fs.mkdtemp(path.resolve("tmp/prompt-contract-")); t.after(() => fs.rm(copy, { recursive: true, force: true }));
  await fs.cp(path.resolve("worker"), path.join(copy, "worker"), { recursive: true });
  const file = path.join(copy, "worker/subtitle-agent.ts"), text = await fs.readFile(file, "utf8");
  assert.ok(text.includes("Your goal is to translate the complete source"));
  await fs.writeFile(file, text.replace("Your goal is to translate the complete source", "Use new terminology. Your goal is to translate the complete source"));
  const changed = await import(pathToFileURL(path.join(copy, "worker/agent-worker.ts")).href);
  worker = new changed.AgentWorker({ storagePath }); await worker.start();
  const second = await finish(worker, options);
  assert.notEqual(second.jobKey, first.jobKey); assert.notEqual(second.jobId, first.jobId); assert.ok(model.calls() > before);
});

test("legacy index backfill runs once; cold lookup and misses never scan conversations", async t => {
  const dir = await directory(t), storagePath = path.join(dir, "state.db");
  let worker = new AgentWorker({ storagePath }); await worker.start(); t.after(() => worker.close());
  for (let i = 0; i < 105; i++) {
    const conversation = await worker.harness!.createConversation({ ownership: { kind: "ownerless" } }, worker.context);
    await conversation.commit(async tx => {
      const doc = await tx.doc(SubtitleJobDoc, conversation.id);
      doc.job_key = `key-${i}`; doc.job_id = `job-${i}`; doc.video_id = `v${i}`; doc.engine = "document"; doc.status = "succeeded";
    }, worker.context);
  }
  await worker.harness!.commit(tx => tx.retireDoc(JobIndexDoc), worker.context); // Simulate an old, unindexed DB.
  await worker.close(); worker = new AgentWorker({ storagePath }); await worker.start();
  assert.equal(Object.keys((await worker.harness!.snapshot(JobIndexDoc, worker.context))!.entries).length, 105);
  await worker.close(); worker = new AgentWorker({ storagePath }); await worker.start();
  const scan = t.mock.method(worker.storage!, "scanConversations", async () => { throw new Error("unexpected linear scan"); });
  const snapshot = t.mock.method(worker.harness!, "snapshot");
  assert.equal((await worker.getJob("key-0"))?.jobId, "job-0"); assert.equal(snapshot.mock.callCount(), 1);
  await worker.getJob("key-0"); assert.equal(snapshot.mock.callCount(), 1);
  assert.equal(await worker.getJob("absent"), null); assert.equal(snapshot.mock.callCount(), 1);
  assert.equal((await worker.getJob("job-104"))?.jobKey, "key-104"); assert.equal(snapshot.mock.callCount(), 2);
  assert.equal(scan.mock.callCount(), 0);
});
