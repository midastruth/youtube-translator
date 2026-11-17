import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually } from "../features/support/browser.js";

test("new installations choose document mode and display background editing-agent progress", async () => {
  const browser = new BrowserFixture();
  try {
    const options = browser.options();
    assert.equal((options.getElementById("translateEngine") as HTMLSelectElement).value, "document");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_engine, "document");
    browser.send([{ type: "meta", total_cues: 1 }, { type: "source_cue", index: 0, start: 0, end: 2000, text: "Source" }, { type: "progress", stage: "editing", progress: "1/1，已执行 3 轮" }]);
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("翻译 Agent") === true);
    browser.send([{ type: "error", code: "document_translation_failed", detail: "Agent 提交失败；未降级为逐句翻译" }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("Agent 提交失败") === true);
    assert.equal(browser.streams.length, 1);
  } finally { browser.close(); }
});

test("cached Whisper discovery skips waiting for player captions and passes only non-secret cache settings", async () => {
  const browser = new BrowserFixture({ segmentation: "statistical", whisperEnabled: true,
    whisperLanguage: "en", whisperBaseUrl: "https://whisper.invalid/v1", whisperModel: "whisper-custom",
    whisperApiKey: "secret-whisper-key", translateApiKey: "secret-translation-key" });
  const originalFetch = browser.dom.window.fetch.bind(browser.dom.window);
  let query: URLSearchParams | undefined;
  browser.dom.window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/subtitle/tracks?")) {
      query = new URL(String(input)).searchParams;
      return Response.json({ tracks: [], cached_source: true });
    }
    return originalFetch(input, init);
  };
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1, "cached Whisper must start without player captions");
    assert.equal(query?.get("prefer_cached"), "true");
    assert.equal(query?.get("segmentation"), "statistical");
    assert.equal(query?.get("whisper_enabled"), "true");
    assert.equal(query?.get("whisper_language"), "en");
    assert.equal(query?.get("whisper_base_url"), "https://whisper.invalid/v1");
    assert.equal(query?.get("whisper_model"), "whisper-custom");
    assert.doesNotMatch(query!.toString(), /secret|api_key/i);
    assert.equal(browser.streams[0].body.source_events, undefined);
    assert.equal(browser.streams[0].body.source_cues, undefined);
    assert.equal(browser.streams[0].body.whisper_language, "en");
    browser.send([{ type: "meta", total_cues: 1, completed_cues: 1 },
      { type: "cue", index: 0, start: 0, end: 2000, text: "Hello", translation: "你好", cached: true },
      { type: "done", failed_cues: 0 }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("字幕翻译完成") === true);
  } finally { browser.close(); }
});

test("obsolete saved engine settings select the current team mode", async () => {
  const browser = new BrowserFixture({ translateEngine: "agent" });
  try {
    const options = browser.options();
    const engine = options.getElementById("translateEngine") as HTMLSelectElement;
    assert.deepEqual([...engine.options].map(option => option.value), ["document", "legacy"]);
    assert.equal(engine.value, "document");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_engine, "document");
  } finally { browser.close(); }
});

test("explicit saved fast-mode preference is preserved", async () => {
  const browser = new BrowserFixture({ translateEngine: "legacy" });
  try {
    const options = browser.options();
    assert.equal((options.getElementById("translateEngine") as HTMLSelectElement).value, "legacy");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_engine, "legacy");
  } finally { browser.close(); }
});

test("a failed document review keeps submitted previews and explains resuming", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.send([
      { type: "meta", total_cues: 3 },
      { type: "source_cue", index: 0, start: 0, end: 1000, text: "One" },
      { type: "source_cue", index: 1, start: 1000, end: 2000, text: "Two" },
      { type: "source_cue", index: 2, start: 2000, end: 3000, text: "Three" },
      { type: "cue", index: 0, start: 0, end: 1000, text: "One", translation: "一", provisional: true },
    ]);
    browser.send([{ type: "error", code: "document_translation_failed", detail: "主 Agent 验收已覆盖全部字幕但未收尾" }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("预览字幕仍可观看") === true);
    const message = browser.dom.window.document.querySelector(".status")!.textContent!;
    assert.match(message, /主 Agent 验收已覆盖全部字幕但未收尾/);
    assert.match(message, /已提交的 1\/3 条预览字幕仍可观看/);
    assert.match(message, /重新开启翻译会从检查点续翻/);
  } finally { browser.close(); }
});

test("the resume hint also appears when every cue was previewed before the review failed", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.send([
      { type: "meta", total_cues: 2 },
      { type: "source_cue", index: 0, start: 0, end: 1000, text: "One" },
      { type: "source_cue", index: 1, start: 1000, end: 2000, text: "Two" },
      { type: "cue", index: 0, start: 0, end: 1000, text: "One", translation: "一", provisional: true },
      { type: "cue", index: 1, start: 1000, end: 2000, text: "Two", translation: "二", provisional: true },
    ]);
    browser.send([{ type: "error", code: "document_translation_failed", detail: "主 Agent 验收已覆盖全部字幕但未收尾" }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("已提交的 2/2 条预览字幕仍可观看") === true);
  } finally { browser.close(); }
});
