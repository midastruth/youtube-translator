import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { modelEndpoint } from "../worker/model-endpoint.js";
import { callDocumentTurn, modelConfig, type DocumentInput } from "../worker/document-translation.js";
import { translateSingle, translateBatch, translateStream, translateWhole } from "../server/src/translate.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";

test("only exact deployment-controlled model URLs are permitted, before DNS or fetch", async t => {
  t.after(trustModelEndpoint("https://api.openai.com/v1"));
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected fetch"); });
  assert.equal(modelEndpoint("https://API.OPENAI.COM:443/v1/"), "https://api.openai.com/v1");
  for (const endpoint of [
    "http://127.0.0.1/v1", "http://2130706433/v1", "http://[::1]/v1", "http://169.254.169.254/v1",
    "http://10.0.0.1/v1", "https://rebind.attacker.invalid/v1", "https://api.openai.com.attacker.invalid/v1",
    "https://api.openai.com:444/v1", "https://api.openai.com/other", "https://user:pass@api.openai.com/v1",
    "https://api.openai.com/v1?redirect=http://127.0.0.1", "file:///etc/passwd",
  ]) {
    assert.throws(() => modelConfig({ baseUrl: endpoint }));
    await assert.rejects(translateSingle("Hello", "en", "zh", { baseUrl: endpoint, apiKey: "secret" }));
  }
  assert.equal(fetches, 0, "untrusted hostnames/IPs must never reach DNS or transport");
});

test("a trusted provider redirect cannot forward deployment credentials to another destination", { timeout: 10000 }, async t => {
  let targetCalls = 0, trustedCalls = 0;
  const target = http.createServer((_req, res) => { targetCalls++; res.end("must not be reached"); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress !== "string");
  const provider = http.createServer((req, res) => {
    trustedCalls++; assert.equal(req.headers.authorization, "Bearer deployment-secret");
    res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/steal` }); res.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    provider.closeAllConnections(); target.closeAllConnections();
    await Promise.all([provider, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  t.after(trustModelEndpoint(`http://127.0.0.1:${address.port}/v1`));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "deployment-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const input: DocumentInput = {
    jobId: "test", jobKey: "test", videoId: "test", title: "Test", fromLang: "en", toLang: "zh", budgetLimit: 10,
    cues: [{ cue_id: "a", start: 0, end: 1000, text: "Hello." }], config: modelConfig(),
  };
  await assert.rejects(callDocumentTurn(input, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, { reserve: async () => {} }));
  await assert.rejects(translateSingle("Hello", "en", "zh"));
  assert.equal(trustedCalls, 2); assert.equal(targetCalls, 0);
});

test("malformed provider JSON and SSE frames fail loudly, including batch and whole modes", async t => {
  t.after(trustModelEndpoint("https://api.openai.com/v1"));
  let streaming = false;
  t.mock.method(globalThis, "fetch", async () => new Response(streaming ? "data: {broken}\n\n" : "{broken}", { status: 200 }));
  const options = { apiKey: "test-key" };
  await assert.rejects(translateBatch(["Hello", "World"], "en", "zh", options), SyntaxError);
  await assert.rejects(translateWhole([{ start: 0, end: 1000, text: "Hello" }], "en", "zh", options), SyntaxError);
  streaming = true;
  await assert.rejects(async () => {
    for await (const _chunk of translateStream("Hello", "en", "zh", options)) { /* consume */ }
  }, SyntaxError);
});
