import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewTranslations, buildRevisionPrompt } from "../worker/reviewer.js";
import { glossaryQuery } from "../worker/glossary.js";
import { mappingStructure } from "../worker/validator.js";

const cue = { cue_id: "c0", start: 123, end: 987, text: "Hello" };

test("review rules retain issue order and repeated source-number findings", async () => {
  const source = { ...cue, text: "Do not use 5 mg or 5 mg for database transaction embedding" };
  const result = await reviewTranslations([source], { c0: "50 毫克 交易 支付" }, { glossary: { transaction: "事务", embedding: "嵌入" }, domain: "database" });
  assert.equal(result.passed, false);
  assert.deepEqual(result.issues.map(issue => issue.reason), ["negation_loss", "dose_and_number_error", "dose_and_number_error", "terminology_mismatch", "terminology_mismatch", "hallucination"]);
  assert.ok(result.issues.every(issue => issue.cue_id === "c0"));
});

test("review preserves glossary exceptions and does not flag legitimate financial language", async () => {
  const cases: { text: string; translation: string; glossary: Record<string, string>; domain: string; reasons: string[] }[] = [
    { text: "Do not use 5 mg", translation: "不要使用 5 毫克", glossary: {}, domain: "general", reasons: [] },
    { text: "database transaction", translation: "交易", glossary: { transaction: "事务" }, domain: "general", reasons: ["terminology_mismatch"] },
    { text: "transaction", translation: "交易", glossary: { transaction: "事务" }, domain: "general", reasons: [] },
    { text: "database transaction", translation: "事务交易", glossary: { transaction: "别称" }, domain: "database", reasons: [] },
    { text: "embedding", translation: "嵌入", glossary: { embedding: "嵌入" }, domain: "general", reasons: [] },
    { text: "other term", translation: "译", glossary: { other: "指定" }, domain: "general", reasons: [] },
    { text: "Payment cost", translation: "支付", glossary: { embedding: "嵌入" }, domain: "general", reasons: [] },
  ];
  for (const { text, translation, glossary, domain, reasons } of cases) {
    const result = await reviewTranslations([{ ...cue, text }], new Map([["c0", translation]]), { glossary, domain });
    assert.deepEqual(result.issues.map(issue => issue.reason), reasons);
  }
  assert.equal((await reviewTranslations([cue], null)).passed, true);
  assert.equal((await reviewTranslations([{ ...cue, text: "" }], {})).passed, true);
});

test("revision prompt preserves references and defaults absent context to empty arrays", () => {
  const cues = [cue], draftTranslations = { c0: "译" }, issues = [{ cue_id: "c0", reason: "test" }];
  const prompt = buildRevisionPrompt({ cues, draftTranslations, issues });
  assert.equal(prompt.cues, cues); assert.equal(prompt.draftTranslations, draftTranslations); assert.equal(prompt.issues, issues);
  assert.deepEqual(prompt.contextBefore, []); assert.deepEqual(prompt.contextAfter, []);
});

test("glossary tool preserves the original term and transaction-before-embedding precedence", () => {
  assert.deepEqual(glossaryQuery(" Transaction embedding "), { term: " Transaction embedding ", translation: "事务", context: "approved" });
  assert.deepEqual(glossaryQuery("EMBEDDING"), { term: "EMBEDDING", translation: "嵌入", context: "approved" });
  assert.deepEqual(glossaryQuery(""), { term: "", translation: null, context: "unmatched" });
});

test("structure tool reports original empty-array and whitespace semantics", () => {
  for (const mappings of [[], [{ cue_id: "c0", translation: "译" }]]) {
    assert.deepEqual(mappingStructure(mappings), { valid: true, count: mappings.length });
  }
  for (const mappings of [[{ cue_id: "", translation: "译" }], [{ cue_id: "c0", translation: "" }], [{ cue_id: "c0", translation: "  " }]]) {
    assert.deepEqual(mappingStructure(mappings), { valid: false, count: 1 });
  }
});
