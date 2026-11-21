import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually } from "../features/support/browser.js";

function input(document: Document, id: string, value: string) {
  const element = document.getElementById(id) as HTMLInputElement;
  element.value = value;
  element.dispatchEvent(new document.defaultView!.Event("input"));
}

test("asynchronous live writes preserve both sizes across options pages", async () => {
  const browser = new BrowserFixture({ fontSizeOrig: 18, fontSizeTran: 24, translateApiKey: "existing-key" });
  try {
    const first = browser.options();
    const second = browser.options();
    browser.storageDelayMs = 10;
    input(first, "fontSizeOrig", "30");
    input(second, "fontSizeTran", "32");
    await eventually(() => browser.storageWrites === 2);
    assert.equal(browser.settings.fontSizeOrig, 30);
    assert.equal(browser.settings.fontSizeTran, 32);
    input(first, "fontSizeOrig", "32");
    input(first, "fontSizeOrig", "34");
    await eventually(() => browser.storageWrites === 4);
    assert.equal(browser.settings.fontSizeOrig, 34);
    assert.equal(browser.settings.fontSizeTran, 32);
    assert.equal(browser.settings.translateApiKey, "existing-key");
    for (const document of [first, second]) {
      assert.equal((document.getElementById("fontSizeOrig") as HTMLInputElement).value, "34");
      assert.equal((document.getElementById("fontSizeTran") as HTMLInputElement).value, "32");
    }
  } finally { browser.close(); }
});

test("stale storage acknowledgements do not overwrite newer slider edits", async () => {
  const browser = new BrowserFixture({ fontSizeOrig: 18 });
  try {
    const first = browser.options();
    const second = browser.options();
    browser.storageDelayMs = 20;
    const slider = first.getElementById("fontSizeOrig") as HTMLInputElement;
    const remoteSlider = second.getElementById("fontSizeOrig") as HTMLInputElement;
    input(first, "fontSizeOrig", "19");
    input(first, "fontSizeOrig", "20");
    await eventually(() => browser.storageWrites === 1);
    assert.equal(remoteSlider.value, "19", "other pages still receive committed changes");
    assert.equal(slider.value, "20", "an older write must not reset the local slider");
    assert.equal(first.getElementById("fontSizeOrigVal")!.textContent, "20px");
    assert.equal(first.getElementById("previewOrig")!.style.fontSize, "20px");
    // Simulate another ArrowRight using the current control value.
    input(first, "fontSizeOrig", String(Number(slider.value) + 1));
    await eventually(() => browser.storageWrites === 2);
    assert.equal(slider.value, "21", "an older callback must not clear the latest pending edit");
    await eventually(() => browser.storageWrites === 3);
    assert.equal(browser.settings.fontSizeOrig, 21);
    assert.equal(remoteSlider.value, "21");
    input(second, "fontSizeOrig", "22");
    await eventually(() => browser.storageWrites === 4);
    assert.equal(slider.value, "22", "remote updates resume after local writes finish");
  } finally { browser.close(); }
});

test("overlapping drag, API Save and live controls retain each field and budget deletion", async () => {
  const browser = new BrowserFixture({ positionY: 12, translateRequestBudget: 100, fontSizeOrig: 18 });
  try {
    const options = browser.options();
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.toggle(); // Keep the mounted draggable overlay, but stop translation.
    const document = browser.dom.window.document;
    const overlay = document.getElementById("yts-overlay")!;
    const player = document.getElementById("movie_player")!;
    Object.defineProperty(player, "clientHeight", { value: 400 });
    Object.defineProperty(overlay, "offsetHeight", { value: 50 });
    player.getBoundingClientRect = () => ({ bottom: 600 }) as DOMRect;
    overlay.getBoundingClientRect = () => ({ bottom: 400 }) as DOMRect;
    browser.storageDelayMs = 10;
    const mouse = (target: Element | Document, type: string, clientY: number) => {
      target.dispatchEvent(new browser.dom.window.MouseEvent(type, { button: 0, clientY }));
    };
    mouse(overlay, "mousedown", 200);
    mouse(document, "mousemove", 220);
    mouse(document, "mouseup", 220);
    input(options, "fontSizeOrig", "30");
    (options.getElementById("translateApiKey") as HTMLInputElement).value = "updated-key";
    (options.getElementById("translateRequestBudget") as HTMLInputElement).value = "";
    options.getElementById("saveButton")!.click();
    // Saved confirmation must wait for the queued write to succeed.
    assert.equal(options.getElementById("savedMsg")!.classList.contains("show"), false);
    input(options, "fontSizeTran", "32");
    await eventually(() => browser.storageWrites === 4);
    assert.equal(browser.settings.positionY, 45);
    assert.equal(browser.settings.fontSizeOrig, 30);
    assert.equal(browser.settings.fontSizeTran, 32);
    assert.equal(browser.settings.translateApiKey, "updated-key");
    assert.equal(browser.settings.translateRequestBudget, undefined);
    assert.equal(options.getElementById("savedMsg")!.classList.contains("show"), true);
  } finally { browser.close(); }
});

for (const operation of ["get", "set"] as const) {
  test(`storage ${operation} failure returns a stable boundary error without retrying or reporting success`, async () => {
    const browser = new BrowserFixture({ fontSizeOrig: 18 });
    try {
      browser.storageDelayMs = 5;
      browser.storageFailure = operation;
      const runtime = (browser.dom.window as unknown as { chrome: typeof chrome }).chrome.runtime;
      const result = await new Promise(resolve => runtime.sendMessage({ action: "updateSettings", patch: { fontSizeOrig: 30 }, remove: [] }, resolve));
      assert.deepEqual(result, { ok: false, code: operation === "get" ? "settings_read_failed" : "settings_write_failed" });
      assert.equal(browser.settings.fontSizeOrig, 18);
      assert.equal(browser.storageWrites, 0);
    } finally { browser.close(); }
  });
}
