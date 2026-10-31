import { defineDoc } from "@earendil-works/pi-durable";
import type { JobDocument } from "./domain-types.js";

/** Durable state shared by the translation team and its delivery adapters. */
export const SubtitleJobDoc = defineDoc<JobDocument>({
  kind: "youtube.subtitle_job",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    job_key: "", video_id: "", from_lang: "en", to_lang: "zh-CN",
    status: "pending", stage: "editing", source_cues: [], published_cues: {},
    failed_cues: [], network_attempts: 0, budget_limit: 0,
    cancelled: false, final_result: null,
  }),
});
