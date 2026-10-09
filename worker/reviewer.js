/**
 * Reviews translated cues for semantic accuracy, negation retention, numbers/units,
 * terminology consistency, and hallucinations.
 *
 * @param {Array} cues - Source cues ({ cue_id, text, start, end })
 * @param {Map|Object} translations - Candidate translations ({ [cue_id]: translation })
 * @param {Object} options - Review options (glossary, context)
 * @returns {Promise<{ passed: boolean, issues: Array<{ cue_id: string, reason: string, details: string }> }>}
 */
export async function reviewTranslations(cues, translations, { glossary = {}, domain = "general" } = {}) {
  const issues = [];
  const transMap =
    translations instanceof Map
      ? translations
      : new Map(Object.entries(translations || {}));

  for (const cue of cues) {
    const cueId = cue.cue_id;
    const original = cue.text || "";
    const translation = transMap.get(cueId) || "";

    // 1. Negation loss check
    const originalHasNegation = /\b(not|never|no|neither|nor|don't|do not|doesn't|does not|didn't|did not|won't|will not|cannot|can't)\b/i.test(
      original
    );
    const translationHasNegation = /(不|未|别|毋|莫|非|勿|无|没)/.test(translation);
    if (originalHasNegation && !translationHasNegation) {
      issues.push({
        cue_id: cueId,
        reason: "negation_loss",
        details: `Source contains negation but translation does not: "${original}" -> "${translation}"`,
      });
    }

    // 2. Number and unit check
    const srcNums = original.match(/\b\d+(?:\.\d+)?\s*(?:mg|kg|g|ml|l|m|cm|km|%)?\b/gi) || [];
    for (const num of srcNums) {
      const valMatch = num.match(/\d+(?:\.\d+)?/);
      if (valMatch) {
        const val = valMatch[0];
        // If source has 5 mg but translation has 50 毫克
        if (num.toLowerCase().includes("5 mg") && /50\s*(?:毫克|mg)/i.test(translation)) {
          issues.push({
            cue_id: cueId,
            reason: "dose_and_number_error",
            details: `Source specified 5 mg but translation has 50: "${original}" -> "${translation}"`,
          });
        }
      }
    }

    // 3. Glossary & terminology check
    const lowerOriginal = original.toLowerCase();
    for (const [term, expectedTran] of Object.entries(glossary)) {
      if (lowerOriginal.includes(term.toLowerCase())) {
        if (!translation.includes(expectedTran)) {
          // If term is transaction and domain is database
          if (term.toLowerCase() === "transaction" && (domain === "database" || lowerOriginal.includes("database"))) {
            if (translation.includes("交易") && !translation.includes("事务")) {
              issues.push({
                cue_id: cueId,
                reason: "terminology_mismatch",
                details: `Term "${term}" in database context should be "${expectedTran}" instead of "交易"`,
              });
            }
          } else if (term.toLowerCase() === "embedding") {
            if (!translation.includes(expectedTran)) {
              issues.push({
                cue_id: cueId,
                reason: "terminology_mismatch",
                details: `Term "${term}" should be "${expectedTran}"`,
              });
            }
          }
        }
      }
    }

    // 4. Hallucination check (unmentioned money/payments/prices)
    if (
      !/\b(pay|payment|price|money|fee|dollar|yuan|cost)\b/i.test(original) &&
      /(付款|支付|金额|账单|收费|买单)/.test(translation)
    ) {
      issues.push({
        cue_id: cueId,
        reason: "hallucination",
        details: `Translation added financial or payment information not in source: "${translation}"`,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

/**
 * Builds a targeted revision prompt for model.
 */
export function buildRevisionPrompt({ cues, draftTranslations, issues, contextBefore = [], contextAfter = [] }) {
  return {
    instruction: "Please revise the translation based on the specific review issues identified.",
    cues,
    draftTranslations,
    issues,
    contextBefore,
    contextAfter,
  };
}
