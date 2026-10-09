export type ExtensionSettings = {
  backendUrl: string; languages: string; toLang: string; segmentation: string;
  translateEngine: string; translateProvider: string; translateApiKey: string; translateBaseUrl: string; translateModel: string;
  translateWhole: boolean; autoTranslate: boolean; enabled: boolean;
  whisperEnabled: boolean; whisperApiKey: string; whisperBaseUrl: string; whisperModel: string; whisperLanguage: string;
  isBilingual: boolean; fontSizeOrig: number; fontSizeTran: number; positionY: number;
  origColor: string; tranColor: string; bgOpacity: number;
};
export type StoredSettings = { ytsSettings?: Partial<ExtensionSettings> };
export type Subtitle = { start: number; end: number; text: string; translation?: string };
export type Json3Segment = { utf8: string; tOffsetMs?: number };
export type Json3Event = { tStartMs: number; dDurationMs: number; segs: Json3Segment[]; aAppend?: number };
export type BrowserSubtitles = { videoId: string; title?: string; language: string; events?: Json3Event[]; cues?: Subtitle[] };
export type SubtitlePayload = { events?: Json3Event[]; cues?: Subtitle[] };
export type CaptionTrack = { baseUrl: string; languageCode?: string; kind?: string };
export type PlayerResponse = { videoDetails?: { videoId?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } };
export type StreamRequest = {
  url: string; languages: string[]; allow_automatic: boolean; segmentation: string;
  source_events?: Json3Event[]; source_cues?: Subtitle[]; source_video_id?: string; source_title?: string; source_language?: string;
  language?: string; translate_to?: string; translate_engine?: string; translate_provider?: string;
  translate_api_key?: string; translate_base_url?: string; translate_model?: string; translate_whole?: boolean;
  whisper_enabled?: boolean; whisper_api_key?: string; whisper_base_url?: string; whisper_model?: string; whisper_language?: string;
};
export type SubtitleEvent = {
  type: string; total_cues?: number; completed_cues?: number; failed_cues?: number; index?: number;
  start?: number; end?: number; text?: string; translation?: string; cached?: boolean;
  detail?: string; code?: string; hide_after_ms?: number;
};
export type DisplayError = Error & { code?: string; hideAfterMs?: number };
export function displayError(value: unknown): DisplayError {
  return value instanceof Error ? value : new Error(String(value));
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseBrowserSubtitles(raw: unknown): BrowserSubtitles | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!record(value) || typeof value.videoId !== "string" || typeof value.language !== "string") return null;
  const detail: BrowserSubtitles = { videoId: value.videoId, language: value.language };
  if (typeof value.title === "string") detail.title = value.title;
  if (Array.isArray(value.events)) detail.events = normalizeJson3({ events: value.events });
  if (Array.isArray(value.cues)) detail.cues = value.cues.filter((cue): cue is Subtitle =>
    record(cue) && typeof cue.start === "number" && typeof cue.end === "number" && typeof cue.text === "string");
  return detail;
}
export function normalizeJson3(data: unknown): Json3Event[] {
  if (!record(data) || !Array.isArray(data.events)) return [];
  return data.events.filter((event): event is Record<string, unknown> =>
    record(event) && Number.isFinite(Number(event.tStartMs)) && Array.isArray(event.segs)
  ).map(event => {
    const segs = Array.isArray(event.segs) ? event.segs : [];
    const out: Json3Event = {
      tStartMs: Number(event.tStartMs), dDurationMs: Number(event.dDurationMs || 0),
      segs: segs.map((seg: unknown) => {
        const s: Json3Segment = { utf8: record(seg) ? String(seg.utf8 ?? "") : "" };
        if (record(seg) && Number.isFinite(Number(seg.tOffsetMs))) s.tOffsetMs = Number(seg.tOffsetMs);
        return s;
      }),
    };
    if (event.aAppend === 1) out.aAppend = 1;
    return out;
  });
}

declare global {
  interface Window { ytInitialPlayerResponse?: PlayerResponse }
  interface HTMLElement { getPlayerResponse?: () => PlayerResponse }
  interface XMLHttpRequest { __ytsCaptionUrl?: string }
  interface WindowEventMap {
    "yts-request-subtitles": CustomEvent<unknown>;
    "yts-browser-subtitles": CustomEvent<unknown>;
  }
}
