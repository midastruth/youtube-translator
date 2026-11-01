/** Bounds for the temporary legacy translation around the player's clock (ms). */
export const PLAYBACK_BEFORE_MS = 10_000;
export const PLAYBACK_AFTER_MS = 45_000;
export const PLAYBACK_MAX_CUES = 12;
export const PLAYBACK_MAX_TEXT = 12_000;

export function inPlaybackWindow(cue: { start: number; end: number }, position: number) {
  return cue.end >= position - PLAYBACK_BEFORE_MS && cue.start <= position + PLAYBACK_AFTER_MS;
}
