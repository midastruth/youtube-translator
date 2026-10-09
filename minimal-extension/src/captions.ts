import type { CaptionTrack } from "./types.js";

/** Preference shared by passive captures and active player-track selection. */
export function captionLanguageRank(code: string | undefined, languages: string[]) {
  const value = String(code || "").toLowerCase();
  if (!value || value === "auto") return languages.length + 1;
  const exact = languages.findIndex(l => l.toLowerCase() === value);
  if (exact >= 0) return exact;
  const prefix = value.split("-")[0];
  const related = languages.findIndex(l => l.toLowerCase().split("-")[0] === prefix);
  return related >= 0 ? related : languages.length;
}

export function selectPlayerCaptionTrack(tracks: CaptionTrack[], languages: string[]) {
  const usable = tracks.filter(t => t?.baseUrl);
  if (!usable.length) return null;
  // Manual tracks precede ASR; equal ranks retain the player's original order.
  return [...usable].sort((a, b) => (
    Number(a.kind === "asr") - Number(b.kind === "asr")
    || captionLanguageRank(a.languageCode, languages) - captionLanguageRank(b.languageCode, languages)
  ))[0];
}

/** Auto-translated responses must never become original-language source cues. */
export function originalCaptionInfo(url: string, pageUrl: string) {
  try {
    const parsed = new URL(url, pageUrl);
    if (!/\/api\/timedtext/i.test(parsed.pathname) || parsed.searchParams.get("tlang")) return null;
    return {
      videoId: parsed.searchParams.get("v") || "",
      language: parsed.searchParams.get("lang") || "auto",
    };
  } catch {
    return null;
  }
}
