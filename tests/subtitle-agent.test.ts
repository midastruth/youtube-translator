import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  advanceSubtitleAgent, finalSubtitleAgentCues, initialSubtitleAgentState, subtitleAgentContext,
  subtitleAgentTool, SUBTITLE_AGENT_TOOLS,
} from "../worker/subtitle-agent.js";
import { TEAM_TOOLS } from "../worker/translation-team.js";
import { modelConfig } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { SubtitleJobDoc } from "../worker/job-document.js";
import { DocumentResumeDoc } from "../worker/document-task.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { endModelStream, modelChunk, sendModelJson } from "./support/model-stream.js";
import { scriptedAgentTools, sendAgentTools, type AgentPayload } from "./support/subtitle-agent-model.js";

const cues = [
  { cue_id: "a", start: 123, end: 1200, text: "The transaction was rejected." },
  { cue_id: "b", start: 1200, end: 2500, text: "By transaction, I mean a database transaction, not a payment." },
];
function input(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return { jobId: "test", jobKey: "key", videoId: "video", title: "Transactions", fromLang: "en", toLang: "zh-CN", cues,
    config: modelConfig(), budgetLimit: 128, ...overrides };
}
function assistant(tools: { name: string; args: unknown }[] = [], text = ""): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: 0, stopReason: tools.length ? "toolUse" : "stop",
    content: [...(text ? [{ type: "text" as const, text }] : []), ...tools.map((t, i) => ({ type: "toolCall" as const, id: `t${i}`, name: t.name, arguments: t.args as ToolCall["arguments"] }))],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

test("agent defaults to sol while explicit model and deployment configuration take precedence", () => {
  const previous = process.env.TRANSLATION_AGENT_MODEL;
  try {
    delete process.env.TRANSLATION_AGENT_MODEL;
    assert.equal(modelConfig().model, "sol");
    assert.equal(modelConfig({ model: "custom-model" }).model, "custom-model");
    process.env.TRANSLATION_AGENT_MODEL = "deployment-model";
    assert.equal(modelConfig().model, "deployment-model");
    assert.equal(modelConfig({ model: "custom-model" }).model, "custom-model");
  } finally {
    if (previous === undefined) delete process.env.TRANSLATION_AGENT_MODEL;
    else process.env.TRANSLATION_AGENT_MODEL = previous;
  }
});

test("reasoning configuration defaults off, validates levels and snapshots deployment settings", () => {
  const previous = process.env.TRANSLATION_REASONING_EFFORT;
  try {
    delete process.env.TRANSLATION_REASONING_EFFORT;
    assert.equal(modelConfig().reasoningEffort, "off");
    process.env.TRANSLATION_REASONING_EFFORT = "medium";
    const config = modelConfig();
    assert.equal(config.reasoningEffort, "medium");
    assert.equal(modelConfig({ reasoningEffort: "off" }).reasoningEffort, "off");
    assert.equal(modelConfig({ reasoningEffort: "high" }).reasoningEffort, "high");
    process.env.TRANSLATION_REASONING_EFFORT = "low";
    assert.equal(config.reasoningEffort, "medium");
    assert.equal(modelConfig(config).reasoningEffort, "medium");
    process.env.TRANSLATION_REASONING_EFFORT = "invalid-private-value";
    assert.throws(() => modelConfig(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid TRANSLATION_REASONING_EFFORT/);
      assert.doesNotMatch(error.message, /invalid-private-value/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.TRANSLATION_REASONING_EFFORT;
    else process.env.TRANSLATION_REASONING_EFFORT = previous;
  }
});

test("agent workspace reads paginated immutable timed source and searches later definitions", () => {
  const document = input(), state = initialSubtitleAgentState(document);
  const page = subtitleAgentTool(document, state, "read_file", { path: "source.json", count: 1 }) as { content: string; next_offset: number };
  assert.deepEqual(JSON.parse(page.content), [cues[0]]); assert.equal(page.next_offset, 1);
  const next = subtitleAgentTool(document, state, "read_file", { path: "source.json", offset: 1, count: 1 }) as { content: string; next_offset: null };
  assert.deepEqual(JSON.parse(next.content), [cues[1]]); assert.equal(next.next_offset, null);
  const found = subtitleAgentTool(document, state, "search_file", { path: "source.json", query: "not a payment" }) as { matches: { cue_id: string }[] };
  assert.equal(found.matches[0].cue_id, "b");
  for (const path of ["source.json", "/etc/passwd", "../translations.json", "notes.md/../source.json"]) {
    assert.throws(() => subtitleAgentTool(document, state, "write_file", { path, content: "{}" }));
  }
  assert.throws(() => subtitleAgentTool(document, state, "bash", { command: "pwd" }));
  assert.throws(() => subtitleAgentTool(document, state, "read_file", { path: "source.json", offset: -1, count: 1 }));
  const empty = subtitleAgentTool(document, state, "read_file", { path: "translations.json", count: 2 }) as { content: string };
  assert.deepEqual(JSON.parse(empty.content), {}, "reading an empty file must not invent editable placeholder entries");
  assert.deepEqual(document.cues, cues);
});

test("read size is agent-selected and required, with a 200-cue limit and budget-aware pagination", async () => {
  const source = Array.from({ length: 221 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Sentence ${i}.` }));
  const document = input({ cues: source }), state = initialSubtitleAgentState(document);
  const read = (path: string, count?: unknown, offset = 0) => subtitleAgentTool(document, state, "read_file", { path, count, offset }) as { content: string; next_offset: number | null };
  for (const count of [undefined, null, 0, -1, 201, 1.5, "40"]) {
    assert.throws(() => read("source.json", count), /explicit count/);
    assert.throws(() => read("translations.json", count), /explicit count/);
  }
  const large = read("source.json", 200);
  assert.equal(JSON.parse(large.content).length, 200); assert.equal(large.next_offset, 200);
  const small = read("source.json", 17);
  assert.equal(JSON.parse(small.content).length, 17); assert.equal(small.next_offset, 17);
  const tail = read("source.json", 200, 200);
  assert.equal(JSON.parse(tail.content).length, 21); assert.equal(tail.next_offset, null);
  state.draft = Object.fromEntries(source.map(c => [c.cue_id, "事务"]));
  assert.equal(Object.keys(JSON.parse(read("translations.json", 200).content)).length, 200);
  state.notes = "a".repeat(4000);
  assert.throws(() => read("notes.md"), /explicit count/);
  assert.equal(read("notes.md", 4000).content.length, 4000, "notes count remains measured in characters");

  const limited = input({ cues: source, config: modelConfig({ contextTokens: 24000, outputTokens: 1024 }) });
  const page = subtitleAgentTool(limited, initialSubtitleAgentState(limited), "read_file", { path: "source.json", count: 200 }) as { content: string; next_offset: number };
  const actual = JSON.parse(page.content).length;
  assert.ok(actual > 0 && actual < 200); assert.equal(page.next_offset, actual);
  const missing = await advanceSubtitleAgent(document, state, async () => assistant([{ name: "read_file", args: { path: "source.json" } }]));
  const result = missing.messages.at(-1);
  assert.equal(result?.role, "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
});

test("translation writes and exact edits are atomic; invalid IDs, values, duplicates and overlapping edits are rejected", () => {
  const document = input(), state = initialSubtitleAgentState(document);
  const write = (content: string, merge = false) => subtitleAgentTool(document, state, "write_file", { path: "translations.json", content, merge });
  write('{"a":"这笔交易被拒绝了。"}');
  write('{"b":"这里指数据库事务，不是付款。"}', true);
  assert.equal(state.revision, 2);
  subtitleAgentTool(document, state, "edit_file", { path: "translations.json", edits: [{ old_text: "这笔交易被拒绝了。", new_text: "该事务被拒绝了。" }] });
  assert.equal(state.draft.a, "该事务被拒绝了。");
  const snapshot = structuredClone(state);
  for (const bad of ['{"z":"未知编号"}', '{"a":""}', '{"a":"[Translation failed]"}', '{"a":{"start":0}}', '{"a":"甲","a":"乙"}', '{"a":null,"a":"乙"}', '{invalid', '[]']) {
    assert.throws(() => write(bad)); assert.deepEqual(state, snapshot);
  }
  for (const edits of [
    [{ old_text: "不存在", new_text: "错误" }],
    [{ old_text: "事务", new_text: "交易" }], // ambiguous in both entries
    [{ old_text: "该事务", new_text: "甲" }, { old_text: "事务被", new_text: "乙" }],
    [{ old_text: '"a"', new_text: '"unknown"' }],
  ]) {
    assert.throws(() => subtitleAgentTool(document, state, "edit_file", { path: "translations.json", edits }));
    assert.deepEqual(state, snapshot);
  }
});

test("only explicit submission of the current fully validated revision can publish; time axis stays host-owned", () => {
  const document = input(), state = initialSubtitleAgentState(document);
  const tool = (name: string, args = {}) => subtitleAgentTool(document, state, name, args);
  assert.throws(() => tool("finish_translation"));
  tool("write_file", { path: "translations.json", content: '{"a":"事务失败。"}' });
  const incomplete = tool("validate_translation") as { valid: boolean; errors: string[] };
  assert.equal(incomplete.valid, false); assert.match(incomplete.errors.join(), /Missing translation/);
  assert.throws(() => tool("finish_translation"));
  tool("write_file", { path: "translations.json", content: '{"b":"这里指数据库事务。"}', merge: true });
  assert.equal((tool("validate_translation") as { valid: boolean }).valid, true);
  tool("edit_file", { path: "translations.json", edits: [{ old_text: "事务失败。", new_text: "该事务被拒绝了。" }] });
  assert.throws(() => tool("finish_translation"));
  tool("validate_translation");
  tool("write_file", { path: "notes.md", content: "已对照全文检查，transaction 统一为事务。" });
  tool("finish_translation");
  assert.deepEqual(finalSubtitleAgentCues(document, state), cues.map((c, index) => ({ ...c, index, translation: state.draft[c.cue_id] })));
  assert.throws(() => tool("write_file", { path: "translations.json", content: "{}" }));
});

test("team workspace session chooses tools and repairs a bad edit without fixed stages", async () => {
  const document = input(); let state = initialSubtitleAgentState(document);
  const turn = async (tools: { name: string; args: unknown }[]) => {
    state = await advanceSubtitleAgent(document, state, async context => {
      assert.equal(context.systemPrompt?.includes("coding agent"), true);
      assert.deepEqual(context.tools?.map(t => t.name), SUBTITLE_AGENT_TOOLS.map(t => t.name));
      return assistant(tools);
    });
  };
  await turn([{ name: "search_file", args: { path: "source.json", query: "transaction" } }]);
  await turn([{ name: "write_file", args: { path: "translations.json", content: '{"a":"交易被拒绝。","b":"这里是数据库事务。"}' } }]);
  const before = structuredClone(state);
  await turn([{ name: "edit_file", args: { path: "translations.json", edits: [{ old_text: "不匹配", new_text: "错误" }] } }]);
  assert.deepEqual(state.draft, before.draft);
  assert.equal(state.messages.at(-1)?.role, "toolResult");
  await turn([{ name: "edit_file", args: { path: "translations.json", edits: [{ old_text: "交易被拒绝。", new_text: "该事务被拒绝了。" }] } }]);
  await turn([{ name: "validate_translation", args: {} }, { name: "finish_translation", args: {} }]);
  assert.equal(state.stage, "publish"); assert.equal(state.cursor, 5);
  assert.equal(finalSubtitleAgentCues(document, state)[0].translation, "该事务被拒绝了。");
  assert.deepEqual(before.draft.a, "交易被拒绝。");
});

test("plain text cannot publish; invalid tool schemas and forged file paths cannot mutate state", async () => {
  const document = input(), initial = initialSubtitleAgentState(document);
  const text = await advanceSubtitleAgent(document, initial, async () => assistant([], '{"a":"伪完成"}'));
  assert.equal(text.stage, "editing"); assert.deepEqual(text.draft, {}); assert.match(text.feedback, /does not submit/);
  const invalid = await advanceSubtitleAgent(document, initial, async () => assistant([
    { name: "write_file", args: { path: "source.json", content: "{}" } },
    { name: "read_file", args: { path: "/etc/passwd" } },
    { name: "finish_translation", args: { bypass: true } },
  ]));
  assert.equal(invalid.stage, "editing"); assert.deepEqual(invalid.draft, {});
  assert.equal(invalid.messages.filter(m => m.role === "toolResult" && m.isError).length, 3);
  assert.deepEqual(initial.messages, []);
});

test("compaction preserves workspace edits, notes and revision, and resumes with bounded fresh context", () => {
  const document = input({ config: modelConfig({ contextTokens: 20000, outputTokens: 1024 }) });
  const state = initialSubtitleAgentState(document);
  subtitleAgentTool(document, state, "write_file", { path: "translations.json", content: '{"a":"事务。"}' });
  subtitleAgentTool(document, state, "write_file", { path: "notes.md", content: "transaction=事务；接下来阅读 b。" });
  state.messages.push(assistant([], "previous conversation ".repeat(5000)));
  const context = subtitleAgentContext(document, state);
  assert.equal(state.compactions, 1); assert.deepEqual(state.messages, []);
  assert.equal(state.draft.a, "事务。"); assert.equal(state.revision, 1);
  assert.match(JSON.stringify(context.messages), /transaction=事务/);
  assert.match(JSON.stringify(context.messages[0]), /resumed_after_compaction/);
  assert.match(JSON.stringify(context.messages.at(-1)), /first_untranslated_id/);
  assert.match(JSON.stringify(context.messages.at(-1)), /transaction=事务/, "notes travel in the trailing status");
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored.draft, state.draft);
});

test("prompt prefix is byte-stable across turns: volatile progress and notes only trail the history", async () => {
  const document = input(); let state = initialSubtitleAgentState(document);
  const sent: { context: ReturnType<typeof subtitleAgentContext>; key?: string }[] = [];
  const turn = async (tools: { name: string; args: unknown }[]) => {
    state = await advanceSubtitleAgent(document, state, async (context, key) => {
      sent.push({ context: structuredClone(context), key });
      return { ...assistant(tools), usage: { ...assistant().usage, input: 10, cacheRead: 90 } };
    });
  };
  await turn([{ name: "read_file", args: { path: "source.json", count: 2 } }]);
  await turn([{ name: "write_file", args: { path: "translations.json", content: '{"a":"事务被拒绝。"}' } }, { name: "write_file", args: { path: "notes.md", content: "transaction=事务" } }]);
  await turn([{ name: "write_file", args: { path: "translations.json", content: '{"b":"数据库事务。"}', merge: true } }]);
  for (let i = 1; i < sent.length; i++) {
    const previous = sent[i - 1].context, current = sent[i].context;
    assert.equal(current.systemPrompt, previous.systemPrompt);
    assert.deepEqual(current.tools, previous.tools);
    // Everything except the previous trailing status must be an exact prefix.
    const stable = previous.messages.slice(0, -1);
    assert.deepEqual(current.messages.slice(0, stable.length), stable);
  }
  assert.deepEqual(sent.map(s => s.context.messages.length), [2, 4, 7]);
  assert.equal(new Set(sent.map(s => s.key)).size, 1);
  const status = JSON.parse((sent[2].context.messages.at(-1) as { content: string }).content);
  assert.equal(status.type, "workspace_status");
  assert.equal(status.notes, "transaction=事务");
  assert.equal(status.first_untranslated_id, "b");
  assert.doesNotMatch(JSON.stringify(sent[2].context.messages.slice(0, -1).filter(m => m.role === "user")), /first_untranslated_id|translated_cues/);
  assert.deepEqual(state.usage, { input: 30, cacheRead: 270, cacheWrite: 0 });
  assert.equal(state.messages.some(m => m.role === "user"), false, "status is never persisted into history");
});

test("agent input rejects invalid timing, duplicate/reserved IDs and insufficient context before charging", () => {
  for (const source of [[cues[0], cues[0]], [{ ...cues[0], start: -1 }], [{ ...cues[0], end: 0 }], [{ ...cues[0], cue_id: "__proto__" }], []]) {
    assert.throws(() => initialSubtitleAgentState(input({ cues: source })));
  }
  assert.throws(() => initialSubtitleAgentState(input({ config: modelConfig({ contextTokens: 6000, outputTokens: 1024 }) })));
});

type FixtureOptions = {
  failures?: number[];
  intercept?: (payload: AgentPayload, res: http.ServerResponse, authorization: string | undefined) => Promise<boolean | void>;
};
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const requests: AgentPayload[] = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body); requests.push(payload);
      assert.equal(payload.stream, true); assert.equal(payload.response_format, undefined);
      const names = payload.tools.map((tool: { function: { name: string } }) => tool.function.name);
      assert.deepEqual(names, names.includes("dispatch_subagents") ? TEAM_TOOLS.map(t => t.name) : [...SUBTITLE_AGENT_TOOLS.map(t => t.name), "read_context"]);
      if (options.failures?.length) { res.writeHead(options.failures.shift()!); res.end("private provider key body"); return; }
      if (await options.intercept?.(payload, res, req.headers.authorization)) return;
      sendAgentTools(res, scriptedAgentTools(payload));
    } catch { if (!res.headersSent) res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1`, restoreEndpoint = trustModelEndpoint(url);
  const directory = await fs.mkdtemp("./tmp/subtitle-agent-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
  const jobOptions = { engine: "document", cues, title: "Transactions", baseUrl: url, apiKey: "ephemeral-browser-agent-key" };
  t.after(async () => {
    await worker.close(); restoreEndpoint(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    requests, directory, jobOptions, get worker() { return worker; },
    restart: async () => { await worker.close(); worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start(); },
  };
}
function lastTool(payload: AgentPayload) {
  return payload.messages.filter(m => m.role === "assistant" && m.tool_calls?.length).at(-1)?.tool_calls?.at(-1)?.function;
}
function gate() {
  let release!: () => void, reached!: () => void;
  return { waiting: new Promise<void>(r => { reached = r; }), pause: new Promise<void>(r => { release = r; }), release: () => release(), reached: () => reached() };
}

test("default document job edits a workspace, self-checks then publishes atomically; keys never persist", { timeout: 15000 }, async t => {
  const hold = gate(); t.after(hold.release);
  const f = await fixture(t, { intercept: async (payload, _res, authorization) => {
    assert.equal(authorization, "Bearer ephemeral-browser-agent-key");
    if (lastTool(payload)?.name === "validate_translation") { hold.reached(); await hold.pause; }
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await hold.waiting;
  assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []);
  assert.equal((await f.worker.snapshotJob(job)).status, "running");
  assert.equal(await f.worker.submitOrAttachJob(f.jobOptions), job);
  assert.equal(await f.worker.submitOrAttachJob({ ...f.jobOptions, engine: undefined, segmentation: "rule", fromLang: "en", toLang: "zh-CN", provider: "openai" }), job,
    "implicit team/default metadata must retain the same document cache identity");
  const stream = f.worker.observeJobStream(job, { heartbeatIntervalMs: 1 });
  assert.equal((await stream.next()).value?.type, "meta"); await stream.next(); await stream.next();
  assert.equal((await stream.next()).value?.stage, "editing");
  hold.release(); await job.taskPromise; assert.equal(job.status, "succeeded");
  const events = []; for await (const event of stream) events.push(event);
  assert.equal(events.filter(e => e.type === "cue").length, 2); assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(job.finalResult?.cues.map(c => [c.cue_id, c.start, c.end]), [["a", 123, 1200], ["b", 1200, 2500]]);
  assert.equal(f.requests.length, 9, "main acceptance, closing, validation and submission share one turn");
  assert.equal(f.requests.some(r => r.messages.some(m => m.role === "tool")), true);
  const calls = f.requests.length;
  await f.restart(); const restored = await f.worker.submitOrAttachJob(f.jobOptions);
  assert.equal(restored.jobId, job.jobId); assert.equal(restored.status, "succeeded"); assert.equal(f.requests.length, calls);
  for (const name of await fs.readdir(f.directory)) if (name.startsWith("state.db")) {
    assert.equal((await fs.readFile(`${f.directory}/${name}`)).includes(Buffer.from(f.jobOptions.apiKey)), false);
  }
});

test("default document budget is unlimited beyond 128 calls and still counts actual usage", { timeout: 15000 }, async t => {
  const previous = process.env.TRANSLATION_REQUEST_BUDGET;
  delete process.env.TRANSLATION_REQUEST_BUDGET;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSLATION_REQUEST_BUDGET;
    else process.env.TRANSLATION_REQUEST_BUDGET = previous;
  });
  let extraReads = 130;
  const f = await fixture(t, { intercept: async (payload, res) => {
    const manifest = JSON.parse(payload.messages.find(m => m.role === "user")!.content!);
    assert.equal(manifest.request_budget, "unlimited");
    // Unlimited aggregate budget is distinct from the main-agent no-progress
    // watchdog. Exercise the budget across a child session, not stuck planning.
    const main = payload.tools?.some(t => t.function.name === "dispatch_subagents");
    if (!main && extraReads-- > 0) {
      sendAgentTools(res, [{ name: "read_file", args: { path: "source.json", offset: 0, count: 100 } }]);
      return true;
    }
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await job.taskPromise;
  assert.equal(job.status, "succeeded");
  assert.ok(f.requests.length > 128);
  const doc = await f.worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, f.worker.context);
  assert.equal(doc?.budget_limit, 0);
  assert.equal(doc?.network_attempts, f.requests.length);
  assert.equal(job.finalResult?.cues.length, cues.length);
});

test("stalled main review stops paid requests, retains submitted children in SQLite, and resumes after restart", { timeout: 15000 }, async t => {
  let stall = true;
  const f = await fixture(t, { intercept: async (payload, res) => {
    if (!payload.tools?.some(tool => tool.function.name === "dispatch_subagents")) return;
    const live = payload.messages.filter(m => m.role === "user").map(m => {
      try { return JSON.parse(m.content || "{}"); } catch { return {}; }
    }).find(m => m.type === "workspace_status");
    if (!live?.subagents?.length || live.subagents.some((c: { status: string }) => c.status === "running")) return;
    const progress = live.main_progress;
    if (!progress.bilingual_read_cues) {
      sendAgentTools(res, [{ name: "read_bilingual", args: { offset: 0, count: 1 } }]);
    } else if (!progress.reviewed_cues) {
      sendAgentTools(res, [{ name: "record_review", args: { offset: 0, count: 1, revision: progress.review_revision, summary: "First page checked; negation preserved. Continue at position 1." } }]);
    } else if (stall) {
      sendAgentTools(res, [{ name: "read_bilingual", args: { offset: 0, count: 1 } }]);
    } else {
      assert.equal(progress.next_review_offset, 1, "explicit semantic review survives SQLite persistence and restart");
      assert.match(progress.review_summary, /negation preserved/);
      sendAgentTools(res, progress.bilingual_read_cues === 1 ? [{ name: "read_bilingual", args: { offset: 1, count: 1 } }] : [
        { name: "record_review", args: { offset: 1, count: 1, revision: progress.review_revision, summary: "Both pages checked; no unresolved meaning or terminology problems." } },
        { name: "accept_translation", args: { review: "Rechecked source meaning and submitted sections; numbers and terminology consistent." } },
        { name: "close_subagents", args: {} }, { name: "validate_translation", args: {} }, { name: "finish_translation", args: {} },
      ]);
    }
    return true;
  } });
  const job = await f.worker.submitOrAttachJob({ ...f.jobOptions, budgetLimit: 0 }); await job.taskPromise;
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /主 Agent 验收无进展.*检查点已保留/);
  const saved = await f.worker.harness!.snapshot(DocumentResumeDoc, job.conversationId, f.worker.context);
  const workspace = saved?.document as unknown as { draft: Record<string, string>; children: { status: string }[]; mainProgress: { guard: { stalled: number }; reviewed: number[][] } };
  assert.equal(Object.keys(workspace.draft).length, cues.length);
  assert.ok(workspace.children.every(c => c.status === "completed"));
  assert.equal(workspace.mainProgress.guard.stalled, 12);
  assert.deepEqual(workspace.mainProgress.reviewed, [[0, 1]]);
  const before = f.requests.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.requests.length, before, "failed job must not keep spending requests");
  assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []);
  stall = false;
  await f.restart();
  const resumed = await f.worker.submitOrAttachJob({ ...f.jobOptions, budgetLimit: 0 }); await resumed.taskPromise;
  assert.equal(resumed.jobId, job.jobId);
  assert.equal(resumed.status, "succeeded");
  assert.equal(f.requests.length, before + 2, "manual resume resets only the watchdog and reviews only the remaining page, without respawning children");
  const doc = await f.worker.harness!.snapshot(SubtitleJobDoc, resumed.conversationId, f.worker.context);
  assert.equal(doc?.network_attempts, f.requests.length);
});

test("reasoning effort is stable across agent turns, separates cache keys and survives restart", { timeout: 15000 }, async t => {
  const previous = process.env.TRANSLATION_REASONING_EFFORT;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSLATION_REASONING_EFFORT;
    else process.env.TRANSLATION_REASONING_EFFORT = previous;
  });
  process.env.TRANSLATION_REASONING_EFFORT = "high";
  const f = await fixture(t);
  const high = await f.worker.submitOrAttachJob(f.jobOptions);
  process.env.TRANSLATION_REASONING_EFFORT = "off";
  await high.taskPromise;
  assert.equal(high.status, "succeeded");
  assert.ok(f.requests.length > 1);
  for (const request of f.requests) {
    const payload = request as unknown as Record<string, unknown>;
    assert.equal(payload.reasoning_effort, "high");
    assert.equal(payload.max_completion_tokens, 16384);
    assert.equal(payload.temperature, undefined);
  }
  const highCalls = f.requests.length;
  const off = await f.worker.submitOrAttachJob(f.jobOptions); await off.taskPromise;
  assert.equal(off.status, "succeeded");
  assert.notEqual(off.jobKey, high.jobKey);
  for (const request of f.requests.slice(highCalls)) {
    const payload = request as unknown as Record<string, unknown>;
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.max_tokens, 16384);
  }
  process.env.TRANSLATION_REASONING_EFFORT = "medium";
  const medium = await f.worker.submitOrAttachJob(f.jobOptions); await medium.taskPromise;
  assert.equal(medium.status, "succeeded");
  assert.notEqual(medium.jobKey, high.jobKey);
  assert.notEqual(medium.jobKey, off.jobKey);
  const calls = f.requests.length;
  await f.restart();
  process.env.TRANSLATION_REASONING_EFFORT = "high";
  const restored = await f.worker.submitOrAttachJob(f.jobOptions);
  assert.equal(restored.jobId, high.jobId);
  assert.equal(restored.status, "succeeded");
  assert.equal(f.requests.length, calls);
});

test("restart resumes committed edits and tool conversation without repeating the write; browser credentials reattach", { timeout: 15000 }, async t => {
  const hold = gate(); t.after(hold.release); let paused = false;
  const f = await fixture(t, { intercept: async payload => {
    if (lastTool(payload)?.name === "write_file" && !paused) { paused = true; hold.reached(); await hold.pause; }
  } });
  const original = await f.worker.submitOrAttachJob(f.jobOptions); await hold.waiting;
  await f.restart(); hold.release();
  const restored = await f.worker.submitOrAttachJob(f.jobOptions);
  assert.equal(restored.jobId, original.jobId);
  const events = []; for await (const event of f.worker.observeJobStream(restored, { heartbeatIntervalMs: 1 })) events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  // Only the pending read-after-write provider turn is replayed, not the committed write request.
  assert.equal(f.requests.filter(r => lastTool(r)?.name === "read_file" && JSON.parse(lastTool(r)!.arguments).path === "source.json").length, 2);
  assert.equal(events.filter(e => e.type === "cue" && !e.provisional).length, 2);
});

test("long transcript is paginated and incrementally edited instead of requiring one giant model output", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const source = Array.from({ length: 230 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Sentence ${i} about database transactions.` }));
  const job = await f.worker.submitOrAttachJob({ ...f.jobOptions, cues: source }); await job.taskPromise;
  assert.equal(job.status, "succeeded"); assert.equal(job.finalResult?.cues.length, source.length);
  assert.ok(f.requests.filter(r => lastTool(r)?.name === "write_file").length >= 3);
});

test("real SSE agent uses an exact file edit to correct its draft before submitting", { timeout: 15000 }, async t => {
  let corrected = false;
  const f = await fixture(t, { intercept: async (payload, res) => {
    const last = lastTool(payload);
    if (!corrected && last?.name === "read_file" && JSON.parse(last.arguments).path === "translations.json") {
      corrected = true;
      sendAgentTools(res, [{ name: "edit_file", args: { path: "translations.json", edits: [{ old_text: "数据库事务：a", new_text: "该事务被拒绝了。" }] } }]);
      return true;
    }
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await job.taskPromise;
  assert.equal(job.status, "succeeded"); assert.equal(job.finalResult?.cues[0].translation, "该事务被拒绝了。");
  assert.equal(f.requests.some(r => lastTool(r)?.name === "edit_file"), true);
});

test("truncated streaming tool calls are never executed or saved", { timeout: 15000 }, async t => {
  const f = await fixture(t, { intercept: async (_payload, res) => {
    modelChunk(res, { tool_calls: [{ index: 0, id: "truncated", type: "function", function: {
      name: "write_file", arguments: JSON.stringify({ path: "translations.json", content: '{"a":"不应保存"}' }),
    } }] });
    endModelStream(res, "length"); return true;
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await job.taskPromise;
  assert.equal(job.status, "failed"); assert.equal(f.requests.length, 3);
  assert.equal(f.requests.every(r => r.messages.every(m => m.role !== "tool")), true);
  assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []);
});

test("a network failure after a saved edit retries the same turn without losing or replaying workspace writes", { timeout: 15000 }, async t => {
  let failed = false;
  const f = await fixture(t, { intercept: async (payload, res) => {
    if (!failed && lastTool(payload)?.name === "write_file") { failed = true; res.writeHead(502); res.end("private key body"); return true; }
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await job.taskPromise;
  assert.equal(job.status, "succeeded"); assert.equal(f.requests.length, 10);
  const doc = await f.worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, f.worker.context);
  assert.equal(doc?.network_attempts, 10); assert.equal(doc?.published_cues.a.translation, "数据库事务：a");
});

test("transient HTTP failures retry within the shared budget; persistent failures stop after two retries", { timeout: 15000 }, async t => {
  for (const failures of [[499, 502], [499, 499, 499, 499]]) await t.test(failures.length === 2 ? "transient" : "persistent", async t => {
    const persistent = failures.length === 4;
    const f = await fixture(t, { failures }); const job = await f.worker.submitOrAttachJob(f.jobOptions); await job.taskPromise;
    assert.equal(job.status, persistent ? "failed" : "succeeded");
    if (persistent) { assert.equal(f.requests.length, 3); assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []); }
    const doc = await f.worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, f.worker.context);
    assert.equal(doc?.network_attempts, f.requests.length); assert.equal(JSON.stringify(doc).includes("private provider"), false);
  });
});

test("budget exhaustion and chat-only pseudo-completion never publish partial translations", { timeout: 15000 }, async t => {
  for (const chatOnly of [false, true]) await t.test(chatOnly ? "chat-only" : "request-budget", async t => {
    const f = await fixture(t, chatOnly ? { intercept: async (_payload, res) => { sendModelJson(res, { done: true }); return true; } } : {});
    const job = await f.worker.submitOrAttachJob({ ...f.jobOptions, budgetLimit: chatOnly ? 3 : 1 }); await job.taskPromise;
    assert.equal(job.status, "failed"); assert.equal(f.requests.length, chatOnly ? 3 : 1);
    assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []);
  });
});

test("authentication failures do not retry or leak provider bodies; corrected credentials resume the same job", { timeout: 15000 }, async t => {
  const f = await fixture(t, { intercept: async (_payload, res, authorization) => {
    if (authorization === "Bearer bad-key") { res.writeHead(401); res.end("private bad-key provider response"); return true; }
  } });
  const failed = await f.worker.submitOrAttachJob({ ...f.jobOptions, apiKey: "bad-key" }); await failed.taskPromise;
  assert.equal(failed.status, "failed"); assert.equal(f.requests.length, 1);
  const events = []; for await (const event of f.worker.observeJobStream(failed)) events.push(event);
  assert.equal(events.at(-1)?.type, "error"); assert.doesNotMatch(JSON.stringify(events), /private|bad-key/);
  const retry = await f.worker.submitOrAttachJob(f.jobOptions); await retry.taskPromise;
  assert.equal(retry.jobId, failed.jobId); assert.notEqual(retry.taskId, failed.taskId);
  assert.equal(retry.status, "succeeded");
});

test("exhausted network retries preserve the workspace for manual continuation, including after restart", { timeout: 15000 }, async t => {
  for (const restart of [false, true]) await t.test(restart ? "after restart" : "same worker", async t => {
    let offline = true;
    const f = await fixture(t, { intercept: async (payload, res) => {
      const last = lastTool(payload);
      if (!payload.tools?.some(t => t.function.name === "dispatch_subagents") && last?.name === "read_file" && JSON.parse(last.arguments).path === "source.json") {
        sendAgentTools(res, [...scriptedAgentTools(payload), { name: "write_file", args: { path: "notes.md", content: "transaction=事务；已保存草稿" } }]);
        return true;
      }
      if (offline && last?.name === "write_file") { res.destroy(); return true; }
    } });
    const failed = await f.worker.submitOrAttachJob(f.jobOptions); await failed.taskPromise;
    assert.equal(failed.status, "failed"); assert.equal(f.requests.length, 7);
    const saved = await f.worker.harness!.snapshot(DocumentResumeDoc, failed.conversationId, f.worker.context);
    const child = (saved?.document?.children as unknown as { agent: { draft: unknown; revision: number; notes: string; messages: unknown } }[])[0].agent;
    assert.deepEqual(child.draft, { a: "数据库事务：a", b: "数据库事务：b" });
    assert.equal(child.revision, 1);
    assert.equal(child.notes, "transaction=事务；已保存草稿");
    assert.ok(Array.isArray(child.messages));
    assert.deepEqual((await f.worker.snapshotJob(failed)).published_cues, []);
    const failedEvents = []; for await (const event of f.worker.observeJobStream(failed)) failedEvents.push(event);
    assert.equal(failedEvents.at(-1)?.type, "error");
    if (restart) await f.restart();
    offline = false;
    const calls = f.requests.length;
    const [resumed, attached] = await Promise.all([
      f.worker.submitOrAttachJob(f.jobOptions), f.worker.submitOrAttachJob(f.jobOptions),
    ]);
    assert.equal(resumed, attached);
    assert.equal(resumed.jobId, failed.jobId); assert.equal(resumed.conversationId, failed.conversationId);
    assert.notEqual(resumed.taskId, failed.taskId);
    await resumed.taskPromise;
    assert.equal(resumed.status, "succeeded"); assert.equal(resumed.error, undefined);
    assert.equal(f.requests.length - calls, 5, "child read/check/submit and one main acceptance turn remain; committed writes must not repeat");
    assert.match(JSON.stringify(f.requests[calls].messages), /transaction=事务/);
    const doc = await f.worker.harness!.snapshot(SubtitleJobDoc, resumed.conversationId, f.worker.context);
    assert.equal(doc?.network_attempts, f.requests.length); assert.equal(doc?.error, undefined);
    assert.equal(doc?.failed_cues.length, 0);
    assert.equal((await f.worker.harness!.snapshot(DocumentResumeDoc, resumed.conversationId, f.worker.context))?.document, null);
    const events = []; for await (const event of f.worker.observeJobStream(resumed)) events.push(event);
    assert.equal(events.at(-1)?.type, "done"); assert.equal(events.filter(e => e.type === "cue" && !e.provisional).length, 2);
    for (const name of await fs.readdir(f.directory)) if (name.startsWith("state.db")) {
      assert.equal((await fs.readFile(`${f.directory}/${name}`)).includes(Buffer.from(f.jobOptions.apiKey)), false);
    }
  });
});

test("manual continuation cannot reset the shared budget; an explicitly raised budget preserves saved work", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const failed = await f.worker.submitOrAttachJob({ ...f.jobOptions, budgetLimit: 2 }); await failed.taskPromise;
  assert.equal(failed.status, "failed"); assert.equal(f.requests.length, 2);
  await assert.rejects(f.worker.submitOrAttachJob(f.jobOptions), /预算已耗尽/);
  assert.equal(f.requests.length, 2);
  const resumed = await f.worker.submitOrAttachJob({ ...f.jobOptions, budgetLimit: 20 }); await resumed.taskPromise;
  assert.equal(resumed.jobId, failed.jobId); assert.equal(resumed.status, "succeeded");
  assert.equal(f.requests.length, 9, "the main read and dispatch must not repeat");
});

test("explicit cancellation aborts live model I/O and never publishes saved but unsubmitted edits", { timeout: 15000 }, async t => {
  const hold = gate(); t.after(hold.release);
  const f = await fixture(t, { intercept: async payload => {
    if (lastTool(payload)?.name === "write_file") { hold.reached(); await hold.pause; }
  } });
  const job = await f.worker.submitOrAttachJob(f.jobOptions); await hold.waiting;
  await f.worker.abortJob(job.jobId); await job.taskPromise;
  assert.equal((await f.worker.snapshotJob(job)).status, "cancelled");
  assert.deepEqual((await f.worker.snapshotJob(job)).published_cues, []);
  const events = []; for await (const event of f.worker.observeJobStream(job)) events.push(event);
  assert.equal(events.at(-1)?.code, "task_cancelled"); hold.release();
  assert.equal((await f.worker.harness!.snapshot(DocumentResumeDoc, job.conversationId, f.worker.context))?.document, null);
  const fresh = await f.worker.submitOrAttachJob(f.jobOptions); await fresh.taskPromise;
  assert.notEqual(fresh.jobId, job.jobId); assert.equal(fresh.status, "succeeded");
});
