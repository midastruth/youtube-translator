import { setTimeout as delay } from "node:timers/promises";
import type { JobDocument, JobRecord, StreamEvent } from "./types.js";

/** Observe committed state, not transient events: reconnects and task completion cannot race. */
export async function* observeDocumentJob(job: JobRecord, snapshot: () => Promise<JobDocument | undefined | null>, {
  heartbeatIntervalMs = 5000, signal = null,
}: { heartbeatIntervalMs?: number; signal?: AbortSignal | null } = {}): AsyncGenerator<StreamEvent> {
  const first = await snapshot();
  if (!first) { yield { type: "error", detail: "Document job state missing" }; return; }
  yield { type: "meta", video_id: job.videoId, title: job.title, from_lang: job.fromLang, to_lang: job.toLang,
    total_cues: job.cues.length, completed_cues: Object.keys(first.status === "succeeded" ? first.published_cues : first.preview_cues || {}).length };
  for (let index = 0; index < job.cues.length; index++) yield { type: "source_cue", index, ...job.cues[index] };
  const sent = new Map<string, string>();
  let doc: JobDocument | undefined | null = first;
  let stage = "";
  while (!signal?.aborted) {
    if (!doc) { yield { type: "error", detail: "Document job state missing" }; return; }
    if (doc.status === "cancelled") { yield { type: "error", code: "task_cancelled", detail: "全文翻译任务已取消" }; return; }
    if (doc.status === "succeeded" && doc.final_result) {
      // Always resend final cues, including the opening: the main agent may have
      // corrected it. Stable indices replace previews rather than append them.
      for (const cue of doc.final_result.cues) yield { type: "cue", ...cue, provisional: false, cached: first.status === "succeeded" };
      yield { type: "done", total_cues: job.cues.length, failed_cues: 0 }; return;
    }
    for (let index = 0; index < job.cues.length; index++) {
      const cue = doc.preview_cues?.[job.cues[index].cue_id];
      if (cue && sent.get(cue.cue_id) !== cue.translation) {
        sent.set(cue.cue_id, cue.translation);
        yield { type: "cue", ...cue, index, provisional: true, cached: !!first.preview_cues?.[cue.cue_id] };
      }
    }
    if (doc.status === "failed" || job.error) {
      yield { type: "error", code: "document_translation_failed", detail: doc.error || "全文翻译失败；已显示的开头仍为待统一审校版本，可重新开启续翻" }; return;
    }
    const current = `${doc.stage}:${doc.progress || ""}`;
    if (current !== stage) { stage = current; yield { type: "progress", stage: doc.stage, progress: doc.progress }; }
    else yield { type: "keepalive" };
    try { await delay(Math.min(1000, heartbeatIntervalMs), undefined, { signal: signal || undefined }); }
    catch { return; }
    doc = await snapshot();
  }
}
