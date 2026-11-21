import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFixture, eventually } from "../features/support/browser.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

for (const initiallyMissing of [false, true]) {
  test(`translation toggle survives ${initiallyMissing ? "late toolbar creation" : "whole toolbar replacement"}`, async () => {
    const browser = new BrowserFixture();
    try {
      const document = browser.dom.window.document;
      const oldToolbar = document.querySelector(".ytp-chrome-bottom")!;
      if (initiallyMissing) oldToolbar.remove();
      browser.execute("content");
      const toolbar = document.createElement("div");
      toolbar.className = "ytp-chrome-bottom";
      toolbar.innerHTML = '<div class="ytp-right-controls"></div>';
      if (initiallyMissing) document.getElementById("movie_player")!.appendChild(toolbar);
      else oldToolbar.replaceWith(toolbar);
      await eventually(() => !!toolbar.querySelector("#yts-toggle"));
      assert.equal(document.querySelectorAll("#yts-toggle").length, 1);
      browser.toggle();
      await eventually(() => browser.streams.length === 1);
      // Rebuilt controls must also preserve the current enabled state.
      const secondToolbar = toolbar.cloneNode(false) as HTMLElement;
      secondToolbar.innerHTML = '<div class="ytp-right-controls"></div>';
      toolbar.replaceWith(secondToolbar);
      await eventually(() => !!secondToolbar.querySelector("#yts-toggle"));
      assert.equal(browser.isOff(), false);
      browser.toggle();
      assert.equal(browser.isOff(), true);
      assert.equal(browser.streams[0].signal?.aborted, true);
    } finally { browser.close(); }
  });
}

test("same-video media replacement preserves the live subtitle session and refreshes its position", async () => {
  const browser = new BrowserFixture({ translateEngine: "legacy" });
  try {
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    const stream = browser.streams[0];
    browser.send([
      { type: "meta", total_cues: 2 },
      { type: "cue", index: 0, start: 0, end: 2000, text: "First", translation: "第一条" },
      { type: "cue", index: 1, start: 4000, end: 5000, text: "Second", translation: "第二条" },
    ]);
    browser.seek(100);
    const document = browser.dom.window.document;
    await eventually(() => document.querySelector(".tran")?.textContent === "第一条");
    const replacement = document.createElement("video");
    replacement.currentTime = 4.1;
    document.querySelector("video")!.replaceWith(replacement);
    await eventually(() => document.querySelector(".tran")?.textContent === "第二条");
    await settle();
    assert.equal(browser.streams.length, 1);
    assert.equal(stream.signal?.aborted, false);
    browser.send([{ type: "cue", index: 1, start: 4000, end: 5000, text: "Second", translation: "更新后的第二条" }], stream);
    await eventually(() => document.querySelector(".tran")?.textContent === "更新后的第二条");
  } finally { browser.close(); }
});

test("playback frames display short cues without timeupdate and stop on pause, end, and toggle", async () => {
  const browser = new BrowserFixture({ translateEngine: "legacy" });
  const window = browser.dom.window;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  Object.defineProperties(window, {
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; } },
    cancelAnimationFrame: { value: (id: number) => frames.delete(id) },
  });
  const frame = () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  };
  try {
    const video = window.document.querySelector("video")!;
    let paused = true, ended = false;
    Object.defineProperties(video, { paused: { get: () => paused }, ended: { get: () => ended } });
    browser.execute("content"); browser.toggle();
    await eventually(() => browser.streams.length === 1);
    browser.send([
      { type: "meta", total_cues: 1 },
      { type: "cue", index: 0, start: 100, end: 200, text: "Short", translation: "短字幕" },
      { type: "done", total_cues: 1, failed_cues: 0 },
    ]);
    browser.finish();
    await eventually(() => window.document.querySelector(".status")?.textContent?.includes("字幕翻译完成") === true);
    frame();
    assert.equal(frames.size, 0, "paused video must not poll");
    const bg = window.document.querySelector<HTMLElement>(".bg")!;
    paused = false; video.dispatchEvent(new window.Event("play"));
    video.currentTime = 0.15;
    frame(); frame();
    assert.equal(bg.style.display, "block");
    assert.equal(window.document.querySelector(".tran")?.textContent, "短字幕");
    video.currentTime = 0.25;
    frame(); frame();
    assert.equal(bg.style.display, "none");
    paused = true; video.dispatchEvent(new window.Event("pause"));
    frame(); frame();
    assert.equal(frames.size, 0);
    // Seeking while paused still updates immediately via the media event.
    video.currentTime = 0.15; video.dispatchEvent(new window.Event("seeking"));
    frame();
    assert.equal(bg.style.display, "block");
    paused = false; video.dispatchEvent(new window.Event("play"));
    ended = true; video.dispatchEvent(new window.Event("ended"));
    frame(); frame();
    assert.equal(frames.size, 0);
    ended = false; video.dispatchEvent(new window.Event("play"));
    browser.toggle(); frame(); frame();
    assert.equal(frames.size, 0);
    assert.equal(bg.style.display, "none");
    assert.equal(browser.streams.length, 1);
  } finally { browser.close(); }
});
