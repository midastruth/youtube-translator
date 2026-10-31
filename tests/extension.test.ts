import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually, OLD_SETTINGS as oldSettings } from "../features/support/browser.js";
import { normalizeJson3, parseBrowserSubtitles } from "../extension/src/types.js";

test("settings page saves existing values, trims backend, and sends real content request", async () => {
  const browser = new BrowserFixture(oldSettings);
  try {
    const document = browser.options();
    const url = document.getElementById("backendUrl");
    const engine = document.getElementById("translateEngine");
    assert.ok(url && "value" in url && engine && "value" in engine);
    url.value = "http://localhost:8791///"; engine.value = "document";
    document.getElementById("saveButton")!.click();
    assert.deepEqual(browser.settings, { ...browser.settings, ...oldSettings, backendUrl: "http://localhost:8791", translateEngine: "document" });
    browser.execute("content");
    assert.equal(browser.streams.length, 0);
    browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].url, "http://localhost:8791/api/subtitle/stream");
    assert.equal(browser.streams[0].body.translate_api_key, oldSettings.translateApiKey);
    assert.equal(browser.streams[0].body.translate_engine, "document");
  } finally { browser.close(); }
});

test("request budget is validated, persisted and sent by the document extension", async () => {
  const browser = new BrowserFixture();
  try {
    const document = browser.options();
    const budget = document.getElementById("translateRequestBudget") as HTMLInputElement;
    assert.equal(budget.value, "");
    for (const invalid of ["-1", "1001", "1.5"]) {
      budget.value = invalid;
      document.getElementById("saveButton")!.click();
      assert.equal(browser.settings.translateRequestBudget, undefined);
      assert.equal(budget.checkValidity(), false);
    }
    budget.value = "512";
    document.getElementById("saveButton")!.click();
    assert.equal(browser.settings.translateRequestBudget, 512);
    assert.equal((browser.options().getElementById("translateRequestBudget") as HTMLInputElement).value, "512");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_request_budget, 512);
    assert.equal(browser.streams[0].body.translate_engine, "document");
  } finally { browser.close(); }
});

test("zero request budget disables the limit and is not dropped as a falsy setting", async () => {
  const browser = new BrowserFixture({ translateRequestBudget: 512 });
  try {
    const document = browser.options();
    (document.getElementById("translateRequestBudget") as HTMLInputElement).value = "0";
    document.getElementById("saveButton")!.click();
    assert.equal(browser.settings.translateRequestBudget, 0);
    assert.equal((browser.options().getElementById("translateRequestBudget") as HTMLInputElement).value, "0");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_request_budget, 0);
  } finally { browser.close(); }
});

test("blank request budget removes the override and inherits the server limit", async () => {
  const browser = new BrowserFixture({ translateRequestBudget: 512 });
  try {
    const document = browser.options();
    (document.getElementById("translateRequestBudget") as HTMLInputElement).value = "";
    document.getElementById("saveButton")!.click();
    assert.equal(browser.settings.translateRequestBudget, undefined);
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_request_budget, undefined);
  } finally { browser.close(); }
});

test("stream errors distinguish subtitle loading from translation and explain budget continuation", async () => {
  for (const scenario of [
    { meta: false, detail: "No captions", prefix: "字幕加载失败" },
    { meta: true, detail: "provider_error", prefix: "字幕翻译失败" },
    { meta: false, detail: "subagent-7: Document translation exhausted its model request budget", prefix: "翻译请求预算已耗尽" },
    { meta: false, detail: "翻译请求预算已耗尽；请提高预算后继续", prefix: "翻译请求预算已耗尽" },
    { meta: true, detail: "subagent-1: 翻译 Token 预算已耗尽", prefix: "翻译 Token 预算已耗尽" },
  ]) {
    const browser = new BrowserFixture();
    try {
      browser.execute("content"); browser.toggle();
      await eventually(() => browser.streams.length === 1);
      if (scenario.meta) browser.send([{ type: "meta", total_cues: 2054 }]);
      browser.send([{ type: "error", detail: scenario.detail }]);
      browser.finish();
      await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.startsWith(scenario.prefix) === true);
      const message = browser.dom.window.document.querySelector(".status")!.textContent!;
      assert.ok(message.includes(scenario.detail));
      if (scenario.prefix === "翻译请求预算已耗尽") {
        assert.match(message, /512.*续翻已保存草稿/);
        assert.doesNotMatch(message, /字幕加载失败/);
      }
      if (scenario.prefix === "翻译 Token 预算已耗尽") {
        assert.match(message, /草稿已保留.*重新开启翻译.*重置 Token 预算并续翻/);
        assert.doesNotMatch(message, /512|请提高预算/);
      }
      assert.equal(browser.streams.length, 1, "budget failures do not start automatic fresh tasks");
    } finally { browser.close(); }
  }
});

test("duplicate cue replaces one subtitle; actual background action exports milliseconds", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.execute("background"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const cue = { index: 0, start: 1000, end: 2500, text: "Hello", translation: "你好" };
    browser.send([{ type: "meta", total_cues: 1, failed_cues: 0 }, { type: "source_cue", ...cue }, { type: "cue", ...cue }, { type: "cue", ...cue }, { type: "done", total_cues: 1, failed_cues: 0 }]);
    browser.finish(); browser.seek(1500);
    await eventually(() => browser.dom.window.document.querySelector(".tran")?.textContent === "你好");
    browser.clickAction();
    assert.equal(browser.response?.count, 1);
    assert.equal(browser.downloads.length, 1);
    assert.match(await browser.downloads[0].blob.text(), /00:01.000 --> 00:02.500\nHello\n你好/);
  } finally { browser.close(); }
});

test("opening preview renders while the stream is live, then final review replaces it at the same index", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.execute("background"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const opening = { index: 0, start: 1000, end: 2500, text: "Transaction" };
    const later = { index: 1, start: 2500, end: 4000, text: "Later definition" };
    browser.send([{ type: "meta", total_cues: 2 }, { type: "source_cue", ...opening }, { type: "source_cue", ...later },
      { type: "cue", ...opening, translation: "开头预览", provisional: true }]);
    browser.seek(1500);
    await eventually(() => browser.dom.window.document.querySelector(".tran")?.textContent === "开头预览");
    assert.match(browser.dom.window.document.querySelector(".status")!.textContent!, /已提交片段可先观看.*全文审校后/);
    browser.send([{ type: "cue", ...opening, translation: "统一审校后的事务", provisional: false },
      { type: "cue", ...later, translation: "后续定义", provisional: false }, { type: "done", total_cues: 2, failed_cues: 0 }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".tran")?.textContent === "统一审校后的事务");
    browser.clickAction();
    assert.equal(browser.response?.count, 2);
    const exported = await browser.downloads[0].blob.text();
    assert.match(exported, /统一审校后的事务/); assert.doesNotMatch(exported, /开头预览/);
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
    const oldVideo = browser.dom.window.document.querySelector("video");
    browser.navigate("new-video");
    assert.notEqual(browser.dom.window.document.querySelector("video"), oldVideo);
    browser.send([{ type: "cue", index: 0, start: 0, end: 2000, text: "late", translation: "迟到" }, { type: "done", total_cues: 1, failed_cues: 0 }], old);
    browser.finish(old);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(browser.isOff(), true); assert.equal(browser.streams.length, 1);
    assert.equal(browser.dom.window.document.querySelector<HTMLElement>(".bg")?.style.display, "none");
    browser.toggle(); await eventually(() => browser.streams.length === 2);
    assert.match(browser.streams[1].body.url, /v=new-video$/);
  } finally { browser.close(); }
});

test("a translation without source timing cannot invent an exportable zero-length cue", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.execute("background"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.send([{ type: "meta", total_cues: 1, failed_cues: 0 }, { type: "cue", index: 0, text: "Hello", translation: "你好" }, { type: "done", total_cues: 1, failed_cues: 0 }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("字幕翻译完成") === true);
    browser.clickAction();
    assert.equal(browser.response?.ok, false); assert.equal(browser.downloads.length, 0);
  } finally { browser.close(); }
});

test("json3 normalization preserves word offsets and rejects malformed cross-world details", () => {
  const events = [{ tStartMs: 100, dDurationMs: 1000, segs: [{ utf8: "Hello", tOffsetMs: 123 }], aAppend: 1 }];
  assert.deepEqual(normalizeJson3({ events }), events);
  assert.deepEqual(parseBrowserSubtitles(JSON.stringify({ videoId: "v", language: "en", events }))?.events, events);
  assert.equal(parseBrowserSubtitles("not json"), null);
  assert.equal(parseBrowserSubtitles({ videoId: "v", events }), null);
});
