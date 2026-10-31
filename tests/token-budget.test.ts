import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { checkTokenBudget, documentTokenBudget } from "../worker/token-budget.js";
import { tokenEstimate, turnTokenUsage } from "../worker/document-translation.js";
import { validateSubtitleRequest } from "../server/src/app.js";

test("token budget defaults to 20 million and supports request/deployment overrides", t => {
  const previous = process.env.TRANSLATION_TOKEN_BUDGET;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSLATION_TOKEN_BUDGET;
    else process.env.TRANSLATION_TOKEN_BUDGET = previous;
  });
  delete process.env.TRANSLATION_TOKEN_BUDGET;
  assert.equal(documentTokenBudget(), 20_000_000);
  assert.equal(documentTokenBudget(undefined, 500), 500);
  process.env.TRANSLATION_TOKEN_BUDGET = " 30000000 ";
  assert.equal(documentTokenBudget(undefined, 500), 30_000_000);
  assert.equal(documentTokenBudget(0), 0);
  process.env.TRANSLATION_TOKEN_BUDGET = "0";
  assert.equal(documentTokenBudget(), 0);
  for (const value of ["-1", "0.5", "abc", "Infinity", "9007199254740992"]) {
    process.env.TRANSLATION_TOKEN_BUDGET = value;
    assert.throws(() => documentTokenBudget(), /Token 预算/);
    assert.equal(documentTokenBudget(100), 100);
  }
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => documentTokenBudget(value), /Token 预算/);
  }
});

test("token gate is soft: stop the next request at the limit, never reject saved work", () => {
  assert.doesNotThrow(() => checkTokenBudget(100, 99));
  for (const used of [100, 200]) {
    assert.throws(() => checkTokenBudget(100, used), /Token 预算已耗尽.*草稿已保留.*重新开启翻译/);
  }
  assert.doesNotThrow(() => checkTokenBudget(0, 1e9));
  assert.doesNotThrow(() => checkTokenBudget(undefined, 1e9), "old checkpoints remain compatible");
});

test("token accounting includes cached input and output without double counting totals", () => {
  const context = { messages: [] };
  const response = { usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 } } as AssistantMessage;
  assert.equal(turnTokenUsage(response, context, 1000), 100);
  response.usage.input = 0; response.usage.output = 0; response.usage.cacheRead = 0; response.usage.cacheWrite = 0;
  assert.equal(turnTokenUsage(response, context, 1000), tokenEstimate(context) + 1000);
});

test("SSE/WebSocket gateway validates token budgets before model calls", () => {
  const body = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  for (const valid of [undefined, null, 0, 1, 20_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => validateSubtitleRequest({ ...body, translate_token_budget: valid }));
  }
  for (const invalid of [-1, 0.5, "20000000", {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateSubtitleRequest({ ...body, translate_token_budget: invalid }), error => {
      assert.equal((error as Error & { statusCode: number }).statusCode, 422);
      assert.match((error as Error).message, /translate_token_budget/);
      return true;
    });
  }
});
