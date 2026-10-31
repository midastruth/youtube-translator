import assert from "node:assert/strict";
import { test } from "node:test";
import { documentRequestBudget } from "../worker/agent-worker.js";
import { validateSubtitleRequest } from "../server/src/app.js";

test("document request budget uses explicit request, deployment override, then saved/default limit", t => {
  const previous = process.env.TRANSLATION_REQUEST_BUDGET;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSLATION_REQUEST_BUDGET;
    else process.env.TRANSLATION_REQUEST_BUDGET = previous;
  });
  delete process.env.TRANSLATION_REQUEST_BUDGET;
  assert.equal(documentRequestBudget(), 0);
  assert.equal(documentRequestBudget(undefined, 200), 200);
  process.env.TRANSLATION_REQUEST_BUDGET = " ";
  assert.equal(documentRequestBudget(undefined, 200), 200);
  process.env.TRANSLATION_REQUEST_BUDGET = " 512 ";
  assert.equal(documentRequestBudget(), 512);
  assert.equal(documentRequestBudget(undefined, 200), 512);
  assert.equal(documentRequestBudget(256), 256);
  assert.equal(documentRequestBudget(0), 0, "request can disable a configured limit");
  process.env.TRANSLATION_REQUEST_BUDGET = "0";
  assert.equal(documentRequestBudget(undefined, 200), 0, "deployment can disable a saved limit");
  assert.equal(documentRequestBudget(256), 256, "explicit limit overrides unlimited deployment");
  for (const invalid of ["-1", "1001", "1.5", "abc", "Infinity"]) {
    process.env.TRANSLATION_REQUEST_BUDGET = invalid;
    assert.throws(() => documentRequestBudget(), /0～1000/);
    assert.equal(documentRequestBudget(256), 256);
  }
  for (const invalid of [-1, 1001, 1.5, NaN, Infinity]) {
    assert.throws(() => documentRequestBudget(invalid), /0～1000/);
  }
});

test("subtitle gateway validates request budget before starting translation", () => {
  const body = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  for (const valid of [undefined, null, 0, 1, 512, 1000]) {
    assert.doesNotThrow(() => validateSubtitleRequest({ ...body, translate_request_budget: valid }));
  }
  for (const invalid of [-1, 1001, 1.5, "512", {}, NaN, Infinity]) {
    assert.throws(() => validateSubtitleRequest({ ...body, translate_request_budget: invalid }), error => {
      assert.equal((error as Error & { statusCode: number }).statusCode, 422);
      assert.match((error as Error).message, /translate_request_budget/);
      return true;
    });
  }
});
