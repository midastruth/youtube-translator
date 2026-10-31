export type SubtitleTrack = {
  language: string;
  source: "manual" | "automatic";
  label: string;
};

/**
 * Subtitle cue representation.
 * Note: While internal segmentation algorithms in Pane 1 may temporarily work in seconds,
 * all gateway API requests/responses (SSE events, REST endpoints), frontend extensions,
 * and Worker domain types strictly operate in MILLISECONDS.
 */
export type SubtitleCue = {
  start: number; // in milliseconds (Gateway API & Worker domain)
  end: number;   // in milliseconds (Gateway API & Worker domain)
  text: string;
  translation?: string;
  cue_id?: string;
};

export type SubtitleRequest = {
  url: string;
  language?: string;
  languages?: string[];
  allow_automatic?: boolean;
  segmentation?: "rule" | "statistical";
  translate_to?: string;
  translate_engine?: "legacy" | "agent" | "document";
  translate_provider?: string;
  translate_api_key?: string;
  translate_base_url?: string;
  translate_model?: string;
  translate_whole?: boolean;
  translate_context_tokens?: number;
  translate_output_tokens?: number;
  translate_request_budget?: number;
  whisper_enabled?: boolean;
  whisper_api_key?: string;
  whisper_base_url?: string;
  whisper_model?: string;
  whisper_language?: string;
  source_events?: any[];
  source_cues?: any[];
  source_video_id?: string;
  source_title?: string;
  source_language?: string;
};

export type SubtitleResponse = {
  video_id: string;
  title: string;
  from_lang: string;
  to_lang?: string;
  segmentation: string;
  source: "manual" | "automatic" | "whisper";
  cues: SubtitleCue[];
  progress: number;
  translation_status: "succeeded" | "partial" | "failed" | "not_requested";
  failed_cues: number;
  job_id?: string;
};

export type TracksResponse = {
  video_id: string;
  title: string;
  tracks: SubtitleTrack[];
};

export type HealthResponse = {
  status: string;
  version: string;
};

export type AbortJobRequest = {
  job_id: string;
};

export type AbortJobResponse = {
  success: boolean;
  job_id: string;
};

export type FlatEvent = {
  text: string;
  start: number; // in milliseconds
  end: number;   // in milliseconds
};

export type PreparedEvents = {
  events: any[];
  flat_events: FlatEvent[];
  filtered_non_speech_count: number;
  flatEvents?: FlatEvent[];
  filteredNonSpeechCount?: number;
};
