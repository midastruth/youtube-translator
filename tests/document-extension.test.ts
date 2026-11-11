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
