import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { sendSSE, sendWebSocket, withHeartbeats } from "../server/src/streaming.js";
import { createApp } from "../server/src/app.js";
import { attachWebSocket } from "../server/src/websocket.js";
import { SubtitleCache } from "../server/src/cache.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("SSE backpressure bounds a slow consumer to one frame and abort interrupts drain", async () => {
  class SlowResponse extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    writes: string[] = [];
    write(frame: string) { this.writes.push(frame); return false; }
  }
  const response = new SlowResponse();
  const controller = new AbortController();
  const pending = (async () => {
    for (let index = 0; index < 10000; index++) {
      await sendSSE(response as unknown as ServerResponse, { type: "cue", index }, controller.signal);
    }
  })();
  const failed = assert.rejects(pending, { name: "AbortError" });
  await tick(); assert.equal(response.writes.length, 1);
  response.emit("drain");
  await tick(); assert.equal(response.writes.length, 2);
  controller.abort(); await failed;
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
});

test("SSE disconnect rejects a blocked send instead of leaving a drain waiter", async () => {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, write: () => false });
  const failed = assert.rejects(sendSSE(response as unknown as ServerResponse, { type: "cue" }, new AbortController().signal), /closed/);
  response.emit("close"); await failed;
  assert.equal(response.listenerCount("drain"), 0);
});

test("WebSocket backpressure awaits each send callback and stops a blocked producer on close", async () => {
  class SlowSocket extends EventEmitter {
    readyState = WebSocket.OPEN;
    writes = 0;
    callbacks: ((error?: Error) => void)[] = [];
    send(_data: string, callback: (error?: Error) => void) { this.writes++; this.callbacks.push(callback); }
  }
  const socket = new SlowSocket();
  const pending = (async () => {
    for (let index = 0; index < 10000; index++) await sendWebSocket(socket as unknown as WebSocket, String(index));
  })();
  const failed = assert.rejects(pending, /closed/);
  await tick(); assert.equal(socket.writes, 1);
  socket.callbacks.shift()!(); await tick(); assert.equal(socket.writes, 2);
  socket.emit("close"); await failed;
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

test("provider and heartbeat write errors propagate without a successful result", async () => {
  await assert.rejects(withHeartbeats(Promise.reject(new Error("provider failed")), async () => {}), /provider failed/);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(withHeartbeats(pending, async () => { throw new Error("write failed"); }, 1), /write failed/);
  release();
});

test("createApp and attachWebSocket surface default worker storage initialization failures", { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yts-init-failure-"));
  const file = path.join(directory, "not-a-directory"); await fs.writeFile(file, "file");
  const previous = process.env.TRANSLATION_AGENT_STORAGE;
  process.env.TRANSLATION_AGENT_STORAGE = path.join(file, "worker.db");
  t.after(async () => {
    if (previous === undefined) delete process.env.TRANSLATION_AGENT_STORAGE;
    else process.env.TRANSLATION_AGENT_STORAGE = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cache = new SubtitleCache(path.join(directory, "cache"));
  const server = http.createServer(createApp({ cache }));
  const closeWebSocket = attachWebSocket(server, { cache });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await closeWebSocket(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 500); await response.arrayBuffer();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/subtitle/process`);
  const events: { type: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ url: "https://youtu.be/fixture", source_cues: [{ start: 0, end: 1000, text: "Hello." }] })));
    socket.on("message", raw => events.push(JSON.parse(raw.toString())));
    socket.once("close", () => resolve()); socket.once("error", reject);
  });
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.some(e => e.type === "done"), false);
});
