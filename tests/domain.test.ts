import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOutputMapping } from "../worker/validator.js";
import { BudgetExceededError, executeWithRetryAndBudget, NetworkError, RequestBudgetTracker } from "../worker/network.js";
import { exportableSubtitles, formatVtt, formatVttTime, subtitleIndexAt, videoIdFromUrl } from "../minimal-extension/src/subtitles.js";
import { buildStreamRequest, hasBrowserSubtitles, selectBackendTrack } from "../minimal-extension/src/stream-request.js";
import { apiStream, consumeSubtitleStream } from "../minimal-extension/src/subtitle-stream.js";
import type { ExtensionSettings, StreamRequest, SubtitleEvent } from "../minimal-extension/src/types.js";

const cue = { cue_id: "c0", start: 123, end: 987, text: "Hello" };

test("validation reports exact boundary failures without publishing partial results", () => {
  const cases: [unknown, string][] = [
    [null, "Output is empty or null"], [true, "Invalid candidate output type"],
    ["Here is the translation", "Non-structured explanation-only output"], ["garbage", "Cannot parse structured JSON output"],
    [[], "Parsed output contains no cue translations"], [[1], "Translation item is not an object"],
    [[{ translation: "译" }], "Item is missing cue_id"], [[{ cue_id: "extra", translation: "译" }], "Non-existent cue_id returned: extra"],
    [[{ cue_id: "c0", translation: 0 }], "Translation for c0 is not a string"],
    [[{ cue_id: "c0", translation: "  " }], "Translation for c0 is empty or whitespace only"],
    [[{ cue_id: "c0", translation: "[Translation failed]" }], "Translation for c0 contains Translation failed placeholder"],
  ];
  for (const [candidate, error] of cases) {
    const result = validateOutputMapping([cue], candidate);
    assert.equal(result.valid, false); assert.ok(result.errors.includes(error));
    assert.equal(result.orderedCues, undefined); assert.equal(result.mappings, undefined);
  }
  assert.deepEqual(validateOutputMapping([cue], { c0: { translation: "  译  " } }).orderedCues, [{ ...cue, translation: "译" }]);
  assert.deepEqual(validateOutputMapping([cue], [{ id: "c0", text: "译" }]).orderedCues, [{ ...cue, translation: "译" }]);
});

test("retry policy classifies config failures before retry exhaustion", async () => {
  for (const failure of [{ status: 403 }, { status: 400 }, { message: "unsupported model" }, { message: "Invalid model" }, { message: "invalid parameter" }]) {
    const budgetTracker = new RequestBudgetTracker();
    let attempts = 0;
    await assert.rejects(executeWithRetryAndBudget(async () => { attempts++; throw failure; }, {
      maxAttempts: 1, budgetTracker, sleepFn: async () => assert.fail("non-retryable error must not sleep"),
    }), error => error instanceof NetworkError && !error.retryable && error.errorType === ("status" in failure && failure.status === 403 ? "auth_error" : "config_error"));
    assert.equal(attempts, 1); assert.equal(budgetTracker.interruptedAttempts, 0);
  }
});

test("retry backoff is capped, reserves every attempt and counts only known usage", async () => {
  const delays: number[] = [], attempts: number[] = [];
  const budgetTracker = new RequestBudgetTracker();
  const result = await executeWithRetryAndBudget(async attempt => {
    if (attempt < 5) throw new Error("timeout");
    return { usage: { promptTokens: 10, completionTokens: 20, cost: 0.5 } };
  }, { maxAttempts: 5, budgetTracker, onAttempt: attempt => attempts.push(attempt), sleepFn: async ms => { delays.push(ms); } });
  assert.deepEqual(delays, [1000, 2000, 4000, 4000]); assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.equal(result.usage.cost, 0.5);
  assert.deepEqual(budgetTracker.getUsageReport(), { totalAttempts: 5, maxBudget: 12, knownTokens: 30, knownCost: 0.5, interruptedAttempts: 0, remainingAttempts: 7 });
});

test("retry exhaustion and budget exhaustion do not issue extra calls", async () => {
  const tracker = new RequestBudgetTracker({ maxBudget: 1 });
  let calls = 0;
  await assert.rejects(executeWithRetryAndBudget(async () => { calls++; throw 42; }, { budgetTracker: tracker, sleepFn: async () => {} }), BudgetExceededError);
  assert.equal(calls, 1);
  const exhausted = new RequestBudgetTracker();
  await assert.rejects(executeWithRetryAndBudget(async () => { throw { statusCode: 503 }; }, { maxAttempts: 1, budgetTracker: exhausted }), /Request failed after max attempts \(1\)/);
  assert.equal(exhausted.interruptedAttempts, 1);
  await assert.rejects(executeWithRetryAndBudget(async () => assert.fail(), { maxAttempts: 0 }), /Max attempts \(0\) exceeded/);
  exhausted.recordSuccess(null); exhausted.recordSuccess({ promptTokens: "bad", completionTokens: 2, cost: "bad" });
  assert.equal(exhausted.knownTokens, 2); assert.equal(exhausted.knownCost, 0);
});

test("rate limiting accepts numeric Retry-After and falls back for invalid/missing headers", async () => {
  for (const [header, expected] of [["bad", 1000], [undefined, 1000], ["0.25", 250]] as const) {
    let calls = 0;
    const delays: number[] = [];
    await executeWithRetryAndBudget(async () => {
      if (calls++ === 0) throw { status: 429, retryAfter: header };
      return "ok";
    }, { sleepFn: async ms => { delays.push(ms); } });
    assert.deepEqual(delays, [expected]);
  }
});

test("VTT keeps optional translations, hour formatting, and pending cue exclusion", () => {
  assert.equal(formatVttTime(3600123), "01:00:00.123");
  assert.equal(formatVtt([{ ...cue, translation: "你好" }, { start: 1000, end: 2000, text: "Bye" }]),
    "WEBVTT\n\n1\n00:00.123 --> 00:00.987\nHello\n你好\n\n2\n00:01.000 --> 00:02.000\nBye\n");
  assert.deepEqual(exportableSubtitles([cue, { text: "Pending" }, { start: NaN, end: 0, text: "Invalid" }, { start: 0, end: 1, text: "" }]), [cue]);
  assert.equal(subtitleIndexAt([cue], 123), 0); assert.equal(subtitleIndexAt([cue], 987), 0);
  assert.equal(subtitleIndexAt([cue], 1000), -1); assert.equal(subtitleIndexAt([cue], 0), -1);
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=abc"), "abc");
  assert.equal(videoIdFromUrl("not a url"), ""); assert.equal(videoIdFromUrl("https://youtube.com/"), "");
});

test("track choice prefers manual then language order, then first unmatched track", () => {
  const automatic = { source: "automatic", language: "en" }, manual = { source: "manual", language: "zh-Hans" };
  assert.equal(selectBackendTrack([automatic, manual], ["en", "zh"]), manual);
  assert.equal(selectBackendTrack([automatic], ["en-US"]), automatic);
  assert.equal(selectBackendTrack([automatic, manual], ["fr"]), automatic);
  assert.equal(selectBackendTrack([], ["en"]), undefined);
  assert.equal(hasBrowserSubtitles(null), false);
  assert.equal(hasBrowserSubtitles({ videoId: "v", language: "en", cues: [] }), false);
  assert.equal(hasBrowserSubtitles({ videoId: "v", language: "en", cues: [cue] }), true);
});

// Only request-related fields are read; use a fully typed fixture to catch accidental additions.
const settings: ExtensionSettings = {
  backendUrl: "http://localhost:8787", languages: "en", toLang: "zh-CN", segmentation: "rule",
  translateEngine: "", translateProvider: "", translateApiKey: "fixture", translateBaseUrl: "https://model.invalid", translateModel: "model", translateWhole: true, autoTranslate: true, enabled: false,
  whisperEnabled: true, whisperApiKey: "whisper", whisperBaseUrl: "https://whisper.invalid", whisperModel: "whisper-model", whisperLanguage: "en",
  isBilingual: true, fontSizeOrig: 22, fontSizeTran: 18, positionY: 12, origColor: "#ffffff", tranColor: "#ffff00", bgOpacity: 0.6,
};

test("request builder preserves fallback, defaults, translation and whisper settings", () => {
  const input = { pageUrl: "https://youtube.com/watch?v=v", languages: ["en"], browserSubtitles: null, title: "Title - YouTube", settings };
  const request = buildStreamRequest(input);
  assert.deepEqual(request, {
    url: input.pageUrl, languages: ["en"], allow_automatic: true, segmentation: "rule", translate_to: "zh-CN", translate_engine: "legacy", translate_provider: "openai",
    translate_api_key: "fixture", translate_base_url: "https://model.invalid", translate_model: "model", translate_whole: true,
    whisper_enabled: true, whisper_api_key: "whisper", whisper_base_url: "https://whisper.invalid", whisper_model: "whisper-model", whisper_language: "en",
  });
  const fallback = buildStreamRequest({ ...input, browserSubtitles: { videoId: "v", language: "auto", cues: [cue] }, settings: { ...settings, autoTranslate: false, whisperEnabled: false } });
  assert.deepEqual(fallback.languages, ["en"]); assert.equal(fallback.source_title, "Title"); assert.equal(fallback.source_cues?.[0], cue);
  assert.equal(fallback.translate_to, undefined); assert.equal(fallback.whisper_enabled, undefined);
  const events = [{ tStartMs: 0, dDurationMs: 1, segs: [{ utf8: "x" }] }];
  const captured = buildStreamRequest({ ...input, track: { source: "manual", language: "en" }, browserSubtitles: { videoId: "v", language: "fr", title: "Captured", events, cues: [cue] } });
  assert.equal(captured.source_events, events); assert.equal(captured.source_cues, undefined);
  assert.equal(captured.source_title, "Captured"); assert.deepEqual(captured.languages, ["fr"]); assert.equal(captured.language, "en");
});

test("stream decoder supports split UTF-8, multiline data, comments and unterminated final frames", async () => {
  const bytes = new TextEncoder().encode(': ignored\r\ndata: {"type":"cue",\r\ndata: "text":"你好"}\r\n\r\ndata: {"type":"done"}');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const actual: SubtitleEvent[] = [];
  await consumeSubtitleStream(stream, event => actual.push(event));
  assert.deepEqual(actual, [{ type: "cue", text: "你好" }, { type: "done" }]);
  const invalid = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: nope\n\n")); controller.close(); } });
  await assert.rejects(consumeSubtitleStream(invalid, () => {}), SyntaxError);
});

test("stream HTTP adapter preserves POST body, backend errors, and absent-body diagnostics", async t => {
  const request: StreamRequest = { url: "video", languages: ["en"], allow_automatic: true, segmentation: "rule" };
  const controller = new AbortController();
  const events: SubtitleEvent[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://backend.invalid/api/subtitle/stream");
    assert.equal(init.method, "POST"); assert.equal(init.signal, controller.signal); assert.equal(init.body, JSON.stringify(request));
    return new Response('data: {"type":"done"}\n\n');
  });
  await apiStream("https://backend.invalid", "/api/subtitle/stream", request, controller.signal, event => events.push(event));
  assert.deepEqual(events, [{ type: "done" }]);
  for (const [response, message] of [[new Response('{"detail":"denied"}', { status: 400 }), "denied"], [new Response("bad", { status: 500 }), "Backend 500"], [new Response(null), "浏览器不支持流式字幕响应"]] as const) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(apiStream("base", "/path", request, controller.signal, () => {}), new RegExp(message));
  }
});
