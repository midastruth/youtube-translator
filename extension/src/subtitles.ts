import type { Subtitle } from "./types.js";

export type PendingSubtitle = Omit<Subtitle, "start" | "end"> & Partial<Pick<Subtitle, "start" | "end">>;

export function videoIdFromUrl(url: string) {
  try { return new URL(url).searchParams.get("v") || ""; } catch { return ""; }
}

export function subtitleIndexAt(subtitles: PendingSubtitle[], ms: number) {
  let lo = 0, hi = subtitles.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >>> 1, s = subtitles[m];
    if (ms >= Number(s.start) && ms <= Number(s.end)) return m;
    if (ms < Number(s.start)) hi = m - 1; else lo = m + 1;
  }
  return -1;
}

export function exportableSubtitles(subtitles: PendingSubtitle[]): Subtitle[] {
  return subtitles.filter((s): s is Subtitle => (
    s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && Boolean(s.text)
  ));
}

export function formatVttTime(ms: number) {
  const s = ms / 1000;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

export function formatVtt(subtitles: Subtitle[]) {
  const lines = ["WEBVTT", ""];
  subtitles.forEach((s, i) => {
    lines.push(`${i + 1}`, `${formatVttTime(s.start)} --> ${formatVttTime(s.end)}`, s.text);
    if (s.translation) lines.push(s.translation);
    lines.push("");
  });
  return lines.join("\n");
}
