import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { DocumentInput } from "./document-translation.js";
import { inputBudget, tokenEstimate } from "./document-translation.js";
import { WorkspaceError } from "./subtitle-agent.js";

/** Half-open cue-position intervals, not claims of semantic understanding. */
type Range = [start: number, end: number];
export type MainProgress = {
  plan: string; sourceRead: Range[];
  reviewRevision: number; reviewRead: Range[]; translationRead: Range[]; reviewed: Range[]; reviewSummary: string;
  checklist?: { revision: number; flagged_total: number; issue_counts: Record<string, number>; flagged_offsets: number[]; boundary_offsets: number[] };
  guard: { phase: "planning" | "review"; turns: number; stalled: number };
};
type Workspace = { revision: number; mainProgress?: MainProgress };

export const MAIN_PROGRESS_TOOLS: Tool[] = [
  { name: "save_plan", description: "Persist a compact cumulative understanding/style/terminology plan and unresolved questions BEFORE reading more source. Survives compaction/restart; does not dispatch. Do not transcribe the source.", parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }) },
  { name: "record_review", description: "Explicitly confirm semantic review of a delivered bilingual page at the current revision. Reading alone is NOT review. Persist a cumulative summary of decisions and remaining issues; offset/count must describe actual returned rows (not the requested page size). Survives compaction/restart. Does not accept or publish the translation.", parameters: Type.Object({ offset: Type.Integer({ minimum: 0 }), count: Type.Integer({ minimum: 1, maximum: 400 }), revision: Type.Integer({ minimum: 0 }), summary: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }) },
];

export function mainProgress(state: Workspace): MainProgress {
  const p = state.mainProgress ??= {
    plan: "", sourceRead: [], reviewRevision: state.revision, reviewRead: [], translationRead: [], reviewed: [], reviewSummary: "",
    guard: { phase: "planning", turns: 0, stalled: 0 },
  };
  p.translationRead ??= [];
  // Legacy checkpoints have no review evidence. Never infer review from draft coverage.
  if (p.reviewRevision !== state.revision) {
    p.reviewRevision = state.revision; p.reviewRead = []; p.translationRead = []; p.reviewed = []; p.reviewSummary = ""; delete p.checklist;
  }
  return p;
}
export function addRange(ranges: Range[], start: number, end: number): Range[] {
  if (end <= start) return ranges;
  const result: Range[] = [];
  for (const range of [...ranges, [start, end] as Range].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}
export const rangeCount = (ranges: Range[]) => ranges.reduce((n, [start, end]) => n + end - start, 0);
export function nextUnread(ranges: Range[], total: number) {
  const offset = ranges[0]?.[0] === 0 ? ranges[0][1] : 0;
  return offset < total ? offset : null;
}
function without(ranges: Range[], offsets: Set<number>): Range[] {
  const result: Range[] = [];
  for (const [start, end] of ranges) {
    let from = start;
    for (let i = start; i < end; i++) if (offsets.has(i)) {
      if (i > from) result.push([from, i]);
      from = i + 1;
    }
    if (from < end) result.push([from, end]);
  }
  return result;
}
export function invalidateReview(state: Workspace, changedOffsets: number[]) {
  const p = state.mainProgress;
  if (!p) return;
  const changed = new Set(changedOffsets);
  p.reviewRead = without(p.reviewRead, changed); p.translationRead = without(p.translationRead ?? [], changed); p.reviewed = without(p.reviewed, changed);
  p.reviewRevision = state.revision;
  delete p.checklist;
}
export function progressTool(input: DocumentInput, state: Workspace, name: string, args: Record<string, unknown>) {
  const p = mainProgress(state);
  if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 2000 || tokenEstimate(args.summary) > inputBudget(input.config) * 0.08) {
    throw new WorkspaceError("Provide a compact nonempty cumulative summary within the context budget");
  }
  if (name === "save_plan") { p.plan = args.summary; return { saved: true }; }
  const { offset, count, revision } = args;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 400 || (offset as number) + (count as number) > input.cues.length) {
    throw new WorkspaceError("Review range must contain 1-400 source cues within the document");
  }
  if (revision !== state.revision) throw new WorkspaceError("Review revision is stale; read the current bilingual page again");
  const end = (offset as number) + (count as number);
  if (!p.reviewRead.some(([a, b]) => a <= (offset as number) && b >= end)) throw new WorkspaceError("Read the requested bilingual rows before recording semantic review");
  p.reviewed = addRange(p.reviewed, offset as number, end); p.reviewSummary = args.summary;
  return { saved: true, reviewed_cues: rangeCount(p.reviewed), next_review_offset: nextUnread(p.reviewed, input.cues.length) };
}
export function progressStatus(state: Workspace, total: number) {
  const p = mainProgress(state);
  return {
    plan_summary: p.plan, source_read_ranges: p.sourceRead.slice(0, 20), source_read_cues: rangeCount(p.sourceRead), next_source_offset: nextUnread(p.sourceRead, total),
    review_revision: p.reviewRevision, bilingual_read_cues: rangeCount(p.reviewRead), translation_read_cues: rangeCount(p.translationRead), reviewed_ranges: p.reviewed.slice(0, 20), reviewed_cues: rangeCount(p.reviewed),
    next_review_offset: nextUnread(p.reviewed, total), review_summary: p.reviewSummary, checklist: p.checklist ?? null,
    guard: p.guard,
  };
}
