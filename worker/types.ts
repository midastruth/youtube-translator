import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { EventEmitter } from "node:events";

// Compatibility facade for application consumers; core modules use domain-types directly.
export type * from "./domain-types.js";
import type { SourceCue, InputCue, FinalResult, TaskResult } from "./domain-types.js";
export type SubmitJobOptions = {
  cues?: InputCue[]; videoId?: string; title?: string; fromLang?: string; toLang?: string;
  segmentation?: string; provider?: string; model?: string; baseUrl?: string;
  budgetLimit?: number; engine?: string; apiKey?: string; contextTokens?: number; outputTokens?: number;
};
export type JobRecord = {
  jobId: string; jobKey: string; taskId: TaskId<TaskResult> | null; conversationId: ConversationId;
  videoId: string; title: string; fromLang: string; toLang: string; cues: SourceCue[];
  status: string; emitter: EventEmitter; finalResult?: FinalResult | null;
  taskPromise?: Promise<void> | null; aborted: boolean; error?: unknown; engine?: string;
};
export type StreamEvent = {
  type: string; index?: number; cue_id?: string; start?: number; end?: number; text?: string;
  translation?: string; cached?: boolean; video_id?: string; title?: string; from_lang?: string; to_lang?: string;
  total_cues?: number; completed_cues?: number; failed_cues?: number; code?: string; detail?: string;
  stage?: string; progress?: string; provisional?: boolean;
};
