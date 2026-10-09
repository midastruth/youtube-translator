import type { SourceCue, PublishedCue } from "./types.js";

export type ValidationResult = {
  valid: boolean; errors: string[]; mappings?: Map<string, string>; orderedCues?: PublishedCue[];
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Strictly validates candidate model output against expected cues.
 *
 * @param {Array} expectedCues - Array of expected cue objects ({ cue_id, start, end, text })
 * @param {unknown} candidate - Model output (string or object)
 * @returns {{ valid: boolean, errors: string[], mappings?: Map<string, string>, orderedCues?: Array }}
 */
export function validateOutputMapping(expectedCues: SourceCue[], candidate: unknown): ValidationResult {
  const errors = [];
  const expectedCueIds = new Set(expectedCues.map((c) => c.cue_id));

  if (!candidate) {
    return {
      valid: false,
      errors: ["Output is empty or null"],
    };
  }

  let parsed: unknown = null;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    // Check for explanation-only or non-structured output
    if (
      trimmed.startsWith("Here is the translation") ||
      trimmed.startsWith("Below is the translation") ||
      trimmed.startsWith("I cannot translate") ||
      trimmed.startsWith("This is an explanation")
    ) {
      if (!trimmed.includes("{") && !trimmed.includes("[")) {
        return {
          valid: false,
          errors: ["Non-structured explanation-only output"],
        };
      }
    }

    // Try extracting JSON from code fence or plain JSON
    let jsonStr = trimmed;
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        valid: false,
        errors: ["Cannot parse structured JSON output"],
      };
    }
  } else if (typeof candidate === "object") {
    parsed = candidate;
  } else {
    return {
      valid: false,
      errors: ["Invalid candidate output type"],
    };
  }

  // Normalize parsed into an array of { cue_id, translation }
  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (isRecord(parsed)) {
    if (Array.isArray(parsed.translations)) {
      items = parsed.translations;
    } else if (Array.isArray(parsed.cues)) {
      items = parsed.cues;
    } else {
      // Map format { [cue_id]: translation }
      items = Object.entries(parsed).map(([k, v]) => ({
        cue_id: k,
        translation: isRecord(v) ? v.translation : String(v),
      }));
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    return {
      valid: false,
      errors: ["Parsed output contains no cue translations"],
    };
  }

  const seenIds = new Set<string>();
  const mappings = new Map<string, string>();

  for (const item of items) {
    if (!isRecord(item)) {
      errors.push("Translation item is not an object");
      continue;
    }

    const cueId = item.cue_id || item.id;
    const translation = item.translation ?? item.text;

    if (typeof cueId !== "string" || !cueId) {
      errors.push("Item is missing cue_id");
      continue;
    }

    if (!expectedCueIds.has(cueId)) {
      errors.push(`Non-existent cue_id returned: ${cueId}`);
      continue;
    }

    if (seenIds.has(cueId)) {
      errors.push(`Duplicate cue_id returned: ${cueId}`);
      continue;
    }
    seenIds.add(cueId);

    if (typeof translation !== "string") {
      errors.push(`Translation for ${cueId} is not a string`);
      continue;
    }

    const trimmedTran = translation.trim();
    if (!trimmedTran) {
      errors.push(`Translation for ${cueId} is empty or whitespace only`);
      continue;
    }

    if (
      trimmedTran === "[Translation failed]" ||
      trimmedTran === "Translation failed" ||
      trimmedTran.toLowerCase().includes("[translation failed]")
    ) {
      errors.push(`Translation for ${cueId} contains Translation failed placeholder`);
      continue;
    }

    mappings.set(cueId, trimmedTran);
  }

  // Check for missing expected cues
  for (const expId of expectedCueIds) {
    if (!seenIds.has(expId)) {
      errors.push(`Missing translation for required cue: ${expId}`);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  // Reorder strictly according to expectedCues order, preserving exact timestamps in milliseconds
  const orderedCues = expectedCues.map((c) => ({
    ...c,
    translation: mappings.get(c.cue_id)!,
  }));

  return {
    valid: true,
    errors: [],
    mappings,
    orderedCues,
  };
}
