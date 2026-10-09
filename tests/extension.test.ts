import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually, OLD_SETTINGS as oldSettings } from "../features/support/browser.js";
import { normalizeJson3, parseBrowserSubtitles } from "../minimal-extension/src/types.js";

test("settings page saves existing values, trims backend, and sends real content request", async () => {
  const browser = new BrowserFixture(oldSettings);
  try {
    const document = browser.options();
    const url = document.getElementById("backendUrl");
    const engine = document.getElementById("translateEngine");
    assert.ok(url && "value" in url && engine && "value" in engine);
    url.value = "http://localhost:8791///"; engine.value = "agent";
    document.getElementById("saveButton")!.click();
    assert.deepEqual(browser.settings, { ...browser.settings, ...oldSettings, backendUrl: "http://localhost:8791", translateEngine: "agent" });
    browser.execute("content");
    assert.equal(browser.streams.length, 0);
    browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].url, "http://localhost:8791/api/subtitle/stream");
    assert.equal(browser.streams[0].body.translate_api_key, oldSettings.translateApiKey);
    assert.equal(browser.streams[0].body.translate_engine, "agent");
  } finally { browser.close(); }
});

test("duplicate cue replaces one subtitle; actual background action exports milliseconds", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.execute("background"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const cue = { index: 0, start: 1000, end: 2500, text: "Hello", translation: "你好" };
    browser.send([{ type: "meta", total_cues: 1 }, { type: "source_cue", ...cue }, { type: "cue", ...cue }, { type: "cue", ...cue }, { type: "done", total_cues: 1, failed_cues: 0 }]);
    browser.finish(); browser.seek(1500);
    await eventually(() => browser.dom.window.document.querySelector(".tran")?.textContent === "你好");
    browser.clickAction();
    assert.equal(browser.response?.count, 1);
    assert.equal(browser.downloads.length, 1);
    assert.match(await browser.downloads[0].blob.text(), /00:01.000 --> 00:02.500\nHello\n你好/);
  } finally { browser.close(); }
});

test("new page and SPA navigation start off despite legacy enabled; stale stream cannot repaint", async () => {
  const browser = new BrowserFixture({ enabled: true });
  try {
    browser.execute("content"); assert.equal(browser.isOff(), true); assert.equal(browser.requests.length, 0);
    browser.toggle(); await eventually(() => browser.streams.length === 1);
    const old = browser.streams[0];
    browser.send([{ type: "meta", total_cues: 1 }, { type: "source_cue", index: 0, start: 0, end: 2000, text: "old" }], old);
    browser.seek(100);
    await eventually(() => browser.dom.window.document.querySelector(".orig")?.textContent === "old");
    browser.navigate("new-video");
    browser.send([{ type: "cue", index: 0, start: 0, end: 2000, text: "late", translation: "迟到" }, { type: "done", total_cues: 1, failed_cues: 0 }], old);
    browser.finish(old);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(browser.isOff(), true); assert.equal(browser.streams.length, 1);
    assert.equal(browser.dom.window.document.querySelector<HTMLElement>(".bg")?.style.display, "none");
    browser.toggle(); await eventually(() => browser.streams.length === 2);
    assert.match(browser.streams[1].body.url, /v=new-video$/);
  } finally { browser.close(); }
});

test("json3 normalization preserves word offsets and rejects malformed cross-world details", () => {
  const events = [{ tStartMs: 100, dDurationMs: 1000, segs: [{ utf8: "Hello", tOffsetMs: 123 }], aAppend: 1 }];
  assert.deepEqual(normalizeJson3({ events }), events);
  assert.deepEqual(parseBrowserSubtitles(JSON.stringify({ videoId: "v", language: "en", events }))?.events, events);
  assert.equal(parseBrowserSubtitles("not json"), null);
  assert.equal(parseBrowserSubtitles({ videoId: "v", events }), null);
});
