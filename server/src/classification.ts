/**
 * Subtitle text classification — mirrors kiss-translator's subtitleTextClassification.js.
 * Detects whether a subtitle segment consists entirely of non-speech markers.
 */

// Pure bracket/parenthesized segments or musical notes are sound descriptions.
// Examples: [Music], (Laughter), [Applause], ♪, ♫, or combinations like >> [Music]
const NON_SPEECH_SEGMENT_RE = /^(?:>>\s*)?(?:(?:\[[^\]\r\n]+\]|\([^)\r\n]+\)|[♪♫♩♬]+)\s*)+$/;

export function is_non_speech_segment(text: string = ""): boolean {
  if (!text || typeof text !== "string") {
    return false;
  }
  return NON_SPEECH_SEGMENT_RE.test(text.trim());
}

export const isNonSpeechSegment = is_non_speech_segment;
