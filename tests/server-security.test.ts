import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { startServer, type ServerOptions } from "../server/src/server.js";
import { SubtitleCache } from "../server/src/cache.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { createWorkerServer } from "../worker/server.js";
import { isAllowedOrigin } from "../server/src/origin.js";
import { WhisperClient, deploymentWhisperKey, whisperEndpoint } from "../server/src/transcribe.js";
import { IngestError } from "../server/src/errors.js";

const ENV_KEYS = ["ALLOWED_ORIGINS", "WHISPER_BASE_URL", "OPENAI_BASE_URL", "WHISPER_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "HOST"];

function isolateEnv(t: TestContext, values: Record<string, string | undefined> = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function gateway(t: TestContext, overrides: Partial<ServerOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-security-"));
  const running = await startServer({
    port: 0, host: "127.0.0.1",
    cache: new SubtitleCache(path.join(root, "cache")),
    worker: new AgentWorker({ storagePath: path.join(root, "state.db") }),
    fetchMetadata: async () => { throw new Error("Unexpected metadata lookup"); },
    ...overrides,
  });
  t.after(async () => {
    try { await running.close(); } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  return `http://127.0.0.1:${running.port}`;
}

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const browserRequest = {
  url: "https://www.youtube.com/watch?v=security123",
  source_language: "en",
  source_cues: [{ start: 0, end: 1000, text: "Hello world." }],
};

test("origin allowlist accepts only YouTube and extension contexts", t => {
  isolateEnv(t);
  for (const origin of ["https://www.youtube.com", "chrome-extension://abcdefghijklmnop", "moz-extension://0d4f3c1e-1234-4abc-9def-123456789abc"]) {
    assert.equal(isAllowedOrigin(origin), true, origin);
  }
  for (const origin of ["https://evil.example", "http://www.youtube.com", "https://www.youtube.com.evil.example", "null", "", "chrome-extension://a/b", "http://localhost:3000"]) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
  process.env.ALLOWED_ORIGINS = "chrome-extension://pinnedid";
  assert.equal(isAllowedOrigin("chrome-extension://pinnedid"), true);
  assert.equal(isAllowedOrigin("chrome-extension://otherid"), false);
  assert.equal(isAllowedOrigin("https://www.youtube.com"), false);
});

test("foreign web pages cannot call the API, preflight, or open a WebSocket", { timeout: 10000 }, async t => {
  isolateEnv(t);
  const base = await gateway(t);
  const evil = { Origin: "https://evil.example" };

  const preflight = await fetch(`${base}/api/subtitle/stream`, { method: "OPTIONS", headers: evil });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);

  const post = await fetch(`${base}/api/subtitle/process`, {
    method: "POST", headers: { ...evil, "Content-Type": "text/plain" }, body: JSON.stringify(browserRequest),
  });
  assert.equal(post.status, 403);
  assert.equal(post.headers.get("access-control-allow-origin"), null);

  const status = await new Promise<number>((resolve, reject) => {
    const req = http.get(`${base}/ws/subtitle/process`, {
      headers: { ...evil, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    req.on("response", res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("upgrade", () => reject(new Error("foreign origin was upgraded")));
    req.on("error", reject);
  });
  assert.equal(status, 403);

  const allowed = await fetch(`${base}/api/subtitle/process`, {
    method: "POST", headers: { Origin: "https://www.youtube.com", "Content-Type": "application/json" }, body: JSON.stringify(browserRequest),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.youtube.com");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
  await allowed.arrayBuffer();

  const sse = await fetch(`${base}/api/subtitle/stream`, {
    method: "POST", headers: { Origin: "chrome-extension://abcdefghijklmnop", "Content-Type": "application/json" }, body: JSON.stringify(browserRequest),
  });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
  await sse.arrayBuffer();
});

test("a caller-chosen whisper_base_url is rejected before any audio work or key use", { timeout: 10000 }, async t => {
  isolateEnv(t, { WHISPER_API_KEY: "deployment-secret" });
  let attackerCalls = 0;
  const attacker = await listen((_req, res) => { attackerCalls++; res.end("{}"); });
  t.after(() => new Promise<void>(resolve => attacker.server.close(() => resolve())));
  let downloads = 0;
  const base = await gateway(t, {
    fetchMetadata: async () => ({ id: "nosubs", title: "No captions", subtitles: {}, automatic_captions: {} }),
    downloadAudio: async () => { downloads++; throw new Error("must not download"); },
  });
  const response = await fetch(`${base}/api/subtitle/process`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=nosubs", whisper_enabled: true, whisper_base_url: `${attacker.url}/v1` }),
  });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /whisper_base_url is not trusted/);
  assert.equal(downloads, 0);
  assert.equal(attackerCalls, 0);
});

test("Whisper endpoint is deployment-pinned and keys stay with their provider", t => {
  isolateEnv(t, { OPENAI_API_KEY: "sk-openai" });
  // Without OPENAI_BASE_URL/WHISPER_BASE_URL the default is Groq: an OpenAI key must not go there.
  assert.equal(whisperEndpoint(), "https://api.groq.com/openai/v1");
  assert.equal(deploymentWhisperKey(whisperEndpoint()), undefined);
  assert.throws(() => new WhisperClient(), IngestError);
  assert.throws(() => whisperEndpoint("https://attacker.invalid/openai/v1"), /not trusted/);
  assert.throws(() => whisperEndpoint("https://api.groq.com.attacker.invalid/openai/v1"), /not trusted/);

  process.env.GROQ_API_KEY = "gsk-groq";
  assert.equal(new WhisperClient().apiKey, "gsk-groq");
  // A caller-supplied key may be used with the trusted endpoint (equivalent spelling allowed).
  assert.equal(new WhisperClient({ apiKey: "user", baseUrl: "https://api.groq.com/openai/v1/" }).apiKey, "user");

  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  assert.equal(whisperEndpoint(), "https://api.openai.com/v1");
  assert.equal(new WhisperClient().apiKey, "sk-openai");
  assert.throws(() => new WhisperClient({ baseUrl: "https://api.groq.com/openai/v1" }), /not trusted/);
});

test("Whisper requests never follow redirects with credentials", { timeout: 10000 }, async t => {
  let leaked = 0;
  const sink = await listen((req, res) => { if (req.headers.authorization) leaked++; res.end("{\"text\":\"x\"}"); });
  t.after(() => new Promise<void>(resolve => sink.server.close(() => resolve())));
  const redirector = await listen((_req, res) => { res.writeHead(307, { Location: `${sink.url}/v1/audio/transcriptions` }); res.end(); });
  t.after(() => new Promise<void>(resolve => redirector.server.close(() => resolve())));
  isolateEnv(t, { WHISPER_BASE_URL: `${redirector.url}/v1`, WHISPER_API_KEY: "deployment-secret" });

  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "whisper-redirect-")), "a.mp3");
  await fs.writeFile(file, "audio");
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  await assert.rejects(new WhisperClient({ retries: 1, timeoutSeconds: 2 }).transcribe(file));
  assert.equal(leaked, 0);
});

test("the server binds to loopback unless HOST is configured", { timeout: 10000 }, async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-bind-"));
  const running = await startServer({
    port: 0, cache: new SubtitleCache(path.join(root, "cache")),
    worker: new AgentWorker({ storagePath: path.join(root, "state.db") }),
  });
  t.after(async () => { try { await running.close(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const address = running.server.address(); assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
});

test("the internal worker rejects browser-originated requests", { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-origin-"));
  const { server, worker } = await createWorkerServer({ storagePath: path.join(root, "state.db"), port: 0 });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const blocked = await fetch(`${base}/internal/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  const direct = await fetch(`${base}/internal/health`);
  assert.notEqual(direct.status, 403);
  await direct.arrayBuffer();
});
