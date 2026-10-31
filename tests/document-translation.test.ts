// Compatibility coverage for pre-agent fixed-stage tasks still persisted in existing databases.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceDocument, chapterCues, documentTool, finalDocumentCues, initialDocumentState,
  inputBudget, modelConfig, outputBudget, outputEstimate, tokenEstimate, validateChapters,
} from "../worker/document-translation.js";
import type { DocumentInput, ModelRequest } from "../worker/document-translation.js";

const cues = [
  { cue_id: "a", start: 123, end: 1200, text: "The transaction was rejected." },
  { cue_id: "b", start: 1200, end: 2500, text: "By transaction, I mean a database transaction, not a payment." },
];
const note = { summary: "Database transactions, not financial payments; rejection refers to database failure.", glossary: [{ term: "transaction", meaning: "database operation", translation: "事务" }] };
function input(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return { jobId: "test", jobKey: "key", videoId: "video", title: "Transactions", fromLang: "en", toLang: "zh-CN",
    cues, config: modelConfig(), budgetLimit: 128, ...overrides };
}
function chapters(source: typeof cues, config = modelConfig()) {
  const result: { start_id: string; end_id: string; title: string }[] = [];
  let group: typeof cues = [];
  for (const cue of source) {
    if (group.length && (outputEstimate([...group, cue]) > outputBudget(config) ||
        tokenEstimate([...group, cue]) + outputEstimate([...group, cue]) > inputBudget(config) * 0.6)) {
      result.push({ start_id: group[0].cue_id, end_id: group.at(-1)!.cue_id, title: "Semantic topic" }); group = [];
    }
    group.push(cue);
  }
  if (group.length) result.push({ start_id: group[0].cue_id, end_id: group.at(-1)!.cue_id, title: "Semantic topic" });
  return result;
}
function result(request: ModelRequest, config = modelConfig()): unknown {
  const data = request.data as { source: typeof cues };
  switch (request.operation) {
    case "analyze": return { ...note, chapters: chapters(data.source, config) };
    case "brief": case "consolidate": case "audit_consolidate": case "final_audit_consolidate": return note;
    case "translate": return { ...note, translations: data.source.map(c => ({ cue_id: c.cue_id, translation: `数据库事务：${c.cue_id}` })) };
    case "audit": return { guidance: "Use 事务, not financial 交易; verify rejection refers to database operations." };
    case "review": return { ...note, passed: true, issues: [], corrections: [] };
    case "final_audit": return { passed: true, guidance: "All corrected translation choices are globally consistent." };
    default: throw new Error(`Unexpected operation ${request.operation}`);
  }
}
async function run(document: DocumentInput, call: (request: ModelRequest) => Promise<unknown>) {
  let state = initialDocumentState(document);
  for (let step = 0; step < 200 && state.stage !== "publish"; step++) state = await advanceDocument(document, state, call);
  assert.equal(state.stage, "publish"); return state;
}

test("v1 short document translates together and re-reviews semantic corrections", async () => {
  const document = input(); const calls: ModelRequest[] = []; let reviews = 0;
  const state = await run(document, async request => {
    calls.push(request);
    if (request.operation === "translate") return { ...note, translations: [{ cue_id: "a", translation: "这笔交易被拒绝了。" }, { cue_id: "b", translation: "这里指数据库事务，而非付款。" }] };
    if (request.operation === "review" && reviews++ === 0) {
      assert.match(JSON.stringify(request.data), /database transaction/);
      return { passed: false, issues: ["a uses the financial sense"], corrections: [{ cue_id: "a", translation: "该事务被拒绝了。" }] };
    }
    return result(request);
  });
  assert.equal(calls.filter(c => c.operation === "translate").length, 1);
  assert.equal(reviews, 2);
  assert.deepEqual(finalDocumentCues(document, state)[0], { ...cues[0], index: 0, translation: "该事务被拒绝了。" });
});

test("v1 post-revision audit can request consistency repair", async () => {
  let audits = 0, reviews = 0;
  const state = await run(input(), async request => {
    if (request.operation === "final_audit" && audits++ === 0) return { passed: false, guidance: "Use the database sense after revisions." };
    if (request.operation === "review" && reviews++ > 0) assert.match(JSON.stringify(request.data), /after revisions/);
    return result(request);
  });
  assert.equal(audits, 2); assert.equal(reviews, 2); assert.equal(state.auditRounds, 1);
});

test("v1 large output uses semantic chapters with shared global context", async () => {
  const config = modelConfig({ contextTokens: 12000, outputTokens: 512 });
  const source = Array.from({ length: 9 }, (_, i) => ({ cue_id: `c${i}`, start: i * 1000, end: i * 1000 + 900, text: `Topic ${i}. This is a database transaction.` }));
  const document = input({ cues: source, config }); const calls: ModelRequest[] = [];
  const state = await run(document, async request => { calls.push(request); return result(request, config); });
  const translations = calls.filter(c => c.operation === "translate");
  assert.ok(translations.length > 1);
  for (const request of translations) {
    const data = request.data as { global_context: unknown; full_source: unknown; source: typeof cues };
    assert.deepEqual(data.global_context, note); assert.deepEqual(data.full_source, source);
    assert.ok(outputEstimate(data.source) <= outputBudget(config));
  }
  assert.deepEqual(finalDocumentCues(document, state).map(c => c.cue_id), source.map(c => c.cue_id));
});

test("v1 reading windows consolidate hierarchically without losing source coverage", async () => {
  const config = modelConfig({ contextTokens: 10000, outputTokens: 512 });
  const source = Array.from({ length: 100 }, (_, i) => ({ cue_id: `x${i}`, start: i * 1000, end: i * 1000 + 900, text: "A complete sentence about transactions." }));
  const document = input({ cues: source, config });
  assert.ok(initialDocumentState(document).reads.length > 1);
  const calls: ModelRequest[] = [];
  const state = await run(document, async request => { calls.push(request); return result(request, config); });
  assert.ok(calls.some(c => c.operation === "audit_consolidate")); assert.equal(Object.keys(state.draft).length, source.length);
});

test("v1 plans and mappings reject missing, duplicate and unknown IDs", async () => {
  const document = input();
  for (const plan of [[], [{ start_id: "b", end_id: "b", title: "missing a" }], [
    { start_id: "a", end_id: "b", title: "all" }, { start_id: "a", end_id: "a", title: "duplicate" },
  ]]) assert.throws(() => validateChapters(cues, plan, document.config));
  let state = initialDocumentState(document);
  while (state.stage !== "translate") state = await advanceDocument(document, state, async request => result(request));
  for (const mappings of [[{ cue_id: "a", translation: "事务" }], [{ cue_id: "z", translation: "事务" }], [
    { cue_id: "a", translation: "事务" }, { cue_id: "a", translation: "事务" },
  ]]) await assert.rejects(advanceDocument(document, state, async () => ({ ...note, translations: mappings })));
  assert.throws(() => initialDocumentState(input({ cues: [cues[0], cues[0]] })));
  assert.throws(() => initialDocumentState(input({ cues: [{ ...cues[0], end: 0 }] })));
});

test("v1 retrieval remains read-only and finds distant context", () => {
  const document = input(), state = initialDocumentState(document);
  assert.deepEqual(documentTool(document, state, "read_transcript", { start_id: "b", count: 1 }), { source: [{ ...cues[1], translation: "" }], next_id: undefined });
  assert.equal((documentTool(document, state, "search_transcript", { query: "not a payment" }) as { total: number }).total, 1);
  assert.throws(() => documentTool(document, state, "bash", { command: "pwd" }));
  assert.deepEqual(chapterCues(cues, { start_id: "a", end_id: "b", title: "all" }), cues);
});
