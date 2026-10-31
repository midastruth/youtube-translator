import assert from "node:assert/strict";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { sendModelJson } from "./support/model-stream.js";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../server/src/server.js";
import { SubtitleCache } from "../server/src/cache.js";
import { AgentWorker } from "../worker/agent-worker.js";

describe("WebSocket Subtitle Processing Endpoint (/ws/subtitle/process)", () => {
  let tmpDir: string;
  let running: RunningServer;
  let cache: SubtitleCache;
  let worker: AgentWorker;
  let mockModelServer: http.Server | null = null;
  let mockModelPort = 0;
  let restoreEndpoint: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yts-ws-test-"));
    const cacheDir = path.join(tmpDir, "cache");
    const storagePath = path.join(tmpDir, "worker.db");
    cache = new SubtitleCache(cacheDir);
    worker = new AgentWorker({ storagePath });

    // Mock OpenAI HTTP Server for both document & legacy streaming tests
    mockModelServer = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const payload = JSON.parse(raw);

        // SSE Streaming branch for legacy cue_chunk tests
        if (payload.stream && !payload.tools?.length) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.writeHead(200);

          // Emit at least two UTF-8 deltas
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "事务" } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 20));
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "失败了。" } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 20));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // pi streaming branch for document translation operations with tools
        const userMsg = payload.messages?.find((m: any) => m.role === "user")?.content;
        const request = JSON.parse(userMsg);
        const cues = (request.data as { source?: { cue_id: string; start: number; end: number }[] })?.source || [];

        let answer: any;
        switch (request.operation) {
          case "analyze":
            answer = {
              summary: "Test summary",
              glossary: [],
              chapters: [{ start_id: cues[0].cue_id, end_id: cues[cues.length - 1].cue_id, title: "Section" }],
            };
            break;
          case "brief":
            answer = { summary: "Test summary", glossary: [] };
            break;
          case "translate":
            answer = {
              summary: "Test summary",
              glossary: [],
              translations: cues.map((c: any) => ({ cue_id: c.cue_id, translation: `译文：${c.cue_id}` })),
            };
            break;
          case "audit":
            answer = { guidance: "ok" };
            break;
          case "review":
            answer = { summary: "Test summary", glossary: [], passed: true, issues: [], corrections: [] };
            break;
          case "final_audit":
            answer = { passed: true, guidance: "ok" };
            break;
          default:
            answer = { summary: "Test summary", glossary: [] };
        }

        assert.equal(payload.stream, true);
        sendModelJson(res, answer);
      } catch (err: any) {
        res.writeHead(500);
        res.end(String(err));
      }
    });

    await new Promise<void>((resolve) => mockModelServer!.listen(0, "127.0.0.1", resolve));
    const addr = mockModelServer.address();
    mockModelPort = typeof addr === "object" && addr ? addr.port : 0;
    restoreEndpoint = trustModelEndpoint(`http://127.0.0.1:${mockModelPort}/v1`);

    running = await startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker,
    });
  });

  afterEach(async () => {
    restoreEndpoint?.();
    if (mockModelServer) {
      mockModelServer.closeAllConnections?.();
      await new Promise<void>((resolve) => mockModelServer!.close(() => resolve()));
      mockModelServer = null;
    }
    if (running) {
      await running.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function connectWs(pathname = "/ws/subtitle/process"): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}${pathname}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  it("handles malformed JSON payload without crashing server", { timeout: 10_000 }, async () => {
    const ws = await connectWs();
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("close", () => resolve());
      ws.send("this-is-not-json{{{");
    });

    assert.ok(messages.length >= 1);
    assert.equal(messages[0].type, "error");
    assert.ok(messages[0].detail.includes("Invalid JSON"));
  });

  it("handles empty or missing url payload without crashing", { timeout: 10_000 }, async () => {
    const ws = await connectWs();
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("close", () => resolve());
      ws.send(JSON.stringify({ allow_automatic: true }));
    });

    assert.ok(messages.length >= 1);
    assert.equal(messages[0].type, "error");
    assert.ok(messages[0].detail.includes("url"));
  });

  it("streams raw cues without translation when translate_to is absent", { timeout: 10_000 }, async () => {
    const ws = await connectWs();
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("close", () => resolve());

      ws.send(JSON.stringify({
        url: "https://www.youtube.com/watch?v=ws_raw_test",
        source_cues: [
          { start: 0, end: 1200, text: "Line 1." },
          { start: 1500, end: 3000, text: "Line 2." },
        ],
      }));
    });

    // 1. Meta (exactly 1)
    const metaList = messages.filter((m) => m.type === "meta");
    assert.equal(metaList.length, 1, "Must receive exactly 1 meta event");
    assert.equal(metaList[0].total_cues, 2);

    // 2. Source cues (in milliseconds, exactly 2)
    const sourceCues = messages.filter((m) => m.type === "source_cue");
    assert.equal(sourceCues.length, 2);
    assert.equal(sourceCues[0].start, 0);
    assert.equal(sourceCues[0].end, 1200);
    assert.equal(sourceCues[1].start, 1500);
    assert.equal(sourceCues[1].end, 3000);

    // 3. Result cues (exactly 2)
    const cues = messages.filter((m) => m.type === "cue");
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "Line 1.");
    assert.equal(cues[1].text, "Line 2.");

    // 4. Done event
    const done = messages.find((m) => m.type === "done");
    assert.ok(done, "Should receive done event");
    assert.equal(done.total_cues, 2);
    assert.equal(done.failed_cues, 0);
  });

  it("preserves OpenAI legacy WS cue_chunk streaming protocol with UTF-8 deltas", { timeout: 10_000 }, async () => {
    const ws = await connectWs();
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("close", () => resolve());

      ws.send(JSON.stringify({
        url: "https://www.youtube.com/watch?v=ws_legacy_test",
        translate_to: "zh-Hans",
        translate_engine: "legacy",
        translate_base_url: `http://127.0.0.1:${mockModelPort}/v1`,
        translate_api_key: "test-legacy-key",
        source_cues: [
          { start: 100, end: 1500, text: "The transaction failed." },
        ],
      }));
    });

    const metaList = messages.filter((m) => m.type === "meta");
    assert.equal(metaList.length, 1, "Must receive exactly 1 meta event");
    assert.equal(metaList[0].to_lang, "zh-Hans");

    const sourceCues = messages.filter((m) => m.type === "source_cue");
    assert.equal(sourceCues.length, 1);

    // Verify cue_chunk messages with progressive delta text
    const chunks = messages.filter((m) => m.type === "cue_chunk");
    assert.ok(chunks.length >= 2, `Should receive at least two cue_chunk messages, received: ${chunks.length}`);
    assert.equal(chunks[0].translation, "事务");
    assert.equal(chunks[1].translation, "事务失败了。");

    // Final cue has complete translation
    const cues = messages.filter((m) => m.type === "cue");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, "The transaction failed.");
    assert.equal(cues[0].translation, "事务失败了。");

    const done = messages.find((m) => m.type === "done");
    assert.ok(done);
    assert.equal(done.failed_cues, 0);
  });

  it("supports document mode translation with real in-memory worker and exactly 1 meta", { timeout: 15_000 }, async () => {
    const ws = await connectWs();
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("close", () => resolve());

      ws.send(JSON.stringify({
        url: "https://www.youtube.com/watch?v=ws_doc_test",
        translate_to: "zh-Hans",
        translate_engine: "document",
        translate_base_url: `http://127.0.0.1:${mockModelPort}/v1`,
        translate_api_key: "test-document-key",
        source_cues: [
          { start: 0, end: 1000, text: "The transaction failed." },
          { start: 2000, end: 3500, text: "Database connection closed." },
        ],
      }));
    });

    // Exactly 1 meta from worker
    const metaList = messages.filter((m) => m.type === "meta");
    assert.equal(metaList.length, 1, "Worker metadata must not be forwarded twice");

    // Exactly 2 source cues from worker with millisecond timings
    const sourceCues = messages.filter((m) => m.type === "source_cue");
    assert.equal(sourceCues.length, 2, "Source cues count must match input count");
    assert.equal(sourceCues[0].start, 0);
    assert.equal(sourceCues[0].end, 1000);
    assert.equal(sourceCues[1].start, 2000);
    assert.equal(sourceCues[1].end, 3500);

    // Cues translated by worker
    const cues = messages.filter((m) => m.type === "cue");
    assert.equal(cues.length, 2);
    assert.ok(cues[0].translation.startsWith("译文："));

    // Terminal done
    const done = messages.find((m) => m.type === "done");
    assert.ok(done, "Should complete with done event");
  });

  it("handles abrupt client disconnection without server crash", { timeout: 10_000 }, async () => {
    const ws = await connectWs();

    ws.send(JSON.stringify({
      url: "https://www.youtube.com/watch?v=ws_disconnect_test",
      translate_to: "zh-Hans",
      translate_engine: "legacy",
      source_cues: [
        { start: 0, end: 5000, text: "Disconnect test line." },
      ],
    }));

    // Abruptly terminate immediately after sending
    ws.terminate();

    // Verify server is still completely alive and healthy
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`http://127.0.0.1:${running.port}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.status, "ok");
  });

  it("server.close() cleans up open WebSocket connections without hanging", { timeout: 10_000 }, async () => {
    const ws = await connectWs();

    // Server close should terminate the open ws connection and resolve cleanly
    await Promise.all([
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve();
        else ws.once("close", () => resolve());
      }),
      running.close(),
    ]);
    assert.equal(ws.readyState, WebSocket.CLOSED);
  });

  it("rejects non-matching WebSocket upgrade paths with 404", { timeout: 5_000 }, async () => {
    await assert.rejects(
      () => connectWs("/ws/invalid_path"),
      (err: any) => err !== null,
    );
  });
});
