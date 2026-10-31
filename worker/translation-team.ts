import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import {
  advanceSubtitleAgent, finalSubtitleAgentCues, initialSubtitleAgentState,
  SUBTITLE_AGENT_PROMPT, SUBTITLE_AGENT_TOOLS, subtitleAgentContext, subtitleAgentTool, WorkspaceError, MAX_READ_CUES,
} from "./subtitle-agent.js";
import type { SubtitleAgentState } from "./subtitle-agent.js";
import { callDocumentTurn, DocumentModelError, DocumentPermanentError, inputBudget, parseReasoningEffort, tokenEstimate } from "./document-translation.js";
import type { DocumentInput, ModelConfig } from "./document-translation.js";
import { createDocumentTask } from "./document-task.js";
import type { DocumentAdvanceControl } from "./document-task.js";
import { setTimeout as delay } from "node:timers/promises";

export const TRANSLATION_TEAM_VERSION = "subtitle-translation-team-v2-streaming";
export const MAX_SUBAGENTS = 9; // Remainder agents; the dedicated opening is additional.

/** Resolve deployment overrides once, before caching or persisting the task. */
export function translationTeamReasoning(config: ModelConfig): NonNullable<DocumentInput["teamReasoning"]> {
  const fallback = config.reasoningEffort ?? "off";
  return {
    main: parseReasoningEffort(process.env.TRANSLATION_MAIN_REASONING_EFFORT || fallback, "TRANSLATION_MAIN_REASONING_EFFORT"),
    subagent: parseReasoningEffort(process.env.TRANSLATION_SUBAGENT_REASONING_EFFORT || fallback, "TRANSLATION_SUBAGENT_REASONING_EFFORT"),
  };
}

export function translationTeamModelConfig(input: DocumentInput, role: "main" | "subagent"): ModelConfig {
  // Never consult the current environment while executing/restoring a task.
  const effort = input.teamReasoning?.[role] ?? input.config.reasoningEffort ?? "off";
  return { ...input.config, reasoningEffort: parseReasoningEffort(effort) };
}
type Assignment = { start_id: string; end_id: string; instructions: string };
export type TranslationChild = Assignment & {
  id: string; kind?: "opening" | "translation"; status: "running" | "completed" | "closed";
  agent: SubtitleAgentState; failures: number; error: string; terminal: boolean; retryAt: number;
};
export type TranslationTeamState = SubtitleAgentState & {
  brief: string; children: TranslationChild[]; acceptedRevision: number; acceptance: string;
};

export const TEAM_PROMPT = `${SUBTITLE_AGENT_PROMPT}
You are the MAIN agent coordinating a translation team, not the bulk translator.
Quickly read representative source (opening plus later definitions) to assess subject, audience, tone, subtitle style and terminology; do not spend many turns exhaustively reading before delegation. Save useful notes. Then call dispatch_subagents with a shared style/terminology brief, a dedicated opening assignment, and 0 to 9 further contiguous, non-overlapping semantic assignments covering the REMAINDER. The opening always starts at the first source cue. Choose its end_id according to total translation volume, cue density and sentence/topic boundaries: aim for a small, quickly translatable first viewing buffer (usually 30-90 seconds, about 10-30 ordinary cues), not a large chapter. For tiny sources the opening may cover everything and assignments may be empty. Do not allocate the opening to any other child. Choose the remaining parallelism proportional to source length/complexity, at most 9. Avoid splitting sentences or dependent explanations. All children receive the same immutable brief and can read the whole source for context. Put explicit source term -> target term decisions in the brief. Assignments can be large: children paginate and translate incrementally. Historical tasks without stream_opening may still use assignments covering the whole source without opening.
The host runs every child independently and checkpoints each completed turn; a fast child never waits for a slow sibling's turn. The opening child submits a self-checked preview for immediate viewing while other children keep translating. It is provisional, not final main-agent acceptance. The host returns control after all translations are complete. Do not translate the whole source yourself before delegation. You can inspect team status in every task manifest. After completion, read and check the actual merged translations against the source, especially boundaries, terminology, numbers and negation. Use search/edit tools to fix problems. You are responsible for semantic acceptance; structure validation alone is NOT review.
After your review and corrections, call accept_translation with a concrete review summary, then close_subagents to release child sessions. Finally validate_translation and finish_translation. Any translation edit invalidates acceptance. You cannot submit until all children are completed, accepted and closed. Ordinary chat is not completion.`;

export const TEAM_TOOLS: Tool[] = [
  ...SUBTITLE_AGENT_TOOLS,
  { name: "dispatch_subagents", description: "Launch a dedicated opening agent plus up to 9 independent translation agents. Opening starts at the first cue; assignments cover the remainder exactly once in source order. Required opening for stream_opening tasks; optional only for historical tasks. One immutable shared brief. Can be called only once.", parameters: Type.Object({
    brief: Type.String({ minLength: 1, maxLength: 12000 }),
    opening: Type.Optional(Type.Object({ end_id: Type.String(), instructions: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false })),
    assignments: Type.Array(Type.Object({ start_id: Type.String(), end_id: Type.String(), instructions: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }), { minItems: 0, maxItems: MAX_SUBAGENTS }),
  }, { additionalProperties: false }) },
  { name: "accept_translation", description: "Record MAIN agent's semantic acceptance of the current merged revision, after reading/reviewing and correcting it. Does not replace structural validation.", parameters: Type.Object({ review: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }) },
  { name: "close_subagents", description: "Close all completed child sessions after MAIN acceptance. Releases their conversation memory, preserves submitted results. Required before final publication.", parameters: Type.Object({}, { additionalProperties: false }) },
];
const CHILD_TOOLS: Tool[] = [...SUBTITLE_AGENT_TOOLS, {
  name: "read_context", description: "Read/search the entire read-only source for context outside your assignment. For reading, explicitly choose count (1-200 cues), no default. For query searches count is not used. Offsets are global cue positions. Never translate IDs outside your assignment.",
  parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CUES })), query: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
}];

export function initialTranslationTeamState(input: DocumentInput): TranslationTeamState {
  translationTeamModelConfig(input, "main");
  translationTeamModelConfig(input, "subagent");
  const state: TranslationTeamState = { ...initialSubtitleAgentState(input), brief: "", children: [], acceptedRevision: -1, acceptance: "" };
  const context = teamContext(subtitleAgentContext(input, state), state, input);
  context.tools = TEAM_TOOLS;
  if (tokenEstimate(context) > inputBudget(input.config)) throw new DocumentPermanentError("configuration", "Main agent instructions/tools exceed configured context budget");
  return state;
}
function childInput(input: DocumentInput, assignment: Assignment): DocumentInput {
  const start = input.cues.findIndex(c => c.cue_id === assignment.start_id);
  const end = input.cues.findIndex(c => c.cue_id === assignment.end_id);
  return { ...input, cues: input.cues.slice(start, end + 1) };
}
function completed(state: TranslationTeamState) {
  return state.children.length > 0 && state.children.every(c => c.status !== "running");
}
function accepted(state: TranslationTeamState) {
  return completed(state) && state.acceptedRevision === state.revision;
}
export function translationTeamTool(input: DocumentInput, state: TranslationTeamState, name: string, args: unknown): unknown {
  if (state.stage === "publish") throw new WorkspaceError("Translation already submitted");
  const a = args as Record<string, unknown>;
  if (name === "dispatch_subagents") {
    if (state.children.length) throw new WorkspaceError("Subagents already dispatched; inspect merged translations after completion");
    if (!a || typeof a.brief !== "string" || !a.brief.trim() || a.brief.length > 12000 || !Array.isArray(a.assignments) || a.assignments.length > MAX_SUBAGENTS) throw new WorkspaceError("Provide a shared brief, opening and up to 9 remainder assignments");
    const opening = a.opening as { end_id: string; instructions: string } | undefined;
    if (input.streamOpening && !opening) throw new WorkspaceError("Provide a small opening assignment for immediate viewing, plus assignments covering the remainder");
    if (opening && (typeof opening !== "object" || typeof opening.end_id !== "string")) throw new WorkspaceError("Invalid opening assignment");
    const assignments: Assignment[] = [
      ...(opening ? [{ start_id: input.cues[0].cue_id, end_id: opening.end_id, instructions: opening.instructions }] : []),
      ...a.assignments as Assignment[],
    ];
    if (!assignments.length) throw new WorkspaceError("Provide at least one assignment");
    let cursor = 0;
    for (const assignment of assignments) {
      const end = input.cues.findIndex(c => c.cue_id === assignment.end_id);
      if (assignment.start_id !== input.cues[cursor]?.cue_id || end < cursor || typeof assignment.instructions !== "string" || !assignment.instructions.trim() || assignment.instructions.length > 2000) throw new WorkspaceError("Assignments must cover every cue exactly once in source order, without gaps or overlaps");
      cursor = end + 1;
    }
    if (cursor !== input.cues.length) throw new WorkspaceError("Assignments must cover the entire source");
    // Limit instruction overhead so children retain room for actual source/tool results.
    if (tokenEstimate({ brief: a.brief, assignments }) > inputBudget(input.config) * 0.15) throw new WorkspaceError("Shared brief/assignments too long for configured context");
    const children: TranslationChild[] = assignments.map((assignment, index) => ({
      ...assignment, id: opening && index === 0 ? "opening-agent" : `subagent-${index + (opening ? 0 : 1)}`, kind: opening && index === 0 ? "opening" : "translation", status: "running", agent: initialSubtitleAgentState(childInput(input, assignment)), failures: 0, error: "", terminal: false, retryAt: 0,
    }));
    state.brief = a.brief; state.children = children;
    return { dispatched: children.map(({ id, start_id, end_id }) => ({ id, start_id, end_id })), shared_brief: state.brief };
  }
  if (name === "accept_translation") {
    if (!completed(state)) throw new WorkspaceError("Wait for all subagents to complete before acceptance");
    if (typeof a?.review !== "string" || !a.review.trim() || a.review.length > 4000) throw new WorkspaceError("Provide a concrete semantic review summary");
    // Check coverage without granting or replacing the explicit validation tool.
    const probe = structuredClone(state);
    const result = subtitleAgentTool(input, probe, "validate_translation", {}) as { valid: boolean };
    if (!result.valid) throw new WorkspaceError("Merged translation incomplete; repair it before acceptance");
    state.acceptedRevision = state.revision; state.acceptance = a.review;
    return { accepted: true, revision: state.revision };
  }
  if (name === "close_subagents") {
    if (!accepted(state)) throw new WorkspaceError("Main agent must accept the current revision before closing subagents");
    for (const child of state.children) {
      child.status = "closed"; child.agent.messages = []; child.agent.notes = "";
    }
    return { closed: state.children.map(c => c.id) };
  }
  if (name === "finish_translation" && (!accepted(state) || state.children.some(c => c.status !== "closed"))) throw new WorkspaceError("Review and accept the current translation, then close all subagents before submitting");
  if ((name === "write_file" || name === "edit_file") && a?.path === "translations.json" && !completed(state)) throw new WorkspaceError("Delegate translation first; edit merged translations after subagents complete");
  return subtitleAgentTool(input, state, name, args);
}
function teamContext(context: Context, state: TranslationTeamState, input?: DocumentInput): Context {
  return { ...context, systemPrompt: TEAM_PROMPT, messages: [
    ...context.messages.slice(0, 1),
    { role: "user", timestamp: 0, content: JSON.stringify({ role: "main", shared_brief: state.brief, stream_opening: !!input?.streamOpening,
      subagents: state.children.map(c => ({ id: c.id, kind: c.kind, start_id: c.start_id, end_id: c.end_id, instructions: c.instructions, status: c.status, translated_cues: Object.keys(c.agent.draft).length })),
      accepted_revision: state.acceptedRevision, current_revision: state.revision, acceptance: state.acceptance,
    }) }, ...context.messages.slice(1),
  ] };
}

async function advanceChild(input: DocumentInput, state: TranslationTeamState, child: TranslationChild, call: (context: Context) => Promise<AssistantMessage>) {
  const assigned = childInput(input, child);
  try {
    const next = await advanceSubtitleAgent(assigned, child.agent, call, {
      tools: CHILD_TOOLS,
      context: context => ({ ...context, systemPrompt: `${SUBTITLE_AGENT_PROMPT}\nYou are a translation SUBAGENT. Translate ONLY your assigned source.json IDs. Follow the MAIN agent's shared style and terminology brief. Use read_context to check later definitions or surrounding sentences in the full source. Submit your own complete assignment with validate_translation and finish_translation; the MAIN agent will review it.${child.kind === "opening" ? " You are the dedicated OPENING agent: viewers are waiting for these first subtitles. Work efficiently, avoid unnecessary notes/tool turns, self-review and submit this small opening promptly. It will be shown provisionally before whole-document review." : ""}`, messages: [
        ...context.messages.slice(0, 1), { role: "user", timestamp: 0, content: JSON.stringify({ role: "subagent", id: child.id, kind: child.kind, shared_brief: state.brief, assignment: { start_id: child.start_id, end_id: child.end_id, instructions: child.instructions } }) }, ...context.messages.slice(1),
      ] }),
      tool: (s, name, args) => {
        if (name !== "read_context") return subtitleAgentTool(assigned, s, name, args);
        const a = args as { offset?: number; count?: number; query?: string };
        return subtitleAgentTool(input, s, a.query ? "search_file" : "read_file", { ...a, path: "source.json" });
      },
    });
    // Validate before changing committed workspace/merge state.
    const cues = next.stage === "publish" ? finalSubtitleAgentCues(assigned, next) : [];
    child.agent = next;
    child.failures = 0; child.error = ""; child.retryAt = 0;
    if (next.stage === "publish") {
      for (const cue of cues) state.draft[cue.cue_id] = cue.translation;
      state.revision++; state.validatedRevision = -1;
      child.status = "completed";
    }
  } catch (error) {
    child.failures++;
    child.error = error instanceof Error ? error.message.slice(0, 2000) : "Subagent model call failed";
    child.terminal = error instanceof DocumentPermanentError || (error instanceof DocumentModelError && error.status >= 400 && error.status < 500 && ![429, 499].includes(error.status));
    child.retryAt = Date.now() + (error instanceof DocumentModelError ? error.retryAfterMs * child.failures : 0);
  }
}
function failedChild(state: TranslationTeamState) {
  return state.children.find(c => c.status === "running" && (c.terminal || c.failures > 2));
}
function updateFeedback(state: TranslationTeamState) {
  state.feedback = completed(state) ? "All subagents completed. Review the actual merged translations (including the provisional opening), fix inconsistencies, accept_translation, close_subagents, then validate and finish." : "";
}

/** Single-step driver retained for deterministic workspace tests and integrations. */
export async function stepTranslationTeam(input: DocumentInput, previous: TranslationTeamState, call: (context: Context) => Promise<AssistantMessage>): Promise<TranslationTeamState> {
  const state = structuredClone(previous);
  const running = state.children.filter(c => c.status === "running");
  if (!running.length) {
    return await advanceSubtitleAgent(input, state, call, {
      tools: TEAM_TOOLS,
      context: context => teamContext(context, state, input),
      tool: (s, name, args) => translationTeamTool(input, s as TranslationTeamState, name, args),
    }) as TranslationTeamState;
  }
  const failed = failedChild(state);
  if (failed) throw new DocumentPermanentError("convergence", `${failed.id}: ${failed.error}`);
  await Promise.all(running.filter(c => c.retryAt <= Date.now()).map(c => advanceChild(input, state, c, call)));
  state.cursor++;
  updateFeedback(state);
  return state;
}

/** Production driver: each child loops independently, saving EVERY completed turn.
 * Promise.allSettled only joins the final results, never synchronizes model turns.
 * On failure/cancellation drain in-flight calls before returning to the task boundary.
 */
export async function advanceTranslationTeam(input: DocumentInput, previous: TranslationTeamState, call: (context: Context) => Promise<AssistantMessage>, control?: DocumentAdvanceControl<TranslationTeamState>): Promise<TranslationTeamState> {
  if (!previous.children.some(c => c.status === "running")) return stepTranslationTeam(input, previous, call);
  const state = structuredClone(previous);
  let stopped = false;
  const results = await Promise.allSettled(state.children.filter(c => c.status === "running").map(async child => {
    try {
      while (child.status === "running" && !failedChild(state) && !stopped && !control?.signal.aborted) {
        if (child.retryAt > Date.now()) await delay(child.retryAt - Date.now(), undefined, { signal: control?.signal });
        if (failedChild(state) || stopped || control?.signal.aborted) break;
        await advanceChild(input, state, child, call);
        state.cursor++;
        updateFeedback(state);
        await control?.save(state);
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  }));
  const rejected = results.find(r => r.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  if (control?.signal.aborted) throw new Error("Task cancelled");
  const failed = failedChild(state);
  if (failed) throw new DocumentPermanentError("convergence", `${failed.id}: ${failed.error}`);
  return state;
}

/** Only the opening child's explicitly submitted, host-validated result is visible early. */
export function translationTeamPreviewCues(input: DocumentInput, state: TranslationTeamState) {
  const opening = state.children.find(c => c.kind === "opening");
  return opening && opening.status !== "running" ? finalSubtitleAgentCues(childInput(input, opening), opening.agent) : [];
}

export function finalTranslationTeamCues(input: DocumentInput, state: TranslationTeamState) {
  if (!accepted(state) || state.children.some(c => c.status !== "closed")) throw new Error("Translation team has not been accepted and closed");
  return finalSubtitleAgentCues(input, state);
}
/** Report saved work, not just submitted/merged assignments. Never expose draft text. */
export function translationTeamProgress(input: DocumentInput, state: TranslationTeamState): string {
  const running = state.children.filter(c => c.status === "running");
  // Completed child drafts also exist in state.draft. Count IDs only once, and
  // prefer the main workspace during review (child copies may now be stale).
  const saved = new Set(Object.keys(state.draft));
  for (const child of running) for (const id of Object.keys(child.agent.draft)) saved.add(id);
  const phase = state.stage === "publish" ? "正在发布" : running.length ? "并行翻译中" : state.children.length ? "主 Agent 验收" : "主 Agent 规划";
  const parts = [phase, `${running.length ? "已保存草稿" : "已合并"} ${saved.size}/${input.cues.length}（未发布）`];
  if (state.children.length) parts.push(`Subagent 已提交 ${state.children.length - running.length}/${state.children.length}`);
  parts.push(`已完成 ${state.cursor} 轮`);
  const opening = state.children.find(c => c.kind === "opening");
  if (opening) parts.push(opening.status === "running" ? "开头优先翻译中" : "开头已就绪，可先观看（全文审校后更新）");
  const failed = running.filter(c => c.terminal || c.failures > 2).length;
  const retrying = running.filter(c => c.failures > 0 && !c.terminal && c.failures <= 2).length;
  if (failed) parts.push(`Subagent 失败 ${failed}`);
  if (retrying) parts.push(`Subagent 重试中 ${retrying}`);
  return parts.join("，");
}

export const TranslationTeamTask = createDocumentTask({
  name: "subtitle_translation_team", initial: initialTranslationTeamState, advance: advanceTranslationTeam,
  call: (input, state, context, options) => callDocumentTurn({
    ...input, config: translationTeamModelConfig(input, state.children.some(c => c.status === "running") ? "subagent" : "main"),
  }, context, options),
  finalCues: finalTranslationTeamCues,
  previewCues: translationTeamPreviewCues,
  resume: state => ({ ...state, children: state.children.map(c => ({ ...c, failures: 0, error: "", terminal: false, retryAt: 0 })) }),
  wakeAt: state => {
    const running = state.children.filter(c => c.status === "running");
    return running.length && running.every(c => !c.terminal && c.failures <= 2 && c.retryAt > Date.now()) ? Math.min(...running.map(c => c.retryAt)) : 0;
  },
  progress: translationTeamProgress,
});
