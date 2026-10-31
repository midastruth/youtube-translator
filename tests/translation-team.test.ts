import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import {
  stepTranslationTeam as advanceTranslationTeam, finalTranslationTeamCues, initialTranslationTeamState,
  translationTeamTool, translationTeamReasoning, translationTeamModelConfig, translationTeamProgress, MAX_SUBAGENTS,
} from "../worker/translation-team.js";
import { DocumentModelError, modelConfig } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { SubtitleJobDoc } from "../worker/task-definition.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { scriptedAgentTools, sendAgentTools, type AgentPayload } from "./support/subtitle-agent-model.js";

const source = Array.from({ length: 9 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Database transaction ${i}.` }));
function input(): DocumentInput {
  return { jobId: "team", jobKey: "team", videoId: "v", title: "Database transactions", fromLang: "en", toLang: "zh-CN", cues: source, config: modelConfig(), budgetLimit: 128 };
}
function response(name: string, args: unknown): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: 0, stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool", name, arguments: args as ToolCall["arguments"] }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function dispatch(document = input(), opening = false) {
  return { brief: "Concise technical subtitles; transaction=事务; preserve numbers and negation.",
    ...(opening ? { opening: { end_id: document.cues[0].cue_id, instructions: "Translate the opening promptly for viewing." } } : {}),
    assignments: document.cues.slice(opening ? 1 : 0).map(c => ({ start_id: c.cue_id, end_id: c.cue_id, instructions: "Translate using the shared terminology." })) };
}
function manifest(context: Context) {
  return JSON.parse((context.messages[1] as { content: string }).content) as { id: string; shared_brief: string; assignment: { start_id: string } };
}

test("role reasoning inherits global settings, validates overrides and never changes restored inputs", () => {
  const names = ["TRANSLATION_MAIN_REASONING_EFFORT", "TRANSLATION_SUBAGENT_REASONING_EFFORT"] as const;
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    const config = modelConfig({ reasoningEffort: "low" });
    assert.deepEqual(translationTeamReasoning(config), { main: "low", subagent: "low" });
    process.env.TRANSLATION_MAIN_REASONING_EFFORT = "high";
    process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "medium";
    const document = { ...input(), config, teamReasoning: translationTeamReasoning(config) };
    process.env.TRANSLATION_MAIN_REASONING_EFFORT = "off";
    process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "off";
    const restored = JSON.parse(JSON.stringify(document)) as DocumentInput;
    assert.equal(translationTeamModelConfig(restored, "main").reasoningEffort, "high");
    assert.equal(translationTeamModelConfig(restored, "subagent").reasoningEffort, "medium");
    assert.deepEqual(translationTeamReasoning(config), { main: "off", subagent: "off" });
    delete restored.teamReasoning;
    assert.equal(translationTeamModelConfig(restored, "main").reasoningEffort, "low");
    assert.equal(translationTeamModelConfig(restored, "subagent").reasoningEffort, "low");
    delete restored.config.reasoningEffort;
    assert.equal(translationTeamModelConfig(restored, "main").reasoningEffort, "off");
    for (const name of names) {
      process.env[name] = "invalid-private-value";
      assert.throws(() => translationTeamReasoning(config), error => {
        assert.ok(error instanceof Error); assert.match(error.message, new RegExp(name));
        assert.doesNotMatch(error.message, /invalid-private-value/); return true;
      });
      process.env[name] = "";
    }
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});

test("main dispatch validates exact ordered coverage and hard cap of nine, atomically", () => {
  const document = input(), state = initialTranslationTeamState(document), plan = dispatch(document);
  for (const assignments of [[], [...plan.assignments, plan.assignments[0]], plan.assignments.slice(1), [...plan.assignments].reverse(), [{ ...plan.assignments[0], end_id: "missing" }]]) {
    assert.throws(() => translationTeamTool(document, state, "dispatch_subagents", { ...plan, assignments }));
    assert.deepEqual(state.children, []);
  }
  assert.throws(() => translationTeamTool(document, state, "finish_translation", {}));
  assert.throws(() => translationTeamTool(document, state, "accept_translation", { review: "unchecked" }));
  assert.throws(() => translationTeamTool(document, state, "write_file", { path: "translations.json", content: '{"c0":"事务"}' }));
  translationTeamTool(document, state, "dispatch_subagents", plan);
  assert.equal(state.children.length, MAX_SUBAGENTS);
  assert.throws(() => translationTeamTool(document, state, "dispatch_subagents", plan));
});

test("nine independent children run concurrently, share brief, read global context but cannot write each other's IDs", async () => {
  const document = input(); let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", dispatch());
  let active = 0, peak = 0;
  state = await advanceTranslationTeam(document, state, async context => {
    const task = manifest(context);
    assert.match(task.shared_brief, /transaction=事务/);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return response("read_context", { query: "transaction 8" });
  });
  assert.equal(peak, 9);
  for (const child of state.children) assert.match(JSON.stringify(child.agent.messages.at(-1)), /c8/);
  state = await advanceTranslationTeam(document, state, async context => response("write_file", { path: "translations.json", content: JSON.stringify({ [manifest(context).assignment.start_id === "c0" ? "c1" : "c0"]: "越界" }) }));
  for (const child of state.children) {
    assert.deepEqual(child.agent.draft, {});
    assert.equal(child.agent.messages.at(-1)?.role, "toolResult");
    assert.match(JSON.stringify(child.agent.messages.at(-1)), /Unknown cue ID/);
  }
  state = await advanceTranslationTeam(document, state, async context => response("write_file", { path: "translations.json", content: JSON.stringify({ [manifest(context).assignment.start_id]: "事务" }) }));
  assert.deepEqual(state.draft, {}, "unsubmitted child drafts must not be merged");
  assert.match(translationTeamProgress(document, state), /已保存草稿 9\/9（未发布），Subagent 已提交 0\/9/);
  state = await advanceTranslationTeam(document, state, async () => response("validate_translation", {}));
  state = await advanceTranslationTeam(document, state, async () => response("finish_translation", {}));
  assert.equal(Object.keys(state.draft).length, 9);
  assert.equal(state.children.every(c => c.status === "completed"), true);
  assert.throws(() => translationTeamTool(document, state, "close_subagents", {}));
  assert.throws(() => translationTeamTool(document, state, "finish_translation", {}));
  translationTeamTool(document, state, "accept_translation", { review: "Checked all sections and consistent 事务 terminology." });
  translationTeamTool(document, state, "edit_file", { path: "translations.json", edits: [{ old_text: '"c0": "事务"', new_text: '"c0": "数据库事务"' }] });
  assert.throws(() => translationTeamTool(document, state, "close_subagents", {}), "edits invalidate acceptance");
  translationTeamTool(document, state, "accept_translation", { review: "Rechecked updated wording and all boundary cues." });
  translationTeamTool(document, state, "close_subagents", {});
  assert.equal(state.children.every(c => c.status === "closed" && !c.agent.messages.length), true);
  translationTeamTool(document, state, "validate_translation", {});
  translationTeamTool(document, state, "finish_translation", {});
  assert.deepEqual(finalTranslationTeamCues(document, state).map(c => [c.cue_id, c.start, c.end]), source.map(c => [c.cue_id, c.start, c.end]));
});

test("progress distinguishes saved drafts, submitted agents, review and publication without exposing text", () => {
  const document = input(), state = initialTranslationTeamState(document);
  assert.match(translationTeamProgress(document, state), /主 Agent 规划.*0\/9.*已完成 0 轮/);
  translationTeamTool(document, state, "dispatch_subagents", dispatch());
  state.children[0].agent.draft = { c0: "private draft text" };
  state.children[1].agent.draft = { c1: "private draft text" };
  state.cursor = 3;
  let progress = translationTeamProgress(document, state);
  assert.match(progress, /并行翻译中，已保存草稿 2\/9（未发布），Subagent 已提交 0\/9，已完成 3 轮/);
  assert.doesNotMatch(progress, /private draft text/);
  assert.deepEqual(state.draft, {}, "progress must not merge unsubmitted drafts");

  state.children[0].status = "completed";
  state.draft.c0 = "merged translation";
  assert.match(translationTeamProgress(document, state), /已保存草稿 2\/9.*已提交 1\/9/, "merged and child copies are not double counted");
  state.children[1].failures = 1;
  state.children[2].failures = 3;
  state.children[3].failures = 1; state.children[3].terminal = true;
  progress = translationTeamProgress(document, state);
  assert.match(progress, /Subagent 失败 2，Subagent 重试中 1/);

  for (const child of state.children) child.status = "closed";
  delete state.draft.c0;
  assert.match(translationTeamProgress(document, state), /主 Agent 验收，已合并 0\/9.*已提交 9\/9/, "review uses main edits, not stale child copies");
  state.stage = "publish";
  assert.match(translationTeamProgress(document, state), /^正在发布/);
});

test("child context compaction retains assignment, shared terminology, notes and saved translations", async () => {
  const document = input();
  document.config = modelConfig({ contextTokens: 24000, outputTokens: 1024 });
  let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", dispatch(document));
  state.children[0].agent.notes = "Checked later definitions; transaction means database transaction.";
  state.children[0].agent.draft = { c0: "数据库事务" };
  const old = response("read_file", { path: "source.json" });
  old.content = [{ type: "text", text: "long history ".repeat(10000) }];
  state.children[0].agent.messages = [old];
  state = await advanceTranslationTeam(document, state, async context => {
    const task = manifest(context);
    if (task.id === "subagent-1") {
      assert.match(JSON.stringify(context), /transaction=事务/);
      assert.match(JSON.stringify(context), /Checked later definitions/);
      assert.equal(task.assignment.start_id, "c0");
      assert.doesNotMatch(JSON.stringify(context), /long history/);
    }
    return response("read_file", { path: "translations.json" });
  });
  assert.equal(state.children[0].agent.compactions, 1);
  assert.equal(state.children[0].agent.draft.c0, "数据库事务");
});

test("one failed child retains siblings' committed work and retries only its own turn", async () => {
  const document = input(); let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", dispatch());
  state = await advanceTranslationTeam(document, state, async context => {
    const task = manifest(context);
    if (task.id === "subagent-1") throw new DocumentModelError(502, 1000);
    return response("write_file", { path: "translations.json", content: JSON.stringify({ [task.assignment.start_id]: "事务" }) });
  });
  assert.equal(state.children[0].failures, 1);
  assert.equal(state.children[1].agent.revision, 1);
  const restored = JSON.parse(JSON.stringify(state));
  restored.children[0].retryAt = 0;
  state = await advanceTranslationTeam(document, restored, async context => {
    const task = manifest(context);
    return task.id === "subagent-1" ? response("write_file", { path: "translations.json", content: '{"c0":"事务"}' }) : response("validate_translation", {});
  });
  assert.equal(state.children[0].agent.revision, 1);
  assert.equal(state.children[0].failures, 0);
  assert.equal(state.children[1].agent.revision, 1, "successful sibling writes were not replayed");
  assert.equal(state.children[1].agent.validatedRevision, 1);
});

test("durable HTTP workflow runs nine concurrent model sessions, enforces aggregate budget, resumes and publishes only after main acceptance", { timeout: 15000 }, async t => {
  const names = ["TRANSLATION_MAIN_REASONING_EFFORT", "TRANSLATION_SUBAGENT_REASONING_EFFORT", "TRANSLATION_REQUEST_BUDGET"] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  process.env.TRANSLATION_MAIN_REASONING_EFFORT = "high";
  process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "medium";
  const settings: { main: boolean; effort: unknown; cap: unknown; temperature: unknown }[] = [];
  let active = 0, peak = 0, requests = 0;
  // Keep the first wave open until all nine children have arrived. SQLite
  // reservations may stagger arrivals; a fixed 10ms window measures timing,
  // not whether child model calls can actually overlap.
  let releaseFirstWave!: () => void;
  const firstWave = new Promise<void>(resolve => { releaseFirstWave = resolve; });
  let firstWaveComplete = false;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as AgentPayload;
    requests++;
    const main = !!payload.tools?.some(t => t.function.name === "dispatch_subagents");
    const wire = payload as unknown as Record<string, unknown>;
    settings.push({ main, effort: wire.reasoning_effort, cap: wire.max_completion_tokens, temperature: wire.temperature });
    if (!main && !firstWaveComplete) {
      active++; peak = Math.max(peak, active);
      if (active === 9) { firstWaveComplete = true; releaseFirstWave(); }
      await firstWave;
      active--;
    }
    const tools = main && payload.messages.some(m => m.role === "tool") && !payload.messages.some(m => m.tool_calls?.some(c => c.function.name === "dispatch_subagents"))
      ? [{ name: "dispatch_subagents", args: dispatch(input(), true) }] : scriptedAgentTools(payload);
    sendAgentTools(res, tools);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const restore = trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`);
  const directory = await fs.mkdtemp("./tmp/team-integration-");
  let worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
  t.after(async () => { await worker.close(); restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  process.env.TRANSLATION_REQUEST_BUDGET = "15";
  const options = { engine: "document", cues: source, apiKey: "private-team-key", baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const failed = await worker.submitOrAttachJob(options);
  process.env.TRANSLATION_MAIN_REASONING_EFFORT = "off";
  process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "off";
  await failed.taskPromise;
  assert.equal(failed.status, "failed");
  assert.equal(requests, 15, "all children and main share a single hard request budget");
  assert.equal(peak, 9);
  assert.deepEqual((await worker.snapshotJob(failed)).published_cues, []);
  assert.match(String(failed.error), /已用 15 次，上限 15 次.*共享.*TRANSLATION_REQUEST_BUDGET/);
  process.env.TRANSLATION_MAIN_REASONING_EFFORT = "high";
  process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "medium";
  await assert.rejects(worker.submitOrAttachJob(options), /预算已耗尽/);
  assert.equal(requests, 15, "manual retry cannot reset the budget");
  await worker.close(); worker = new AgentWorker({ storagePath: `${directory}/state.db` }); await worker.start();
  process.env.TRANSLATION_MAIN_REASONING_EFFORT = "high";
  process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "medium";
  process.env.TRANSLATION_REQUEST_BUDGET = "0";
  const resumed = await worker.submitOrAttachJob(options); await resumed.taskPromise;
  assert.equal(resumed.jobId, failed.jobId);
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.finalResult?.cues.length, 9);
  const doc = await worker.harness!.snapshot(SubtitleJobDoc, resumed.conversationId, worker.context);
  assert.equal(doc?.network_attempts, requests);
  assert.equal(doc?.budget_limit, 0, "disabling the limit resumes saved work without resetting usage");
  assert.equal(peak, 9);
  const before = requests;
  assert.equal((await worker.submitOrAttachJob({ ...options, budgetLimit: 100 })).status, "succeeded");
  assert.equal(requests, before);
  assert.ok(settings.some(s => s.main) && settings.some(s => !s.main));
  for (const setting of settings) {
    assert.equal(setting.effort, setting.main ? "high" : "medium");
    assert.equal(setting.cap, 16384); assert.equal(setting.temperature, undefined);
  }
  process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT = "low";
  const low = await worker.submitOrAttachJob({ ...options, budgetLimit: 100 }); await low.taskPromise;
  assert.equal(low.status, "succeeded"); assert.notEqual(low.jobKey, resumed.jobKey);
  for (const setting of settings.slice(before)) assert.equal(setting.effort, setting.main ? "high" : "low");
  const highStart = settings.length;
  process.env.TRANSLATION_MAIN_REASONING_EFFORT = "medium";
  const mediumMain = await worker.submitOrAttachJob({ ...options, budgetLimit: 100 }); await mediumMain.taskPromise;
  assert.equal(mediumMain.status, "succeeded"); assert.notEqual(mediumMain.jobKey, low.jobKey);
  for (const setting of settings.slice(highStart)) assert.equal(setting.effort, setting.main ? "medium" : "low");
  for (const name of await fs.readdir(directory)) if (name.startsWith("state.db")) assert.equal((await fs.readFile(`${directory}/${name}`)).includes(Buffer.from(options.apiKey)), false);
});
