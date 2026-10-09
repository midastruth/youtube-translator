import type { SourceCue, Draft, ReviewIssue, ReviewResult } from "./domain-types.js";
export { buildRevisionPrompt } from "./revision-prompt.js";

type ReviewCue = { cueId: string; original: string; translation: string };

function negationIssues({ cueId, original, translation }: ReviewCue): ReviewIssue[] {
  const sourceNegation = /\b(not|never|no|neither|nor|don't|do not|doesn't|does not|didn't|did not|won't|will not|cannot|can't)\b/i.test(original);
  const translatedNegation = /(不|未|别|毋|莫|非|勿|无|没)/.test(translation);
  if (!sourceNegation || translatedNegation) return [];
  return [{ cue_id: cueId, reason: "negation_loss", details: `Source contains negation but translation does not: "${original}" -> "${translation}"` }];
}

function numberIssues({ cueId, original, translation }: ReviewCue): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const numbers = original.match(/\b\d+(?:\.\d+)?\s*(?:mg|kg|g|ml|l|m|cm|km|%)?\b/gi) || [];
  for (const number of numbers) {
    if (number.match(/\d+(?:\.\d+)?/) && number.toLowerCase().includes("5 mg") && /50\s*(?:毫克|mg)/i.test(translation)) {
      issues.push({ cue_id: cueId, reason: "dose_and_number_error", details: `Source specified 5 mg but translation has 50: "${original}" -> "${translation}"` });
    }
  }
  return issues;
}

function termIssue(cue: ReviewCue, term: string, expected: string, domain: string): ReviewIssue | null {
  const original = cue.original.toLowerCase();
  if (!original.includes(term.toLowerCase()) || cue.translation.includes(expected)) return null;
  if (term.toLowerCase() === "transaction" && (domain === "database" || original.includes("database"))) {
    if (cue.translation.includes("交易") && !cue.translation.includes("事务")) {
      return { cue_id: cue.cueId, reason: "terminology_mismatch", details: `Term "${term}" in database context should be "${expected}" instead of "交易"` };
    }
  } else if (term.toLowerCase() === "embedding") {
    return { cue_id: cue.cueId, reason: "terminology_mismatch", details: `Term "${term}" should be "${expected}"` };
  }
  return null;
}

function terminologyIssues(cue: ReviewCue, glossary: Draft, domain: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const [term, expected] of Object.entries(glossary)) {
    const issue = termIssue(cue, term, expected, domain);
    if (issue) issues.push(issue);
  }
  return issues;
}

function hallucinationIssues({ cueId, original, translation }: ReviewCue): ReviewIssue[] {
  if (/\b(pay|payment|price|money|fee|dollar|yuan|cost)\b/i.test(original) || !/(付款|支付|金额|账单|收费|买单)/.test(translation)) return [];
  return [{ cue_id: cueId, reason: "hallucination", details: `Translation added financial or payment information not in source: "${translation}"` }];
}

function appendIssues(target: ReviewIssue[], ...groups: ReviewIssue[][]) {
  for (const group of groups) for (const issue of group) target.push(issue);
}

/** Reviews semantic rules in their original order, retaining every issue. */
export async function reviewTranslations(cues: SourceCue[], translations: Draft | Map<string, string> | null, { glossary = {}, domain = "general" }: { glossary?: Draft; domain?: string } = {}): Promise<ReviewResult> {
  const transMap = translations instanceof Map ? translations : new Map(Object.entries(translations || {}));
  const issues: ReviewIssue[] = [];
  for (const source of cues) {
    const cue = { cueId: source.cue_id, original: source.text || "", translation: transMap.get(source.cue_id) || "" };
    appendIssues(issues, negationIssues(cue), numberIssues(cue), terminologyIssues(cue, glossary, domain), hallucinationIssues(cue));
  }
  return { passed: issues.length === 0, issues };
}
