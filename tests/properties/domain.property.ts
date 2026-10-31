import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { calculateJobKey } from "../../worker/keys.js";
import { validateOutputMapping } from "../../worker/validator.js";
import { formatVttTime, subtitleIndexAt } from "../../extension/src/subtitles.js";
import { normalizeJson3, parseBrowserSubtitles } from "../../extension/src/types.js";
import { consumeSubtitleStream } from "../../extension/src/subtitle-stream.js";
import type { SubtitleEvent } from "../../extension/src/types.js";

const options = { seed: 20261009, numRuns: 200 };
const texts = fc.array(fc.string({ maxLength: 400 }), { maxLength: 50 });
const sourceCues = texts.map(values => values.map((text, index) => ({
  cue_id: `c${index}`, start: index * 1000 + 123, end: index * 1000 + 987, text,
})));

test("property: output encodings and shuffled IDs preserve source order and milliseconds", () => {
  fc.assert(fc.property(sourceCues.filter(cues => cues.length > 0), cues => {
    const items = cues.map(cue => ({ cue_id: cue.cue_id, translation: `译 ${cue.cue_id}` })).reverse();
    const map = Object.fromEntries(items.map(item => [item.cue_id, item.translation]));
    const expected = cues.map(cue => ({ ...cue, translation: `译 ${cue.cue_id}` }));
    for (const candidate of [items, { cues: items }, { translations: items }, map, JSON.stringify(items), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\``]) {
      const result = validateOutputMapping(cues, candidate);
      assert.equal(result.valid, true);
      assert.deepEqual(result.orderedCues, expected);
    }
    assert.equal(validateOutputMapping(cues, [...items, items[0]]).valid, false);
    assert.equal(validateOutputMapping(cues, items.slice(1)).valid, false);
    assert.equal(validateOutputMapping(cues, [...items, { cue_id: "unknown", translation: "译" }]).valid, false);
  }), options);
});

test("property: cache keys normalize endpoints/languages but retain cue timeline", () => {
  fc.assert(fc.property(sourceCues, fc.integer({ min: 1, max: 10 }), (cues, trailingSlashes) => {
    const base = { sourceCues: cues, provider: "openai", fromLang: "en", toLang: "zh-cn", baseUrl: "https://model.invalid/v1", model: "gpt-4o" };
    const key = calculateJobKey(base);
    assert.equal(calculateJobKey({ ...base, sourceCues: structuredClone(cues), provider: " OPENAI ", fromLang: "EN", toLang: "ZH-CN", baseUrl: ` ${base.baseUrl}${"/".repeat(trailingSlashes)} `, model: " gpt-4o " }), key);
    if (cues.length) assert.notEqual(calculateJobKey({ ...base, sourceCues: cues.map((cue, i) => i ? cue : { ...cue, start: cue.start + 1 }) }), key);
  }), options);
});

test("property: subtitle lookup agrees with linear lookup for disjoint intervals", () => {
  fc.assert(fc.property(sourceCues, fc.integer({ min: -1000, max: 51000 }), (cues, ms) => {
    assert.equal(subtitleIndexAt(cues, ms), cues.findIndex(cue => ms >= cue.start && ms <= cue.end));
  }), options);
});

test("property: millisecond VTT timestamps round trip below rounding boundaries", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 86400000 }), ms => {
    const parts = formatVttTime(ms).split(":").map(Number);
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    assert.equal(Math.round(seconds * 1000), ms);
  }), options);
});

test("property: normalized json3 is idempotent and survives cross-world serialization", () => {
  fc.assert(fc.property(fc.array(fc.record({
    tStartMs: fc.integer({ min: 0, max: 100000 }), dDurationMs: fc.integer({ min: 0, max: 10000 }),
    segs: fc.array(fc.record({ utf8: fc.string(), tOffsetMs: fc.integer({ min: 0, max: 10000 }) }), { maxLength: 10 }),
    aAppend: fc.constantFrom(0, 1),
  }), { maxLength: 20 }), events => {
    const normalized = normalizeJson3({ events });
    assert.deepEqual(normalizeJson3({ events: normalized }), normalized);
    assert.deepEqual(parseBrowserSubtitles(JSON.stringify({ videoId: "video", language: "en", events }))?.events, normalized);
  }), options);
});

test("property: SSE decoding is independent of byte chunk boundaries", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 20 }), fc.boolean(),
    async (values, widths, crlf) => {
      const events = values.map(text => ({ type: "cue", text }));
      const newline = crlf ? "\r\n" : "\n";
      const bytes = new TextEncoder().encode(events.map(event => `: ignored${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join(""));
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        let offset = 0, index = 0;
        while (offset < bytes.length) {
          const width = widths[index++ % widths.length];
          controller.enqueue(bytes.slice(offset, offset + width)); offset += width;
        }
        controller.close();
      } });
      const actual: SubtitleEvent[] = [];
      await consumeSubtitleStream(stream, event => actual.push(event));
      assert.deepEqual(actual, events);
    }), options);
});
