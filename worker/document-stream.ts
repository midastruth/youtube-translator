import { setTimeout as delay } from "node:timers/promises";
import type { JobDocument, JobRecord, StreamEvent } from "./types.js";

/** Observe committed state, not transient events: reconnects and task completion cannot race. */
export async function* observeDocumentJob(job: JobRecord, snapshot: () => Promise<JobDocument | undefined | null>, {
  heartbeatIntervalMs = 5000, signal = null,
}: { heartbeatIntervalMs?: number; signal?: AbortSignal | null } = {}): AsyncGenerator<StreamEvent> {
  const first = await snapshot();
  if (!first) { yield { type: "error", detail: "Document job state missing" }; return; }
  yield { type: "meta", video_id: job.videoId, title: job.title, from_lang: job.fromLang, to_lang: job.toLang,
    total_cues: job.cues.length, completed_cues: Object.keys(first.published_cues).length };
  for (let index = 0; index < job.cues.length; index++) yield { type: "source_cue", index, ...job.cues[index] };
  let doc: JobDocument | undefined | null = first;
  let stage = "";
  while (!signal?.aborted) {
    if (!doc) { yield { type: "error", detail: "Document job state missing" }; return; }
    if (doc.status === "cancelled") { yield { type: "error", code: "task_cancelled", detail: "全文翻译任务已取消" }; return; }
    if (doc.status === "failed" || job.error) {
      yield { type: "error", code: "document_translation_failed", detail: doc.error || "全文翻译失败；未降级为逐句翻译" }; return;
    }
    if (doc.status === "succeeded" && doc.final_result) {
      for (const cue of doc.final_result.cues) yield { type: "cue", ...cue, cached: first.status === "succeeded" };
      yield { type: "done", total_cues: job.cues.length, failed_cues: 0 }; return;
    }
    const current = `${doc.stage}:${doc.progress || ""}`;
    if (current !== stage) { stage = current; yield { type: "progress", stage: doc.stage, progress: doc.progress }; }
    else yield { type: "keepalive" };
    try { await delay(Math.min(1000, heartbeatIntervalMs), undefined, { signal: signal || undefined }); }
    catch { return; }
    doc = await snapshot();
  }
}
