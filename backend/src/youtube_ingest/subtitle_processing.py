"""YouTube subtitle processing — mirrors kiss-translator's youtubeSubtitleProcessing.js.

Provides: HTML cleaning, event flattening, rule-based sentence breaking,
statistical (Z-Score/MAD) intelligent segmentation — all in pure Python.
"""

from __future__ import annotations

import logging
import re
import statistics
from dataclasses import dataclass, field
from typing import Any

from .subtitle_text_classification import is_non_speech_segment

logger = logging.getLogger(__name__)

# ── helpers ────────────────────────────────────────────────────────────

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_ZERO_WIDTH_SPACE_RE = re.compile(r"\u200B")


def clean_timed_text(utf8: str = "") -> str:
    """Strip HTML tags, zero-width spaces and collapse whitespace."""
    text = str(utf8)
    text = _HTML_TAG_RE.sub("", text)
    text = _ZERO_WIDTH_SPACE_RE.sub("", text)
    return " ".join(text.strip().split())


# ── flat events ────────────────────────────────────────────────────────

@dataclass
class FlatEvent:
    text: str
    start: float  # ms
    end: float  # ms


def prepare_timed_text_events(raw_events: list[dict] | None) -> dict[str, Any]:
    """Clean, deduplicate and flatten YouTube json3 events.

    Returns {"events": [...], "flat_events": [...], "filtered_non_speech_count": int}
    """
    raw_events = raw_events or []
    events: list[dict] = []
    flat_events: list[FlatEvent] = []
    filtered_non_speech_count = 0
    buffer: FlatEvent | None = None
    last_visible_event_key = ""

    def flush_buffer(end_at: float | None = None) -> None:
        nonlocal buffer
        if buffer is None:
            return
        if end_at is not None and (buffer.end is None or buffer.end > end_at):
            buffer.end = end_at
        if buffer.end is not None and buffer.end > buffer.start:
            flat_events.append(buffer)
        buffer = None

    for raw_event in raw_events:
        event = raw_event or {}
        raw_segs: list[dict] = event.get("segs") or []
        t_start_ms = float(event.get("tStartMs") or 0)
        d_duration_ms = float(event.get("dDurationMs") or 0)
        is_line_break = (
            event.get("aAppend") == 1
            and len(raw_segs) == 1
            and raw_segs[0].get("utf8") == "\n"
        )

        normalized_segs: list[dict] = []
        for seg in raw_segs:
            s = dict(seg)
            s["utf8"] = "\n" if is_line_break else clean_timed_text(s.get("utf8", ""))
            normalized_segs.append(s)

        visible_text = " ".join(
            clean_timed_text(s.get("utf8", ""))
            for s in normalized_segs
            if clean_timed_text(s.get("utf8", ""))
        ).strip()
        visible_text = re.sub(r"\s+", " ", visible_text)

        event_key = (
            f"{t_start_ms}|{d_duration_ms}|{visible_text}" if visible_text else ""
        )

        # Skip adjacent duplicates (same time, duration, and visible text).
        if event_key and event_key == last_visible_event_key:
            continue

        canonical_event = dict(event, segs=normalized_segs)
        events.append(canonical_event)
        last_visible_event_key = event_key

        for idx, seg in enumerate(normalized_segs):
            utf8 = seg.get("utf8", "")
            t_offset_ms = float(seg.get("tOffsetMs") or 0)
            text = clean_timed_text(utf8)
            start = t_start_ms + t_offset_ms

            if not text:
                if buffer is not None and start > buffer.start:
                    flush_buffer(start)
                continue

            if is_non_speech_segment(text):
                flush_buffer(start)
                filtered_non_speech_count += 1
                continue

            flush_buffer(start)
            buffer = FlatEvent(text=text, start=start, end=t_start_ms + d_duration_ms)
            if idx == len(normalized_segs) - 1:
                buffer.end = t_start_ms + d_duration_ms

    flush_buffer(buffer.end if buffer else None)

    return {
        "events": events,
        "flat_events": [
            fe for fe in flat_events if fe.end is not None and fe.end > fe.start
        ],
        "filtered_non_speech_count": filtered_non_speech_count,
    }


# ── rule-based segmentation ────────────────────────────────────────────

_GROUPED_PAUSE_WORDS: set[str] = {
    "actually", "also", "although", "and", "anyway", "as", "basically",
    "because", "but", "eventually", "frankly", "honestly", "hopefully",
    "however", "if", "instead", "it's", "just", "let's", "like",
    "literally", "maybe", "meanwhile", "nevertheless", "nonetheless",
    "now", "okay", "or", "otherwise", "perhaps", "personally", "probably",
    "right", "since", "so", "suddenly", "that's", "then", "there's",
    "therefore", "though", "thus", "unless", "until", "well", "while",
}


def _is_quality_poor(items: list[dict], length_threshold: int = 200,
                     percentage_threshold: float = 0.1) -> bool:
    """Detect poor source subtitle quality (excessive long lines)."""
    if not items:
        return False
    long_count = sum(1 for it in items if len(it["text"]) > length_threshold)
    return (long_count / len(items)) > percentage_threshold


def process_subtitles(
    flat_events: list[FlatEvent],
    use_pause: bool = False,
    timeout: int = 1000,
    max_words: int = 15,
    max_duration_ms: int = 10000,
) -> list[dict]:
    """Core sentence-breaking state machine for Latin-script languages."""
    sentences: list[dict] = []
    current_buffer: list[FlatEvent] = []
    buffer_word_count = 0

    def flush() -> None:
        nonlocal buffer_word_count
        if current_buffer:
            sentences.append({
                "text": " ".join(e.text for e in current_buffer).strip(),
                "start": current_buffer[0].start,
                "end": current_buffer[-1].end,
                "translation": "",
            })
        current_buffer.clear()
        buffer_word_count = 0

    for segment in flat_events:
        if not segment.text:
            continue

        last = current_buffer[-1] if current_buffer else None

        if last is not None:
            ends_with_punc = bool(re.search(r"[.?!…\])]$", last.text))
            ends_with_comma = last.text.rstrip().endswith(",")
            is_timeout = (segment.start - last.end) > timeout
            is_dur_exceeded = (segment.start - current_buffer[0].start) >= max_duration_ms
            is_word_limited = (use_pause or ends_with_comma) and buffer_word_count >= max_words
            starts_with_sign = bool(re.match(r"^[\[(♪]", segment.text))
            starts_with_pause_word = (
                use_pause
                and segment.text.lower().split(None, 1)[0] in _GROUPED_PAUSE_WORDS
                and len(current_buffer) > 1
            )

            if (
                ends_with_punc
                or is_timeout
                or is_dur_exceeded
                or is_word_limited
                or starts_with_sign
                or starts_with_pause_word
            ):
                flush()

        current_buffer.append(segment)
        buffer_word_count += len(segment.text.split())

    flush()
    return sentences


_NO_SPACE_LANGS = {"zh", "ja", "ko", "th", "lo", "km", "my"}


def format_subtitles(
    flat_events: list[FlatEvent],
    lang: str = "auto",
    long_sentence_threshold: int = 120,
) -> list[dict]:
    """Format flat events into subtitle cues, language-aware."""
    if not flat_events:
        return []

    if lang[:2] in _NO_SPACE_LANGS:
        subtitles: list[dict] = []
        if _is_quality_poor(
            [{"text": e.text} for e in flat_events],
            length_threshold=5,
            percentage_threshold=0.5,
        ):
            return [
                {"text": e.text, "start": e.start, "end": e.end, "translation": ""}
                for e in flat_events
            ]

        current_line: dict | None = None
        MAX_LENGTH = 30
        PAUSE_THRESHOLD_MS = 1000

        for segment in flat_events:
            if not segment.text:
                continue
            if (
                current_line is not None
                and segment.start - current_line["end"] > PAUSE_THRESHOLD_MS
            ):
                subtitles.append(current_line)
                current_line = None

            if current_line is None:
                current_line = {
                    "text": segment.text,
                    "start": segment.start,
                    "end": segment.end,
                    "translation": "",
                }
            else:
                current_line["text"] += segment.text
                current_line["end"] = segment.end

            is_eos = bool(re.search(r"[。！？.!?…][\"'""」』】）》）\]]*$", segment.text))
            if is_eos or len(current_line["text"]) >= MAX_LENGTH:
                subtitles.append(current_line)
                current_line = None

        if current_line is not None:
            subtitles.append(current_line)
        return subtitles

    # Latin / space-separated languages
    subtitles = process_subtitles(flat_events)

    result: list[dict] = []
    for sub in subtitles:
        if len(sub["text"]) > long_sentence_threshold:
            sub_events = [
                e
                for e in flat_events
                if e.start >= sub["start"] and e.start < sub["end"]
            ]
            if len(sub_events) > 1:
                re_processed = process_subtitles(sub_events, use_pause=True)
                result.extend(re_processed)
            else:
                result.append(sub)
        else:
            result.append(sub)

    return result


# ── statistical (Z-Score / MAD) intelligent segmentation ──────────────

@dataclass
class _Word:
    text: str
    start_ms: float
    end_ms: float

    @property
    def stripped(self) -> str:
        return self.text.strip()

    @property
    def ends_with_sentence_punc(self) -> bool:
        return bool(re.search(r"[.?!]$", self.stripped))

    @property
    def ends_with_comma(self) -> bool:
        return self.stripped.endswith(",")

    @property
    def starts_with_capital(self) -> bool:
        s = self.stripped
        return bool(s) and s[0].isupper() and s[0] != s[0].lower()

    @property
    def is_all_caps(self) -> bool:
        s = self.stripped
        return len(s) >= 2 and s == s.upper()

    @property
    def starts_with_arrow(self) -> bool:
        return self.text.startswith(">>")


@dataclass
class _WordGap:
    gap_ms: float
    prev_word: _Word
    next_word: _Word
    is_youtube_break: bool
    is_same_event: bool
    gap_index: int


@dataclass
class _GapStats:
    mean: float = 0
    median: float = 0
    std: float = 0
    min_val: float = 0
    max_val: float = 0
    p25: float = 0
    p50: float = 0
    p75: float = 0
    p90: float = 0
    p95: float = 0
    mad: float = 0
    robust_sigma: float = 0


def _percentile(sorted_data: list[float], p: float) -> float:
    """Linear-interpolation percentile."""
    if not sorted_data:
        return 0.0
    n = len(sorted_data)
    k = (n - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, n - 1)
    if f == c:
        return sorted_data[f]
    return sorted_data[f] * (c - k) + sorted_data[c] * (k - f)


def _compute_gap_stats(
    gaps: list[_WordGap], exclude_values: set[float] | None = None
) -> _GapStats:
    """Compute descriptive statistics over gap durations."""
    values = sorted(
        g.gap_ms for g in gaps if (exclude_values is None or g.gap_ms not in exclude_values)
    )
    if not values:
        return _GapStats()

    n = len(values)
    mean = sum(values) / n
    median = _percentile(values, 50)

    if n >= 2:
        variance = sum((v - mean) ** 2 for v in values) / (n - 1)
        std = variance**0.5
    else:
        std = 0.0

    abs_devs = sorted(abs(v - median) for v in values)
    mad = _percentile(abs_devs, 50) if abs_devs else 0.0
    robust_sigma = mad * 1.4826

    return _GapStats(
        mean=mean,
        median=median,
        std=std,
        min_val=values[0],
        max_val=values[-1],
        p25=_percentile(values, 25),
        p50=median,
        p75=_percentile(values, 75),
        p90=_percentile(values, 90),
        p95=_percentile(values, 95),
        mad=mad,
        robust_sigma=robust_sigma,
    )


def _detect_default_fill_values(
    gaps: list[_WordGap], word_event_ids: list[int]
) -> set[float]:
    """Detect YouTube's artificial alignment fill values (e.g. 30ms, 100ms)."""
    same_event_counts: dict[float, int] = {}
    cross_event_values: set[float] = set()

    for i, g in enumerate(gaps):
        same_event = word_event_ids[i] == word_event_ids[i + 1]
        if same_event:
            same_event_counts[g.gap_ms] = same_event_counts.get(g.gap_ms, 0) + 1
        else:
            cross_event_values.add(g.gap_ms)

    total_same = sum(1 for i in range(len(gaps))
                     if word_event_ids[i] == word_event_ids[i + 1])
    if total_same < 10:
        return set()

    total_cross = max(
        sum(1 for i in range(len(gaps))
            if word_event_ids[i] != word_event_ids[i + 1]),
        1,
    )

    suspicious: set[float] = set()
    for val, count in same_event_counts.items():
        freq_same = count / total_same
        cross_count = sum(1 for g in gaps if g.gap_ms == val and not cross_event_values)
        freq_cross = cross_count / total_cross
        if freq_same >= 0.08 and freq_cross < 0.02:
            suspicious.add(val)

    return suspicious


_DEFAULT_PARAMS = {
    "max_duration_ms": 7000,
    "max_words": 30,
    "sensitivity": 2.0,
    "punctuation_break_bonus": 2.5,
    "comma_break_bonus": 1.0,
    "capital_break_bonus": 0.5,
    "min_boundary_score": 1.2,
    "min_sentence_words": 4,
    "min_sentence_duration_ms": 500,
    "force_break_on_punctuation": True,
    "force_punctuation_min_words": 6,
    "force_punctuation_min_duration_ms": 2000,
}


def _compute_boundary_score(
    gap: _WordGap, stats: _GapStats, params: dict
) -> float:
    """Score a word-word gap as a potential sentence boundary."""
    if gap.gap_ms <= 0:
        return -100.0

    default_fill_values = params.get("default_fill_values")
    sensitivity = params["sensitivity"]

    prev = gap.prev_word
    next_w = gap.next_word
    score = 0.0

    # A. Linguistic features
    if prev.ends_with_sentence_punc:
        score += params["punctuation_break_bonus"]
    if prev.ends_with_comma:
        score += params["comma_break_bonus"]
    if next_w.starts_with_capital and not next_w.is_all_caps:
        score += params["capital_break_bonus"]
    if (
        prev.ends_with_sentence_punc
        and next_w.starts_with_capital
        and not next_w.is_all_caps
    ):
        score += params["punctuation_break_bonus"] * 0.4

    # B. Statistical (Z-Score)
    z_classical = 0.0
    z_robust = 0.0
    if stats.std > 0:
        z_classical = (gap.gap_ms - stats.mean) / stats.std
    if stats.robust_sigma > 0:
        z_robust = (gap.gap_ms - stats.median) / stats.robust_sigma

    z_score = min(z_classical, z_robust)
    score += max(0.0, z_score) * sensitivity

    treat_as_default = (
        default_fill_values is not None
        and gap.gap_ms in default_fill_values
        and gap.is_same_event
    )
    dampen = 0.4 if treat_as_default else 1.0

    if gap.gap_ms >= stats.p75:
        score += 0.5 * dampen
    if gap.gap_ms >= stats.p90:
        score += 1.0 * dampen
    if gap.gap_ms >= stats.p95:
        score += 1.5 * dampen

    if gap.gap_ms >= 500:
        score += 0.3
    if gap.gap_ms >= 800:
        score += 0.5
    if gap.gap_ms >= 1500:
        score += 1.0
    if gap.gap_ms >= 3000:
        score += 1.5

    # C. YouTube structural features
    if gap.is_youtube_break:
        score += 0.8
    if not gap.is_same_event:
        score += 0.3
    else:
        score -= 1.0

    return score


def _find_sentence_boundaries(
    words: list[_Word], gaps: list[_WordGap], stats: _GapStats, params: dict
) -> list[int]:
    """Find sentence boundary indices."""
    if not words or not gaps:
        return []

    scores = [_compute_boundary_score(g, stats, params) for g in gaps]
    boundaries: list[int] = []
    sentence_start_idx = 0
    best_break_since_start = -1
    best_break_score = float("-inf")

    for i in range(len(gaps)):
        score = scores[i]
        prev = gaps[i].prev_word
        next_w = gaps[i].next_word
        current_duration = next_w.end_ms - words[sentence_start_idx].start_ms
        current_word_count = i + 1 - sentence_start_idx + 1

        # Force break: speaker change arrow
        if next_w.starts_with_arrow:
            if (
                current_duration >= min(params["min_sentence_duration_ms"], 100)
                and current_word_count >= params["min_sentence_words"]
            ):
                boundaries.append(i + 1)
                sentence_start_idx = i + 1
                best_break_since_start = -1
                best_break_score = float("-inf")
                continue

        # Force break: punctuation + capital
        mandatory_punc = (
            params["force_break_on_punctuation"]
            and prev.ends_with_sentence_punc
            and next_w.starts_with_capital
            and not next_w.is_all_caps
            and current_word_count >= max(
                params["force_punctuation_min_words"], params["min_sentence_words"]
            )
            and current_duration >= params["force_punctuation_min_duration_ms"]
            and len(words) - (i + 1) >= params["min_sentence_words"]
        )
        if mandatory_punc:
            boundaries.append(i + 1)
            sentence_start_idx = i + 1
            best_break_since_start = -1
            best_break_score = float("-inf")
            continue

        # Track best candidate break
        potential_dur = words[i].end_ms - words[sentence_start_idx].start_ms
        if (
            score > best_break_score
            and i - sentence_start_idx + 1 > 0
            and potential_dur >= params["min_sentence_duration_ms"]
        ):
            best_break_score = score
            best_break_since_start = i

        # Force break: duration / word limit exceeded
        force_break = (
            current_duration >= params["max_duration_ms"]
            or current_word_count >= params["max_words"]
        )
        if force_break:
            break_at = best_break_since_start if best_break_since_start >= 0 else i
            boundaries.append(break_at + 1)
            sentence_start_idx = break_at + 1
            best_break_since_start = -1
            best_break_score = float("-inf")
            continue

        # Skip short sentences
        if current_word_count < params["min_sentence_words"]:
            continue

        # Score threshold
        if score >= params["min_boundary_score"]:
            effective_threshold = params["min_boundary_score"]
            if gaps[i].is_same_event:
                effective_threshold = params["min_boundary_score"] * 1.5
            if (
                prev.ends_with_sentence_punc
                and current_word_count < params["force_punctuation_min_words"]
            ):
                effective_threshold = float("inf")

            if score >= effective_threshold:
                boundaries.append(i + 1)
                sentence_start_idx = i + 1
                best_break_since_start = -1
                best_break_score = float("-inf")

    return sorted(set(boundaries))


def _merge_short_sentences(
    words: list[_Word], boundaries: list[int], params: dict
) -> list[int]:
    """Merge overly fragmented short sentences."""
    max_merge_gap_ms = 3000
    prev_boundary = 0
    merged: list[int] = []

    for b in boundaries:
        current_words = b - prev_boundary
        if current_words < params["min_sentence_words"] and merged:
            if b < len(words) and not words[b].starts_with_arrow:
                gap_ms = (
                    words[b].start_ms - words[prev_boundary - 1].end_ms
                    if prev_boundary > 0
                    else 0
                )
                new_start = merged[-2] if len(merged) >= 2 else 0
                combined_duration = words[b - 1].end_ms - words[new_start].start_ms
                if gap_ms <= max_merge_gap_ms and combined_duration <= params["max_duration_ms"]:
                    merged.pop()
                    prev_boundary = merged[-1] if merged else 0
                    continue
        merged.append(b)
        prev_boundary = b

    # Tail cleanup
    last_words = len(words) - prev_boundary
    if last_words < params["min_sentence_words"] and len(merged) >= 1:
        last_boundary = merged[-1]
        if last_boundary < len(words) and not words[last_boundary].starts_with_arrow:
            gap_ms = (
                words[last_boundary].start_ms - words[last_boundary - 1].end_ms
                if last_boundary > 0
                else 0
            )
            new_start = merged[-2] if len(merged) >= 2 else 0
            combined_duration = words[-1].end_ms - words[new_start].start_ms
            if gap_ms <= max_merge_gap_ms and combined_duration <= params["max_duration_ms"]:
                merged.pop()

    return merged


def _build_subtitle_sentences(
    words: list[_Word], boundaries: list[int], params: dict
) -> list[dict]:
    """Assemble subtitle sentences from word index boundaries."""
    split_points = [0, *boundaries]
    if split_points[-1] < len(words):
        split_points.append(len(words))

    def _make_sentence(word_slice: list[_Word], idx: int) -> dict:
        parts: list[str] = []
        for w in word_slice:
            if w.text == "\n":
                continue
            if not parts:
                parts.append(w.text.lstrip())
            elif w.text.startswith(" "):
                parts.append(w.text)
            else:
                parts.append(" " + w.text)
        return {
            "text": "".join(parts).strip(),
            "start": word_slice[0].start_ms,
            "end": word_slice[-1].end_ms,
            "translation": "",
        }

    sentences: list[dict] = []
    for i in range(len(split_points) - 1):
        start_idx = split_points[i]
        end_idx = split_points[i + 1]
        ws = words[start_idx:end_idx]
        if not ws:
            continue
        sentences.append(_make_sentence(ws, len(sentences)))

    # Split long sentences
    final: list[dict] = []
    for s in sentences:
        if s["end"] - s["start"] <= params["max_duration_ms"]:
            final.append(s)
        else:
            words_in = [w for w in words if w.start_ms >= s["start"] and w.end_ms <= s["end"]]
            n = len(words_in)
            if n <= 1:
                final.append(s)
            else:
                parts = max(1, int((s["end"] - s["start"]) / params["max_duration_ms"] + 0.5))
                per_part = max(1, n // parts)
                for j in range(0, n, per_part):
                    chunk = words_in[j: j + per_part]
                    if chunk:
                        final.append({
                            "text": " ".join(w.text for w in chunk).strip(),
                            "start": chunk[0].start_ms,
                            "end": chunk[-1].end_ms,
                            "translation": "",
                        })

    # Fix time overlaps
    for i in range(len(final) - 1):
        if final[i]["end"] > final[i + 1]["start"]:
            final[i]["end"] = final[i + 1]["start"]

    return final


def intelligent_sentence_break(data: dict, params: dict | None = None) -> list[dict]:
    """Statistical sentence segmentation for YouTube ASR subtitles.

    Mirrors kiss-translator's `intelligentSentenceBreak()` in sentenceBreaker.js.
    """
    params = {**_DEFAULT_PARAMS, **(params or {})}

    # 1. Parse
    events = data.get("events") or []
    words: list[_Word] = []
    word_event_ids: list[int] = []
    event_idx = 0

    for event in events:
        t_start = float(event.get("tStartMs") or 0)
        t_duration = float(event.get("dDurationMs") or 0)
        t_end = t_start + t_duration
        segs = event.get("segs") or []
        is_append = event.get("aAppend") == 1

        if not segs:
            event_idx += 1
            continue
        if is_append and len(segs) == 1 and segs[0].get("utf8") == "\n":
            event_idx += 1
            continue

        for i, seg in enumerate(segs):
            text = seg.get("utf8") or ""
            if not text or text == "\n" or is_non_speech_segment(text):
                continue
            offset = float(seg.get("tOffsetMs") or 0)
            word_start = t_start + offset
            if i + 1 < len(segs):
                next_offset = float(segs[i + 1].get("tOffsetMs") or 0)
                word_end = t_start + next_offset
            else:
                word_end = t_end
            words.append(_Word(text=text, start_ms=word_start, end_ms=word_end))
            word_event_ids.append(event_idx)
        event_idx += 1

    if not words:
        return []

    # 2. YouTube break times
    youtube_break_times: list[float] = []
    for event in events:
        if event.get("aAppend") == 1 and len(event.get("segs", [])) == 1:
            if event["segs"][0].get("utf8") == "\n":
                youtube_break_times.append(float(event.get("tStartMs") or 0))

    # 3. Build gaps
    gaps: list[_WordGap] = []
    for i in range(len(words) - 1):
        w_prev = words[i]
        w_next = words[i + 1]
        gap_ms = max(0.0, w_next.start_ms - w_prev.start_ms)
        is_yt_break = any(w_prev.start_ms <= t <= w_next.start_ms for t in youtube_break_times)
        gaps.append(_WordGap(
            gap_ms=gap_ms,
            prev_word=w_prev,
            next_word=w_next,
            is_youtube_break=is_yt_break,
            is_same_event=(word_event_ids[i] == word_event_ids[i + 1]),
            gap_index=i,
        ))

    if not gaps:
        return [{"text": w.text, "start": w.start_ms, "end": w.end_ms, "translation": ""}
                for w in words]

    # 4. Default fill detection
    default_fill_values = _detect_default_fill_values(gaps, word_event_ids)

    # 5. Statistics
    stats = _compute_gap_stats(gaps, default_fill_values if default_fill_values else None)

    # 6. Run params
    run_params = {**params, "default_fill_values": default_fill_values if default_fill_values else None}

    # 7. Boundaries
    boundaries = _find_sentence_boundaries(words, gaps, stats, run_params)

    # 8. Merge short sentences
    boundaries = _merge_short_sentences(words, boundaries, run_params)

    # 9. Build
    return _build_subtitle_sentences(words, boundaries, run_params)


# ── high-level entry points (mirrors kiss-translator's builtinSegment / runBuiltinSegmentation) ──

def builtin_segment(
    events: list[dict],
    flat_events: list[FlatEvent],
    from_lang: str = "auto",
    mode: str = "rule",
    long_sentence_threshold: int = 120,
) -> list[dict]:
    """Run built-in segmentation (rule or statistical)."""
    def _to_cues(items: list[dict]) -> list[dict]:
        return [
            {
                "start": it["start"],
                "end": it["end"],
                "text": it["text"],
                "translation": it.get("translation", ""),
            }
            for it in items
        ]

    if mode == "statistical":
        logger.info("Youtube Provider: Sentence break mode: STATISTICAL")
        result = intelligent_sentence_break({"events": events})
        if result:
            return _to_cues(result)
        logger.info("Statistical segmentation returned empty, falling back to rule")

    logger.info("Youtube Provider: Sentence break mode: RULE")
    return _to_cues(format_subtitles(flat_events, from_lang, long_sentence_threshold))


def split_events_into_chunks(
    flat_events: list[FlatEvent], chunk_length: int = 1000
) -> list[list[FlatEvent]]:
    """Split flat events into chunks for AI batch processing."""
    if not flat_events:
        return []

    max_chunk_len = max(1, chunk_length)
    preferred_boundary = int(max_chunk_len * 0.8)
    pause_threshold_ms = 1000

    chunks: list[list[FlatEvent]] = []
    current_chunk: list[FlatEvent] = []
    current_text_len = 0

    def flush() -> None:
        nonlocal current_chunk, current_text_len
        if current_chunk:
            chunks.append(current_chunk)
            current_chunk = []
            current_text_len = 0

    for i, event in enumerate(flat_events):
        event_len = len(event.text or "")

        if current_chunk and current_text_len + event_len > max_chunk_len:
            flush()

        current_chunk.append(event)
        current_text_len += event_len

        is_last = i == len(flat_events) - 1
        if not is_last and current_text_len >= preferred_boundary:
            ends_with_punc = bool(re.search(r"[.?!…\])]$", event.text))
            next_event = flat_events[i + 1]
            pause = next_event.start - event.end
            if ends_with_punc or pause > pause_threshold_ms:
                flush()

    flush()
    return chunks
