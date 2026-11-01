import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserFixture, eventually } from "../features/support/browser.js";
import { mergeSubtitleEvent } from "../extension/src/subtitles.js";
import { inPlaybackWindow, PLAYBACK_MAX_CUES } from "../shared/playback-window.js";

const source = Array.from({ length: 120 }, (_, index) => ({
  type: "source_cue", index, start: index * 5000, end: index * 5000 + 4500, text: `Sentence ${index}`,
}));

async function start(browser: BrowserFixture) {
  browser.execute("content"); browser.toggle();
  await eventually(() => browser.streams.length === 1);
  browser.send([{ type: "meta", total_cues: source.length, from_lang: "en" }, ...source]);
}

function translation(browser: BrowserFixture) {
  return browser.dom.window.document.querySelector(".tran")?.textContent;
}

test("document gets only a bounded legacy playback window, then preview and final replace it", async () => {
  const browser = new BrowserFixture({ translateModel: "configured-model", translateApiKey: "fixture-key" });
  try {
    await start(browser);
    await eventually(() => browser.windows.length === 1);
    const window = browser.windows[0];
    assert.equal(window.body.translate_engine, "legacy");
    assert.equal(window.body.translate_model, "configured-model");
    assert.equal(window.body.translate_api_key, "fixture-key");
    assert.equal(window.body.source_language, "en");
    const cues = window.body.source_cues!;
    assert.ok(cues.length <= PLAYBACK_MAX_CUES && cues.length < source.length);
    assert.ok(cues.every(cue => inPlaybackWindow(cue, 0)));
    assert.equal(window.body.source_events, undefined);
    assert.equal(window.body.whisper_enabled, undefined);
    window.respond(cues.map((_, index) => ({ index, translation: `快速 ${index}` })));
    browser.seek(1000);
    await eventually(() => translation(browser) === "快速 0");
    browser.send([{ ...source[0], type: "cue", translation: "文档预览", provisional: true }]);
    await eventually(() => translation(browser) === "文档预览");
    browser.send([{ ...source[0], type: "cue", translation: "文档定稿", provisional: false }, { type: "done", failed_cues: 0 }]);
    browser.finish();
    await eventually(() => translation(browser) === "文档定稿");
    const count = browser.windows.length;
    browser.seek(400_000);
    await delay(180);
    assert.equal(browser.windows.length, count, "final publication stops temporary translation");
    assert.equal(browser.streams.length, 1, "document job was never restarted");
  } finally { browser.close(); }
});

test("a late legacy response cannot overwrite document results and already-translated cues are skipped", async () => {
  const browser = new BrowserFixture();
  try {
    await start(browser);
    await eventually(() => browser.windows.length === 1);
    const window = browser.windows[0];
    browser.send([{ ...source[0], type: "cue", translation: "文档预览", provisional: true }]);
    browser.seek(1000);
    await eventually(() => translation(browser) === "文档预览");
    window.respond(window.body.source_cues!.map((_, index) => ({ index, translation: "迟到的快速翻译" })));
    await delay(180);
    assert.equal(translation(browser), "文档预览");
    assert.equal(browser.windows.length, 1, "no repeated request for successful cached fallback cues");
  } finally { browser.close(); }
});

test("seeking cancels an irrelevant legacy request and translates the new position, not the intervening video", async () => {
  const browser = new BrowserFixture();
  try {
    await start(browser);
    await eventually(() => browser.windows.length === 1);
    const old = browser.windows[0];
    browser.seek(400_000);
    await eventually(() => browser.windows.length === 2);
    assert.equal(old.signal?.aborted, true);
    const current = browser.windows[1];
    assert.equal(current.body.playback_ms, 400_000);
    assert.ok(current.body.source_cues!.every(cue => inPlaybackWindow(cue, 400_000)));
    assert.ok(current.body.source_cues!.length <= PLAYBACK_MAX_CUES);
    old.respond([{ index: 0, translation: "旧位置" }]);
    current.respond(current.body.source_cues!.map(cue => ({ index: source.find(s => s.start === cue.start)!.index, translation: "新位置" })));
    await eventually(() => translation(browser) === "新位置");
    browser.seek(1000);
    await delay(30);
    assert.notEqual(translation(browser), "旧位置", "aborted responses are discarded");
    browser.seek(400_000);
    await delay(180);
    assert.equal(browser.windows.length, 2, "returning to an already translated window uses local results");
  } finally { browser.close(); }
});

test("toggle and SPA navigation abort legacy work and reject its late response", async () => {
  for (const navigate of [false, true]) {
    const browser = new BrowserFixture();
    try {
      await start(browser);
      await eventually(() => browser.windows.length === 1);
      const old = browser.windows[0];
      if (navigate) browser.navigate("new-video"); else browser.toggle();
      assert.equal(old.signal?.aborted, true);
      old.respond([{ index: 0, translation: "过期译文" }]);
      await delay(150);
      assert.equal(browser.isOff(), true);
      assert.notEqual(translation(browser), "过期译文");
      assert.equal(browser.windows.length, 1);
    } finally { browser.close(); }
  }
});

test("legacy failures are best-effort and rate-limited; document failure leaves the fallback available", async () => {
  const browser = new BrowserFixture();
  try {
    await start(browser);
    await eventually(() => browser.windows.length === 1);
    browser.windows[0].respond([], 503);
    for (let i = 0; i < 10; i++) browser.seek(1000);
    await delay(180);
    assert.equal(browser.windows.length, 1, "failed cues have a retry cooldown");
    assert.equal(browser.streams.length, 1);
    browser.send([{ type: "error", detail: "Document provider unavailable" }]); browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("Document provider unavailable") === true);
    browser.seek(400_000);
    await eventually(() => browser.windows.length === 2);
    browser.windows[1].respond([{ index: 80, translation: "仍可观看" }]);
    await eventually(() => translation(browser) === "仍可观看");
    assert.equal(browser.streams.length, 1);
  } finally { browser.close(); }
});

test("explicit legacy mode and untranslated subtitles never start the document fallback", async () => {
  for (const settings of [{ translateEngine: "legacy" }, { autoTranslate: false }]) {
    const browser = new BrowserFixture(settings);
    try {
      await start(browser); browser.seek(1000);
      await delay(180);
      assert.equal(browser.windows.length, 0);
    } finally { browser.close(); }
  }
});

test("dense captions are capped per batch and document-covered cues are never requested", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const dense = Array.from({ length: 100 }, (_, index) => ({
      type: "source_cue", index, start: index * 1000, end: index * 1000 + 900, text: `Dense ${index}`,
    }));
    browser.send([{ type: "meta", total_cues: dense.length }, ...dense,
      { ...dense[31], type: "cue", translation: "已有文档译文", provisional: true }]);
    browser.seek(30_500);
    await eventually(() => browser.windows.length === 1);
    const requested = browser.windows[0].body.source_cues!;
    assert.equal(requested.length, PLAYBACK_MAX_CUES);
    assert.ok(requested.some(cue => cue.start === 30_000), "current caption has priority");
    assert.ok(requested.every(cue => cue.start >= 30_000 && cue.start !== 31_000), "future captions before past, no document duplicates");
    assert.ok(requested.every(cue => inPlaybackWindow(cue, 30_500)));
    // Complete document coverage before the deferred legacy response.
    browser.send(dense.map(cue => ({ ...cue, type: "cue", translation: "文档预览", provisional: true })));
    await eventually(() => browser.windows[0].signal?.aborted === true);
    browser.windows[0].respond([{ index: 30, translation: "迟到" }]);
    await delay(150);
    assert.equal(browser.windows.length, 1);
    assert.equal(translation(browser), "文档预览");
  } finally { browser.close(); }
});

test("source replay preserves fallback and document final cannot regress to a preview", () => {
  const legacy = { start: 0, end: 1000, text: "Source", translation: "Fast", translationSource: "legacy" as const };
  const replayed = mergeSubtitleEvent(legacy, { type: "source_cue", translation: "" }, true);
  assert.equal(replayed.translation, "Fast");
  const final = mergeSubtitleEvent(replayed, { type: "cue", translation: "Final" }, true);
  assert.equal(final.translationSource, "document");
  assert.equal(mergeSubtitleEvent(final, { type: "cue", translation: "Old preview", provisional: true }, true).translation, "Final");
  assert.equal(mergeSubtitleEvent(final, { type: "cue", translation: "[Translation failed]" }, true).translation, "Final");
});
