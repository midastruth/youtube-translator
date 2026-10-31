import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { is_non_speech_segment, isNonSpeechSegment } from "../server/src/classification.js";
import {
  builtinSegment,
  cleanTimedText,
  formatSubtitles,
  intelligentSentenceBreak,
  intelligentSentenceBreakWithMode,
  prepareTimedTextEvents,
  splitEventsIntoChunks,
  type FlatEvent,
} from "../server/src/subtitle-processing.js";

describe("CleanTimedText", () => {
  it("strips HTML tags", () => {
    assert.equal(cleanTimedText('<font color="red">Hello</font>'), "Hello");
  });

  it("strips zero-width space", () => {
    assert.equal(cleanTimedText("Hello\u200BWorld"), "HelloWorld");
  });

  it("collapses whitespace", () => {
    assert.equal(cleanTimedText(" 多个   空格 "), "多个 空格");
  });

  it("handles empty input", () => {
    assert.equal(cleanTimedText(""), "");
    assert.equal(cleanTimedText(), "");
    assert.equal(cleanTimedText(null), "");
  });
});

describe("NonSpeechSegment", () => {
  it("detects music in brackets", () => {
    assert.equal(is_non_speech_segment("[Music]"), true);
  });

  it("detects laughter in brackets", () => {
    assert.equal(is_non_speech_segment("[Laughter]"), true);
  });

  it("detects multiple bracket segments", () => {
    assert.equal(is_non_speech_segment("[Music] [Applause]"), true);
  });

  it("detects speaker arrow with music", () => {
    assert.equal(is_non_speech_segment(">> [Music]"), true);
  });

  it("detects parenthesized descriptions", () => {
    assert.equal(is_non_speech_segment("(Laughter)"), true);
    assert.equal(is_non_speech_segment("(Applause)"), true);
    assert.equal(is_non_speech_segment(">> (Applause)"), true);
  });

  it("detects musical notes", () => {
    assert.equal(is_non_speech_segment("♪"), true);
    assert.equal(is_non_speech_segment("♫"), true);
    assert.equal(is_non_speech_segment("♪ [Music] ♪"), true);
  });

  it("rejects normal text", () => {
    assert.equal(is_non_speech_segment("Hello world"), false);
    assert.equal(is_non_speech_segment("Use [React] in this project"), false);
    assert.equal(is_non_speech_segment(">>"), false);
    assert.equal(is_non_speech_segment(""), false);
    assert.equal(isNonSpeechSegment(""), false);
  });
});

describe("PrepareTimedTextEvents", () => {
  it("prepares simple event", () => {
    const raw = [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Hello", tOffsetMs: 0 }] },
    ];
    const result = prepareTimedTextEvents(raw);
    assert.equal(result.flat_events.length, 1);
    assert.equal(result.flat_events[0].text, "Hello");
    assert.equal(result.flat_events[0].start, 0);
    assert.equal(result.flat_events[0].end, 500);
  });

  it("prepares two words in same event", () => {
    const raw = [
      {
        tStartMs: 0,
        dDurationMs: 1000,
        segs: [
          { utf8: "Hello", tOffsetMs: 0 },
          { utf8: " world.", tOffsetMs: 100 },
        ],
      },
    ];
    const result = prepareTimedTextEvents(raw);
    assert.equal(result.flat_events.length, 2);
    assert.equal(result.flat_events[0].text, "Hello");
    assert.equal(result.flat_events[0].start, 0);
    assert.equal(result.flat_events[0].end, 100);
    assert.equal(result.flat_events[1].text, "world.");
    assert.equal(result.flat_events[1].start, 100);
    assert.equal(result.flat_events[1].end, 1000);
  });

  it("removes adjacent duplicates", () => {
    const raw = [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Hi", tOffsetMs: 0 }] },
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Hi", tOffsetMs: 0 }] },
    ];
    const result = prepareTimedTextEvents(raw);
    assert.equal(result.events.length, 1);
    assert.equal(result.flat_events.length, 1);
  });

  it("filters non-speech segments", () => {
    const raw = [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "[Music]", tOffsetMs: 0 }] },
      { tStartMs: 600, dDurationMs: 800, segs: [{ utf8: "Hello", tOffsetMs: 0 }] },
    ];
    const result = prepareTimedTextEvents(raw);
    assert.equal(result.flat_events.length, 1);
    assert.equal(result.flat_events[0].text, "Hello");
    assert.equal(result.filtered_non_speech_count, 1);
  });
});

describe("FormatSubtitles", () => {
  it("formats CJK simple phrases into a single sentence", () => {
    const fe: FlatEvent[] = [
      { text: "你好", start: 0, end: 500 },
      { text: "世界。", start: 550, end: 1000 },
    ];
    const cues = formatSubtitles(fe, "zh");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, "你好世界。");
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 1);
    assert.equal(cues[0].cue_id, "c1");
  });

  it("splits CJK on punctuation", () => {
    const fe: FlatEvent[] = [
      { text: "你好。", start: 0, end: 500 },
      { text: "世界！", start: 600, end: 1100 },
    ];
    const cues = formatSubtitles(fe, "zh");
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "你好。");
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 0.5);
    assert.equal(cues[0].cue_id, "c1");
    assert.equal(cues[1].text, "世界！");
    assert.equal(cues[1].start, 0.6);
    assert.equal(cues[1].end, 1.1);
    assert.equal(cues[1].cue_id, "c2");
  });

  it("splits CJK on long pauses", () => {
    const fe: FlatEvent[] = [
      { text: "你好", start: 0, end: 500 },
      { text: "世界", start: 3000, end: 3500 },
    ];
    const cues = formatSubtitles(fe, "zh");
    assert.equal(cues.length, 2);
  });

  it("handles CJK poor quality fallback", () => {
    const fe: FlatEvent[] = [
      { text: "这是一个非常长的句子用于测试字幕质量不佳的情况", start: 0, end: 1000 },
      { text: "这是第二个非常长的句子同样用于测试异常字幕", start: 1000, end: 2000 },
    ];
    const cues = formatSubtitles(fe, "zh");
    assert.equal(cues.length, 2);
  });

  it("formats English basic sentences", () => {
    const fe: FlatEvent[] = [
      { text: "Hello", start: 0, end: 100 },
      { text: "world.", start: 150, end: 500 },
      { text: "This", start: 600, end: 700 },
      { text: "is", start: 750, end: 850 },
      { text: "a test.", start: 900, end: 1400 },
    ];
    const cues = formatSubtitles(fe, "en");
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "Hello world.");
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 0.5);
    assert.equal(cues[1].text, "This is a test.");
    assert.equal(cues[1].start, 0.6);
    assert.equal(cues[1].end, 1.4);
  });

  it("splits English with long sentence threshold", () => {
    const words: FlatEvent[] = Array.from({ length: 50 }, (_, i) => ({
      text: `word${i}`,
      start: i * 100,
      end: i * 100 + 80,
    }));
    const cues = formatSubtitles(words, "en", 120);
    assert.ok(cues.length > 1);
  });
});

describe("SplitEventsIntoChunks", () => {
  it("splits events into chunks based on chunk length", () => {
    const fe: FlatEvent[] = Array.from({ length: 30 }, (_, i) => ({
      text: "a".repeat(100),
      start: i * 100,
      end: i * 100 + 80,
    }));
    const chunks = splitEventsIntoChunks(fe, 500);
    assert.ok(chunks.length > 1);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    assert.equal(total, 30);
  });

  it("handles a single event", () => {
    const fe: FlatEvent[] = [{ text: "short", start: 0, end: 100 }];
    const chunks = splitEventsIntoChunks(fe);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });

  it("handles empty input", () => {
    assert.deepEqual(splitEventsIntoChunks([]), []);
  });
});

describe("IntelligentSentenceBreak", () => {
  it("breaks sentences using statistical gap analysis from raw events", () => {
    const data = {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 2000,
          segs: [
            { utf8: "Hello", tOffsetMs: 0 },
            { utf8: " world.", tOffsetMs: 100 },
          ],
        },
        {
          tStartMs: 2100,
          dDurationMs: 3000,
          segs: [
            { utf8: "My", tOffsetMs: 0 },
            { utf8: " name", tOffsetMs: 100 },
            { utf8: " is Python.", tOffsetMs: 200 },
          ],
        },
      ],
    };
    const results = intelligentSentenceBreak(data);
    assert.ok(results.length > 0);
    assert.ok(results[0].text.includes("Hello"));
    assert.ok(results[results.length - 1].text.includes("Python"));
    assert.equal(typeof results[0].start, "number");
    assert.equal(typeof results[0].end, "number");
    assert.ok(results[0].cue_id?.startsWith("c"));
  });

  it("breaks sentences from FlatEvent array", () => {
    const fe: FlatEvent[] = [
      { text: "Hello", start: 0, end: 1000 },
      { text: " world.", start: 1100, end: 2000 },
    ];
    const results = intelligentSentenceBreak(fe);
    assert.ok(results.length > 0);
    assert.ok(results[0].text.includes("Hello"));
  });

  it("handles empty events data", () => {
    assert.deepEqual(intelligentSentenceBreak({}), []);
    assert.deepEqual(intelligentSentenceBreak({ events: [] }), []);
    assert.deepEqual(intelligentSentenceBreak([]), []);
  });
});

describe("BuiltinSegment & IntelligentSentenceBreakWithMode", () => {
  it("processes subtitles with rule mode", () => {
    const events = [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Hi there.", tOffsetMs: 0 }] },
    ];
    const fe: FlatEvent[] = [{ text: "Hi there.", start: 0, end: 500 }];
    const cues = builtinSegment(events, fe, "en", "rule");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, "Hi there.");
  });

  it("falls back to rule if statistical segmentation returns empty", () => {
    const events: any[] = [];
    const fe: FlatEvent[] = [];
    const cues = builtinSegment(events, fe, "en", "statistical");
    assert.deepEqual(cues, []);

    const cuesMode = intelligentSentenceBreakWithMode(fe, "statistical", "en");
    assert.deepEqual(cuesMode, []);
  });

  it("returns statistical results in statistical mode", () => {
    const fe: FlatEvent[] = [
      { text: "Welcome to this demonstration.", start: 0, end: 2000 },
      { text: "We will explore sentence boundaries.", start: 2500, end: 5000 },
    ];
    const cues = intelligentSentenceBreakWithMode(fe, "statistical", "en");
    assert.ok(cues.length > 0);
    assert.equal(typeof cues[0].start, "number");
  });
});
