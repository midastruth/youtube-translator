import type { SourceCue, PublishedCue } from "./types.js";

export type ValidationResult = {
  valid: boolean; errors: string[]; mappings?: Map<string, string>; orderedCues?: PublishedCue[];
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Lightweight schema check used by the validate_structure tool (no expected cue set). */
export function mappingStructure(mappings: { cue_id: string; translation: string }[]) {
  return {
    valid: mappings.every(m => m.cue_id && m.translation && m.translation.trim().length > 0),
    count: mappings.length,
  };
}

type ParsedOutput = { parsed: unknown; error?: never } | { error: string; parsed?: never };

function isExplanationOnly(text: string) {
  const explanation = ["Here is the translation", "Below is the translation", "I cannot translate", "This is an explanation"]
    .some(prefix => text.startsWith(prefix));
  return explanation && !text.includes("{") && !text.includes("[");
}

function parseCandidate(candidate: unknown): ParsedOutput {
  if (!candidate) return { error: "Output is empty or null" };
  if (typeof candidate === "object") return { parsed: candidate };
  if (typeof candidate !== "string") return { error: "Invalid candidate output type" };
  const trimmed = candidate.trim();
  if (isExplanationOnly(trimmed)) return { error: "Non-structured explanation-only output" };
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  try {
    return { parsed: JSON.parse(fence ? fence[1].trim() : trimmed) };
  } catch {
    return { error: "Cannot parse structured JSON output" };
  }
}

function translationItems(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.translations)) return parsed.translations;
  if (Array.isArray(parsed.cues)) return parsed.cues;
  return Object.entries(parsed).map(([cue_id, value]) => ({
    cue_id, translation: isRecord(value) ? value.translation : String(value),
  }));
}

function translationError(cueId: string, translation: unknown) {
  if (typeof translation !== "string") return `Translation for ${cueId} is not a string`;
  const trimmed = translation.trim();
  if (!trimmed) return `Translation for ${cueId} is empty or whitespace only`;
  if (trimmed === "[Translation failed]" || trimmed === "Translation failed" || trimmed.toLowerCase().includes("[translation failed]")) {
    return `Translation for ${cueId} contains Translation failed placeholder`;
  }
  return null;
}

function collectMapping(item: unknown, expected: Set<string>, seen: Set<string>, mappings: Map<string, string>): string | null {
  if (!isRecord(item)) return "Translation item is not an object";
  const cueId = item.cue_id || item.id;
  if (typeof cueId !== "string" || !cueId) return "Item is missing cue_id";
  if (!expected.has(cueId)) return `Non-existent cue_id returned: ${cueId}`;
  if (seen.has(cueId)) return `Duplicate cue_id returned: ${cueId}`;
  // A present-but-invalid translation is not also reported as missing.
  seen.add(cueId);
  const translation = item.translation ?? item.text;
  const error = translationError(cueId, translation);
  if (error) return error;
  mappings.set(cueId, (translation as string).trim());
  return null;
}

/** Validates all cue identities and translations before publishing in exact source order. */
export function validateOutputMapping(expectedCues: SourceCue[], candidate: unknown): ValidationResult {
  const output = parseCandidate(candidate);
  if (output.error !== undefined) return { valid: false, errors: [output.error] };
  const items = translationItems(output.parsed);
  if (items.length === 0) return { valid: false, errors: ["Parsed output contains no cue translations"] };

  const expected = new Set(expectedCues.map(cue => cue.cue_id));
  const seen = new Set<string>();
  const mappings = new Map<string, string>();
  const errors: string[] = [];
  for (const item of items) {
    const error = collectMapping(item, expected, seen, mappings);
    if (error) errors.push(error);
  }
  for (const cueId of expected) {
    if (!seen.has(cueId)) errors.push(`Missing translation for required cue: ${cueId}`);
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true, errors: [], mappings,
    orderedCues: expectedCues.map(cue => ({ ...cue, translation: mappings.get(cue.cue_id)! })),
  };
}
