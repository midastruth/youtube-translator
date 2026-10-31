import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import {
  advanceSubtitleAgent, finalSubtitleAgentCues, initialSubtitleAgentState,
  SUBTITLE_AGENT_PROMPT, SUBTITLE_AGENT_TOOLS, subtitleAgentContext, subtitleAgentTool, WorkspaceError,
} from "./subtitle-agent.js";
import type { SubtitleAgentState } from "./subtitle-agent.js";
import { callDocumentTurn, DocumentModelError, DocumentPermanentError, inputBudget, parseReasoningEffort, tokenEstimate } from "./document-translation.js";
import type { DocumentInput, ModelConfig } from "./document-translation.js";
import { createDocumentTask } from "./document-task.js";

export const TRANSLATION_TEAM_VERSION = "subtitle-translation-team-v1";
export const MAX_SUBAGENTS = 9;

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
  id: string; status: "running" | "completed" | "closed";
  agent: SubtitleAgentState; failures: number; error: string; terminal: boolean; retryAt: number;
};
export type TranslationTeamState = SubtitleAgentState & {
  brief: string; children: TranslationChild[]; acceptedRevision: number; acceptance: string;
};

export const TEAM_PROMPT = `${SUBTITLE_AGENT_PROMPT}
You are the MAIN agent coordinating a translation team, not the bulk translator.
First read enough source (including later definitions) to assess subject, audience, tone, subtitle style and terminology. Save useful notes. Then call dispatch_subagents with a shared style/terminology brief and 1 to 9 contiguous, non-overlapping semantic assignments covering the ENTIRE source. Choose parallelism proportional to source length/complexity: 1 for tiny texts, more for larger ones, at most 9. Avoid splitting sentences or dependent explanations. All children receive the same immutable brief and can read the whole source for context. Put explicit source term -> target term decisions in the brief. Assignments can be large: children paginate and translate incrementally.
The host runs children concurrently and returns control after their translations are complete. Do not translate the whole source yourself before delegation. You can inspect team status in every task manifest. After completion, read and check the actual merged translations against the source, especially boundaries, terminology, numbers and negation. Use search/edit tools to fix problems. You are responsible for semantic acceptance; structure validation alone is NOT review.
After your review and corrections, call accept_translation with a concrete review summary, then close_subagents to release child sessions. Finally validate_translation and finish_translation. Any translation edit invalidates acceptance. You cannot submit until all children are completed, accepted and closed. Ordinary chat is not completion.`;

export const TEAM_TOOLS: Tool[] = [
  ...SUBTITLE_AGENT_TOOLS,
  { name: "dispatch_subagents", description: "Launch 1-9 parallel translation agents after reading source. One immutable shared style/terminology brief; assignments in source order must cover every cue exactly once. Can be called only once.", parameters: Type.Object({
    brief: Type.String({ minLength: 1, maxLength: 12000 }),
    assignments: Type.Array(Type.Object({ start_id: Type.String(), end_id: Type.String(), instructions: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_SUBAGENTS }),
  }, { additionalProperties: false }) },
  { name: "accept_translation", description: "Record MAIN agent's semantic acceptance of the current merged revision, after reading/reviewing and correcting it. Does not replace structural validation.", parameters: Type.Object({ review: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }) },
  { name: "close_subagents", description: "Close all completed child sessions after MAIN acceptance. Releases their conversation memory, preserves submitted results. Required before final publication.", parameters: Type.Object({}, { additionalProperties: false }) },
];
const CHILD_TOOLS: Tool[] = [...SUBTITLE_AGENT_TOOLS, {
  name: "read_context", description: "Read/search the entire read-only source for context outside your assignment. Offsets are global cue positions. Never translate IDs outside your assignment.",
  parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), query: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
}];

export function initialTranslationTeamState(input: DocumentInput): TranslationTeamState {
  translationTeamModelConfig(input, "main");
  translationTeamModelConfig(input, "subagent");
  const state: TranslationTeamState = { ...initialSubtitleAgentState(input), brief: "", children: [], acceptedRevision: -1, acceptance: "" };
  const context = teamContext(subtitleAgentContext(input, state), state);
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
    if (!a || typeof a.brief !== "string" || !a.brief.trim() || a.brief.length > 12000 || !Array.isArray(a.assignments) || !a.assignments.length || a.assignments.length > MAX_SUBAGENTS) throw new WorkspaceError("Provide a shared brief and 1-9 assignments");
    const assignments = a.assignments as Assignment[];
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
      ...assignment, id: `subagent-${index + 1}`, status: "running", agent: initialSubtitleAgentState(childInput(input, assignment)), failures: 0, error: "", terminal: false, retryAt: 0,
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
function teamContext(context: Context, state: TranslationTeamState): Context {
  return { ...context, systemPrompt: TEAM_PROMPT, messages: [
    ...context.messages.slice(0, 1),
    { role: "user", timestamp: 0, content: JSON.stringify({ role: "main", shared_brief: state.brief,
      subagents: state.children.map(c => ({ id: c.id, start_id: c.start_id, end_id: c.end_id, instructions: c.instructions, status: c.status, translated_cues: Object.keys(c.agent.draft).length })),
      accepted_revision: state.acceptedRevision, current_revision: state.revision, acceptance: state.acceptance,
    }) }, ...context.messages.slice(1),
  ] };
}

/** One durable round: one main turn OR one concurrent turn per live child. */
export async function advanceTranslationTeam(input: DocumentInput, previous: TranslationTeamState, call: (context: Context) => Promise<AssistantMessage>): Promise<TranslationTeamState> {
  const state = structuredClone(previous);
  const running = state.children.filter(c => c.status === "running");
  if (!running.length) {
    return await advanceSubtitleAgent(input, state, call, {
      tools: TEAM_TOOLS,
      context: context => teamContext(context, state),
      tool: (s, name, args) => translationTeamTool(input, s as TranslationTeamState, name, args),
    }) as TranslationTeamState;
  }
  const failed = running.find(c => c.terminal || c.failures > 2);
  if (failed) throw new DocumentPermanentError("convergence", `${failed.id}: ${failed.error}`);
  await Promise.all(running.map(async child => {
    // A transient failure only replays this child's pending turn, never siblings.
    if (child.retryAt > Date.now()) return;
    const assigned = childInput(input, child);
    try {
      child.agent = await advanceSubtitleAgent(assigned, child.agent, call, {
        tools: CHILD_TOOLS,
        context: context => ({ ...context, systemPrompt: `${SUBTITLE_AGENT_PROMPT}\nYou are a translation SUBAGENT. Translate ONLY your assigned source.json IDs. Follow the MAIN agent's shared style and terminology brief. Use read_context to check later definitions or surrounding sentences in the full source. Submit your own complete assignment with validate_translation and finish_translation; the MAIN agent will review it.`, messages: [
          ...context.messages.slice(0, 1), { role: "user", timestamp: 0, content: JSON.stringify({ role: "subagent", id: child.id, shared_brief: state.brief, assignment: { start_id: child.start_id, end_id: child.end_id, instructions: child.instructions } }) }, ...context.messages.slice(1),
        ] }),
        tool: (s, name, args) => {
          if (name !== "read_context") return subtitleAgentTool(assigned, s, name, args);
          const a = args as { offset?: number; count?: number; query?: string };
          return subtitleAgentTool(input, s, a.query ? "search_file" : "read_file", { ...a, path: "source.json" });
        },
      });
      child.failures = 0; child.error = ""; child.retryAt = 0;
      if (child.agent.stage === "publish") {
        // Validate the scoped draft before merging. Source IDs never overlap.
        const cues = finalSubtitleAgentCues(assigned, child.agent);
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
  }));
  state.cursor++;
  state.feedback = completed(state) ? "All subagents completed. Review the actual merged translations, fix inconsistencies, accept_translation, close_subagents, then validate and finish." : "";
  return state;
}

export function finalTranslationTeamCues(input: DocumentInput, state: TranslationTeamState) {
  if (!accepted(state) || state.children.some(c => c.status !== "closed")) throw new Error("Translation team has not been accepted and closed");
  return finalSubtitleAgentCues(input, state);
}
export const TranslationTeamTask = createDocumentTask({
  name: "subtitle_translation_team", initial: initialTranslationTeamState, advance: advanceTranslationTeam,
  call: (input, state, context, options) => callDocumentTurn({
    ...input, config: translationTeamModelConfig(input, state.children.some(c => c.status === "running") ? "subagent" : "main"),
  }, context, options),
  finalCues: finalTranslationTeamCues,
  resume: state => ({ ...state, children: state.children.map(c => ({ ...c, failures: 0, error: "", terminal: false, retryAt: 0 })) }),
  wakeAt: state => {
    const running = state.children.filter(c => c.status === "running");
    return running.length && running.every(c => !c.terminal && c.failures <= 2 && c.retryAt > Date.now()) ? Math.min(...running.map(c => c.retryAt)) : 0;
  },
  progress: (input, state) => `${Object.keys(state.draft).length}/${input.cues.length}，子 Agent ${state.children.filter(c => c.status !== "running").length}/${state.children.length}，${state.children.some(c => c.status === "running") ? "并行翻译中" : state.children.length ? "主 Agent 验收" : "主 Agent 规划"}`,
});
