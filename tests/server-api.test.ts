import assert from "node:assert/strict";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { respondAsSubtitleAgent } from "./support/subtitle-agent-model.js";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { IngestError } from "../server/src/errors.js";
import { startServer, type RunningServer } from "../server/src/server.js";
import { getWhisperCacheProfile } from "../server/src/app.js";
import { SubtitleCache } from "../server/src/cache.js";
import { AgentWorker } from "../worker/agent-worker.js";
import type { SubtitleCue, FlatEvent, PreparedEvents } from "../server/src/types.js";
import type { ModelRequest } from "../worker/document-translation.js";

// Helper to parse SSE stream into array of JSON events
async function parseSseStream(response: Response): Promise<any[]> {
  const text = await response.text();
  const events: any[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore malformed
      }
    }
  }
  return events;
}

describe("Server API Endpoints & Gateway Integration", () => {
  let tmpDir: string;
  let cache: SubtitleCache;
  let testWorker: AgentWorker;
  let runningServer: RunningServer;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-api-test-"));
    cache = new SubtitleCache(path.join(tmpDir, "cache"), 3600);
    testWorker = new AgentWorker({ storagePath: path.join(tmpDir, "worker-state.db") });
  });

  afterEach(async () => {
    if (runningServer) {
      await runningServer.close();
    } else {
      try {
        await testWorker.close();
      } catch {
        // ignore
      }
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── 1. Health & CORS & OPTIONS ──────────────────────────────────────────

  it("GET /api/health should return ok and version 0.3.0", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");

    const data = await res.json();
    assert.equal(data.status, "ok");
    assert.equal(data.version, "0.3.0");
  });

  it("OPTIONS request should return 204 with CORS headers", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/health`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(res.headers.get("access-control-allow-methods")?.includes("GET"));
  });

  // ── 2. Tracks Endpoint ──────────────────────────────────────────────────

  it("GET /api/subtitle/tracks requires url parameter", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/tracks`);
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.ok(data.detail.includes("url"));
  });

  it("GET /api/subtitle/tracks returns available tracks", async () => {
    const mockFetchMetadata = async (_url: string) => ({
      id: "test123",
      title: "Test Video",
      subtitles: {
        en: [{ ext: "vtt" }],
        "zh-Hans": [{ ext: "vtt" }],
      },
      automatic_captions: {
        en: [{ ext: "vtt" }],
      },
    });

    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
      fetchMetadata: mockFetchMetadata,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/tracks?url=https://www.youtube.com/watch?v=test123`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.video_id, "test123");
    assert.equal(data.title, "Test Video");

    const enTracks = data.tracks.filter((t: any) => t.language === "en");
    const zhTracks = data.tracks.filter((t: any) => t.language === "zh-Hans");
    assert.ok(enTracks.some((t: any) => t.source === "manual"));
    assert.ok(enTracks.some((t: any) => t.source === "automatic"));
    assert.ok(zhTracks.some((t: any) => t.source === "manual"));
  });

  it("GET /api/subtitle/tracks returns empty tracks when no requested language matches", async () => {
    const mockFetchMetadata = async (_url: string) => ({
      id: "test123",
      title: "Test Video",
      subtitles: { en: [{ ext: "vtt" }] },
      automatic_captions: {},
    });

    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
      fetchMetadata: mockFetchMetadata,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(
      `${baseUrl}/api/subtitle/tracks?url=https://www.youtube.com/watch?v=test123&languages=ja,ko`
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.tracks.length, 0);
  });

  it("GET /api/subtitle/tracks handles IngestError from yt-dlp", async () => {
    const mockFetchMetadata = async (_url: string) => {
      throw new IngestError("yt-dlp crashed");
    };

    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
      fetchMetadata: mockFetchMetadata,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/tracks?url=https://www.youtube.com/watch?v=bad`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.detail.includes("yt-dlp crashed"));
  });

  // ── 3. Process Endpoint ─────────────────────────────────────────────────

  it("POST /api/subtitle/process rejects document translation engine with 422", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=doc123",
        translate_engine: "document",
        translate_to: "zh-CN",
      }),
    });
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.ok(data.detail.includes("/api/subtitle/stream") || data.detail.includes("流式"));
  });

  it("POST /api/subtitle/process supports browser source_cues fallback in milliseconds", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=browser123",
        source_cues: [{ start: 1500, end: 3500, text: "Hello from browser." }],
        source_language: "en",
        source_title: "Browser Title",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, "browser");
    assert.equal(data.title, "Browser Title");
    assert.equal(data.translation_status, "not_requested");
    assert.equal(data.cues.length, 1);
    assert.equal(data.cues[0].text, "Hello from browser.");
    assert.equal(data.cues[0].start, 1500);
    assert.equal(data.cues[0].end, 3500);
  });

  it("POST /api/subtitle/process performs legacy translation and gives honest status", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
      translateSubtitles: async (cues) => cues.map((c) => ({ ...c, translation: "早上好。" })),
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=legacy123",
        source_cues: [{ start: 0, end: 2000, text: "Good morning." }],
        translate_to: "zh-CN",
        translate_engine: "legacy",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cues[0].translation, "早上好。");
    assert.equal(data.translation_status, "succeeded");
    assert.equal(data.failed_cues, 0);
    assert.equal(data.progress, 100);
  });

  it("POST /api/subtitle/process reports failed status when translation fails completely", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
      translateSubtitles: async (cues) => cues.map((c) => ({ ...c, translation: "[Translation failed]" })),
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=legacyfail",
        source_cues: [{ start: 0, end: 2000, text: "Good morning." }],
        translate_to: "zh-CN",
        translate_engine: "legacy",
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.translation_status, "failed");
    assert.equal(data.failed_cues, 1);
    assert.equal(data.progress, 0);
  });

  // ── 4. Stream Endpoint (SSE & Direct Worker Integration) ────────────────

  it("POST /api/subtitle/stream rejects non-openai document translation with 422", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=doc422",
        translate_engine: "document",
        translate_provider: "deepl",
        translate_to: "zh-CN",
      }),
    });

    assert.equal(res.status, 422);
    const data = await res.json();
    assert.ok(data.detail.includes("OpenAI-compatible"));
  });

  it("POST /api/subtitle/stream streams cues without translation in milliseconds", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=stream1",
        source_cues: [{ start: 1000, end: 2500, text: "Subtitle line 1" }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

    const events = await parseSseStream(res);
    assert.equal(events[0].type, "meta");
    assert.equal(events[0].total_cues, 1);
    assert.equal(events[1].type, "cue");
    assert.equal(events[1].text, "Subtitle line 1");
    assert.equal(events[1].start, 1000);
    assert.equal(events[1].end, 2500);
    assert.equal(events[2].type, "done");
  });

  it("POST /api/subtitle/stream integrates directly with real AgentWorker for document mode", async () => {
    const calls: ModelRequest[] = [];

    // Local mock OpenAI HTTP server
    const modelServer = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      assert.equal(req.headers.authorization, "Bearer test-key-123");
      const payload = JSON.parse(raw);
      const userMessage = payload.messages.find((m: any) => m.role === "user");
      const request = JSON.parse(userMessage.content) as ModelRequest;
      calls.push(request);

      assert.equal(request.operation, "translate_workspace");
      assert.equal(payload.stream, true);
      assert.equal(respondAsSubtitleAgent(payload, res, id => `测试翻译：${id}`), true);
    });

    await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    assert.ok(address && typeof address !== "string");
    const restoreEndpoint = trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`);

    try {
      runningServer = await startServer({
        port: 0,
        host: "127.0.0.1",
        cache,
        worker: testWorker,
      });
      baseUrl = `http://127.0.0.1:${runningServer.port}`;

      const res = await fetch(`${baseUrl}/api/subtitle/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=fixture_doc",
          translate_engine: "document",
          translate_provider: "openai",
          translate_base_url: `http://127.0.0.1:${address.port}/v1`,
          translate_api_key: "test-key-123",
          translate_request_budget: 512,
          translate_to: "zh-CN",
          source_cues: [{ start: 1500, end: 3500, text: "A database transaction." }],
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const events = await parseSseStream(res);
      assert.equal(events[0]?.type, "meta");
      assert.deepEqual(events.filter(e => e.type === "source_cue").map(c => [c.start, c.end]), [[1500, 3500]]);
      const translatedCue = events.find(e => e.type === "cue");
      assert.ok(translatedCue);
      assert.equal(translatedCue.start, 1500);
      assert.equal(translatedCue.end, 3500);
      assert.ok(translatedCue.translation.startsWith("测试翻译："));
      assert.equal(events.at(-1)?.type, "done");
      assert.ok(calls.length > 0);
      for (const call of calls) assert.equal((call as unknown as { request_budget: number }).request_budget, 512);
    } finally {
      restoreEndpoint();
      modelServer.closeAllConnections();
      await new Promise<void>(resolve => modelServer.close(() => resolve()));
    }
  });

  // ── 5. Abort / Cancel Endpoint ──────────────────────────────────────────

  it("POST /api/subtitle/abort & /api/subtitle/cancel calls worker.abortJob", async () => {
    let abortedId = "";
    const mockWorker: any = {
      start: async () => {},
      close: async () => {},
      abortJob: async (id: string) => {
        abortedId = id;
        return true;
      },
    };

    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: mockWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/subtitle/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: "test-abort-123" }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.job_id, "test-abort-123");
    assert.equal(abortedId, "test-abort-123");
  });

  // ── 6. Cache Management Endpoints ───────────────────────────────────────

  it("DELETE /api/cache/:videoId, DELETE /api/cache, POST /api/cache/purge", async () => {
    await cache.putMetadata("test_v1", { id: "test_v1" });
    await cache.putMetadata("test_v2", { id: "test_v2" });

    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res1 = await fetch(`${baseUrl}/api/cache/test_v1`, { method: "DELETE" });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(typeof data1.removed, "number");

    const res2 = await fetch(`${baseUrl}/api/cache/purge`, { method: "POST" });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(typeof data2.removed, "number");

    const res3 = await fetch(`${baseUrl}/api/cache`, { method: "DELETE" });
    assert.equal(res3.status, 200);
    const data3 = await res3.json();
    assert.equal(typeof data3.removed, "number");
  });

  // ── 7. Input Validation & 413 & 404 ──────────────────────────────────────

  it("Rejects invalid bodies with client error 400 or 422", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    for (const body of [
      null,
      {},
      { url: 123 },
      { url: "https://www.youtube.com/watch?v=1", languages: "not-an-array" },
      { url: "https://www.youtube.com/watch?v=1", translate_engine: "invalid-engine" },
      { url: "https://www.youtube.com/watch?v=1", source_cues: [{ start: null, end: 1000, text: "invalid" }] },
    ]) {
      const res = await fetch(`${baseUrl}/api/subtitle/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok([400, 422].includes(res.status), `Body ${JSON.stringify(body)} returned ${res.status}`);
    }
  });

  it("Unknown endpoint returns 404", async () => {
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const res = await fetch(`${baseUrl}/api/non_existent_route`);
    assert.equal(res.status, 404);
  });

  // ── 8. Startup Failure & Resource Cleanup ────────────────────────────────

  it("Rejects invalid port without leaking worker resources", async () => {
    const leakDbPath = path.join(tmpDir, "leak-check.db");
    const leakWorker = new AgentWorker({ storagePath: leakDbPath });

    await assert.rejects(
      async () => {
        await startServer({
          port: -1,
          host: "127.0.0.1",
          cache,
          worker: leakWorker,
        });
      },
      (err: any) => {
        assert.ok(err instanceof RangeError);
        return true;
      }
    );

    // Verify storage can be opened by another worker immediately (no lock leak)
    const successorWorker = new AgentWorker({ storagePath: leakDbPath });
    await successorWorker.start();
    const check = await successorWorker.readinessCheck();
    assert.equal(check.ready, true);
    await successorWorker.close();
  });

  it("Cleans up worker on real EADDRINUSE and allows same storage to reopen", async () => {
    // 1. Start server A on an ephemeral port
    runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker: testWorker,
    });
    const occupiedPort = runningServer.port;

    // 2. Try to start server B on the exact same port with a dedicated storage
    const conflictDbPath = path.join(tmpDir, "conflict-worker.db");
    const conflictWorker = new AgentWorker({ storagePath: conflictDbPath });

    await assert.rejects(
      async () => {
        await startServer({
          port: occupiedPort,
          host: "127.0.0.1",
          cache,
          worker: conflictWorker,
        });
      },
      (err: any) => {
        assert.ok(err?.code === "EADDRINUSE" || String(err).includes("EADDRINUSE"));
        return true;
      }
    );

    // 3. Verify conflictWorker's storage was cleanly closed and can be reopened immediately
    const reopenedWorker = new AgentWorker({ storagePath: conflictDbPath });
    await reopenedWorker.start();
    const check = await reopenedWorker.readinessCheck();
    assert.equal(check.ready, true);
    await reopenedWorker.close();
  });

  // ── 9. Whisper Cache Profile Endpoint Priority & Isolation ──────────────

  it("getWhisperCacheProfile isolates endpoints and honors OPENAI_BASE_URL fallback", () => {
    const origWhisperBase = process.env.WHISPER_BASE_URL;
    const origOpenAIBase = process.env.OPENAI_BASE_URL;

    try {
      delete process.env.WHISPER_BASE_URL;
      delete process.env.OPENAI_BASE_URL;

      // 1. Default Groq URL
      const defaultProfile = getWhisperCacheProfile("en", null, "whisper-large-v3");

      // 2. Fallback to OPENAI_BASE_URL
      process.env.OPENAI_BASE_URL = "https://custom-openai.com/v1";
      const openAIProfile = getWhisperCacheProfile("en", null, "whisper-large-v3");
      assert.notEqual(defaultProfile, openAIProfile, "OPENAI_BASE_URL must produce a distinct isolated profile");

      // 3. WHISPER_BASE_URL takes priority over OPENAI_BASE_URL
      process.env.WHISPER_BASE_URL = "https://custom-whisper.com/v1";
      const whisperEnvProfile = getWhisperCacheProfile("en", null, "whisper-large-v3");
      assert.notEqual(openAIProfile, whisperEnvProfile, "WHISPER_BASE_URL must override OPENAI_BASE_URL and produce distinct profile");

      // 4. Explicit baseUrl argument takes priority over all env variables
      const explicitArgProfile = getWhisperCacheProfile("en", "https://arg-whisper.com/v1", "whisper-large-v3");
      assert.notEqual(whisperEnvProfile, explicitArgProfile, "Explicit argument must take highest priority");

      // Verify trailing slashes are normalized and produce identical profiles
      const explicitTrailingSlash = getWhisperCacheProfile("en", "https://arg-whisper.com/v1/", "whisper-large-v3");
      assert.equal(explicitArgProfile, explicitTrailingSlash, "Trailing slashes in baseUrl should normalize to same profile");
    } finally {
      if (origWhisperBase !== undefined) process.env.WHISPER_BASE_URL = origWhisperBase;
      else delete process.env.WHISPER_BASE_URL;
      if (origOpenAIBase !== undefined) process.env.OPENAI_BASE_URL = origOpenAIBase;
      else delete process.env.OPENAI_BASE_URL;
    }
  });
});
