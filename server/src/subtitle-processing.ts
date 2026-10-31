/**
 * YouTube subtitle processing — mirrors kiss-translator's youtubeSubtitleProcessing.js
 * and sentenceBreaker.js.
 *
 * Provides: HTML cleaning, event flattening, rule-based sentence breaking,
 * statistical (Z-Score/MAD) intelligent segmentation.
 */

import { is_non_speech_segment } from "./classification.js";
import type { FlatEvent, PreparedEvents, SubtitleCue } from "./types.js";

export type { FlatEvent, PreparedEvents, SubtitleCue };

// ── helpers ────────────────────────────────────────────────────────────

const HTML_TAG_RE = /<[^>]+>/g;
const ZERO_WIDTH_SPACE_RE = /\u200B/g;

export function cleanTimedText(utf8?: string | null): string {
  if (utf8 === undefined || utf8 === null) {
    return "";
  }
  const text = String(utf8)
    .replace(HTML_TAG_RE, "")
    .replace(ZERO_WIDTH_SPACE_RE, "");
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

export const clean_timed_text = cleanTimedText;

// ── flat events ────────────────────────────────────────────────────────

export function prepareTimedTextEvents(rawEvents?: any[] | null): PreparedEvents {
  const eventsList: any[] = rawEvents || [];
  const events: any[] = [];
  const flatEvents: FlatEvent[] = [];
  let filteredNonSpeechCount = 0;
  let buffer: FlatEvent | null = null;
  let lastVisibleEventKey = "";

  function flushBuffer(endAt?: number): void {
    if (buffer === null) {
      return;
    }
    if (endAt !== undefined && endAt !== null && (buffer.end === undefined || buffer.end > endAt)) {
      buffer.end = endAt;
    }
    if (buffer.end !== undefined && buffer.end > buffer.start) {
      flatEvents.push(buffer);
    }
    buffer = null;
  }

  for (const rawEvent of eventsList) {
    const event = rawEvent || {};
    const rawSegs: any[] = event.segs || [];
    const tStartMs = Number(event.tStartMs || 0);
    const dDurationMs = Number(event.dDurationMs || 0);
    const isLineBreak =
      event.aAppend === 1 &&
      rawSegs.length === 1 &&
      rawSegs[0].utf8 === "\n";

    const normalizedSegs: any[] = [];
    for (const seg of rawSegs) {
      const s = { ...seg };
      s.utf8 = isLineBreak ? "\n" : cleanTimedText(s.utf8 || "");
      normalizedSegs.push(s);
    }

    let visibleText = normalizedSegs
      .map(s => cleanTimedText(s.utf8 || ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    visibleText = visibleText.replace(/\s+/g, " ");

    const eventKey = visibleText ? `${tStartMs}|${dDurationMs}|${visibleText}` : "";

    // Skip adjacent duplicates (same time, duration, and visible text).
    if (eventKey && eventKey === lastVisibleEventKey) {
      continue;
    }

    const canonicalEvent = { ...event, segs: normalizedSegs };
    events.push(canonicalEvent);
    lastVisibleEventKey = eventKey;

    for (let idx = 0; idx < normalizedSegs.length; idx++) {
      const seg = normalizedSegs[idx];
      const utf8 = seg.utf8 || "";
      const tOffsetMs = Number(seg.tOffsetMs || 0);
      const text = cleanTimedText(utf8);
      const start = tStartMs + tOffsetMs;

      if (!text) {
        if (buffer !== null && start > buffer.start) {
          flushBuffer(start);
        }
        continue;
      }

      if (is_non_speech_segment(text)) {
        flushBuffer(start);
        filteredNonSpeechCount++;
        continue;
      }

      flushBuffer(start);
      buffer = { text, start, end: tStartMs + dDurationMs };
      if (idx === normalizedSegs.length - 1) {
        buffer.end = tStartMs + dDurationMs;
      }
    }
  }

  flushBuffer(buffer ? buffer.end : undefined);

  const validFlatEvents = flatEvents.filter(fe => fe.end !== undefined && fe.end > fe.start);

  return {
    events,
    flat_events: validFlatEvents,
    flatEvents: validFlatEvents,
    filtered_non_speech_count: filteredNonSpeechCount,
    filteredNonSpeechCount,
  };
}

export const prepare_timed_text_events = prepareTimedTextEvents;

// ── conversion helper ──────────────────────────────────────────────────

export function toSubtitleCues(
  raw: Array<{ text: string; start: number; end: number; translation?: string; cue_id?: string }>,
): SubtitleCue[] {
  return raw.map((c, index) => {
    const startSec = Number((c.start / 1000).toFixed(3));
    const endSec = Number((c.end / 1000).toFixed(3));
    return {
      cue_id: c.cue_id || `c${index + 1}`,
      start: Number.isNaN(startSec) ? 0 : startSec,
      end: Number.isNaN(endSec) ? 0 : endSec,
      text: c.text,
      translation: c.translation || "",
    };
  });
}

// ── rule-based segmentation ────────────────────────────────────────────

const GROUPED_PAUSE_WORDS = new Set([
  "actually", "also", "although", "and", "anyway", "as", "basically",
  "because", "but", "eventually", "frankly", "honestly", "hopefully",
  "however", "if", "instead", "it's", "just", "let's", "like",
  "literally", "maybe", "meanwhile", "nevertheless", "nonetheless",
  "now", "okay", "or", "otherwise", "perhaps", "personally", "probably",
  "right", "since", "so", "suddenly", "that's", "then", "there's",
  "therefore", "though", "thus", "unless", "until", "well", "while",
]);

function isQualityPoor(
  items: Array<{ text: string }>,
  lengthThreshold: number = 200,
  percentageThreshold: number = 0.1,
): boolean {
  if (!items || !items.length) {
    return false;
  }
  const longCount = items.filter(it => (it.text || "").length > lengthThreshold).length;
  return longCount / items.length > percentageThreshold;
}

export function processSubtitles(
  flatEvents: FlatEvent[],
  usePause: boolean = false,
  timeout: number = 1000,
  maxWords: number = 15,
  maxDurationMs: number = 10000,
): Array<{ text: string; start: number; end: number; translation: string }> {
  const sentences: Array<{ text: string; start: number; end: number; translation: string }> = [];
  const currentBuffer: FlatEvent[] = [];
  let bufferWordCount = 0;

  function flush(): void {
    if (currentBuffer.length > 0) {
      sentences.push({
        text: currentBuffer.map(e => e.text).join(" ").trim(),
        start: currentBuffer[0].start,
        end: currentBuffer[currentBuffer.length - 1].end,
        translation: "",
      });
    }
    currentBuffer.length = 0;
    bufferWordCount = 0;
  }

  for (const segment of flatEvents) {
    if (!segment.text) {
      continue;
    }

    const last = currentBuffer.length > 0 ? currentBuffer[currentBuffer.length - 1] : null;

    if (last !== null) {
      const endsWithPunc = /[.?!…\])]$/.test(last.text);
      const endsWithComma = last.text.trimEnd().endsWith(",");
      const isTimeout = segment.start - last.end > timeout;
      const isDurExceeded = segment.start - currentBuffer[0].start >= maxDurationMs;
      const isWordLimited = (usePause || endsWithComma) && bufferWordCount >= maxWords;
      const startsWithSign = /^[\[(♪]/.test(segment.text);
      const firstWord = segment.text.trim().toLowerCase().split(/\s+/)[0];
      const startsWithPauseWord =
        usePause &&
        GROUPED_PAUSE_WORDS.has(firstWord) &&
        currentBuffer.length > 1;

      if (
        endsWithPunc ||
        isTimeout ||
        isDurExceeded ||
        isWordLimited ||
        startsWithSign ||
        startsWithPauseWord
      ) {
        flush();
      }
    }

    currentBuffer.push(segment);
    bufferWordCount += segment.text.trim().split(/\s+/).filter(Boolean).length;
  }

  flush();
  return sentences;
}

const NO_SPACE_LANGS = new Set(["zh", "ja", "ko", "th", "lo", "km", "my"]);

export function formatSubtitles(
  flatEvents: FlatEvent[],
  lang: string = "auto",
  longSentenceThreshold: number = 120,
): SubtitleCue[] {
  if (!flatEvents || !flatEvents.length) {
    return [];
  }

  const langCode = lang.slice(0, 2).toLowerCase();

  if (NO_SPACE_LANGS.has(langCode)) {
    const subtitles: Array<{ text: string; start: number; end: number; translation: string }> = [];
    if (
      isQualityPoor(
        flatEvents.map(e => ({ text: e.text })),
        5,
        0.5,
      )
    ) {
      return toSubtitleCues(
        flatEvents.map(e => ({ text: e.text, start: e.start, end: e.end, translation: "" })),
      );
    }

    let currentLine: { text: string; start: number; end: number; translation: string } | null = null;
    const MAX_LENGTH = 30;
    const PAUSE_THRESHOLD_MS = 1000;

    for (const segment of flatEvents) {
      if (!segment.text) {
        continue;
      }
      if (
        currentLine !== null &&
        segment.start - currentLine.end > PAUSE_THRESHOLD_MS
      ) {
        subtitles.push(currentLine);
        currentLine = null;
      }

      if (currentLine === null) {
        currentLine = {
          text: segment.text,
          start: segment.start,
          end: segment.end,
          translation: "",
        };
      } else {
        currentLine.text += segment.text;
        currentLine.end = segment.end;
      }

      const isEos = /[。！？.!?…]["'""」』】）》）\]]*$/.test(segment.text);
      if (isEos || currentLine.text.length >= MAX_LENGTH) {
        subtitles.push(currentLine);
        currentLine = null;
      }
    }

    if (currentLine !== null) {
      subtitles.push(currentLine);
    }
    return toSubtitleCues(subtitles);
  }

  // Latin / space-separated languages
  const rawSubtitles = processSubtitles(flatEvents);

  const result: Array<{ text: string; start: number; end: number; translation: string }> = [];
  for (const sub of rawSubtitles) {
    if (sub.text.length > longSentenceThreshold) {
      const subEvents = flatEvents.filter(
        e => e.start >= sub.start && e.start < sub.end,
      );
      if (subEvents.length > 1) {
        const reProcessed = processSubtitles(subEvents, true);
        result.push(...reProcessed);
      } else {
        result.push(sub);
      }
    } else {
      result.push(sub);
    }
  }

  return toSubtitleCues(result);
}

export const format_subtitles = formatSubtitles;

// ── statistical (Z-Score / MAD) intelligent segmentation ──────────────

interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
  stripped: string;
  endsWithSentencePunc: boolean;
  endsWithComma: boolean;
  startsWithCapital: boolean;
  isAllCaps: boolean;
  startsWithArrow: boolean;
}

function createWord(text: string, startMs: number, endMs: number): Word {
  const stripped = text.trim();
  const startsWithCapital =
    Boolean(stripped) &&
    stripped[0] !== stripped[0].toLowerCase() &&
    stripped[0] === stripped[0].toUpperCase();
  const isAllCaps =
    stripped.length >= 2 &&
    stripped === stripped.toUpperCase() &&
    stripped !== stripped.toLowerCase();
  return {
    text,
    start_ms: startMs,
    end_ms: endMs,
    stripped,
    endsWithSentencePunc: /[.?!]$/.test(stripped),
    endsWithComma: stripped.endsWith(","),
    startsWithCapital,
    isAllCaps,
    startsWithArrow: text.trimStart().startsWith(">>"),
  };
}

interface WordGap {
  gap_ms: number;
  prev_word: Word;
  next_word: Word;
  is_youtube_break: boolean;
  is_same_event: boolean;
  gap_index: number;
}

interface GapStats {
  mean: number;
  median: number;
  std: number;
  min_val: number;
  max_val: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  mad: number;
  robust_sigma: number;
}

function percentile(sortedData: number[], p: number): number {
  if (!sortedData.length) {
    return 0.0;
  }
  const n = sortedData.length;
  const k = ((n - 1) * p) / 100.0;
  const f = Math.floor(k);
  const c = Math.min(f + 1, n - 1);
  if (f === c) {
    return sortedData[f];
  }
  return sortedData[f] * (c - k) + sortedData[c] * (k - f);
}

function computeGapStats(
  gaps: WordGap[],
  excludeValues?: Set<number> | null,
): GapStats {
  const values = gaps
    .map(g => g.gap_ms)
    .filter(v => excludeValues == null || !excludeValues.has(v));
  values.sort((a, b) => a - b);

  if (!values.length) {
    return {
      mean: 0,
      median: 0,
      std: 0,
      min_val: 0,
      max_val: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      mad: 0,
      robust_sigma: 0,
    };
  }

  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const median = percentile(values, 50);

  let std = 0.0;
  if (n >= 2) {
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
    std = Math.sqrt(variance);
  }

  const absDevs = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs.length ? percentile(absDevs, 50) : 0.0;
  const robustSigma = mad * 1.4826;

  return {
    mean,
    median,
    std,
    min_val: values[0],
    max_val: values[n - 1],
    p25: percentile(values, 25),
    p50: median,
    p75: percentile(values, 75),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    mad,
    robust_sigma: robustSigma,
  };
}

function detectDefaultFillValues(
  gaps: WordGap[],
  wordEventIds: number[],
): Set<number> {
  const sameEventCounts = new Map<number, number>();
  const crossEventValues = new Set<number>();

  for (let i = 0; i < gaps.length; i++) {
    const sameEvent = wordEventIds[i] === wordEventIds[i + 1];
    if (sameEvent) {
      sameEventCounts.set(gaps[i].gap_ms, (sameEventCounts.get(gaps[i].gap_ms) || 0) + 1);
    } else {
      crossEventValues.add(gaps[i].gap_ms);
    }
  }

  let totalSame = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (wordEventIds[i] === wordEventIds[i + 1]) {
      totalSame++;
    }
  }
  if (totalSame < 10) {
    return new Set<number>();
  }

  let totalCross = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (wordEventIds[i] !== wordEventIds[i + 1]) {
      totalCross++;
    }
  }
  const safeTotalCross = Math.max(totalCross, 1);

  const suspicious = new Set<number>();
  for (const [val, count] of sameEventCounts.entries()) {
    const freqSame = count / totalSame;
    const crossCount = gaps.filter(g => g.gap_ms === val && !crossEventValues.has(val)).length;
    const freqCross = crossCount / safeTotalCross;
    if (freqSame >= 0.08 && freqCross < 0.02) {
      suspicious.add(val);
    }
  }

  return suspicious;
}

const DEFAULT_SEGMENTATION_PARAMS = {
  max_duration_ms: 7000,
  max_words: 30,
  sensitivity: 2.0,
  punctuation_break_bonus: 2.5,
  comma_break_bonus: 1.0,
  capital_break_bonus: 0.5,
  min_boundary_score: 1.2,
  min_sentence_words: 4,
  min_sentence_duration_ms: 500,
  force_break_on_punctuation: true,
  force_punctuation_min_words: 6,
  force_punctuation_min_duration_ms: 2000,
};

function computeBoundaryScore(
  gap: WordGap,
  stats: GapStats,
  params: typeof DEFAULT_SEGMENTATION_PARAMS & { default_fill_values?: Set<number> | null },
): number {
  if (gap.gap_ms <= 0) {
    return -100.0;
  }

  const defaultFillValues = params.default_fill_values;
  const sensitivity = params.sensitivity;

  const prev = gap.prev_word;
  const nextW = gap.next_word;
  let score = 0.0;

  // A. Linguistic features
  if (prev.endsWithSentencePunc) {
    score += params.punctuation_break_bonus;
  }
  if (prev.endsWithComma) {
    score += params.comma_break_bonus;
  }
  if (nextW.startsWithCapital && !nextW.isAllCaps) {
    score += params.capital_break_bonus;
  }
  if (
    prev.endsWithSentencePunc &&
    nextW.startsWithCapital &&
    !nextW.isAllCaps
  ) {
    score += params.punctuation_break_bonus * 0.4;
  }

  // B. Statistical (Z-Score)
  let zClassical = 0.0;
  let zRobust = 0.0;
  if (stats.std > 0) {
    zClassical = (gap.gap_ms - stats.mean) / stats.std;
  }
  if (stats.robust_sigma > 0) {
    zRobust = (gap.gap_ms - stats.median) / stats.robust_sigma;
  }

  const zScore = Math.min(zClassical, zRobust);
  score += Math.max(0.0, zScore) * sensitivity;

  const treatAsDefault =
    defaultFillValues != null &&
    defaultFillValues.has(gap.gap_ms) &&
    gap.is_same_event;
  const dampen = treatAsDefault ? 0.4 : 1.0;

  if (gap.gap_ms >= stats.p75) {
    score += 0.5 * dampen;
  }
  if (gap.gap_ms >= stats.p90) {
    score += 1.0 * dampen;
  }
  if (gap.gap_ms >= stats.p95) {
    score += 1.5 * dampen;
  }

  if (gap.gap_ms >= 500) {
    score += 0.3;
  }
  if (gap.gap_ms >= 800) {
    score += 0.5;
  }
  if (gap.gap_ms >= 1500) {
    score += 1.0;
  }
  if (gap.gap_ms >= 3000) {
    score += 1.5;
  }

  // C. YouTube structural features
  if (gap.is_youtube_break) {
    score += 0.8;
  }
  if (!gap.is_same_event) {
    score += 0.3;
  } else {
    score -= 1.0;
  }

  return score;
}

function findSentenceBoundaries(
  words: Word[],
  gaps: WordGap[],
  stats: GapStats,
  params: typeof DEFAULT_SEGMENTATION_PARAMS & { default_fill_values?: Set<number> | null },
): number[] {
  if (!words.length || !gaps.length) {
    return [];
  }

  const scores = gaps.map(g => computeBoundaryScore(g, stats, params));
  const boundaries: number[] = [];
  let sentenceStartIdx = 0;
  let bestBreakSinceStart = -1;
  let bestBreakScore = -Infinity;

  for (let i = 0; i < gaps.length; i++) {
    const score = scores[i];
    const prev = gaps[i].prev_word;
    const nextW = gaps[i].next_word;
    const currentDuration = nextW.end_ms - words[sentenceStartIdx].start_ms;
    const currentWordCount = i + 1 - sentenceStartIdx + 1;

    // Force break: speaker change arrow
    if (nextW.startsWithArrow) {
      if (
        currentDuration >= Math.min(params.min_sentence_duration_ms, 100) &&
        currentWordCount >= params.min_sentence_words
      ) {
        boundaries.push(i + 1);
        sentenceStartIdx = i + 1;
        bestBreakSinceStart = -1;
        bestBreakScore = -Infinity;
        continue;
      }
    }

    // Force break: punctuation + capital
    const mandatoryPunc =
      params.force_break_on_punctuation &&
      prev.endsWithSentencePunc &&
      nextW.startsWithCapital &&
      !nextW.isAllCaps &&
      currentWordCount >=
        Math.max(params.force_punctuation_min_words, params.min_sentence_words) &&
      currentDuration >= params.force_punctuation_min_duration_ms &&
      words.length - (i + 1) >= params.min_sentence_words;

    if (mandatoryPunc) {
      boundaries.push(i + 1);
      sentenceStartIdx = i + 1;
      bestBreakSinceStart = -1;
      bestBreakScore = -Infinity;
      continue;
    }

    // Track best candidate break
    const potentialDur = words[i].end_ms - words[sentenceStartIdx].start_ms;
    if (
      score > bestBreakScore &&
      i - sentenceStartIdx + 1 > 0 &&
      potentialDur >= params.min_sentence_duration_ms
    ) {
      bestBreakScore = score;
      bestBreakSinceStart = i;
    }

    // Force break: duration / word limit exceeded
    const forceBreak =
      currentDuration >= params.max_duration_ms ||
      currentWordCount >= params.max_words;

    if (forceBreak) {
      const breakAt = bestBreakSinceStart >= 0 ? bestBreakSinceStart : i;
      boundaries.push(breakAt + 1);
      sentenceStartIdx = breakAt + 1;
      bestBreakSinceStart = -1;
      bestBreakScore = -Infinity;
      continue;
    }

    // Skip short sentences
    if (currentWordCount < params.min_sentence_words) {
      continue;
    }

    // Score threshold
    if (score >= params.min_boundary_score) {
      let effectiveThreshold = params.min_boundary_score;
      if (gaps[i].is_same_event) {
        effectiveThreshold = params.min_boundary_score * 1.5;
      }
      if (
        prev.endsWithSentencePunc &&
        currentWordCount < params.force_punctuation_min_words
      ) {
        effectiveThreshold = Infinity;
      }

      if (score >= effectiveThreshold) {
        boundaries.push(i + 1);
        sentenceStartIdx = i + 1;
        bestBreakSinceStart = -1;
        bestBreakScore = -Infinity;
      }
    }
  }

  return Array.from(new Set(boundaries)).sort((a, b) => a - b);
}

function mergeShortSentences(
  words: Word[],
  boundaries: number[],
  params: typeof DEFAULT_SEGMENTATION_PARAMS & { default_fill_values?: Set<number> | null },
): number[] {
  const maxMergeGapMs = 3000;
  let prevBoundary = 0;
  const merged: number[] = [];

  for (const b of boundaries) {
    const currentWords = b - prevBoundary;
    if (currentWords < params.min_sentence_words && merged.length > 0) {
      if (b < words.length && !words[b].startsWithArrow) {
        const gapMs =
          prevBoundary > 0 ? words[b].start_ms - words[prevBoundary - 1].end_ms : 0;
        const newStart = merged.length >= 2 ? merged[merged.length - 2] : 0;
        const combinedDuration = words[b - 1].end_ms - words[newStart].start_ms;
        if (gapMs <= maxMergeGapMs && combinedDuration <= params.max_duration_ms) {
          merged.pop();
          prevBoundary = merged.length > 0 ? merged[merged.length - 1] : 0;
          continue;
        }
      }
    }
    merged.push(b);
    prevBoundary = b;
  }

  // Tail cleanup
  const lastWords = words.length - prevBoundary;
  if (lastWords < params.min_sentence_words && merged.length >= 1) {
    const lastBoundary = merged[merged.length - 1];
    if (lastBoundary < words.length && !words[lastBoundary].startsWithArrow) {
      const gapMs =
        lastBoundary > 0 ? words[lastBoundary].start_ms - words[lastBoundary - 1].end_ms : 0;
      const newStart = merged.length >= 2 ? merged[merged.length - 2] : 0;
      const combinedDuration = words[words.length - 1].end_ms - words[newStart].start_ms;
      if (gapMs <= maxMergeGapMs && combinedDuration <= params.max_duration_ms) {
        merged.pop();
      }
    }
  }

  return merged;
}

function buildSubtitleSentences(
  words: Word[],
  boundaries: number[],
  params: typeof DEFAULT_SEGMENTATION_PARAMS & { default_fill_values?: Set<number> | null },
): Array<{ text: string; start: number; end: number; translation: string }> {
  const splitPoints = [0, ...boundaries];
  if (splitPoints[splitPoints.length - 1] < words.length) {
    splitPoints.push(words.length);
  }

  function makeSentence(wordSlice: Word[]): { text: string; start: number; end: number; translation: string } {
    const parts: string[] = [];
    for (const w of wordSlice) {
      if (w.text === "\n") {
        continue;
      }
      if (!parts.length) {
        parts.push(w.text.replace(/^\s+/, ""));
      } else if (w.text.startsWith(" ")) {
        parts.push(w.text);
      } else {
        parts.push(" " + w.text);
      }
    }
    return {
      text: parts.join("").trim(),
      start: wordSlice[0].start_ms,
      end: wordSlice[wordSlice.length - 1].end_ms,
      translation: "",
    };
  }

  const sentences: Array<{ text: string; start: number; end: number; translation: string }> = [];
  for (let i = 0; i < splitPoints.length - 1; i++) {
    const startIdx = splitPoints[i];
    const endIdx = splitPoints[i + 1];
    const ws = words.slice(startIdx, endIdx);
    if (!ws.length) {
      continue;
    }
    sentences.push(makeSentence(ws));
  }

  // Split long sentences
  const final: Array<{ text: string; start: number; end: number; translation: string }> = [];
  for (const s of sentences) {
    if (s.end - s.start <= params.max_duration_ms) {
      final.push(s);
    } else {
      const wordsIn = words.filter(w => w.start_ms >= s.start && w.end_ms <= s.end);
      const n = wordsIn.length;
      if (n <= 1) {
        final.push(s);
      } else {
        const parts = Math.max(1, Math.floor((s.end - s.start) / params.max_duration_ms + 0.5));
        const perPart = Math.max(1, Math.floor(n / parts));
        for (let j = 0; j < n; j += perPart) {
          const chunk = wordsIn.slice(j, j + perPart);
          if (chunk.length) {
            final.push({
              text: chunk.map(w => w.text).join(" ").trim(),
              start: chunk[0].start_ms,
              end: chunk[chunk.length - 1].end_ms,
              translation: "",
            });
          }
        }
      }
    }
  }

  // Fix time overlaps
  for (let i = 0; i < final.length - 1; i++) {
    if (final[i].end > final[i + 1].start) {
      final[i].end = final[i + 1].start;
    }
  }

  return final;
}

export function intelligentSentenceBreak(
  input: FlatEvent[] | { events?: any[] } | any[],
  lang?: string,
  params?: Partial<typeof DEFAULT_SEGMENTATION_PARAMS>,
): SubtitleCue[] {
  const mergedParams = { ...DEFAULT_SEGMENTATION_PARAMS, ...(params || {}) };

  let rawEvents: any[] | null = null;
  let flatEventsInput: FlatEvent[] | null = null;

  if (input && typeof input === "object" && !Array.isArray(input) && Array.isArray((input as any).events)) {
    rawEvents = (input as any).events;
  } else if (Array.isArray(input)) {
    if (input.length > 0 && ((input[0] as any).segs || (input[0] as any).tStartMs !== undefined)) {
      rawEvents = input;
    } else {
      flatEventsInput = input as FlatEvent[];
    }
  }

  const words: Word[] = [];
  const wordEventIds: number[] = [];
  const youtubeBreakTimes: number[] = [];

  if (rawEvents !== null) {
    let eventIdx = 0;
    for (const event of rawEvents) {
      const tStart = Number(event?.tStartMs || 0);
      const tDuration = Number(event?.dDurationMs || 0);
      const tEnd = tStart + tDuration;
      const segs: any[] = event?.segs || [];
      const isAppend = event?.aAppend === 1;

      if (!segs.length) {
        eventIdx++;
        continue;
      }
      if (isAppend && segs.length === 1 && segs[0]?.utf8 === "\n") {
        youtubeBreakTimes.push(tStart);
        eventIdx++;
        continue;
      }

      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const text = seg?.utf8 || "";
        if (!text || text === "\n" || is_non_speech_segment(text)) {
          continue;
        }
        const offset = Number(seg?.tOffsetMs || 0);
        const wordStart = tStart + offset;
        let wordEnd = tEnd;
        if (i + 1 < segs.length) {
          const nextOffset = Number(segs[i + 1]?.tOffsetMs || 0);
          wordEnd = tStart + nextOffset;
        }
        words.push(createWord(text, wordStart, wordEnd));
        wordEventIds.push(eventIdx);
      }
      eventIdx++;
    }
  } else if (flatEventsInput !== null) {
    for (let i = 0; i < flatEventsInput.length; i++) {
      const fe = flatEventsInput[i];
      if (!fe?.text || is_non_speech_segment(fe.text)) {
        continue;
      }
      words.push(createWord(fe.text, fe.start, fe.end));
      wordEventIds.push(i);
    }
  }

  if (!words.length) {
    return [];
  }

  const gaps: WordGap[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const wPrev = words[i];
    const wNext = words[i + 1];
    const gapMs = Math.max(0.0, wNext.start_ms - wPrev.start_ms);
    const isYtBreak = youtubeBreakTimes.some(
      t => wPrev.start_ms <= t && t <= wNext.start_ms,
    );
    gaps.push({
      gap_ms: gapMs,
      prev_word: wPrev,
      next_word: wNext,
      is_youtube_break: isYtBreak,
      is_same_event: wordEventIds[i] === wordEventIds[i + 1],
      gap_index: i,
    });
  }

  if (!gaps.length) {
    return toSubtitleCues(
      words.map(w => ({ text: w.text, start: w.start_ms, end: w.end_ms, translation: "" })),
    );
  }

  const defaultFillValues = detectDefaultFillValues(gaps, wordEventIds);
  const stats = computeGapStats(
    gaps,
    defaultFillValues.size ? defaultFillValues : null,
  );
  const runParams = {
    ...mergedParams,
    default_fill_values: defaultFillValues.size ? defaultFillValues : null,
  };

  let boundaries = findSentenceBoundaries(words, gaps, stats, runParams);
  boundaries = mergeShortSentences(words, boundaries, runParams);
  const sentences = buildSubtitleSentences(words, boundaries, runParams);

  return toSubtitleCues(sentences);
}

export const intelligent_sentence_break = intelligentSentenceBreak;

// ── high-level entry points ────────────────────────────────────────────

export function intelligentSentenceBreakWithMode(
  flatEvents: FlatEvent[],
  mode: string = "rule",
  lang: string = "auto",
  rawEvents?: any[],
): SubtitleCue[] {
  if (mode === "statistical") {
    const input = rawEvents && rawEvents.length > 0 ? { events: rawEvents } : flatEvents;
    const result = intelligentSentenceBreak(input, lang);
    if (result && result.length > 0) {
      return result;
    }
  }
  return formatSubtitles(flatEvents, lang);
}

export function builtinSegment(
  events: any[],
  flatEvents: FlatEvent[],
  fromLang: string = "auto",
  mode: string = "rule",
  longSentenceThreshold: number = 120,
): SubtitleCue[] {
  if (mode === "statistical") {
    const result = intelligentSentenceBreak({ events }, fromLang);
    if (result && result.length > 0) {
      return result;
    }
  }
  return formatSubtitles(flatEvents, fromLang, longSentenceThreshold);
}

export const builtin_segment = builtinSegment;

// ── chunking ───────────────────────────────────────────────────────────

export function splitEventsIntoChunks<T extends { text?: string; start?: number; end?: number }>(
  flatEvents: T[],
  chunkLengthOrMaxGapMs: number = 1000,
  maxGapMs: number = 1000,
): T[][] {
  if (!flatEvents || !flatEvents.length) {
    return [];
  }

  const maxChunkLen = Math.max(1, chunkLengthOrMaxGapMs);
  const preferredBoundary = Math.floor(maxChunkLen * 0.8);
  const pauseThresholdMs = maxGapMs;

  const chunks: T[][] = [];
  let currentChunk: T[] = [];
  let currentTextLen = 0;

  function flush(): void {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTextLen = 0;
    }
  }

  for (let i = 0; i < flatEvents.length; i++) {
    const event = flatEvents[i];
    const eventLen = (event?.text || "").length;

    if (currentChunk.length > 0 && currentTextLen + eventLen > maxChunkLen) {
      flush();
    }

    currentChunk.push(event);
    currentTextLen += eventLen;

    const isLast = i === flatEvents.length - 1;
    if (!isLast && currentTextLen >= preferredBoundary) {
      const endsWithPunc = /[.?!…\])]$/.test(event?.text || "");
      const nextEvent = flatEvents[i + 1];
      const pause = (nextEvent?.start ?? 0) - (event?.end ?? 0);
      if (endsWithPunc || pause > pauseThresholdMs) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

export const split_events_into_chunks = splitEventsIntoChunks;
