import { inPlaybackWindow, PLAYBACK_MAX_CUES, PLAYBACK_MAX_TEXT } from "../../shared/playback-window.js";
import { usableTranslation } from "./subtitles.js";
import type { PendingSubtitle } from "./subtitles.js";
import type { Subtitle } from "./types.js";

export type IndexedSubtitle = Subtitle & { index: number };
export type WindowTranslation = { index: number; translation?: string };

type Options = {
  subtitles: () => PendingSubtitle[];
  position: () => number;
  request: (cues: IndexedSubtitle[], position: number, signal: AbortSignal) => Promise<WindowTranslation[]>;
  refresh: () => void;
};

/** One small request at a time. Playback, not document progress, drives the window. */
export class PlaybackFallback {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { controller: AbortController; cues: IndexedSubtitle[] };
  private retryAfter = new Map<number, number>();
  private stopped = false;

  constructor(private options: Options) {}

  update() {
    if (this.stopped) return;
    const position = this.options.position();
    if (this.active && !this.active.cues.some(cue => inPlaybackWindow(cue, position)
      && !usableTranslation(this.options.subtitles()[cue.index]?.translation))) {
      // Seeked away, or document supplied every outstanding translation.
      this.active.controller.abort();
      this.active = undefined;
    }
    if (!this.active && !this.timer) {
      // Coalesce the source_cue burst before deciding what to translate.
      this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, 100);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.controller.abort();
    this.active = undefined;
    this.retryAfter.clear();
  }

  private async run() {
    if (this.stopped || this.active) return;
    const position = this.options.position();
    if (!Number.isFinite(position) || position < 0) return;
    const now = Date.now();
    const candidates: IndexedSubtitle[] = [];
    this.options.subtitles().forEach((cue, index) => {
      if (cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text.trim()
        && !usableTranslation(cue.translation) && (this.retryAfter.get(index) || 0) <= now) {
        const indexed = { index, start: cue.start!, end: cue.end!, text: cue.text };
        if (inPlaybackWindow(indexed, position)) candidates.push(indexed);
      }
    });
    // Current speech first, then future, then already-passed subtitles.
    const priority = (cue: IndexedSubtitle) => cue.end < position ? 2 : cue.start <= position ? 0 : 1;
    candidates.sort((a, b) => priority(a) - priority(b) || Math.abs(a.start - position) - Math.abs(b.start - position));
    let length = 0;
    const cues: IndexedSubtitle[] = [];
    for (const cue of candidates) {
      if (cues.length >= PLAYBACK_MAX_CUES) break;
      if (length + cue.text.length > PLAYBACK_MAX_TEXT) continue;
      length += cue.text.length;
      cues.push(cue);
    }
    cues.sort((a, b) => a.index - b.index);
    if (!cues.length) return;
    const active = { controller: new AbortController(), cues };
    this.active = active;
    // Failed/partial windows may be retried, but never on every timeupdate.
    for (const cue of cues) this.retryAfter.set(cue.index, now + 30_000);
    try {
      const result = await this.options.request(cues, position, active.controller.signal);
      if (this.stopped || active.controller.signal.aborted || this.active !== active) return;
      const requested = new Map(cues.map(cue => [cue.index, cue]));
      for (const row of result) {
        const original = requested.get(row.index), current = this.options.subtitles()[row.index];
        if (!original || !current || current.text !== original.text || current.start !== original.start
          || current.end !== original.end || usableTranslation(current.translation) || !usableTranslation(row.translation)) continue;
        current.translation = row.translation;
        current.translationSource = "legacy";
        this.retryAfter.delete(row.index);
      }
      this.options.refresh();
    } catch {
      // Best-effort temporary subtitles must never fail/restart the durable document task.
    } finally {
      if (this.active === active) {
        this.active = undefined;
        this.update();
      }
    }
  }
}
