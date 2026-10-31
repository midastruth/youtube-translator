import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callDocumentModel, DocumentModelError, initialDocumentState, modelConfig } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { endModelStream, modelChunk, sendModelJson } from "./support/model-stream.js";

async function endpoint(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1`;
  const restore = trustModelEndpoint(url);
  t.after(async () => {
    restore(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const input: DocumentInput = {
    jobId: "stream-test", jobKey: "stream-key", videoId: "video", title: "Database",
    fromLang: "en", toLang: "zh-CN", budgetLimit: 10,
    cues: [{ cue_id: "a", start: 0, end: 1000, text: "A database transaction." }],
    config: modelConfig({ model: "same-pi-model", baseUrl: url }),
  };
  let reservations = 0;
  return {
    url,
    reservations: () => reservations,
    call: (signal?: AbortSignal) => callDocumentModel(input, initialDocumentState(input), {
      operation: "test", instructions: "Return JSON", data: {},
    }, { apiKey: "ephemeral-key", signal, reserve: async () => { reservations++; } }),
  };
}

async function body(req: http.IncomingMessage) {
  let raw = ""; for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

test("pi transport streams without response_format and waits for complete JSON before returning", { timeout: 5000 }, async t => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const model = await endpoint(t, async (req, res) => {
    const payload = await body(req);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer ephemeral-key");
    assert.equal(payload.model, "same-pi-model");
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 16384);
    assert.equal(payload.temperature, 0.1);
    assert.equal(payload.response_format, undefined);
    assert.match(payload.messages[0].content, /untrusted task data/);
    modelChunk(res, { reasoning_content: "Private reasoning is not JSON output." });
    // Exercise a UTF-8 codepoint and an SSE frame split across network writes.
    const frame = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"translation":"事务' }, finish_reason: null }] })}\n\n`);
    const split = frame.indexOf(Buffer.from("事")) + 1;
    res.write(frame.subarray(0, split));
    await delay(5);
    res.write(frame.subarray(split));
    reached(); await gate;
    modelChunk(res, { content: '完成"}' });
    endModelStream(res);
  });
  let settled = false;
  const pending = model.call().finally(() => { settled = true; });
  await started; await delay(15);
  assert.equal(settled, false, "partial output must not finish a model turn");
  release();
  assert.deepEqual(await pending, { translation: "事务完成" });
  assert.equal(model.reservations(), 1);
});

test("a stream ending without finish_reason rejects even syntactically complete JSON", { timeout: 5000 }, async t => {
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    modelChunk(res, { content: '{"translation":"not reviewed"}' });
    res.end("data: [DONE]\n\n");
  });
  await assert.rejects(model.call(), /Model API stream failed or ended prematurely/);
});

test("length-limited output cannot masquerade as a completed JSON response", { timeout: 5000 }, async t => {
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    modelChunk(res, { content: '{"translation":"incomplete"}' });
    endModelStream(res, "length");
  });
  await assert.rejects(model.call(), /missing or truncated/);
});

test("cancelling a live pi stream closes model I/O and discards partial text", { timeout: 5000 }, async t => {
  let reached!: () => void, closed!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    res.on("close", closed);
    modelChunk(res, { content: '{"translation":"partial' });
    reached();
  });
  const controller = new AbortController();
  const pending = model.call(controller.signal);
  await started; controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  await disconnected;
  assert.equal(model.reservations(), 1);
});

test("pi HTTP failures retain only safe status and Retry-After, with no hidden SDK retries", { timeout: 5000 }, async t => {
  for (const status of [401, 403, 429, 499, 502, 503, 504]) {
    await t.test(String(status), async t => {
      let hits = 0;
      const model = await endpoint(t, async (req, res) => {
        await body(req); hits++;
        res.writeHead(status, { "Content-Type": "application/json", "Retry-After": "2" });
        res.end(JSON.stringify({ error: { message: "private body ephemeral-key" } }));
      });
      await assert.rejects(model.call(), error => {
        assert.ok(error instanceof DocumentModelError);
        assert.equal(error.status, status);
        assert.equal(error.retryAfterMs, 2000);
        assert.doesNotMatch(error.message, /private|ephemeral-key/);
        return true;
      });
      assert.equal(hits, 1);
      assert.equal(model.reservations(), 1);
    });
  }
});

test("pi streaming never follows redirects with credentials", { timeout: 5000 }, async t => {
  let redirected = 0;
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    if (req.url === "/stolen") { redirected++; sendModelJson(res, { stolen: true }); return; }
    res.writeHead(307, { Location: "/stolen" }); res.end();
  });
  await assert.rejects(model.call(), /Model API stream failed/);
  assert.equal(redirected, 0);
  assert.equal(model.reservations(), 1);
});

test("fragmented invalid tool arguments receive a scoped error and can be repaired", { timeout: 5000 }, async t => {
  let turns = 0;
  const model = await endpoint(t, async (req, res) => {
    const payload = await body(req); turns++;
    if (turns === 1) {
      modelChunk(res, { tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "search_transcript", arguments: '{"query":' } }] });
      modelChunk(res, { tool_calls: [{ index: 0, function: { arguments: "{}}" } }] });
      endModelStream(res, "tool_calls");
    } else {
      const tool = payload.messages.find((m: { role: string }) => m.role === "tool");
      assert.equal(tool.tool_call_id, "lookup");
      assert.match(tool.content, /Invalid retrieval request/);
      assert.doesNotMatch(tool.content, /ephemeral-key/);
      sendModelJson(res, { repaired: true });
    }
  });
  assert.deepEqual(await model.call(), { repaired: true });
  assert.equal(turns, 2); assert.equal(model.reservations(), 2);
});
