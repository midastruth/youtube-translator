export type SourceCue = { cue_id: string; start: number; end: number; text: string };
export type InputCue = { cue_id?: string; start?: number; end?: number; text: string };
export type PublishedCue = SourceCue & { translation: string; index?: number };
export type Draft = Record<string, string>;
export type FinalResult = {
  status: string; total_cues: number; failed_cues: number; published_cues: number;
  cues: PublishedCue[];
};
export type JobDocument = {
  job_key: string; video_id: string; from_lang: string; to_lang: string; status: string; stage: string;
  source_cues: SourceCue[]; published_cues: Record<string, PublishedCue>; failed_cues: string[];
  // Submitted, self-checked opening; provisional until whole-document acceptance.
  preview_cues?: Record<string, PublishedCue>;
  network_attempts: number; budget_limit: number;
  cancelled: boolean; final_result: FinalResult | null;
  engine?: string; job_id?: string; title?: string; task_id?: number; error?: string; progress?: string;
};
export type TaskResult = FinalResult | { cancelled: boolean; published_cues: PublishedCue[] };
