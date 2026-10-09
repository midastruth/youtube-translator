import assert from "node:assert/strict";
import { test } from "node:test";
import { captionLanguageRank, originalCaptionInfo, selectPlayerCaptionTrack } from "../minimal-extension/src/captions.js";

test("caption preference distinguishes exact, related, unmatched and automatic languages", () => {
  const languages = ["en-US", "zh-Hans"];
  for (const [code, rank] of [["EN-us", 0], ["zh", 1], ["fr", 2], ["auto", 3], ["", 3], [undefined, 3]] as const) {
    assert.equal(captionLanguageRank(code, languages), rank);
  }
  assert.equal(captionLanguageRank("en-US", ["en", "en-US"]), 1);
});

test("player caption choice preserves manual priority, input order and unmatched fallback", () => {
  const automatic = { baseUrl: "asr", kind: "asr", languageCode: "en" };
  const manual = { baseUrl: "manual", languageCode: "zh-Hans" };
  const sameRank = { baseUrl: "other", languageCode: "zh-Hans" };
  const tracks = [automatic, manual, sameRank];
  assert.equal(selectPlayerCaptionTrack(tracks, ["en", "zh"]), manual);
  assert.deepEqual(tracks, [automatic, manual, sameRank]);
  assert.equal(selectPlayerCaptionTrack([sameRank, manual], ["zh"]), sameRank);
  assert.equal(selectPlayerCaptionTrack([manual, automatic], ["en"]), manual);
  assert.equal(selectPlayerCaptionTrack([automatic], ["fr"]), automatic);
  assert.equal(selectPlayerCaptionTrack([{ baseUrl: "" }], ["en"]), null);
  assert.equal(selectPlayerCaptionTrack([], []), null);
});

test("caption URLs reject translations while retaining relative paths and default language", () => {
  const page = "https://www.youtube.com/watch?v=current";
  assert.deepEqual(originalCaptionInfo("/api/timedtext?v=source&lang=en", page), { videoId: "source", language: "en" });
  assert.deepEqual(originalCaptionInfo("/API/TIMEDTEXT?v=source", page), { videoId: "source", language: "auto" });
  assert.deepEqual(originalCaptionInfo("/api/timedtext", page), { videoId: "", language: "auto" });
  assert.deepEqual(originalCaptionInfo("/api/timedtext?v=source&tlang=", page), { videoId: "source", language: "auto" });
  assert.equal(originalCaptionInfo("/api/timedtext?v=source&tlang=zh", page), null);
  assert.equal(originalCaptionInfo("/watch?v=source", page), null);
  assert.equal(originalCaptionInfo("http://[broken", page), null);
});
