import type { BrowserSubtitles, ExtensionSettings, StreamRequest, SubtitlePayload } from "./types.js";

export type BackendTrack = { source: string; language: string };

export function selectBackendTrack(tracks: BackendTrack[], languages: string[]) {
  let track: BackendTrack | undefined;
  for (const source of ["manual", "automatic"]) {
    for (const language of languages) {
      const prefix = language.split("-")[0].toLowerCase();
      track = tracks.find(t => t.source === source && t.language.toLowerCase().startsWith(prefix));
      if (track) break;
    }
    if (track) break;
  }
  return track || tracks[0];
}

export function hasBrowserSubtitles(detail: SubtitlePayload | BrowserSubtitles | null) {
  return Boolean(detail && (
    (Array.isArray(detail.events) && detail.events.length)
    || (Array.isArray(detail.cues) && detail.cues.length)
  ));
}

export function buildStreamRequest({ pageUrl, languages, track, browserSubtitles, title, settings }: {
  pageUrl: string; languages: string[]; track?: BackendTrack; browserSubtitles: BrowserSubtitles | null;
  title: string; settings: ExtensionSettings;
}): StreamRequest {
  const body: StreamRequest = {
    url: pageUrl,
    languages: track ? [track.language] : languages,
    allow_automatic: true,
    segmentation: settings.segmentation || "rule",
  };
  if (browserSubtitles) {
    if (browserSubtitles.events?.length) body.source_events = browserSubtitles.events;
    else body.source_cues = browserSubtitles.cues;
    body.source_video_id = browserSubtitles.videoId;
    body.source_title = browserSubtitles.title || title.replace(/ - YouTube$/, "");
    body.source_language = browserSubtitles.language;
    body.languages = [browserSubtitles.language].filter(l => l && l !== "auto");
    if (!body.languages.length) body.languages = languages;
  }
  if (track) body.language = track.language;
  applyTranslationSettings(body, settings);
  applyWhisperSettings(body, settings);
  return body;
}

function applyTranslationSettings(body: StreamRequest, settings: ExtensionSettings) {
  if (settings.autoTranslate === false || !settings.toLang) return;
  body.translate_to = settings.toLang;
  body.translate_engine = settings.translateEngine || "legacy";
  body.translate_provider = settings.translateProvider || "openai";
  if (settings.translateApiKey) body.translate_api_key = settings.translateApiKey;
  if (settings.translateBaseUrl) body.translate_base_url = settings.translateBaseUrl;
  if (settings.translateModel) body.translate_model = settings.translateModel;
  if (settings.translateWhole) body.translate_whole = true;
}

function applyWhisperSettings(body: StreamRequest, settings: ExtensionSettings) {
  if (!settings.whisperEnabled) return;
  body.whisper_enabled = true;
  if (settings.whisperApiKey) body.whisper_api_key = settings.whisperApiKey;
  if (settings.whisperBaseUrl) body.whisper_base_url = settings.whisperBaseUrl;
  if (settings.whisperModel) body.whisper_model = settings.whisperModel;
  if (settings.whisperLanguage) body.whisper_language = settings.whisperLanguage;
}
