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
  // Comma-separated and numbered lists are common in model-written briefs.
  const trading = [{ term: "MA", targets: ["均线"] }, { term: "long", targets: ["做多"] }];
  assert.deepEqual(briefGlossary("MA = 均线, long = 做多"), trading);
  assert.deepEqual(briefGlossary("1. MA = 均线\n2. long = 做多"), trading);
});

test("checklist flags missing cues, lost numbers, untranslated copies, length outliers and brief term violations", () => {
  const draft = {
    a: "交易失败了。", // wrong term and the count 3 was dropped
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

test("checklist accepts spelled-out and scaled numbers, and does not flag whole-word false positives", () => {
  const spoken = [
    { cue_id: "n1", start: 0, end: 900, text: "It's 100% you got it." },
    { cue_id: "n2", start: 1000, end: 1900, text: "they're buying at 11:00 and selling at 12:00." },
    { cue_id: "n3", start: 2000, end: 2900, text: "mid20s at the time and I had $15,000." },
    { cue_id: "n4", start: 3000, end: 3900, text: "I think I'm right eight out of 10 times." },
    { cue_id: "n5", start: 4000, end: 4900, text: "The market was strong but the longer trend held." },
    { cue_id: "n6", start: 5000, end: 5900, text: "I keep a long position and a long-term view." },
  ];
  const draft = {
    n1: "百分之百，你说对了。", n2: "11点买进、12点卖出。", n3: "那时二十五六岁，手里有1.5万美元。",
    n4: "我觉得十次里能对八次。", n5: "市场很强，但更长期的趋势守住了。", n6: "我做多，而且看长期。",
  };
  const report = reviewChecklist(input({ cues: spoken }), { draft, revision: 1 }, "long = 做多", [{ start_id: "n1" }]);
  assert.deepEqual(report.issue_counts, { missing: 0, numbers: 0, untranslated: 0, length: 0, glossary: 0 });
  assert.deepEqual(report.flagged, []);
  // A real omission is still caught.
  const omitted = reviewChecklist(input({ cues: spoken }), { draft: { ...draft, n4: "我觉得我常常是对的。" }, revision: 1 }, "long = 做多", []);
  assert.equal(omitted.issue_counts.numbers, 1);
  assert.match(omitted.flagged[0].issues.join(" | "), /numbers not found in translation: 10/);
});

test("number equivalence does not hide changed values", () => {
  const rows = [
    { cue_id: "x1", start: 0, end: 900, text: "It costs 2.5 dollars." },
    { cue_id: "x2", start: 1000, end: 1900, text: "We have 25 users." },
    { cue_id: "x3", start: 2000, end: 2900, text: "It started in 2019." },
    { cue_id: "x4", start: 3000, end: 3900, text: "Buy at 11:30 sharp." },
  ];
  const report = reviewChecklist(input({ cues: rows }), { draft: { x1: "售价2美元。", x2: "我们有二十个用户。", x3: "始于二〇一九年。", x4: "11点半买入。" }, revision: 1 }, "", []);
  assert.deepEqual(report.flagged.map(f => f.cue_id), ["x1", "x2"]);
});

test("glossary skips numeric commas and keep-as-is quirks that only produce noise", () => {
  assert.deepEqual(briefGlossary("$15,000 = 1.5万美元; socks = SOXX; station analysis = stage analysis; get a course = get a course"), [
    { term: "socks", targets: ["SOXX"] }, { term: "station analysis", targets: ["stage analysis"] },
  ]);
});

test("checklist stays within its context share and reports truncation", () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ cue_id: `m${i}`, start: i * 1000, end: i * 1000 + 900, text: `Value ${i} is important for the transaction log.` }));
  const config = modelConfig({ contextTokens: 24000, outputTokens: 1024 });
  const report = reviewChecklist(input({ cues: many, config }), { draft: {}, revision: 1 }, "transaction=事务", many.filter((_, i) => i % 200 === 0).map(c => ({ start_id: c.cue_id })));
  assert.equal(report.flagged_total, 2000); assert.equal(report.truncated, true);
  assert.ok(tokenEstimate(report) <= inputBudget(config) * 0.15);
  assert.equal(report.issue_counts.missing, 2000, "counts cover every cue even when the list is truncated");
});
