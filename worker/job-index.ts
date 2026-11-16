import { defineDoc } from "@earendil-works/pi-durable";

export type JobIndexEntry = { jobKey: string; jobId: string; videoId: string };

/** Committed atomically with each job. Presence also marks the one-time legacy backfill complete. */
export const JobIndexDoc = defineDoc<{ entries: Record<string, JobIndexEntry> }>({
  kind: "youtube.job_index", version: 1, scope: "session",
  initial: () => ({ entries: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});
