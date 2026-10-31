import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { AgentWorker } from "../worker/agent-worker.js";
import { DocumentResumeDoc } from "../worker/document-task.js";
import { DocumentModelError, modelConfig } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import {
  initialTranslationTeamState, advanceTranslationTeam, translationTeamTool, translationTeamPreviewCues, openingTarget,
} from "../worker/translation-team.js";
import type { TranslationTeamState } from "../worker/translation-team.js";
import { SubtitleJobDoc } from "../worker/task-definition.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { scriptedAgentTools, sendAgentTools, type AgentPayload } from "./support/subtitle-agent-model.js";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const source = Array.from({ length: 11 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Database transaction ${i}.` }));
function input(): DocumentInput {
  return { jobId: "stream", jobKey: "stream", videoId: "v", title: "Transactions", fromLang: "en", toLang: "zh-CN", cues: source, config: modelConfig(), budgetLimit: 0, streamOpening: true };
}
function plan() {
  return { brief: "transaction=事务; preserve negation and numbers.", opening: { end_id: "c1", instructions: "Translate the small opening promptly." },
    assignments: source.slice(2).map(c => ({ start_id: c.cue_id, end_id: c.cue_id, instructions: "Translate this semantic section." })) };
}
function response(name: string, args: unknown): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: 0, stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool", name, arguments: args as ToolCall["arguments"] }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function child(context: Context) {
  return JSON.parse((context.messages[1] as { content: string }).content) as { id: string; assignment: { start_id: string; end_id: string } };
}
function next(context: Context) {
  const m = child(context), turns = context.messages.filter(m => m.role === "assistant").length;
  if (!turns) {
    const start = source.findIndex(c => c.cue_id === m.assignment.start_id), end = source.findIndex(c => c.cue_id === m.assignment.end_id);
    return response("write_file", { path: "translations.json", content: JSON.stringify(Object.fromEntries(source.slice(start, end + 1).map(c => [c.cue_id, `事务：${c.cue_id}`]))) });
  }
  return response(turns === 1 ? "validate_translation" : "finish_translation", {});
}

test("opening plus nine remainder assignments are disjoint, cover everything, and cannot expose unsubmitted drafts", () => {
  const document = input(), state = initialTranslationTeamState(document);
  assert.throws(() => translationTeamTool(document, state, "dispatch_subagents", { ...plan(), opening: undefined }), /opening/);
  for (const p of [
    { ...plan(), opening: { ...plan().opening, end_id: "missing" } },
    { ...plan(), assignments: [{ ...plan().assignments[0], start_id: "c1" }, ...plan().assignments.slice(1)] },
    { ...plan(), assignments: plan().assignments.slice(1) },
    { ...plan(), assignments: [...plan().assignments, plan().assignments[0]] },
  ]) {
    assert.throws(() => translationTeamTool(document, state, "dispatch_subagents", p));
    assert.deepEqual(state.children, []);
  }
  translationTeamTool(document, state, "dispatch_subagents", plan());
  assert.equal(state.children.length, 10);
  assert.equal(state.children[0].id, "opening-agent");
  state.children[0].agent.draft = { c0: "还未提交", c1: "还未提交" };
  assert.deepEqual(translationTeamPreviewCues(document, state), []);

  const tiny = { ...document, cues: source.slice(0, 2) }, tinyState = initialTranslationTeamState(tiny);
  translationTeamTool(tiny, tinyState, "dispatch_subagents", { ...plan(), assignments: [] });
  assert.equal(tinyState.children.length, 1, "tiny jobs need only the dedicated opening agent");
});

test("opening scales with video length: a one-hour video opens with about the first ten minutes", () => {
  // 1 hour, one 3-second cue every 3 seconds -> 1200 cues.
  const hour = Array.from({ length: 1200 }, (_, i) => ({ cue_id: `h${i}`, start: i * 3000, end: i * 3000 + 2900, text: `Sentence ${i}.` }));
  const t = openingTarget(hour);
  assert.ok(Math.abs(t.target - 600_000) < 1000);
  assert.ok(hour[t.suggested].end >= t.target && hour[t.suggested - 1].end < t.target, "first cue reaching the 10-minute mark");
  assert.ok(hour[t.min].end >= 450_000 && hour[t.max].end <= 900_000 + 3000);
  const document = { ...input(), cues: hour }, state = initialTranslationTeamState(document);
  const dispatch = (end: number) => translationTeamTool(document, state, "dispatch_subagents", { brief: "b",
    opening: { end_id: hour[end].cue_id, instructions: "Translate the opening." },
    assignments: [{ start_id: hour[end + 1].cue_id, end_id: hour[1199].cue_id, instructions: "Translate the rest." }] });
  assert.throws(() => dispatch(19), /first 1\/6/, "a 60-second opening is far too small for an hour");
  assert.throws(() => dispatch(600), /first 1\/6/);
  dispatch(t.suggested);
  assert.equal(state.children[0].id, "opening-agent"); assert.equal(state.children[0].end_id, hour[t.suggested].cue_id);
  // Short videos still allow a small (up to ~30 cue) opening.
  assert.equal(openingTarget(source).min, 0); assert.equal(openingTarget(source).max, source.length - 1);
});

test("fast children advance and checkpoint multiple turns while a slow sibling is still in its first turn", { timeout: 5000 }, async t => {
  const document = input(), state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", plan());
  const slow = gate(), openingSaved = gate(); t.after(slow.release);
  const saved: TranslationTeamState[] = [];
  let active = 0, peak = 0, slowFinished = false;
  const running = advanceTranslationTeam(document, state, async context => {
    active++; peak = Math.max(peak, active);
    if (child(context).id === "subagent-1") { await slow.promise; slowFinished = true; }
    await new Promise(resolve => setImmediate(resolve));
    active--; return next(context);
  }, { signal: new AbortController().signal, save: async value => {
    saved.push(structuredClone(value));
    if (value.children[0].status === "completed") openingSaved.release();
  } });
  await openingSaved.promise;
  assert.equal(slowFinished, false);
  assert.equal(peak, 10, "dedicated opening is additional to nine normal agents");
  const checkpoint = saved.at(-1)!;
  assert.equal(checkpoint.children[0].agent.cursor, 3);
  assert.equal(checkpoint.children[1].agent.cursor, 0);
  assert.deepEqual(translationTeamPreviewCues(document, checkpoint).map(c => c.cue_id), ["c0", "c1"]);
  assert.equal(checkpoint.stage, "editing", "opening preview is not whole-document success");
  slow.release();
  const final = await running;
  assert.equal(final.children.every(c => c.status === "completed"), true);
  assert.equal(saved.length, 30, "every individual turn is checkpointed");
});

test("retry backoff only delays its own child; restart state skips already submitted children", { timeout: 5000 }, async () => {
  const document = input(), state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", plan());
  let failed = false, openingDuringBackoff = false;
  let checkpoint!: TranslationTeamState;
  await advanceTranslationTeam(document, state, async context => {
    if (child(context).id === "subagent-1" && !failed) { failed = true; throw new DocumentModelError(502, 100); }
    return next(context);
  }, { signal: new AbortController().signal, save: async value => {
    if (value.children[0].status === "completed" && value.children[1].failures === 1) {
      openingDuringBackoff = true; checkpoint = structuredClone(value);
    }
  } });
  assert.equal(openingDuringBackoff, true);
  checkpoint.children[1].retryAt = 0;
  const calls: string[] = [];
  const restored = await advanceTranslationTeam(document, JSON.parse(JSON.stringify(checkpoint)), async context => {
    calls.push(child(context).id); return next(context);
  });
  assert.equal(calls.includes("opening-agent"), false);
  assert.equal(restored.children.every(c => c.status === "completed"), true);
});

test("production worker streams opening before slow siblings, replays on reconnect and replaces it after main review", { timeout: 15000 }, async t => {
  let slow = gate();
  let failRemainder = false;
  let reviewEdited = false;
  const requests: AgentPayload[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const payload = JSON.parse(raw) as AgentPayload; requests.push(payload);
    const main = !!payload.tools?.some(tool => tool.function.name === "dispatch_subagents");
    const last = payload.messages.filter(m => m.role === "assistant" && m.tool_calls?.length).at(-1)?.tool_calls?.at(-1)?.function;
    if (!main) {
      const m = payload.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content || "{}" )).find(m => m.role === "subagent");
      if (m?.id !== "opening-agent") {
        await slow.promise;
        if (failRemainder) { res.writeHead(401); res.end("private-provider-body"); return; }
      }
    }
    if (main && last?.name === "read_file" && JSON.parse(last.arguments).path === "source.json") {
      sendAgentTools(res, [{ name: "dispatch_subagents", args: plan() }]);
    } else if (main && last?.name === "read_file" && JSON.parse(last.arguments).path === "translations.json" && !reviewEdited) {
      reviewEdited = true;
      sendAgentTools(res, [{ name: "edit_file", args: { path: "translations.json", edits: [{ old_text: '"c0": "数据库事务：c0"', new_text: '"c0": "最终统一术语"' }] } }]);
    } else sendAgentTools(res, scriptedAgentTools(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`, restore = trustModelEndpoint(baseUrl);
  const directory = await fs.mkdtemp("./tmp/streaming-team-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
  t.after(async () => { slow.release(); await worker.close(); restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  const options = { engine: "document", cues: source, baseUrl, apiKey: "private-streaming-key", budgetLimit: 200 };
  const job = await worker.submitOrAttachJob(options);
  const stream = worker.observeJobStream(job, { heartbeatIntervalMs: 1 });
  const early = [];
  for await (const event of stream) {
    early.push(event);
    if (early.filter(e => e.type === "cue").length === 2) break;
  }
  assert.deepEqual(early.filter(e => e.type === "cue").map(e => [e.index, e.cue_id, e.provisional]), [[0, "c0", true], [1, "c1", true]]);
  assert.equal(early.some(e => e.type === "done"), false);
  const doc = await worker.harness!.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
  assert.equal(doc?.status, "running"); assert.equal(doc?.final_result, null);
  assert.deepEqual(doc?.published_cues, {});
  assert.equal(Object.keys(doc?.preview_cues || {}).length, 2);

  // Shut down with nine in-flight siblings. The submitted opening and each saved
  // tool turn must survive; only unfinished provider turns may be replayed.
  await worker.close();
  const openingRequests = () => requests.filter(r => r.messages.some(m => {
    if (m.role !== "user") return false;
    try { const value = JSON.parse(m.content || "{}"); return value.role === "subagent" && value.id === "opening-agent"; }
    catch { return false; }
  })).length;
  const before = openingRequests();
  worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
  const restored = await worker.submitOrAttachJob(options);
  assert.equal(restored.jobId, job.jobId);
  const reconnected = worker.observeJobStream(restored, { heartbeatIntervalMs: 1 });
  const replay = [];
  while (replay.filter(e => e.type === "cue").length < 2) replay.push((await reconnected.next()).value!);
  assert.equal(replay[0].completed_cues, 2);
  assert.ok(replay.filter(e => e.type === "cue").every(e => e.cached && e.provisional));
  assert.equal(restored.status, "running");
  slow.release(); await restored.taskPromise;
  const rest = []; for await (const event of reconnected) rest.push(event);
  assert.equal(rest.at(-1)?.type, "done");
  const final = rest.filter(e => e.type === "cue");
  assert.equal(final.length, source.length); assert.ok(final.every(e => e.provisional === false));
  assert.equal(final[0].index, 0); assert.equal(final[0].translation, "最终统一术语");
  assert.equal(openingRequests(), before, "submitted opening was not translated again after restart");
  assert.equal((await worker.snapshotJob(restored)).status, "succeeded");
  const saved = await worker.harness!.snapshot(DocumentResumeDoc, restored.conversationId, worker.context);
  assert.equal(saved?.document, null);

  // An explicit cancellation removes the provisional result and the continuation
  // checkpoint, and interrupts all independent model calls rather than joining
  // an indefinitely blocked sibling.
  slow = gate();
  const cancelled = await worker.submitOrAttachJob({ ...options, videoId: "cancel-preview" });
  const cancellingStream = worker.observeJobStream(cancelled, { heartbeatIntervalMs: 1 });
  let previews = 0;
  for await (const event of cancellingStream) {
    if (event.type === "cue" && event.provisional && ++previews === 2) break;
  }
  assert.equal(await worker.abortJob(cancelled.jobId), true);
  await cancelled.taskPromise;
  const cancelledDoc = await worker.harness!.snapshot(SubtitleJobDoc, cancelled.conversationId, worker.context);
  assert.equal(cancelledDoc?.status, "cancelled");
  assert.deepEqual(cancelledDoc?.preview_cues, {});
  assert.deepEqual(cancelledDoc?.published_cues, {});
  const cancelledSaved = await worker.harness!.snapshot(DocumentResumeDoc, cancelled.conversationId, worker.context);
  assert.equal(cancelledSaved?.document, null);
  slow.release();

  // A later failure must retain the latest independent checkpoints and replay
  // only the self-checked opening, never report the whole document as done.
  slow = gate(); failRemainder = true;
  const failureOptions = { ...options, videoId: "failed-preview" };
  const failing = await worker.submitOrAttachJob(failureOptions);
  const failureStream = worker.observeJobStream(failing, { heartbeatIntervalMs: 1 });
  let shown = 0;
  for await (const event of failureStream) {
    if (event.type === "cue" && event.provisional && ++shown === 2) { slow.release(); }
    if (event.type === "done") assert.fail("incomplete translation must not emit done");
    if (event.type === "error") break;
  }
  await failing.taskPromise;
  const failedDoc = await worker.harness!.snapshot(SubtitleJobDoc, failing.conversationId, worker.context);
  assert.equal(failedDoc?.status, "failed");
  assert.equal(Object.keys(failedDoc?.preview_cues || {}).length, 2);
  assert.deepEqual(failedDoc?.published_cues, {});
  const failedSaved = await worker.harness!.snapshot(DocumentResumeDoc, failing.conversationId, worker.context);
  const team = failedSaved?.document as unknown as TranslationTeamState;
  assert.equal(team.children[0].status, "completed");
  assert.equal(team.children[0].agent.draft.c0, "数据库事务：c0");
  const previousOpeningRequests = openingRequests();
  failRemainder = false;
  const retried = await worker.submitOrAttachJob(failureOptions); await retried.taskPromise;
  assert.equal(retried.jobId, failing.jobId);
  assert.equal(retried.status, "succeeded");
  assert.equal(openingRequests(), previousOpeningRequests, "manual continuation retains submitted opening");
});
