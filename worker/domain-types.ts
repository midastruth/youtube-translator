export type SourceCue = { cue_id: string; start: number; end: number; text: string };
export type InputCue = { cue_id?: string; start?: number; end?: number; text: string };
export type PublishedCue = SourceCue & { translation: string; index?: number };
export type Draft = Record<string, string>;
export type ReviewIssue = { cue_id?: string; reason: string; details?: string };
export type ReviewResult = { passed: boolean; issues: ReviewIssue[] };
export type CueBlock<T = SourceCue> = {
  blockIndex: number; cues: T[]; contextBefore: T[]; contextAfter: T[];
  totalCuesInBlock: number; isLastBlock: boolean;
};
export type FinalResult = {
  status: string; total_cues: number; failed_cues: number; published_cues: number;
  cues: PublishedCue[];
};
export type JobDocument = {
  job_key: string; video_id: string; from_lang: string; to_lang: string; status: string; stage: string;
  source_cues: SourceCue[]; published_cues: Record<string, PublishedCue>; failed_cues: string[];
  glossary: Draft; network_attempts: number; budget_limit: number; revisions: Record<string, number>;
  cancelled: boolean; final_result: FinalResult | null;
};
export type TaskInput = {
  jobId: string; jobKey: string; videoId: string; title: string; fromLang: string; toLang: string;
  cues: SourceCue[]; budgetLimit: number; maxCuesPerBlock: number; initialGlossary: Draft;
  contextWindow?: number; reserveOutputTokens?: number;
};
export type TaskCheckpoint = {
  phase: string; blockIndex: number; revisions: number; draft: Draft | null;
  issues: ReviewIssue[]; blocks: CueBlock[]; networkAttempts: number;
};
export type TaskResult = FinalResult | { cancelled: boolean; published_cues: PublishedCue[] }
  | { status: string; published_cues: PublishedCue[]; failed_cues: string[] };
export type ModelMocks = {
  translatorMock?: ((input: { cues: SourceCue[]; contextBefore: SourceCue[]; contextAfter: SourceCue[]; glossary: Draft; attempt: number }) => Promise<Draft>) | null;
  reviewerMock?: ((input: { cues: SourceCue[]; draft: Draft; revisions: number }) => Promise<ReviewResult>) | null;
  revisorMock?: ((input: { cues: SourceCue[]; draft: Draft; issues: ReviewIssue[]; revisions: number }) => Promise<Draft>) | null;
};
