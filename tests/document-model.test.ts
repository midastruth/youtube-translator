import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callDocumentModel, DocumentModelError, DocumentStreamError, initialDocumentState, modelConfig } from "../worker/document-translation.js";
import type { DocumentInput, ModelConfig, ReasoningEffort } from "../worker/document-translation.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { endModelStream, modelChunk, sendModelJson } from "./support/model-stream.js";

async function endpoint(t: TestContext, handler: http.RequestListener, config: Partial<ModelConfig> = {}) {
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
    config: modelConfig({ model: "same-pi-model", baseUrl: url, reasoningEffort: "off", ...config }),
  };
  let reservations = 0;
  return {
    url, input,
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
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.max_completion_tokens, undefined);
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

test("pi reasoning options produce OpenAI-compatible payloads and keep reasoning out of JSON output", { timeout: 10000 }, async t => {
  for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
    await t.test(effort, async t => {
      const model = await endpoint(t, async (req, res) => {
        const payload = await body(req);
        assert.equal(payload.reasoning_effort, effort);
        assert.equal(payload.max_completion_tokens, 16384);
        assert.equal(payload.max_tokens, undefined);
        assert.equal(payload.temperature, undefined);
        assert.equal(payload.stream, true);
        assert.ok(payload.tools.length > 0);
        modelChunk(res, { reasoning_content: "Private reasoning, not part of the translation." });
        sendModelJson(res, { translation: "事务完成" });
      }, { reasoningEffort: effort });
      assert.deepEqual(await model.call(), { translation: "事务完成" });
      assert.equal(model.reservations(), 1);
    });
  }
});

test("old checkpoints do not adopt newly enabled deployment reasoning", { timeout: 5000 }, async t => {
  const previous = process.env.TRANSLATION_REASONING_EFFORT;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSLATION_REASONING_EFFORT;
    else process.env.TRANSLATION_REASONING_EFFORT = previous;
  });
  const model = await endpoint(t, async (req, res) => {
    const payload = await body(req);
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.max_completion_tokens, undefined);
    assert.equal(payload.max_tokens, 16384);
    assert.equal(payload.temperature, 0.1);
    sendModelJson(res, { restored: true });
  });
  delete model.input.config.reasoningEffort;
  process.env.TRANSLATION_REASONING_EFFORT = "high";
  assert.deepEqual(await model.call(), { restored: true });
});

test("invalid persisted reasoning settings fail before model I/O or budget reservation", async t => {
  let hits = 0;
  const model = await endpoint(t, async (_req, res) => { hits++; sendModelJson(res, {}); });
  model.input.config.reasoningEffort = "invalid-private-value" as ReasoningEffort;
  await assert.rejects(model.call(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid TRANSLATION_REASONING_EFFORT/);
    assert.doesNotMatch(error.message, /invalid-private-value/);
    return true;
  });
  assert.equal(hits, 0);
  assert.equal(model.reservations(), 0);
});

test("a stream ending without finish_reason rejects even syntactically complete JSON", { timeout: 5000 }, async t => {
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    modelChunk(res, { content: '{"translation":"not reviewed"}' });
    res.end("data: [DONE]\n\n");
  });
  await assert.rejects(model.call(), error => {
    assert.ok(error instanceof DocumentStreamError);
    assert.equal(error.code, "missing_finish_reason");
    assert.match(error.message, /finish_reason/);
    return true;
  });
});

test("an EOF without DONE or finish_reason still rejects complete JSON", { timeout: 5000 }, async t => {
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    modelChunk(res, { content: '{"translation":"not reviewed"}' });
    res.end();
  });
  await assert.rejects(model.call(), error => error instanceof DocumentStreamError && error.code === "missing_finish_reason");
});

test("HTTP 200 JSON and HTML responses identify a non-SSE endpoint without exposing bodies", { timeout: 5000 }, async t => {
  for (const contentType of ["application/json", "text/html; charset=utf-8", "application/problem+json"]) {
    await t.test(contentType, async t => {
      const model = await endpoint(t, async (req, res) => {
        await body(req);
        res.writeHead(200, { "Content-Type": contentType });
        res.end('private body ephemeral-key {"translation":"not reviewed"}');
      });
      await assert.rejects(model.call(), error => {
        assert.ok(error instanceof DocumentStreamError);
        assert.equal(error.code, "invalid_response");
        assert.match(error.message, /SSE/);
        assert.doesNotMatch(error.message, /private|ephemeral-key|not reviewed/);
        return true;
      });
      assert.equal(model.reservations(), 1);
    });
  }
});

test("provider finish errors have safe, distinct diagnostics", { timeout: 5000 }, async t => {
  for (const reason of ["content_filter", "network_error", "private-ephemeral-key"]) {
    await t.test(reason, async t => {
      const model = await endpoint(t, async (req, res) => {
        await body(req);
        modelChunk(res, { content: '{"translation":"not reviewed"}' });
        endModelStream(res, reason);
      });
      await assert.rejects(model.call(), error => {
        assert.ok(error instanceof DocumentStreamError);
        assert.equal(error.code, reason === "private-ephemeral-key" ? "provider_error" : reason);
        assert.doesNotMatch(error.message, /private|ephemeral-key|not reviewed/);
        return true;
      });
    });
  }
});

test("SSE error bodies are never exposed as diagnostics", { timeout: 5000 }, async t => {
  const model = await endpoint(t, async (req, res) => {
    await body(req);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ error: { message: "private body ephemeral-key" } })}\n\n`);
  });
  await assert.rejects(model.call(), error => {
    assert.ok(error instanceof DocumentStreamError);
    assert.equal(error.code, "provider_error");
    assert.doesNotMatch(error.message, /private|ephemeral-key/);
    return true;
  });
});

test("connection failures are identified without SDK retries", { timeout: 5000 }, async t => {
  let hits = 0;
  const model = await endpoint(t, async (req, _res) => {
    await body(req); hits++;
    req.socket.destroy();
  });
  await assert.rejects(model.call(), error => error instanceof DocumentStreamError && error.code === "connection");
  assert.equal(hits, 1);
  assert.equal(model.reservations(), 1);
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

test("reasoning streams support fragmented tool calls, scoped repair and multi-turn tool history", { timeout: 5000 }, async t => {
  let turns = 0;
  const model = await endpoint(t, async (req, res) => {
    const payload = await body(req); turns++;
    assert.equal(payload.reasoning_effort, "medium");
    assert.equal(payload.max_completion_tokens, 16384);
    assert.equal(payload.temperature, undefined);
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
  }, { reasoningEffort: "medium" });
  assert.deepEqual(await model.call(), { repaired: true });
  assert.equal(turns, 2); assert.equal(model.reservations(), 2);
});
