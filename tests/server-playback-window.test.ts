import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { startServer, type ServerOptions } from "../server/src/server.js";
import { SubtitleCache } from "../server/src/cache.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { eventually } from "../features/support/browser.js";

const request = {
  url: "https://www.youtube.com/watch?v=window12345", playback_ms: 100_000,
  source_language: "en", translate_to: "zh-CN", translate_engine: "legacy",
  source_cues: [
    { index: 19, start: 99_000, end: 100_500, text: "First sentence." },
    { index: 23, start: 106_000, end: 108_500, text: "Second sentence." },
  ],
};

async function gateway(t: TestContext, overrides: Partial<ServerOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-playback-window-"));
  const running = await startServer({
    port: 0, host: "127.0.0.1", cache: new SubtitleCache(path.join(root, "cache")),
    worker: new AgentWorker({ storagePath: path.join(root, "state.db") }),
    fetchMetadata: async () => { throw new Error("Playback translation must not fetch metadata"); },
    prepareTimedTextEvents: () => { throw new Error("Playback translation must not re-segment source cues"); },
    ...overrides,
  });
  t.after(async () => {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return (body: unknown, signal?: AbortSignal, origin = "https://www.youtube.com") => fetch(`http://127.0.0.1:${running.port}/api/subtitle/translate-window`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(8000),
  });
}

test("playback endpoint preserves exact cue boundaries/indices and calls bounded contextual legacy translation", async t => {
  let calls = 0;
  const post = await gateway(t, { translateSubtitles: async (cues, from, to, options) => {
    calls++;
    assert.equal(from, "en"); assert.equal(to, "zh-CN");
    assert.deepEqual(cues, request.source_cues);
    assert.equal(options?.whole, true); assert.equal(options?.concurrency, 2);
    assert.equal(options?.apiKey, "fixture-key"); assert.equal(options?.model, "configured-model");
    assert.equal(options?.signal?.aborted, false);
    return cues.map((cue, index) => ({ ...cue, translation: index ? "第二句" : "第一句" }));
  } });
  const response = await post({ ...request, translate_model: "configured-model", translate_api_key: "fixture-key" });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).cues, request.source_cues.map((cue, index) => ({
    ...cue, translation: index ? "第二句" : "第一句",
  })));
  assert.equal(calls, 1);
});

test("playback endpoint rejects invalid/unbounded requests before any model call and enforces origins", async t => {
  let calls = 0;
  const post = await gateway(t, { translateSubtitles: async cues => { calls++; return cues; } });
  const invalid = [
    { ...request, source_cues: [] },
    { ...request, source_cues: Array.from({ length: 13 }, (_, index) => ({ ...request.source_cues[0], index })) },
    { ...request, source_cues: [{ ...request.source_cues[0], start: 146_000, end: 148_000 }] },
    { ...request, source_cues: [{ ...request.source_cues[0], start: 1000, end: 2000 }] },
    { ...request, source_cues: [{ ...request.source_cues[0], start: -1 }] },
    { ...request, source_cues: [{ ...request.source_cues[0], text: "" }] },
    { ...request, source_cues: [{ ...request.source_cues[0], text: "a".repeat(12_001) }] },
    { ...request, source_cues: [request.source_cues[0], request.source_cues[0]] },
    { ...request, source_cues: [{ ...request.source_cues[0], index: -1 }] },
    { ...request, source_cues: [{ ...request.source_cues[0], index: 1.5 }] },
    { ...request, source_cues: [{ ...request.source_cues[0], index: undefined }] },
    { ...request, source_cues: undefined },
    { ...request, source_language: "" }, { ...request, translate_to: "" },
    { ...request, translate_engine: "document" }, { ...request, source_events: [] },
    { ...request, playback_ms: undefined }, { ...request, playback_ms: -1 }, { ...request, playback_ms: "100000" },
  ];
  for (const body of invalid) {
    const response = await post(body);
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 300));
  }
  assert.equal((await post(request, undefined, "https://evil.invalid")).status, 403);
  assert.equal(calls, 0);
});

test("disconnecting a playback request cancels its provider call", async t => {
  let providerSignal: AbortSignal | undefined;
  const post = await gateway(t, { translateSubtitles: async (_cues, _from, _to, options) => {
    providerSignal = options?.signal;
    await new Promise<void>((_resolve, reject) => providerSignal!.addEventListener("abort", () => reject(providerSignal!.reason), { once: true }));
    return [];
  } });
  const controller = new AbortController();
  const pending = post(request, controller.signal);
  await eventually(() => Boolean(providerSignal));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await eventually(() => providerSignal?.aborted === true);
});
