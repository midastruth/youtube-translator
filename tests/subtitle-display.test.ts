import assert from "node:assert/strict";
import { test } from "node:test";
import { subtitleScale } from "../extension/src/subtitle-display.js";
import { BrowserFixture, eventually } from "../features/support/browser.js";

test("automatic scaling has bounds and independent manual adjustment", () => {
  assert.equal(subtitleScale(1280), 1);
  assert.equal(subtitleScale(320), 0.8);
  assert.equal(subtitleScale(3840), 1.6);
  assert.equal(subtitleScale(3840, false, 1.2), 1.2);
  assert.equal(subtitleScale(1280, true, 9), 2);
});

test("live display controls preserve API settings and active translation", async () => {
  const browser = new BrowserFixture({ translateApiKey: "keep", fontSizeOrig: 27 });
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const options = browser.options();
    assert.equal((options.getElementById("fontSizeOrig") as HTMLInputElement).value, "27");
    assert.equal((options.getElementById("fontSizeTran") as HTMLInputElement).value, "24");
    const slider = options.getElementById("fontSizeTran") as HTMLInputElement;
    slider.value = "30";
    slider.dispatchEvent(new options.defaultView!.Event("input"));
    assert.equal(browser.settings.fontSizeTran, 30);
    assert.equal(options.getElementById("previewTran")!.style.fontSize, "30px");
    assert.equal(browser.settings.translateApiKey, "keep");
    assert.equal(browser.streams[0].signal?.aborted, false);
    assert.equal(options.getElementById("previewTran")!.style.fontWeight, "400");
    assert.equal(browser.dom.window.document.querySelectorAll(".yts-font-button").length, 0);
    assert.match(browser.dom.window.document.getElementById("yts-style")!.textContent!, /\.tran \{[^}]*font-weight:400/);
    const scale = options.getElementById("fontScale") as HTMLInputElement;
    scale.value = "110";
    scale.dispatchEvent(new options.defaultView!.Event("input"));
    assert.equal(browser.settings.fontScale, 1.1);
    assert.equal((options.getElementById("fontScale") as HTMLInputElement).value, "110");
    assert.equal(options.getElementById("previewTran")!.style.fontSize, "33px");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(browser.streams.length, 1);
    assert.equal(browser.streams[0].signal?.aborted, false);
  } finally { browser.close(); }
});

test("subtitle text displays unchanged and preserves timing and export", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.execute("background"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const translation = "这是一句需要完整阅读的字幕，".repeat(4) + "不能因标点而丢失后半句。";
    const cue = { index: 0, start: 1000, end: 1400, text: "A whole sentence.", translation };
    browser.send([{ type: "meta", total_cues: 1 }, { type: "source_cue", ...cue }, { type: "cue", ...cue }, { type: "done", total_cues: 1 }]);
    browser.finish(); browser.seek(1100);
    await eventually(() => browser.dom.window.document.querySelector(".tran")?.textContent === translation);
    const bg = browser.dom.window.document.querySelector<HTMLElement>("#yts-overlay .bg")!;
    assert.equal(bg.style.display, "block");
    browser.seek(1500);
    await eventually(() => bg.style.display === "none");
    browser.clickAction();
    const vtt = await browser.downloads[0].blob.text();
    assert.match(vtt, /00:01.000 --> 00:01.400/);
    assert.ok(vtt.includes(translation));
  } finally { browser.close(); }
});

test("subtitle width uses its content and a wider fullscreen cap, restoring on exit", async () => {
  const browser = new BrowserFixture();
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const { document, getComputedStyle } = browser.dom.window;
    const overlay = document.getElementById("yts-overlay")!;
    const player = document.getElementById("movie_player")!;
    assert.equal(getComputedStyle(overlay).width, "max-content");
    assert.equal(getComputedStyle(overlay).maxWidth, "85%");
    player.classList.add("ytp-fullscreen");
    assert.equal(getComputedStyle(overlay).maxWidth, "95%");
    player.classList.add("ytp-autohide");
    assert.equal(getComputedStyle(overlay).maxWidth, "95%");
    player.classList.remove("ytp-fullscreen");
    assert.equal(getComputedStyle(overlay).maxWidth, "85%");
    assert.equal(browser.streams.length, 1);
    assert.equal(browser.streams[0].signal?.aborted, false);
  } finally { browser.close(); }
});

test("ResizeObserver updates player-relative font size in fullscreen and fixed mode", async () => {
  const browser = new BrowserFixture();
  let resize: (entries: { contentRect: { width: number } }[]) => void = () => {};
  Object.defineProperty(browser.dom.window, "ResizeObserver", { value: class {
    constructor(callback: typeof resize) { resize = callback; }
    observe() {} disconnect() {}
  } });
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    resize([{ contentRect: { width: 2560 } }]);
    const style = () => browser.dom.window.document.getElementById("yts-style")!.textContent;
    assert.match(style(), /font-size:38\.4px/);
    const options = browser.options();
    const auto = options.getElementById("autoScale") as HTMLSelectElement;
    auto.value = "false";
    auto.dispatchEvent(new options.defaultView!.Event("input"));
    assert.match(style(), /font-size:24px/);
    assert.equal(browser.streams[0].signal?.aborted, false);
  } finally { browser.close(); }
});
