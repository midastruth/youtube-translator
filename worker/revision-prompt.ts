import type { SourceCue, Draft, ReviewIssue } from "./domain-types.js";

/** Builds a targeted revision prompt for the model. */
export function buildRevisionPrompt({ cues, draftTranslations, issues, contextBefore = [], contextAfter = [] }: {
  cues: SourceCue[]; draftTranslations: Draft; issues: ReviewIssue[]; contextBefore?: SourceCue[]; contextAfter?: SourceCue[];
}) {
  return {
    instruction: "Please revise the translation based on the specific review issues identified.",
    cues, draftTranslations, issues, contextBefore, contextAfter,
  };
}
