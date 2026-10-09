import crypto from "node:crypto";
import type { InputCue } from "./domain-types.js";

export type JobKeyOptions = {
  videoId?: string; sourceCues?: InputCue[]; fromLang?: string; toLang?: string;
  segmentationVersion?: string; engine?: string; provider?: string; baseUrl?: string; model?: string;
  promptVersion?: string; reviewVersion?: string; workflowVersion?: string; glossaryVersion?: string; styleConfig?: string;
};

export const DEFAULT_VERSIONS = {
  workflow_version: "wf-v1",
  segmentation_version: "segment-v1",
  prompt_version: "prompt-v1",
  review_version: "review-v1",
  glossary_version: "glossary-v1",
  style_config: "standard",
};

function sortObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Calculates a deterministic job key covering all 9 contract dimensions:
 * 1. source_cues (cue_id, start, end in ms, text) & timeline
 * 2. from_lang & to_lang
 * 3. segmentation_version
 * 4. engine ("agent")
 * 5. provider & base_url & model
 * 6. prompt_version & review_version
 * 7. workflow_version
 * 8. glossary_version
 * 9. style_config
 */
export function calculateJobKey({
  videoId = "",
  sourceCues = [],
  fromLang = "en",
  toLang = "zh-CN",
  segmentationVersion = DEFAULT_VERSIONS.segmentation_version,
  engine = "agent",
  provider = "openai",
  baseUrl = "https://api.openai.com/v1",
  model = "gpt-4o",
  promptVersion = DEFAULT_VERSIONS.prompt_version,
  reviewVersion = DEFAULT_VERSIONS.review_version,
  workflowVersion = DEFAULT_VERSIONS.workflow_version,
  glossaryVersion = DEFAULT_VERSIONS.glossary_version,
  styleConfig = DEFAULT_VERSIONS.style_config,
}: JobKeyOptions = {}) {
  const normalizedCues = (sourceCues || []).map((cue, index) => ({
    cue_id: cue.cue_id || `c${index}`,
    start: Number(cue.start),
    end: Number(cue.end),
    text: String(cue.text || ""),
  }));

  const payload = {
    video_id: String(videoId || ""),
    from_lang: String(fromLang || "").toLowerCase(),
    to_lang: String(toLang || "").toLowerCase(),
    source_cues: normalizedCues,
    segmentation_version: String(segmentationVersion),
    engine: String(engine),
    provider_endpoint: {
      provider: String(provider).toLowerCase().trim(),
      base_url: String(baseUrl || "").trim().replace(/\/+$/, ""),
      model: String(model || "").trim(),
    },
    prompt_version: String(promptVersion),
    review_version: String(reviewVersion),
    workflow_version: String(workflowVersion),
    glossary_version: String(glossaryVersion),
    style_config: String(styleConfig),
  };

  const serialized = JSON.stringify(sortObject(payload));
  const hash = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  return `job:${payload.video_id || "video"}:${hash}`;
}
