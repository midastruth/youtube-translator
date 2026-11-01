import { inPlaybackWindow, PLAYBACK_MAX_CUES, PLAYBACK_MAX_TEXT } from "../../shared/playback-window.js";
import type { SubtitleCue, SubtitleRequest } from "./types.js";

export type PlaybackWindowRequest = SubtitleRequest & { playback_ms?: number };
export type IndexedCue = SubtitleCue & { index: number };

/** Called after normal subtitle-request validation; no ingestion or re-segmentation. */
export function playbackWindowCues(body: PlaybackWindowRequest): IndexedCue[] {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 422 }); };
  if (!body.translate_to?.trim() || !body.source_language?.trim()) invalid("translate_to and source_language are required");
  if (body.translate_engine && body.translate_engine !== "legacy") invalid("Playback windows use legacy translation only");
  const position = body.playback_ms;
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0) invalid("playback_ms must be a non-negative finite number");
  const cues = body.source_cues;
  if (!Array.isArray(cues) || !cues.length || cues.length > PLAYBACK_MAX_CUES || body.source_events !== undefined) {
    invalid(`source_cues must contain 1 to ${PLAYBACK_MAX_CUES} already-segmented cues`);
  }
  const indices = new Set<number>();
  let length = 0;
  return cues!.map(cue => {
    if (!Number.isSafeInteger(cue.index) || cue.index < 0 || indices.has(cue.index)) invalid("Cue indices must be unique non-negative integers");
    if (!inPlaybackWindow(cue, position!)) invalid("Cue is outside the playback window");
    indices.add(cue.index);
    length += cue.text.length;
    if (length > PLAYBACK_MAX_TEXT) invalid("Playback window text is too large");
    // Never accept a caller-supplied translation or pass unrelated properties on.
    return { index: cue.index, start: cue.start, end: cue.end, text: cue.text };
  });
}
