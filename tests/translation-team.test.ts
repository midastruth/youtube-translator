import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import {
  stepTranslationTeam as advanceTranslationTeam, finalTranslationTeamCues, initialTranslationTeamState,
  translationTeamTool, translationTeamReasoning, translationTeamModelConfig, translationTeamProgress, translationTeamPreviewCues, MAX_SUBAGENTS,
} from "../worker/translation-team.js";
import { DocumentModelError, inputBudget, modelConfig, outputBudget, outputEstimate, tokenEstimate } from "../worker/document-translation.js";
import { subtitleAgentTool, MAX_READ_CUES } from "../worker/subtitle-agent.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { SubtitleJobDoc } from "../worker/job-document.js";
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
  return JSON.parse((context.messages[1] as { content: string }).content) as {
    id: string; shared_brief: string; assignment: { start_id: string };
    initial_source_page: { path: string; offset: number; content: DocumentInput["cues"]; next_offset: number | null; total_cues: number };
  };
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

test("children translate preloaded source on their first turn, then inspect saved translations and validate before submission", async () => {
  const document = input(); let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", { brief: dispatch().brief, assignments: [
    { start_id: "c0", end_id: "c2", instructions: "Translate the first section." },
    { start_id: "c3", end_id: "c8", instructions: "Translate the remaining section." },
  ] });
  const firstRoles = new Map<string, ReturnType<typeof manifest>>();
  const turns = new Map<string, number>();
  const call = async (context: Context) => {
    const task = manifest(context), page = task.initial_source_page;
    const turn = (turns.get(task.id) || 0) + 1; turns.set(task.id, turn);
    assert.match(context.systemPrompt!, /Do not skip semantic self-review/);
    assert.match(context.systemPrompt!, /Avoid routine notes\/progress writes and redundant reads/);
    const expected = task.id === "subagent-1" ? document.cues.slice(0, 3) : document.cues.slice(3);
    assert.deepEqual(page, { path: "source.json", offset: 0, content: expected, next_offset: null, total_cues: expected.length });
    if (turn === 1) {
      firstRoles.set(task.id, structuredClone(task));
      assert.equal(context.messages.some(m => m.role === "toolResult"), false);
      return response("write_file", { path: "translations.json", merge: true, content: JSON.stringify(Object.fromEntries(page.content.map(c => [c.cue_id, `数据库事务 ${c.cue_id}.`]))) });
    }
    assert.deepEqual(task, firstRoles.get(task.id), "preload must remain stable, including after saved-state recovery");
    if (turn === 2) return response("read_file", { path: "translations.json", count: MAX_READ_CUES });
    if (turn === 3) {
      const saved = context.messages.at(-2);
      assert.equal(saved?.role, "toolResult");
      if (saved?.role !== "toolResult") assert.fail("missing saved translation inspection");
      const result = JSON.parse((saved.content[0] as { text: string }).text);
      assert.deepEqual(Object.keys(JSON.parse(result.content)), expected.map(c => c.cue_id));
      return response("validate_translation", {});
    }
    return response("finish_translation", {});
  };
  state = await advanceTranslationTeam(document, state, call);
  assert.deepEqual(state.draft, {}, "a first-turn write is not submission or publication");
  for (const child of state.children) {
    const assigned = { ...document, cues: child.id === "subagent-1" ? document.cues.slice(0, 3) : document.cues.slice(3) };
    assert.throws(() => subtitleAgentTool(assigned, child.agent, "finish_translation", {}), /validate_translation/);
  }
  state = JSON.parse(JSON.stringify(state));
  for (let i = 0; i < 3; i++) state = await advanceTranslationTeam(document, state, call);
  assert.deepEqual([...turns.values()], [4, 4], "write, semantic inspection, validate, submit: no initial source-read turn");
  assert.ok(state.children.every(c => c.status === "completed"));
  assert.equal(Object.keys(state.draft).length, document.cues.length);
  assert.throws(() => finalTranslationTeamCues(document, state), /accepted and closed/, "main acceptance remains mandatory");
});

test("preloaded source is bounded by page, input and output budgets and paginates using assignment-local offsets", async () => {
  const cues = Array.from({ length: 450 }, (_, i) => ({ cue_id: `p${i}`, start: i * 1000, end: i * 1000 + 900, text: "x" }));
  for (const config of [modelConfig(), modelConfig({ contextTokens: 24000, outputTokens: 1024 }), modelConfig({ contextTokens: 24000, outputTokens: 8192 })]) {
    const document = { ...input(), cues, config }; let state = initialTranslationTeamState(document);
    translationTeamTool(document, state, "dispatch_subagents", { brief: dispatch().brief, assignments: [
      { start_id: "p0", end_id: "p9", instructions: "Translate intro." },
      { start_id: "p10", end_id: "p449", instructions: "Translate remaining passage." },
    ] });
    let length = 0;
    state = await advanceTranslationTeam(document, state, async context => {
      const task = manifest(context), page = task.initial_source_page;
      const offset = task.id === "subagent-1" ? 0 : 10;
      assert.ok(page.content.length > 0 && page.content.length <= MAX_READ_CUES);
      assert.deepEqual(page.content, cues.slice(offset, offset + page.content.length));
      assert.equal(page.total_cues, offset ? 440 : 10);
      assert.ok(tokenEstimate(page) <= inputBudget(config) * 0.2);
      assert.ok(outputEstimate(page.content) <= outputBudget(config));
      assert.ok(tokenEstimate(context) <= inputBudget(config));
      if (offset) {
        length = page.content.length;
        if (config.contextTokens === 128000) assert.equal(length, MAX_READ_CUES);
        assert.equal(page.next_offset, length);
        return response("read_file", { path: "source.json", offset: page.next_offset, count: MAX_READ_CUES });
      }
      return response("read_file", { path: "source.json", count: 1 });
    });
    const read = state.children[1].agent.messages.at(-1);
    assert.equal(read?.role, "toolResult");
    if (read?.role !== "toolResult") assert.fail("missing subsequent source page");
    const result = JSON.parse((read.content[0] as { text: string }).text);
    assert.equal(JSON.parse(result.content)[0].cue_id, cues[10 + length].cue_id);
    if (config.contextTokens === 24000) assert.ok(length < MAX_READ_CUES, "tight input or output budgets must shrink the preload");
  }
});

test("oversized preload cues fall back to source reads without breaking a valid child context", async () => {
  const document = { ...input(), config: modelConfig({ contextTokens: 24000, outputTokens: 1024 }), cues: [{ ...source[0], text: "x".repeat(4000) }] };
  let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", { brief: dispatch().brief, assignments: [{ start_id: "c0", end_id: "c0", instructions: "Translate this long cue." }] });
  state = await advanceTranslationTeam(document, state, async context => {
    const page = manifest(context).initial_source_page;
    assert.deepEqual(page.content, []);
    assert.equal(page.next_offset, 0);
    assert.ok(tokenEstimate(context) <= inputBudget(document.config));
    return response("read_file", { path: "source.json", offset: 0, count: 1 });
  });
  assert.equal(state.children[0].failures, 0);
  const result = state.children[0].agent.messages.at(-1);
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") assert.equal(result.isError, false);
});

test("submitted sections preview immediately; main review gets a checklist, reads bilingually and finishes in one turn", async () => {
  const document = input(); let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", { brief: "transaction = 事务; preserve numbers.", assignments: [
    { start_id: "c0", end_id: "c3", instructions: "First half." }, { start_id: "c4", end_id: "c8", instructions: "Second half." },
  ] });
  assert.throws(() => translationTeamTool(document, state, "review_checklist", {}), /Wait for all subagents/);
  const translate = (id: string) => id === "c5" ? "交易 5。" : `数据库事务 ${id.slice(1)}。`;
  const childTurn = async (context: Context) => {
    const task = manifest(context), page = task.initial_source_page.content;
    const turn = context.messages.filter(m => m.role === "assistant").length;
    if (task.id === "subagent-2" && turn === 0) return response("read_context", { query: "transaction" }); // slower sibling
    if (turn === 0 || (task.id === "subagent-2" && turn === 1)) return response("write_file", { path: "translations.json", content: JSON.stringify(Object.fromEntries(page.map(c => [c.cue_id, translate(c.cue_id)]))) });
    const written = turn - (task.id === "subagent-2" ? 1 : 0);
    return response(written === 1 ? "validate_translation" : "finish_translation", {});
  };
  for (let i = 0; i < 3; i++) state = await advanceTranslationTeam(document, state, childTurn);
  assert.deepEqual(state.children.map(c => c.status), ["completed", "running"]);
  assert.deepEqual(translationTeamPreviewCues(document, state).map(c => [c.index, c.cue_id]), [[0, "c0"], [1, "c1"], [2, "c2"], [3, "c3"]],
    "a submitted non-opening section is visible before its slower sibling finishes");
  assert.match(translationTeamProgress(document, state), /已可先观看 4 条/);
  assert.equal(state.messages.length, 0, "no checklist before every child completes");
  state = await advanceTranslationTeam(document, state, childTurn);
  assert.ok(state.children.every(c => c.status === "completed"));
  assert.equal(translationTeamPreviewCues(document, state).length, 9);

  // The checklist is in the main history (and therefore the persisted checkpoint).
  const checklist = JSON.parse((state.messages.at(-1) as { content: string }).content);
  assert.equal(checklist.type, "review_checklist");
  assert.deepEqual(checklist.flagged.map((f: { cue_id: string }) => f.cue_id), ["c5"]);
  assert.match(checklist.flagged[0].issues.join(), /"transaction" expected "事务"/);
  assert.deepEqual(checklist.boundaries.map((b: { rows: string[][] }) => b.rows.map(r => r[0])), [["c1", "c2", "c3", "c4", "c5", "c6"]]);

  const turns: Context[] = [];
  const mainTurn = async (context: Context) => {
    turns.push(structuredClone(context));
    if (turns.length === 1) {
      assert.ok(context.tools!.some(t => t.name === "read_bilingual") && context.tools!.some(t => t.name === "review_checklist"));
      assert.match(JSON.stringify(context.messages), /review_checklist/);
      return response("read_bilingual", { offset: 0, count: 400 });
    }
    if (turns.length === 2) return response("edit_file", { path: "translations.json", edits: [{ old_text: '"c5": "交易 5。"', new_text: '"c5": "数据库事务 5。"' }] });
    if (turns.length === 3) return response("review_checklist", {});
    const calls = ["accept_translation", "close_subagents", "validate_translation", "finish_translation"].map((name, i) => ({
      type: "toolCall" as const, id: `t${i}`, name, arguments: (name === "accept_translation" ? { review: "Fixed c5 terminology; boundaries and numbers consistent." } : {}) as ToolCall["arguments"] }));
    return { ...response("noop", {}), content: calls };
  };
  state = await advanceTranslationTeam(document, state, mainTurn);
  const bilingual = JSON.parse((state.messages.at(-1) as { content: { text: string }[] }).content[0].text);
  assert.equal(bilingual.rows.length, 9); assert.deepEqual(bilingual.rows[5], ["c5", source[5].text, "交易 5。"]);
  state = await advanceTranslationTeam(document, state, mainTurn);
  assert.equal(translationTeamPreviewCues(document, state)[5].translation, "数据库事务 5。", "main corrections refresh the provisional preview");
  state = await advanceTranslationTeam(document, state, mainTurn);
  const recheck = JSON.parse((state.messages.at(-1) as { content: { text: string }[] }).content[0].text);
  assert.equal(recheck.flagged_total, 0);
  state = await advanceTranslationTeam(document, state, mainTurn);
  assert.equal(state.stage, "publish", "acceptance, closing, validation and submission complete in one model turn");
  assert.equal(turns.length, 4);
  assert.equal(finalTranslationTeamCues(document, state)[5].translation, "数据库事务 5。");
});

test("main and child prompts keep a stable cacheable prefix; live team status trails and agents get distinct cache keys", async () => {
  const document = input(); let state = initialTranslationTeamState(document);
  translationTeamTool(document, state, "dispatch_subagents", dispatch());
  const seen = new Map<string, Context[]>();
  const record = async (context: Context, key?: string) => {
    seen.set(key!, [...(seen.get(key!) || []), structuredClone(context)]);
    return response("read_context", { query: "transaction" });
  };
  state = await advanceTranslationTeam(document, state, record);
  state = await advanceTranslationTeam(document, state, record);
  assert.equal(seen.size, 9);
  for (const [key, [first, second]] of seen) {
    assert.match(key, /^subagent-/);
    assert.deepEqual(second.messages.slice(0, first.messages.length - 1), first.messages.slice(0, -1));
    assert.equal(JSON.parse((second.messages.at(-1) as { content: string }).content).type, "workspace_status");
  }
  // Main agent: live subagent status lives in the trailing message, not the role prefix.
  for (const child of state.children) child.status = "completed";
  const main: Context[] = [];
  state = await advanceTranslationTeam(document, state, async (context, key) => { assert.equal(key, "main"); main.push(structuredClone(context)); return response("read_file", { path: "notes.md", count: 10 }); });
  state.children[0].agent.draft = { c0: "x" };
  state = await advanceTranslationTeam(document, state, async context => { main.push(structuredClone(context)); return response("read_file", { path: "notes.md", count: 10 }); });
  assert.deepEqual(main[1].messages.slice(0, main[0].messages.length - 1), main[0].messages.slice(0, -1));
  assert.doesNotMatch(JSON.stringify(main[1].messages[1]), /"status"|translated_cues/);
  const status = JSON.parse((main[1].messages.at(-1) as { content: string }).content);
  assert.equal(status.type, "workspace_status");
  assert.deepEqual(status.subagents[0], { id: "subagent-1", status: "completed", translated_cues: 1 });
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
  const old = response("read_file", { path: "source.json", count: 100 });
  old.content = [{ type: "text", text: "long history ".repeat(10000) }];
  state.children[0].agent.messages = [old];
  state = await advanceTranslationTeam(document, state, async context => {
    const task = manifest(context);
    if (task.id === "subagent-1") {
      assert.match(JSON.stringify(context), /transaction=事务/);
      assert.match(JSON.stringify(context), /Checked later definitions/);
      assert.equal(task.assignment.start_id, "c0");
      assert.doesNotMatch(JSON.stringify(context), /long history/);
      assert.deepEqual(task.initial_source_page.content, [document.cues[0]], "compaction retains the same immutable source preload");
      const status = JSON.parse((context.messages.at(-1) as { content: string }).content);
      assert.equal(status.translated_cues, 1, "saved progress prevents treating the preload as fresh work");
    }
    return response("read_file", { path: "translations.json", count: 100 });
  });
  assert.equal(state.children[0].agent.compactions, 1);
  assert.equal(state.children[0].agent.draft.c0, "数据库事务");
});

test("child global-context reads require a chosen count up to 200, while searches need no count", async () => {
  const document = input(), initial = initialTranslationTeamState(document);
  translationTeamTool(document, initial, "dispatch_subagents", dispatch());
  for (const args of [{ count: 200 }, {}, { count: 201 }, { query: "transaction 8" }]) {
    const state = await advanceTranslationTeam(document, initial, async () => response("read_context", args));
    for (const child of state.children) {
      const result = child.agent.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      if (result?.role !== "toolResult") assert.fail("missing tool result");
      assert.equal(!!result.isError, !("query" in args || args.count === 200));
      if (args.count === 200) {
        const page = JSON.parse((result.content[0] as { text: string }).text);
        assert.equal(JSON.parse(page.content).length, 9);
      }
    }
  }
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
