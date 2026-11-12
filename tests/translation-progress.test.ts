import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { DocumentPermanentError, inputBudget, modelConfig, tokenEstimate } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { dispatchSuggestion, finalTranslationTeamCues, initialTranslationTeamState, stepTranslationTeam, translationTeamTool } from "../worker/translation-team.js";
import type { TranslationTeamState } from "../worker/translation-team.js";
import { mainProgress, progressStatus } from "../worker/team-progress.js";

function document(total = 560, streamOpening = true): DocumentInput {
  return {
    jobId: "progress", jobKey: "progress", videoId: "v", title: "Trading lesson", fromLang: "en", toLang: "zh-CN", budgetLimit: 0, streamOpening,
    config: modelConfig({ contextTokens: 24000, outputTokens: 1024 }),
    // Deliberately non-numeric/non-contiguous IDs: never derive coverage by ID arithmetic.
    cues: Array.from({ length: total }, (_, i) => ({ cue_id: `cue-${i * 3}-x`, start: i * 1000, end: i * 1000 + 900,
      text: `In example ${i}, this explanation describes how to select a trading setup, preserve risk limits, and avoid buying too late. ${"Consider the complete explanation. ".repeat(3)}` })),
  };
}
function response(tools: { name: string; args: unknown }[] = [], text = ""): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: 0, stopReason: tools.length ? "toolUse" : "stop",
    content: [...(text ? [{ type: "text" as const, text }] : []), ...tools.map((t, i) => ({ type: "toolCall" as const, id: `t${i}`, name: t.name, arguments: t.args as ToolCall["arguments"] }))],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function forceCompaction(state: TranslationTeamState) {
  state.messages.unshift(response([], "OBSOLETE_HISTORY ".repeat(30000)));
  return JSON.parse(JSON.stringify(state)) as TranslationTeamState;
}
function mergeCompletedChildren(input: DocumentInput, state: TranslationTeamState) {
  // Represents a previously saved task with all child submissions. No inferred
  // semantic acceptance: the main must still read, review, accept and publish.
  state.draft = Object.fromEntries(input.cues.map((c, i) => [c.cue_id, `示例 ${i}：选择交易形态，限制风险，不要过晚买入。请结合完整解释理解。`]));
  state.revision++;
  for (const child of state.children) child.status = "completed";
}
const finish = [
  { name: "accept_translation", args: { review: "Reviewed the bilingual pages, terminology, negation, numbers and section boundaries; no unresolved issues." } },
  { name: "close_subagents", args: {} }, { name: "validate_translation", args: {} }, { name: "finish_translation", args: {} },
];

for (const count of [1, 29, 560, 2054]) for (const opening of [false, true]) {
  test(`dispatch suggestion covers ${count} arbitrary IDs exactly once (opening=${opening})`, () => {
    const input = document(count, opening), state = initialTranslationTeamState(input);
    const suggestion = dispatchSuggestion(input);
    translationTeamTool(input, state, "dispatch_subagents", { brief: "Natural concise subtitles.", ...suggestion });
    assert.ok(state.children.length >= 1 && state.children.length <= (opening ? 10 : 9));
    const covered = state.children.flatMap(c => input.cues.slice(input.cues.findIndex(s => s.cue_id === c.start_id), input.cues.findIndex(s => s.cue_id === c.end_id) + 1));
    assert.deepEqual(covered, input.cues);
  });
}

for (const total of [560, 2054]) test(`${total} cues: planning and semantic review resume across repeated compaction and serialized checkpoints`, async () => {
  const input = document(total); let state = initialTranslationTeamState(input);
  const turn = async (tools: { name: string; args: unknown }[], inspect?: (context: Context) => void) => {
    state = await stepTranslationTeam(input, state, async context => {
      assert.ok(tokenEstimate(context) <= inputBudget(input.config));
      assert.doesNotMatch(JSON.stringify(context), /OBSOLETE_HISTORY/);
      inspect?.(context);
      return response(tools);
    });
  };
  await turn([{ name: "read_file", args: { path: "source.json", offset: 0, count: 20 } }]);
  await turn([{ name: "save_plan", args: { summary: "Audience: traders. Natural concise subtitles; preserve risk advice. Setup = 交易形态. Use proposed coverage and inspect boundaries as needed." } }]);
  state = forceCompaction(state);
  await turn([{ name: "dispatch_subagents", args: { brief: mainProgress(state).plan, ...dispatchSuggestion(input) } }], context => {
    const live = JSON.parse((context.messages.at(-1) as { content: string }).content);
    assert.match(live.main_progress.plan_summary, /Audience: traders/);
    assert.ok(live.main_progress.source_read_cues > 0);
    const role = JSON.parse((context.messages[1] as { content: string }).content);
    assert.equal(role.source_bounds.last_id, input.cues.at(-1)!.cue_id);
    assert.deepEqual(role.dispatch_suggestion, dispatchSuggestion(input));
  });
  assert.equal(state.cursor, 3, "no exhaustive planning read required");
  mergeCompletedChildren(input, state);
  await turn([{ name: "review_checklist", args: {} }]);
  let pages = 0, priorOffset = -1;
  while (progressStatus(state, total).next_review_offset !== null) {
    const offset = progressStatus(state, total).next_review_offset!;
    assert.ok(offset > priorOffset, "review must advance rather than restart at zero"); priorOffset = offset;
    state = forceCompaction(state);
    await turn([{ name: "read_bilingual", args: { offset, count: 400 } }], context => {
      const live = JSON.parse((context.messages.at(-1) as { content: string }).content);
      assert.equal(live.main_progress.next_review_offset, offset);
      assert.equal(live.main_progress.checklist.revision, state.revision);
      if (offset) assert.match(live.main_progress.review_summary, /No unresolved/);
    });
    const result = state.messages.at(-1);
    assert.equal(result?.role, "toolResult");
    const page = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    assert.ok(page.returned_count > 0 && page.returned_count < 400, "tight context actually shrinks large page requests");
    assert.equal(page.offset, offset);
    // A confirmed page, unlike a read cursor, is durable semantic progress.
    await turn([{ name: "record_review", args: { offset, count: page.returned_count, revision: page.revision, summary: `Reviewed through position ${offset + page.returned_count}; numbers, meaning and terminology consistent. No unresolved issues.` } }]);
    pages++;
    state = JSON.parse(JSON.stringify(state));
  }
  assert.ok(pages > 5 && state.compactions >= pages);
  assert.equal(progressStatus(state, total).reviewed_cues, total);
  assert.equal(state.children.every(c => c.status === "completed"), true, "review never respawns children");
  assert.throws(() => finalTranslationTeamCues(input, state), /accepted and closed/);
  state = forceCompaction(state);
  await turn(finish);
  assert.equal(finalTranslationTeamCues(input, state).length, total);
  assert.ok(mainProgress(state).guard.stalled < 12);
});

test("compaction retains a bounded complete last tool turn, not orphan results, while durable state remains authoritative", async () => {
  const input = document(9); input.config = modelConfig();
  let state = initialTranslationTeamState(input);
  translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
  mergeCompletedChildren(input, state);
  state = await stepTranslationTeam(input, state, async () => response([{ name: "read_bilingual", args: { offset: 0, count: 9 } }]));
  state = forceCompaction(state);
  state = await stepTranslationTeam(input, state, async context => {
    const assistant = context.messages.find(m => m.role === "assistant");
    assert.ok(assistant?.content.some(c => c.type === "toolCall" && c.name === "read_bilingual"));
    const result = context.messages.find(m => m.role === "toolResult");
    assert.equal(result?.role === "toolResult" && result.toolName, "read_bilingual");
    assert.match(JSON.stringify(result), /cue-24-x/);
    assert.ok(tokenEstimate(context) < inputBudget(input.config) * 0.65);
    return response([{ name: "record_review", args: { offset: 0, count: 9, revision: state.revision, summary: "Checked all nine returned rows; no unresolved issues." } }]);
  });
  assert.equal(state.compactions, 1);
  assert.equal(progressStatus(state, 9).reviewed_cues, 9);
});

test("separate translation-file pages count as new reading, but are not bilingual evidence or semantic review", async () => {
  const input = document(30); let state = initialTranslationTeamState(input);
  translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
  mergeCompletedChildren(input, state);
  for (let offset = 0; offset < 20; offset++) {
    state = await stepTranslationTeam(input, state, async () => response([{ name: "read_file", args: { path: "translations.json", offset, count: 1 } }]));
    assert.equal(mainProgress(state).guard.stalled, 0);
  }
  assert.equal(progressStatus(state, 30).translation_read_cues, 20);
  assert.equal(progressStatus(state, 30).reviewed_cues, 0);
  assert.throws(() => translationTeamTool(input, state, "record_review", { offset: 0, count: 1, revision: state.revision, summary: "Unchecked." }), /Read the requested/);
});

test("reading is not review; recording checks actual rows and revision, edits invalidate only affected cues", () => {
  const input = document(9), state = initialTranslationTeamState(input);
  translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
  mergeCompletedChildren(input, state);
  const record = (offset: number, count: number, revision = state.revision) => translationTeamTool(input, state, "record_review", { offset, count, revision, summary: "Checked meaning and numbers. No unresolved issues." });
  assert.throws(() => record(0, 9), /Read the requested/);
  translationTeamTool(input, state, "read_bilingual", { offset: 0, count: 9 });
  assert.equal(progressStatus(state, 9).reviewed_cues, 0);
  assert.throws(() => record(0, 9, state.revision + 1), /stale/);
  record(0, 9);
  assert.equal(progressStatus(state, 9).next_review_offset, null);
  translationTeamTool(input, state, "accept_translation", { review: "All pages checked." });
  const previous = state.revision;
  translationTeamTool(input, state, "write_file", { path: "translations.json", merge: true, content: JSON.stringify({ [input.cues[3].cue_id]: "示例 3：修正后的语义。" }) });
  assert.equal(progressStatus(state, 9).reviewed_cues, 8);
  assert.equal(progressStatus(state, 9).next_review_offset, 3);
  assert.throws(() => record(3, 1, previous), /stale/);
  assert.throws(() => record(3, 1), /Read the requested/);
  assert.throws(() => translationTeamTool(input, state, "close_subagents", {}), /accept/);
  translationTeamTool(input, state, "read_bilingual", { offset: 3, count: 1 });
  record(3, 1);
  assert.equal(progressStatus(state, 9).reviewed_cues, 9);
  assert.throws(() => translationTeamTool(input, state, "finish_translation", {}), /accept/);
});

test("legacy running review checkpoints acquire progress without retranslation or inferred acceptance", async () => {
  const input = document(9); let state = initialTranslationTeamState(input);
  translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
  mergeCompletedChildren(input, state);
  delete state.mainProgress;
  state.cursor = 310; state.compactions = 43;
  state = await stepTranslationTeam(input, state, async context => {
    const live = JSON.parse((context.messages.at(-1) as { content: string }).content);
    assert.equal(live.main_progress.reviewed_cues, 0);
    assert.equal(live.main_progress.next_review_offset, 0);
    assert.equal(live.accepted_revision, -1);
    return response([{ name: "read_bilingual", args: { offset: 0, count: 9 } }]);
  });
  assert.equal(state.cursor, 311);
  assert.equal(state.children.every(c => c.status === "completed"), true);
  assert.equal(Object.keys(state.draft).length, 9);
});

test("phase caps stop exhaustive planning and endless translation edits even when each turn changes something", async () => {
  for (const phase of ["planning", "review"] as const) {
    const input = document(30); let state = initialTranslationTeamState(input);
    if (phase === "review") {
      translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
      mergeCompletedChildren(input, state);
    }
    const limit = phase === "planning" ? 24 : 48;
    let requests = 0;
    const call = async () => {
      const index = requests++;
      return response(phase === "planning" ? [{ name: "read_file", args: { path: "source.json", offset: index, count: 1 } }] : [
        { name: "write_file", args: { path: "translations.json", merge: true, content: JSON.stringify({ [input.cues[0].cue_id]: `第 ${index} 次反复改写。` }) } },
      ]);
    };
    for (let i = 0; i < limit; i++) state = await stepTranslationTeam(input, state, call);
    assert.equal(mainProgress(state).guard.stalled, 0);
    await assert.rejects(stepTranslationTeam(input, state, call), /达到阶段轮数上限/);
    assert.equal(requests, limit);
  }
});

for (const phase of ["planning", "review"] as const) test(`watchdog bounds ${phase} repeats/failed tools/chat and survives compaction/restart`, async () => {
  for (const mode of ["repeat", "bad-tool", "chat"] as const) {
    const input = document(9); let state = initialTranslationTeamState(input);
    if (phase === "review") {
      translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
      mergeCompletedChildren(input, state);
    }
    let requests = 0;
    const call = async () => {
      requests++;
      if (mode === "chat") return response([], "I am still planning.");
      if (mode === "bad-tool") return response([{ name: "dispatch_subagents", args: { brief: "Concise.", assignments: [] } }]);
      return response([{ name: phase === "planning" ? "read_file" : "read_bilingual", args: phase === "planning" ? { path: "source.json", offset: 0, count: 1 } : { offset: 0, count: 1 } }]);
    };
    for (let i = 0; i < (mode === "repeat" ? 13 : 12); i++) {
      state = await stepTranslationTeam(input, state, call);
      state = forceCompaction(state);
    }
    const prior = requests;
    await assert.rejects(stepTranslationTeam(input, state, call), error => error instanceof DocumentPermanentError && error.code === "convergence");
    assert.equal(requests, prior, "no additional paid request after hitting the guard");
    assert.equal(state.stage, "editing");
    assert.equal(Object.keys(state.draft).length, phase === "review" ? 9 : 0);
  }
});

test("a fully reviewed complete translation is not failed on the final submission turn", async () => {
  const input = document(9); let state = initialTranslationTeamState(input);
  translationTeamTool(input, state, "dispatch_subagents", { brief: "Concise.", ...dispatchSuggestion(input) });
  mergeCompletedChildren(input, state);
  translationTeamTool(input, state, "read_bilingual", { offset: 0, count: 9 });
  translationTeamTool(input, state, "record_review", { offset: 0, count: 9, revision: state.revision, summary: "Checked all nine rows; meaning, numbers and terms correct." });
  let requests = 0;
  // The model keeps re-reading instead of submitting. Review coverage is already
  // complete, so the host must keep prompting for submission past the 12-turn
  // stall guard rather than discarding an entirely finished translation.
  const call = async (context: Context) => {
    requests++;
    if (requests === 14) {
      const live = JSON.parse((context.messages.at(-2) as { content: string }).content);
      assert.equal(live.ready_to_submit, true);
      assert.match((context.messages.at(-1) as { content: string }).content, /accept_translation, close_subagents, validate_translation and finish_translation in ONE turn/);
    }
    return requests > 20 ? response(finish) : response([{ name: "read_bilingual", args: { offset: 0, count: 9 } }]);
  };
  for (let i = 0; i < 21; i++) { state = await stepTranslationTeam(input, state, call); state = forceCompaction(state); }
  assert.ok(requests > 20, "submission window survives the 12-turn stall guard");
  assert.equal(finalTranslationTeamCues(input, state).length, 9);
});
