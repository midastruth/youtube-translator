import type { JobDocument, JobRecord, StreamEvent, PublishedCue } from "./types.js";

/** Replays committed cues, then observes live events without owning the job lifecycle. */
export async function* observeJobEvents(doc: JobDocument | null | undefined, job: JobRecord, {
  heartbeatIntervalMs = 5000, signal = null, sourceCueCount = job.cues.length,
}: { heartbeatIntervalMs?: number; signal?: AbortSignal | null; sourceCueCount?: number } = {}): AsyncGenerator<StreamEvent> {
  const total = sourceCueCount;
  const published = doc?.published_cues || {};
  yield {
    type: "meta", video_id: job.videoId, title: job.title, from_lang: job.fromLang, to_lang: job.toLang,
    total_cues: total, completed_cues: Object.keys(published).length,
  };
  for (let i = 0; i < total; i++) yield { type: "source_cue", index: i, ...job.cues[i] };
  for (let i = 0; i < total; i++) {
    const cueId = job.cues[i].cue_id;
    if (published[cueId]) yield { type: "cue", index: i, ...published[cueId], cached: true };
  }

  if (isTerminal(doc, job)) {
    yield { type: "done", total_cues: total, failed_cues: doc?.final_result?.failed_cues ?? 0 };
    return;
  }
  if (doc?.status === "cancelled" || job.status === "cancelled") {
    yield { type: "error", code: "task_cancelled", detail: "Translation task was cancelled" };
    return;
  }
  yield* observeLiveEvents(job, heartbeatIntervalMs, signal);
}

function isTerminal(doc: JobDocument | null | undefined, job: JobRecord) {
  return doc?.status === "succeeded" || doc?.status === "partial" || doc?.status === "failed" ||
    Boolean(doc?.final_result) || job.status === "succeeded" || job.status === "partial" || job.status === "failed";
}

async function* observeLiveEvents(job: JobRecord, heartbeatIntervalMs: number, signal: AbortSignal | null): AsyncGenerator<StreamEvent> {
  const queue: StreamEvent[] = [];
  let resolveNext: ((value?: string) => void) | null = null;
  const push = (item: StreamEvent) => {
    queue.push(item);
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    }
  };
  const cueListener = (cue: PublishedCue) => push({ type: "cue", index: cue.index, ...cue, cached: false });
  const doneListener = (done: { total_cues: number; failed_cues: number }) => push({ type: "done", ...done });
  const errorListener = (error: unknown) => push({ type: "error", detail: error instanceof Error ? error.message : String(error) });
  job.emitter.on("cue", cueListener);
  job.emitter.on("done", doneListener);
  job.emitter.on("error", errorListener);
  try {
    let isDone = false;
    while (!isDone) {
      if (signal?.aborted) break;
      if (queue.length > 0) {
        const item = queue.shift()!;
        yield item;
        if (item.type === "done" || item.type === "error") isDone = true;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waitPromise = new Promise<string | undefined>((resolve) => {
        resolveNext = resolve;
        timer = setTimeout(() => {
          resolveNext = null;
          resolve("keepalive");
        }, heartbeatIntervalMs);
      });
      const result = await waitPromise;
      clearTimeout(timer);
      if (result === "keepalive" && queue.length === 0) yield { type: "keepalive" };
    }
  } finally {
    job.emitter.off("cue", cueListener);
    job.emitter.off("done", doneListener);
    job.emitter.off("error", errorListener);
  }
}
