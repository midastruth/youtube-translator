import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startServer, type ServerOptions } from "../server/src/server.js";
import { SubtitleCache } from "../server/src/cache.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { WhisperClient, type WhisperClientOptions } from "../server/src/transcribe.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { respondAsSubtitleAgent } from "./support/subtitle-agent-model.js";

// Independent acceptance checks: exercise the public HTTP contract, not just module mocks.
const source = [
  { start: 1500, end: 3500, text: "The transaction failed." },
  { start: 6000, end: 8000, text: "It was a database transaction." },
];
const browserRequest = {
  url: "https://www.youtube.com/watch?v=review12345",
  source_language: "en", source_cues: source,
};
type Event = { type: string; index?: number; start?: number; end?: number; text?: string; translation?: string; cached?: boolean; total_cues?: number; failed_cues?: number };
type ProcessResponse = { cues: Event[]; translation_status: string; progress: number; failed_cues: number };

async function gateway(t: TestContext, overrides: Partial<ServerOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-independent-review-"));
  const worker = new AgentWorker({ storagePath: path.join(root, "state.db") });
  const cache = new SubtitleCache(path.join(root, "cache"));
  const running = await startServer({
    port: 0, host: "127.0.0.1", cache, worker,
    fetchMetadata: async () => { throw new Error("Unexpected external metadata lookup in browser fixture"); },
    ...overrides,
  });
  t.after(async () => {
    try { await running.close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return {
    root, cache, worker,
    url: `http://127.0.0.1:${running.port}`,
    close: running.close,
    post: (route: string, body: unknown) => fetch(`http://127.0.0.1:${running.port}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    }),
  };
}
async function sse(response: Response): Promise<Event[]> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  return (await response.text()).split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as Event);
}

async function socketEvents(baseUrl: string, body: unknown): Promise<Event[]> {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws/subtitle/process");
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket acceptance timed out")); }, 6000);
    socket.addEventListener("open", () => socket.send(JSON.stringify(body)));
    socket.addEventListener("message", event => {
      try { events.push(JSON.parse(String(event.data)) as Event); }
      catch (error) { clearTimeout(timer); socket.close(); reject(error); }
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); });
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(events); });
  });
}

test("review: REST and untranslated SSE preserve the extension's millisecond clock", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  const response = await app.post("/api/subtitle/process", browserRequest);
  assert.equal(response.status, 200);
  const body = await response.json() as ProcessResponse;
  assert.deepEqual(body.cues.map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.equal(body.translation_status, "not_requested");
  const events = await sse(await app.post("/api/subtitle/stream", browserRequest));
  assert.deepEqual(events.filter(e => e.type === "cue").map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.equal(events.at(-1)?.type, "done");
});

test("review: WebSocket uses the same validation and millisecond contract", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  const events = await socketEvents(app.url, browserRequest);
  assert.equal(events.filter(e => e.type === "meta").length, 1);
  assert.deepEqual(events.filter(e => e.type === "cue").map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.equal(events.at(-1)?.type, "done");
  const invalid = await socketEvents(app.url, { ...browserRequest, source_cues: [{ start: null, end: 1000, text: "invalid" }] });
  assert.equal(invalid[0]?.type, "error");
  assert.equal(invalid.filter(e => e.type === "cue").length, 0);
});

test("review: shutdown closes idle upgraded connections without hanging", { timeout: 5000 }, async t => {
  const app = await gateway(t);
  const socket = new WebSocket(app.url.replace(/^http/, "ws") + "/ws/subtitle/process");
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([app.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { socket.close(); reject(new Error("Shutdown hung on an idle WebSocket")); }, 1000);
    })]);
  } finally {
    clearTimeout(timer); socket.close();
  }
});

test("review: total legacy translation failure cannot masquerade as 100% success", { timeout: 10000 }, async t => {
  const app = await gateway(t, { translateSubtitles: async cues => cues.map(c => ({ ...c, translation: "[Translation failed]" })) });
  const response = await app.post("/api/subtitle/process", { ...browserRequest, translate_to: "zh-CN" });
  assert.equal(response.status, 200);
  const body = await response.json() as ProcessResponse;
  assert.equal(body.translation_status, "failed");
  assert.equal(body.failed_cues, source.length);
  assert.equal(body.progress, 0);
});

test("review: partial translation has honest status and progress", { timeout: 10000 }, async t => {
  const app = await gateway(t, { translateSubtitles: async cues => cues.map((c, i) => ({ ...c, translation: i ? "[Translation failed]" : "事务失败了。" })) });
  const response = await app.post("/api/subtitle/process", { ...browserRequest, translate_to: "zh-CN" });
  assert.equal(response.status, 200);
  const body = await response.json() as ProcessResponse;
  assert.equal(body.translation_status, "partial");
  assert.equal(body.failed_cues, 1);
  assert.equal(body.progress, 50);
});

test("review: malformed public requests are client errors, never internal failures", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  for (const body of [null, {}, { url: 123 }, { ...browserRequest, languages: "en" },
    { ...browserRequest, translate_engine: "unknown" }, { ...browserRequest, whisper_enabled: "yes" },
    { ...browserRequest, translate_base_url: {} }, { ...browserRequest, translate_to: true },
    { ...browserRequest, translate_whole: "false" },
    { ...browserRequest, source_events: [{ tStartMs: 0, dDurationMs: 1000, segs: "not an array" }] },
    { ...browserRequest, source_cues: [{ start: -1, end: 1000, text: "negative timing" }] },
    { ...browserRequest, source_cues: [{ start: 0, end: 1000, text: {} }] },
    { ...browserRequest, source_cues: [{ start: null, end: 1000, text: "invalid timing" }] }]) {
    const response = await app.post("/api/subtitle/process", body);
    assert.ok([400, 422].includes(response.status), `Invalid body ${JSON.stringify(body)} returned ${response.status}: ${await response.text()}`);
  }
});

test("removed agent engine is rejected by REST, SSE and WebSocket without starting a job", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  const request = { ...browserRequest, translate_to: "zh-CN", translate_engine: "agent" };
  for (const route of ["/api/subtitle/process", "/api/subtitle/stream"]) {
    const response = await app.post(route, request);
    assert.equal(response.status, 422);
    await response.arrayBuffer();
  }
  const events = await socketEvents(app.url, request);
  assert.equal(events[0]?.type, "error");
  assert.equal(events.some(e => e.type === "done" || e.type === "cue"), false);
  assert.equal(app.worker.jobs.size, 0);
});

test("review: oversized JSON receives a bounded HTTP 413 response", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  const response = await app.post("/api/subtitle/process", { ...browserRequest, padding: "x".repeat(10 * 1024 * 1024) });
  assert.equal(response.status, 413);
  await response.arrayBuffer();
});

test("review: delayed legacy SSE delivers translated cues before done", { timeout: 10000 }, async t => {
  const app = await gateway(t, { translateSubtitles: async cues => {
    await delay(35);
    return cues.map(c => ({ ...c, translation: "数据库事务。" }));
  } });
  const events = await sse(await app.post("/api/subtitle/stream", { ...browserRequest, translate_to: "zh-CN" }));
  assert.deepEqual(events.filter(e => e.type === "source_cue").map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.equal(events.filter(e => e.type === "cue" && e.translation === "数据库事务。").length, source.length);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.at(-1)?.failed_cues, 0);
});

test("review: Whisper fallback sends the language hint, shares concurrent work and returns milliseconds", { timeout: 10000 }, async t => {
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    calls++;
    if (!/name="language"\r\n\r\nen\r\n/.test(raw)) {
      res.writeHead(400); res.end("Expected language=en in multipart form"); return;
    }
    await delay(40);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "A database transaction.", duration: 2,
      segments: [{ start: 0.25, end: 1.25, text: "A database transaction." }] }));
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const address = model.address(); assert.ok(address && typeof address !== "string");
  class FastWhisperClient extends WhisperClient {
    constructor(options: WhisperClientOptions = {}) { super({ ...options, retries: 1, timeoutSeconds: 0.5 }); }
  }
  const app = await gateway(t, {
    fetchMetadata: async () => ({ id: "whisper-review", title: "No caption track", subtitles: {}, automatic_captions: {} }),
    downloadAudio: async (_url, directory) => {
      const file = path.join(directory, "fixture.mp3"); await fs.writeFile(file, "local audio boundary fixture"); return file;
    },
    splitAudio: async file => [file],
    WhisperClient: FastWhisperClient,
  });
  const request = { url: browserRequest.url, whisper_enabled: true, whisper_language: "en",
    whisper_base_url: `http://127.0.0.1:${address.port}/v1`, whisper_api_key: "review-whisper-key" };
  const responses = await Promise.all([app.post("/api/subtitle/process", request), app.post("/api/subtitle/process", request)]);
  for (const response of responses) {
    const raw = await response.text(); assert.equal(response.status, 200, raw);
    const body = JSON.parse(raw) as ProcessResponse;
    assert.deepEqual(body.cues.map(c => [c.start, c.end, c.text]), [[250, 1250, "A database transaction."]]);
  }
  assert.equal(calls, 1, "concurrent requests must share transcription");
  const cached = await app.post("/api/subtitle/process", request);
  assert.equal(cached.status, 200); await cached.arrayBuffer();
  assert.equal(calls, 1, "the timed transcript must be cached");
});

test("review: public document SSE uses the real durable worker and reattaches without model calls", { timeout: 15000 }, async t => {
  const previousModel = process.env.TRANSLATION_AGENT_MODEL;
  process.env.TRANSLATION_AGENT_MODEL = "deployment-model";
  t.after(() => {
    if (previousModel === undefined) delete process.env.TRANSLATION_AGENT_MODEL;
    else process.env.TRANSLATION_AGENT_MODEL = previousModel;
  });
  const calls: { operation: string }[] = [];
  const model = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      assert.equal(req.headers.authorization, "Bearer independent-review-ephemeral-key");
      const payload = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] };
      assert.equal(payload.model, "deployment-model");
      const request = JSON.parse(payload.messages.find(m => m.role === "user")!.content);
      calls.push(request);
      await delay(35); // Completion must remain observable after the POST body has ended.
      assert.equal(request.operation, "translate_workspace");
      assert.equal(respondAsSubtitleAgent(payload, res), true);
    } catch (err) {
      res.writeHead(500); res.end(String(err));
    }
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const address = model.address(); assert.ok(address && typeof address !== "string");
  t.after(trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`));
  const app = await gateway(t);
  const request = { ...browserRequest, translate_to: "zh-CN", translate_engine: "document", translate_model: "",
    translate_base_url: `http://127.0.0.1:${address.port}/v1`, translate_api_key: "independent-review-ephemeral-key" };
  const first = await sse(await app.post("/api/subtitle/stream", request));
  assert.equal(first[0]?.type, "meta");
  assert.deepEqual(first.filter(e => e.type === "source_cue").map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.equal(first.at(-1)?.type, "done", JSON.stringify(first));
  assert.deepEqual(first.filter(e => e.type === "cue").map(c => [c.index, c.start, c.end]), [[0, 1500, 3500], [1, 6000, 8000]]);
  assert.ok(first.filter(e => e.type === "cue").every(c => c.translation?.startsWith("数据库事务：")));
  assert.ok(calls.length >= 5);
  assert.ok(calls.every(c => c.operation === "translate_workspace"));
  const count = calls.length;
  const replay = await sse(await app.post("/api/subtitle/stream", request));
  assert.equal(replay.at(-1)?.type, "done");
  assert.equal(replay.filter(e => e.type === "cue" && e.cached).length, source.length);
  assert.equal(calls.length, count);
  const wsReplay = await socketEvents(app.url, request);
  assert.equal(wsReplay.filter(e => e.type === "meta").length, 1, "Worker metadata must not be forwarded twice");
  assert.deepEqual(wsReplay.filter(e => e.type === "source_cue").map(c => [c.start, c.end]), source.map(c => [c.start, c.end]));
  assert.deepEqual(wsReplay.filter(e => e.type === "cue").map(c => [c.index, c.start, c.end]), [[0, 1500, 3500], [1, 6000, 8000]]);
  assert.equal(wsReplay.at(-1)?.type, "done");
  assert.equal(calls.length, count, "WebSocket must reuse the same in-process durable worker");
  for (const name of await fs.readdir(app.root)) {
    if (name.startsWith("state.db")) assert.equal((await fs.readFile(path.join(app.root, name))).includes(Buffer.from(request.translate_api_key)), false);
  }
});

test("review fix: malformed Host cannot terminate HTTP routing", { timeout: 10000 }, async t => {
  const app = await gateway(t);
  const status = await new Promise<number>((resolve, reject) => {
    const request = http.get(`${app.url}/api/health`, { headers: { Host: "[" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject);
  });
  assert.equal(status, 200);
  assert.equal((await fetch(`${app.url}/api/health`)).status, 200);
});

test("review fix: malformed JSON3 is never cached and a corrected download succeeds", { timeout: 10000 }, async t => {
  let downloads = 0;
  const app = await gateway(t, {
    fetchMetadata: async () => ({ id: "json3-fix", title: "JSON3" }),
    chooseSubtitle: () => ["en", "manual"],
    fetchSubtitleJson3: async () => ++downloads === 1 ? "{invalid" : JSON.stringify({ events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "A complete sentence." }] },
    ] }),
  });
  const first = await app.post("/api/subtitle/process", { url: browserRequest.url });
  assert.equal(first.status, 500); await first.arrayBuffer();
  assert.equal(await app.cache.getJson3("json3-fix", "en"), null);
  const second = await app.post("/api/subtitle/process", { url: browserRequest.url });
  assert.equal(second.status, 200, await second.text());
  assert.equal(downloads, 2);
});

test("review fix: legacy SSE exposes cache I/O failures instead of successful done", { timeout: 10000 }, async t => {
  const app = await gateway(t, { translateSubtitles: async cues => cues.map(c => ({ ...c, translation: "译文" })) });
  const writer = t.mock.method(app.cache, "putTranslation", async () => { throw Object.assign(new Error("Cache disk full"), { code: "ENOSPC" }); });
  const events = await sse(await app.post("/api/subtitle/stream", { ...browserRequest, translate_to: "zh-CN" }));
  assert.equal(events.filter(e => e.type === "cue").length, source.length);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.some(e => e.type === "done"), false);
  writer.mock.restore();
  const retry = await sse(await app.post("/api/subtitle/stream", { ...browserRequest, translate_to: "zh-CN" }));
  assert.equal(retry.at(-1)?.type, "done", "cache failures must release in-flight exclusion");
});

test("review fix: matching legacy SSE requests exclude concurrent paid work and release the lock", { timeout: 10000 }, async t => {
  let release!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  t.after(() => release());
  const app = await gateway(t, { translateSubtitles: async cues => {
    calls++; started(); await gate;
    return cues.map(c => ({ ...c, translation: "共享翻译" }));
  } });
  const request = { ...browserRequest, translate_to: "zh-CN" };
  const first = await app.post("/api/subtitle/stream", request);
  await entered;
  const second = await sse(await app.post("/api/subtitle/stream", request));
  assert.equal(second.at(-1)?.type, "error"); assert.equal(calls, 1);
  release();
  assert.equal((await sse(first)).at(-1)?.type, "done");
  assert.equal((await sse(await app.post("/api/subtitle/stream", request))).at(-1)?.type, "done");
  assert.equal(calls, 1, "completed cache should be reused after lock release");
});

test("review fix: legacy SSE emits keepalives independently of a pending provider call", { timeout: 10000 }, async t => {
  let release!: () => void, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const app = await gateway(t, { translateSubtitles: async cues => {
    await gate; finished = true;
    return cues.map(c => ({ ...c, translation: "有心跳" }));
  } });
  const response = await app.post("/api/subtitle/stream", { ...browserRequest, translate_to: "zh-CN" });
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes(": keepalive\n\n")) {
    const next = await reader.read(); assert.equal(next.done, false);
    text += new TextDecoder().decode(next.value);
  }
  assert.equal(finished, false, "heartbeat must arrive before provider completion");
  release();
  while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  assert.match(text, /"type":"done"/);
});

test("review fix: legacy disconnect cancels provider fetches and prevents queued cue calls", { timeout: 10000 }, async t => {
  let started!: () => void, disconnected!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the POST body */ }
    calls++; res.on("close", disconnected); started();
    res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  t.after(trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`));
  const app = await gateway(t);
  const response = await app.post("/api/subtitle/stream", {
    ...browserRequest, translate_to: "zh-CN", translate_api_key: "client-key",
    source_cues: Array.from({ length: 10 }, (_, i) => ({ start: i * 2000, end: i * 2000 + 1000, text: `Sentence ${i}.` })),
  });
  await entered;
  await response.body!.cancel();
  await closed; await delay(50);
  assert.ok(calls <= 3, `only the already in-flight pool may start, saw ${calls} calls`);
});

test("review fix: SSE and WS reject untrusted document endpoints without making model requests", { timeout: 10000 }, async t => {
  let calls = 0;
  const target = http.createServer((_req, res) => { calls++; res.end(); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); });
  const address = target.address(); assert.ok(address && typeof address !== "string");
  const app = await gateway(t);
  const request = { ...browserRequest, translate_to: "zh-CN", translate_engine: "document", translate_base_url: `http://127.0.0.1:${address.port}/v1` };
  assert.equal((await sse(await app.post("/api/subtitle/stream", request))).at(-1)?.type, "error");
  assert.equal((await socketEvents(app.url, request)).at(-1)?.type, "error");
  assert.equal(calls, 0);
});

test("review fix: REST decoding failures are HTTP errors, not recovered translation results", { timeout: 10000 }, async t => {
  const app = await gateway(t, { translateSubtitles: async () => { throw new SyntaxError("Invalid model JSON"); } });
  const response = await app.post("/api/subtitle/process", { ...browserRequest, translate_to: "zh-CN" });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /Invalid model JSON/);
});
