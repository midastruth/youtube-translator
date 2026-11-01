import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually, OLD_SETTINGS } from "../features/support/browser.js";
import type { StreamRequest } from "../extension/src/types.js";

const downloadError = "yt-dlp failed: ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests";
const events = [{ tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: "Hello.", tOffsetMs: 123 }] }];
const source = { videoId: "fixture-video", title: "Player title", language: "en", events };
const status = (browser: BrowserFixture) => browser.dom.window.document.querySelector(".status")?.textContent || "";
const streamBodies = (browser: BrowserFixture): StreamRequest[] => browser.requests
  .filter(request => request.url.endsWith("/api/subtitle/stream"))
  .map(request => JSON.parse(String(request.init?.body)));
function capture(browser: BrowserFixture, detail = source) {
  browser.dom.window.dispatchEvent(new browser.dom.window.CustomEvent("yts-browser-subtitles", { detail: JSON.stringify(detail) }));
}

for (const transport of ["http400", "http429", "sse"] as const) {
  test(`subtitle download failure (${transport}) retries with actual bridge JSON3, not yt-dlp`, async () => {
    const browser = new BrowserFixture(OLD_SETTINGS);
    try {
      browser.playerPayload = JSON.stringify({ events });
      browser.setPlayerResponse({ videoDetails: { videoId: "fixture-video" }, captions: { playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=fixture-video&lang=en", languageCode: "en" }],
      } } });
      if (transport !== "sse") browser.streamResponses.push(Response.json({ detail: downloadError }, { status: transport === "http400" ? 400 : 429 }));
      browser.execute("bridge"); browser.execute("content"); browser.toggle();
      if (transport === "sse") {
        await eventually(() => browser.streams.length === 1);
        browser.send([{ type: "error", detail: downloadError }]); browser.finish();
      }
      await eventually(() => streamBodies(browser).length === 2, "browser subtitle retry");
      const [original, fallback] = streamBodies(browser);
      assert.equal(original.language, "en"); assert.equal(original.source_events, undefined);
      assert.deepEqual(fallback.source_events, events);
      assert.equal(fallback.source_video_id, "fixture-video"); assert.equal(fallback.source_language, "en");
      assert.equal(fallback.language, undefined, "do not retain the failed backend track selection");
      assert.equal(fallback.translate_api_key, OLD_SETTINGS.translateApiKey);
      assert.equal(fallback.translate_model, OLD_SETTINGS.translateModel);
      assert.equal(browser.requests.filter(request => request.url.includes("/api/subtitle/tracks")).length, 1);
      assert.doesNotMatch(JSON.stringify(fallback), /cookie/i);
      browser.send([{ type: "meta", total_cues: 1 }, { type: "cue", index: 0, start: 1000, end: 2500, text: "Hello.", translation: "你好。" }, { type: "done", failed_cues: 0 }]);
      browser.finish(); browser.seek(1500);
      await eventually(() => status(browser).includes("字幕翻译完成"));
      assert.equal(browser.dom.window.document.querySelector(".tran")?.textContent, "你好。");
    } finally { browser.close(); }
  });
}

test("download fallback waits for original player captions, ignores other videos and only retries once", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.send([{ type: "error", detail: downloadError }]); browser.finish();
    await eventually(() => status(browser).includes("请打开播放器"));
    capture(browser, { ...source, videoId: "another-video" });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(browser.streams.length, 1);
    capture(browser);
    await eventually(() => browser.streams.length === 2);
    assert.deepEqual(browser.streams[1].body.source_events, events);
    browser.send([{ type: "error", detail: downloadError }]); browser.finish();
    await eventually(() => status(browser).startsWith("字幕加载失败"));
    capture(browser);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(browser.streams.length, 2, "a failed browser-source request must not loop");
  } finally { browser.close(); }
});

test("missing player captions time out without repeating yt-dlp and retain the original error", async () => {
  const browser = new BrowserFixture();
  try {
    const originalTimeout = browser.dom.window.setTimeout.bind(browser.dom.window);
    browser.dom.window.setTimeout = (handler, timeout, ...args) => originalTimeout(handler, timeout === 8000 ? 10 : timeout, ...args);
    browser.streamResponses.push(Response.json({ detail: downloadError }, { status: 400 }));
    browser.execute("content"); browser.toggle();
    await eventually(() => status(browser).startsWith("字幕加载失败"));
    assert.ok(status(browser).includes(downloadError));
    assert.match(status(browser), /播放器.*字幕.*重新开启翻译/);
    assert.equal(streamBodies(browser).length, 1);
  } finally { browser.close(); }
});

for (const action of ["disable", "navigate"] as const) {
  test(`${action} cancels a pending browser fallback; late captions cannot restart it`, async () => {
    const browser = new BrowserFixture();
    try {
      browser.streamResponses.push(Response.json({ detail: downloadError }, { status: 400 }));
      browser.execute("content"); browser.toggle();
      await eventually(() => status(browser).includes("请打开播放器"));
      if (action === "disable") browser.toggle();
      else browser.navigate("another-video");
      capture(browser);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(streamBodies(browser).length, 1);
      assert.equal(browser.isOff(), true);
    } finally { browser.close(); }
  });
}

test("translation and unrelated backend errors never switch to browser captions", async () => {
  for (const scenario of [
    { meta: true, detail: downloadError },
    { meta: false, detail: "Translation provider HTTP Error 429: Too Many Requests" },
    { meta: false, detail: "Document translation exhausted its model request budget" },
  ]) {
    const browser = new BrowserFixture();
    try {
      browser.execute("content"); browser.toggle();
      await eventually(() => browser.streams.length === 1);
      capture(browser);
      if (scenario.meta) browser.send([{ type: "meta", total_cues: 1 }]);
      browser.send([{ type: "error", detail: scenario.detail }]); browser.finish();
      await eventually(() => status(browser).includes(scenario.detail));
      assert.equal(browser.streams.length, 1);
      assert.equal(streamBodies(browser).length, 1);
    } finally { browser.close(); }
  }
});
