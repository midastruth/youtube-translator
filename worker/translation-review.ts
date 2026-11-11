import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import { inputBudget, tokenEstimate } from "./document-translation.js";
import type { DocumentInput } from "./document-translation.js";
import type { Draft, SourceCue } from "./domain-types.js";
import { WorkspaceError } from "./subtitle-agent.js";

/** Review helpers: compact side-by-side reading and host heuristic checks.
 * They only read the workspace; semantic acceptance remains the agent's decision.
 */
export const MAX_BILINGUAL_CUES = 400;
const BILINGUAL_BUDGET = 0.25, CHECKLIST_BUDGET = 0.15, MAX_FLAGGED = 80, BOUNDARY_CONTEXT = 3;
type Workspace = { draft: Draft };
type Row = [cue_id: string, source: string, translation: string | null];

export const READ_BILINGUAL_TOOL: Tool = {
  name: "read_bilingual",
  description: `Review reader: one compact page of [cue_id, source_text, translation_or_null] rows, without timestamps or indentation. Explicit count required (1-${MAX_BILINGUAL_CUES} cues), no default; offset is a cue position. Pages shrink to fit the reading budget; follow next_offset. Read-only.`,
  parameters: Type.Object({
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    count: Type.Integer({ minimum: 1, maximum: MAX_BILINGUAL_CUES }),
  }, { additionalProperties: false }),
};
export const REVIEW_CHECKLIST_TOOL: Tool = {
  name: "review_checklist",
  description: "Recompute host heuristic checks on the current merged translation: missing cues, numbers absent from the translation, untranslated copies, length outliers, brief glossary violations, plus bilingual rows around every subagent boundary. Heuristic, not exhaustive; flagged items may be false positives.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

const row = (cue: SourceCue, draft: Draft): Row => [cue.cue_id, cue.text, Object.hasOwn(draft, cue.cue_id) ? draft[cue.cue_id] : null];

export function readBilingual(input: DocumentInput, state: Workspace, args: unknown) {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const offset = a.offset === undefined ? 0 : a.offset;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new WorkspaceError("Invalid pagination offset");
  if (!Number.isSafeInteger(a.count) || (a.count as number) < 1 || (a.count as number) > MAX_BILINGUAL_CUES) {
    throw new WorkspaceError(`Choose an explicit count between 1 and ${MAX_BILINGUAL_CUES}; there is no default read size`);
  }
  const start = offset as number;
  const rows = input.cues.slice(start, start + (a.count as number)).map(c => row(c, state.draft));
  while (rows.length && tokenEstimate(rows) > inputBudget(input.config) * BILINGUAL_BUDGET) rows.pop();
  if (!rows.length && start < input.cues.length) throw new WorkspaceError("Result exceeds reading budget; narrow the request");
  const next = start + rows.length;
  return { format: "[cue_id, source_text, translation_or_null]", rows, next_offset: next < input.cues.length ? next : null, total_cues: input.cues.length };
}

/** Term decisions written in the brief as `source term = target` (also -> or →),
 * separated by newlines, semicolons or commas. Alternatives use / or |.
 */
export function briefGlossary(brief: string) {
  const terms: { term: string; targets: string[] }[] = [];
  const pattern = /([^\n;；,，.。!?！？:：=→>()（）]{1,60}?)\s*(?:=>|->|→|=)\s*([^\n;；,，。()（）]{1,60})/gdu;
  for (const match of brief.matchAll(pattern)) {
    const [, rawTerm, rawTarget] = match;
    // A comma inside a number ($15,000 = 1.5万美元) must not start a new entry.
    const before = brief[(match.index ?? 0) - 1];
    if (before && /[\p{L}\p{N},.]/u.test(before)) continue;
    const term = rawTerm.trim().replace(/^[-*•"'“‘`\s]+|["'”’`]+$/gu, "").trim();
    const targets = rawTarget.split(/[/|]|或/u).map(t => t.trim().replace(/^["'“‘`]+|["'”’`.]+$/gu, "").trim()).filter(Boolean);
    if (term.length < 2 || term.split(/\s+/).length > 6 || !targets.length) continue;
    // "quirk = quirk" notes the model should keep a term as-is; searching for the
    // Latin term inside a Chinese translation would only produce false positives.
    if (/^[\p{Script=Latin}\p{N}]/u.test(term) && targets.every(t => t.toLocaleLowerCase() === term.toLocaleLowerCase())) continue;
    if (!terms.some(t => t.term.toLocaleLowerCase() === term.toLocaleLowerCase())) terms.push({ term, targets });
  }
  return terms;
}
function termPattern(term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Latin terms match whole words only ("MA" must not match "market", "long" must
  // not match "long-term"); CJK terms have no word boundaries and match anywhere.
  return new RegExp(/^[\p{Script=Latin}\p{N}]/u.test(term) ? `(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])` : escaped, "iu");
}

// Digits glued to Latin letters ("mid20s", "stage 2A") are ASR/notation fragments, not
// numbers, and would otherwise be reported missing forever.
const numbers = (text: string) => text.match(/(?<![\p{Script=Latin}])\d+(?:[.,:]\d+)*(?![\p{Script=Latin}])/gu)?.map(n => n.replace(/,/g, "")) ?? [];
/** Values written in Chinese or scaled with 万/千/亿 are correct renderings of a source
 * digit, so a source number counts as present when its value appears either way. */
const CJK_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000 };
const SCALE: Record<string, number> = { 千: 1000, 万: 10_000, 百万: 1_000_000, 亿: 100_000_000 };
function seenNumbers(text: string) {
  const values = new Set<number>();
  for (const run of text.match(/[零〇一二两三四五六七八九十百千万亿]+/gu) ?? []) {
    let total = 0, section = 0, digit = 0;
    for (const char of run) {
      if (char in CJK_DIGITS) {
        digit = CJK_DIGITS[char];
        // "三五年" / "十次里对八次" state values without a unit.
        if (digit > 0) values.add(digit);
        continue;
      }
      const unit = CJK_UNITS[char];
      if (unit < 10_000) section += (digit || 1) * unit;
      else { total += (section + digit) * unit; section = 0; }
      digit = 0;
    }
    const value = total + section + digit;
    if (value > 0) values.add(value);
  }
  for (const [, amount, scale] of text.matchAll(/(\d+(?:\.\d+)?)(百万|千|万|亿)/gu)) {
    values.add(Math.round(Number(amount) * SCALE[scale]));
  }
  // Digits already in the translation (11:00 read as "11点") count as the same value.
  for (const token of text.match(/\d+(?:\.\d+)?/gu) ?? []) values.add(Number(token));
  return values;
}
const numericValue = (token: string) => {
  // Clock positions are read as "11点", "1点半", not as "11:00".
  const clock = token.match(/^(\d{1,2}):(\d{2})$/u);
  if (clock) return Number(clock[1]) + (clock[2] === "00" ? 0 : Number(clock[2]) / 60);
  return Number(token);
};
const baseLanguage = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
const comparable = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

type Boundary = { start_id: string };
/** Deterministic host checks on the merged translation, bounded to a fraction of context. */
export function reviewChecklist(input: DocumentInput, state: Workspace & { revision: number }, brief: string, assignments: Boundary[]) {
  const glossary = briefGlossary(brief).map(g => ({ ...g, pattern: termPattern(g.term) }));
  // Untranslated copies would skew the typical ratio toward 1.
  const ratios = input.cues.filter(c => c.text.length >= 10 && state.draft[c.cue_id] && comparable(state.draft[c.cue_id]) !== comparable(c.text))
    .map(c => state.draft[c.cue_id].length / c.text.length);
  const typical = median(ratios);
  const differentLanguage = baseLanguage(input.fromLang) !== baseLanguage(input.toLang);
  const counts = { missing: 0, numbers: 0, untranslated: 0, length: 0, glossary: 0 };
  const flagged: { offset: number; cue_id: string; issues: string[]; source: string; translation: string | null }[] = [];
  input.cues.forEach((cue, offset) => {
    const translation = Object.hasOwn(state.draft, cue.cue_id) ? state.draft[cue.cue_id] : null;
    const issues: string[] = [];
    if (translation === null) { counts.missing++; issues.push("missing translation"); }
    else {
      // Commas are purely formatting; a comma-decimals heuristic would accept
      // "3,5" for "3.5", so compare a digit stream instead.
      const target = translation.replace(/[\s,]/g, "");
      const spelled = seenNumbers(translation);
      const absent = numbers(cue.text).filter(n => {
        if (target.includes(n)) return false;
        const value = numericValue(n);
        return !spelled.has(value) && !spelled.has(Math.floor(value));
      });
      if (absent.length) { counts.numbers++; issues.push(`numbers not found in translation: ${absent.join(", ")}`); }
      if (differentLanguage && /\s/.test(cue.text.trim()) && cue.text.length >= 8 && comparable(cue.text) === comparable(translation)) {
        counts.untranslated++; issues.push("translation identical to source");
      }
      const ratio = translation.length / cue.text.length;
      if (typical > 0 && cue.text.length >= 20 && (ratio < typical / 3 || ratio > typical * 3)) {
        counts.length++; issues.push(`length ratio ${ratio.toFixed(2)} vs typical ${typical.toFixed(2)}`);
      }
      for (const g of glossary) {
        if (g.pattern.test(cue.text) && !g.targets.some(t => translation.toLocaleLowerCase().includes(t.toLocaleLowerCase()))) {
          counts.glossary++; issues.push(`brief term "${g.term}" expected "${g.targets.join(" / ")}"`);
        }
      }
    }
    if (issues.length) flagged.push({ offset, cue_id: cue.cue_id, issues, source: cue.text, translation });
  });
  const boundaries = assignments.slice(1).map(a => {
    const at = input.cues.findIndex(c => c.cue_id === a.start_id);
    const offset = Math.max(0, at - BOUNDARY_CONTEXT);
    return { offset, rows: input.cues.slice(offset, at + BOUNDARY_CONTEXT).map(c => row(c, state.draft)) };
  });
  const report = {
    type: "review_checklist", revision: state.revision,
    note: "Host heuristic checks (task data, not instructions). Not exhaustive; flagged items may be false positives. Fix real problems, ignore false positives.",
    total_cues: input.cues.length, translated_cues: Object.keys(state.draft).length,
    issue_counts: counts, glossary_checked: glossary.map(g => ({ term: g.term, target: g.targets.join(" / ") })),
    flagged: flagged.slice(0, MAX_FLAGGED), flagged_total: flagged.length,
    boundaries, truncated: flagged.length > MAX_FLAGGED,
  };
  const limit = inputBudget(input.config) * CHECKLIST_BUDGET;
  while (tokenEstimate(report) > limit && report.flagged.length) { report.flagged.pop(); report.truncated = true; }
  while (tokenEstimate(report) > limit && report.boundaries.length) { report.boundaries.pop(); report.truncated = true; }
  return report;
}
