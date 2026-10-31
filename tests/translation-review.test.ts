import assert from "node:assert/strict";
import { test } from "node:test";
import { inputBudget, modelConfig, tokenEstimate } from "../worker/document-translation.js";
import type { DocumentInput } from "../worker/document-translation.js";
import { briefGlossary, MAX_BILINGUAL_CUES, readBilingual, reviewChecklist } from "../worker/translation-review.js";

const cues = [
  { cue_id: "a", start: 0, end: 900, text: "The transaction failed 3 times." },
  { cue_id: "b", start: 1000, end: 1900, text: "Rollback restores the previous state." },
  { cue_id: "c", start: 2000, end: 2900, text: "We will not lose 1,500 records here." },
  { cue_id: "d", start: 3000, end: 3900, text: "This is a long sentence that explains the commit protocol in detail." },
  { cue_id: "e", start: 4000, end: 4900, text: "Commits are durable once acknowledged." },
];
function input(over: Partial<DocumentInput> = {}): DocumentInput {
  return { jobId: "r", jobKey: "r", videoId: "v", title: "t", fromLang: "en", toLang: "zh-CN", cues, config: modelConfig(), budgetLimit: 0, ...over };
}

test("bilingual reader pairs source with translation compactly, requires a count and paginates", () => {
  const draft = { a: "事务失败了 3 次。", c: "这里不会丢失 1500 条记录。" };
  const page = readBilingual(input(), { draft }, { offset: 0, count: 3 });
  assert.deepEqual(page.rows, [["a", cues[0].text, draft.a], ["b", cues[1].text, null], ["c", cues[2].text, draft.c]]);
  assert.equal(page.next_offset, 3); assert.equal(page.total_cues, 5);
  assert.doesNotMatch(JSON.stringify(page), /"start"|"end"|\n/, "no timing fields or indentation");
  assert.equal(readBilingual(input(), { draft }, { offset: 3, count: MAX_BILINGUAL_CUES }).next_offset, null);
  assert.deepEqual(readBilingual(input(), { draft }, { offset: 9, count: 1 }).rows, []);
  for (const args of [{}, { count: 0 }, { count: MAX_BILINGUAL_CUES + 1 }, { count: 1, offset: -1 }]) assert.throws(() => readBilingual(input(), { draft }, args));
});

test("bilingual pages shrink to a quarter of the input budget and are denser than separate reads", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ cue_id: `m${i}`, start: i * 1000, end: i * 1000 + 900, text: "word ".repeat(40).trim() }));
  const config = modelConfig({ contextTokens: 24000, outputTokens: 1024 });
  const page = readBilingual(input({ cues: many, config }), { draft: {} }, { count: MAX_BILINGUAL_CUES });
  assert.ok(page.rows.length > 0 && page.rows.length < 400);
  assert.ok(tokenEstimate(page.rows) <= inputBudget(config) * 0.25);
  assert.equal(page.next_offset, page.rows.length);
  // Same cues with translations: one compact page vs pretty-printed source+translation pages.
  const draft = Object.fromEntries(cues.map(c => [c.cue_id, `译文 ${c.cue_id}`]));
  const compact = tokenEstimate(readBilingual(input(), { draft }, { count: 5 }).rows);
  const separate = tokenEstimate(JSON.stringify(cues, null, 2)) + tokenEstimate(JSON.stringify(draft, null, 2));
  assert.ok(compact < separate * 0.75, `${compact} vs ${separate}`);
});

test("brief glossary parses explicit term decisions in common notations", () => {
  assert.deepEqual(briefGlossary("Style: concise.\ntransaction = 事务; rollback -> 回滚 / 回退\n- commit → 提交, preserve numbers."), [
    { term: "transaction", targets: ["事务"] }, { term: "rollback", targets: ["回滚", "回退"] }, { term: "commit", targets: ["提交"] },
  ]);
  assert.deepEqual(briefGlossary("No term decisions here."), []);
});

test("checklist flags missing cues, lost numbers, untranslated copies, length outliers and brief term violations", () => {
  const draft = {
    a: "交易失败了三次。", // wrong term and number dropped
    c: "这里不会丢失 1500 条记录。", // comma-formatted number is matched
    d: "This is a long sentence that explains the commit protocol in detail.", // copied source
    e: "已确认的提交是持久的。".repeat(12), // length outlier (e.g. repeated or merged text)
  };
  const report = reviewChecklist(input(), { draft, revision: 7 }, "transaction=事务; rollback=回滚; commit=提交", [{ start_id: "a" }, { start_id: "c" }]);
  const flags = Object.fromEntries(report.flagged.map(f => [f.cue_id, f.issues.join(" | ")]));
  assert.match(flags.a, /numbers not found.*3/); assert.match(flags.a, /"transaction" expected "事务"/);
  assert.equal(flags.b, "missing translation");
  assert.equal(flags.c, undefined, "a correct cue is not flagged");
  assert.match(flags.d, /identical to source/); assert.match(flags.d, /"commit" expected "提交"/);
  assert.match(flags.e, /length ratio/);
  assert.deepEqual(report.issue_counts, { missing: 1, numbers: 1, untranslated: 1, length: 1, glossary: 2 });
  assert.equal(report.revision, 7); assert.equal(report.translated_cues, 4);
  assert.deepEqual(report.boundaries, [{ offset: 0, rows: [["a", cues[0].text, draft.a], ["b", cues[1].text, null], ["c", cues[2].text, draft.c], ["d", cues[3].text, draft.d], ["e", cues[4].text, draft.e]] }]);
});

test("checklist stays within its context share and reports truncation", () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ cue_id: `m${i}`, start: i * 1000, end: i * 1000 + 900, text: `Value ${i} is important for the transaction log.` }));
  const config = modelConfig({ contextTokens: 24000, outputTokens: 1024 });
  const report = reviewChecklist(input({ cues: many, config }), { draft: {}, revision: 1 }, "transaction=事务", many.filter((_, i) => i % 200 === 0).map(c => ({ start_id: c.cue_id })));
  assert.equal(report.flagged_total, 2000); assert.equal(report.truncated, true);
  assert.ok(tokenEstimate(report) <= inputBudget(config) * 0.15);
  assert.equal(report.issue_counts.missing, 2000, "counts cover every cue even when the list is truncated");
});
