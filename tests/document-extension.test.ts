import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually } from "../features/support/browser.js";

test("new installations choose document mode and display background review progress", async () => {
  const browser = new BrowserFixture();
  try {
    const options = browser.options();
    assert.equal((options.getElementById("translateEngine") as HTMLSelectElement).value, "document");
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    assert.equal(browser.streams[0].body.translate_engine, "document");
    browser.send([{ type: "meta", total_cues: 1 }, { type: "source_cue", index: 0, start: 0, end: 2000, text: "Source" }, { type: "progress", stage: "review", progress: "1/1" }]);
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("双语审校") === true);
    browser.send([{ type: "error", code: "document_translation_failed", detail: "审校未通过；未降级为逐句翻译" }]);
    browser.finish();
    await eventually(() => browser.dom.window.document.querySelector(".status")?.textContent?.includes("审校未通过") === true);
    assert.equal(browser.streams.length, 1);
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
