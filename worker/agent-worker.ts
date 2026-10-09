import { EventEmitter } from "node:events";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";

import { openOwnedSqliteStorage } from "./storage.js";
import { WHITELIST_TOOLS } from "./tools.js";
import { SubtitleTranslationTask, SubtitleJobDoc, TaskMocks } from "./task-definition.js";
import { calculateJobKey } from "./keys.js";
import type { JobRecord, SubmitJobOptions, TaskResult, StreamEvent, PublishedCue } from "./types.js";
import type { TaskId, ConversationId } from "@earendil-works/pi-durable";

export class AgentWorker {
  storagePath: string;
  workerId: string;
  context = BACKGROUND_CONTEXT;
  harness: Harness | null = null;
  storage: Awaited<ReturnType<typeof openOwnedSqliteStorage>>["storage"] | null = null;
  ownershipManager: Awaited<ReturnType<typeof openOwnedSqliteStorage>>["ownershipManager"] | null = null;
  registry: ReturnType<typeof createRegistry> | null = null;
  models: ReturnType<typeof createModels> | null = null;
  jobs = new Map<string, JobRecord>();
  pendingJobs = new Map<string, Promise<JobRecord>>();
  jobEvents = new Map<string, EventEmitter>();
  extension: ReturnType<typeof defineExtension> | null = null;

  private get activeHarness(): Harness {
    if (!this.harness) throw new Error("Worker harness is not open");
    return this.harness;
  }

  constructor({ storagePath = "./data/durable-storage.db", workerId = `worker-${process.pid}` } = {}) {
    this.storagePath = storagePath;
    this.workerId = workerId;
    this.context = BACKGROUND_CONTEXT;

  }

  async start({ registerDefinition = true } = {}) {
    const { storage, ownershipManager } = await openOwnedSqliteStorage(
      this.storagePath,
      this.workerId
    );
    this.storage = storage;
    this.ownershipManager = ownershipManager;

    this.models = createModels();
    this.registry = createRegistry();

    if (registerDefinition) {
      this.extension = defineExtension({
        name: "translation_agent",
        tools: WHITELIST_TOOLS,
        tasks: [SubtitleTranslationTask],
      });
      this.registry.install(this.extension);
    }

    this.harness = await Harness.open(
      this.storage,
      {
        models: this.models,
        registry: this.registry,
        onReport: () => {},
      },
      this.context
    );

    this.harness.resume();
  }

  async close() {
    if (this.harness) {
      try {
        const closeCtx = withAbortSignal(AbortSignal.timeout(1000), this.context);
        await this.harness.close(closeCtx);
      } catch {
        // ignore already closed
      }
      this.harness = null;
    }
    if (this.ownershipManager) {
      try {
        this.ownershipManager.release();
      } catch {
        // ignore
      }
      this.ownershipManager = null;
    }
  }

  async readinessCheck() {
    if (!this.harness) {
      return { ready: false, reason: "harness_not_open" };
    }

    const inspection = await this.harness.inspect(this.context);
    const blocked = (inspection.tasks || []).filter((t) => t.state?.kind === "blocked");
    if (blocked.length > 0) {
      return {
        ready: false,
        reason: "configuration_blocked",
        blockedTasks: blocked.map((t) => ({
          id: t.record.id,
          kind: t.record.kind,
          reason: t.state.kind === "blocked" ? t.state.reason : undefined,
        })),
      };
    }
    return { ready: true };
  }

  async getJob(jobKeyOrId: string | ConversationId): Promise<JobRecord | null> {
    for (const job of this.jobs.values()) {
      if (job.jobKey === jobKeyOrId || job.jobId === jobKeyOrId) {
        return job;
      }
    }
    // Search storage
    if (this.storage && this.harness) {
      try {
        const page = await this.storage.scanConversations({}, 100, undefined, this.context);
        for (const item of page.items || []) {
          const doc = await this.harness.snapshot(SubtitleJobDoc, item.id, this.context);
          if (doc && (doc.job_key === jobKeyOrId || item.id === jobKeyOrId)) {
            const emitter = new EventEmitter();
            emitter.on("error", () => {});
            const jobRecord: JobRecord = {
              jobId: `job-${item.id}`,
              jobKey: doc.job_key,
              taskId: null,
              conversationId: item.id,
              videoId: doc.video_id,
              title: "",
              fromLang: doc.from_lang,
              toLang: doc.to_lang,
              cues: doc.source_cues || [],
              status: doc.status || "succeeded",
              emitter,
              finalResult: doc.final_result,
              aborted: doc.cancelled || false,
            };
            this.jobs.set(doc.job_key, jobRecord);
            return jobRecord;
          }
        }
      } catch {
        // ignore scan error
      }
    }
    return null;
  }

  async submitOrAttachJob({
    jobKey,
    cues = [],
    videoId = "",
    title = "",
    fromLang = "en",
    toLang = "zh-CN",
    segmentation = "rule",
    provider = "openai",
    model = "gpt-4o",
    baseUrl = "https://api.openai.com/v1",
    requestId = null,
    budgetLimit = 12,
    maxCuesPerBlock = 10,
    translatorMock = null,
    reviewerMock = null,
    revisorMock = null,
    initialGlossary = null,
  }: SubmitJobOptions): Promise<JobRecord> {
    const effectiveJobKey =
      jobKey ||
      calculateJobKey({
        videoId,
        sourceCues: cues,
        fromLang,
        toLang,
        segmentationVersion: segmentation,
        provider,
        baseUrl,
        model,
      });

    // Idempotency check: reuse active or finished job with same job_key
    if (this.jobs.has(effectiveJobKey)) {
      return this.jobs.get(effectiveJobKey)!;
    }
    if (this.pendingJobs.has(effectiveJobKey)) {
      return await this.pendingJobs.get(effectiveJobKey)!;
    }

    const createJobPromise = (async () => {
      const conversation = await this.activeHarness.createConversation(
        { ownership: { kind: "ownerless" } },
        this.context
      );

      const emitter = new EventEmitter();
      emitter.on("error", () => {});
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.jobEvents.set(jobId, emitter);

      const normalizedCues = cues.map((c, i) => {
        const s = Number(c.start);
        const e = Number(c.end);
        return {
          cue_id: c.cue_id || `c${i}`,
          start: Number.isFinite(s) ? s : i * 1000,
          end: Number.isFinite(e) ? e : (i + 1) * 1000,
          text: String(c.text || ""),
        };
      });

      const taskInput = {
        jobId,
        jobKey: effectiveJobKey,
        videoId,
        title,
        fromLang,
        toLang,
        cues: normalizedCues,
        budgetLimit,
        maxCuesPerBlock,
        initialGlossary: initialGlossary || {},
      };

      let taskId: TaskId<TaskResult> | undefined;
      await conversation.commit(async (tx) => {
        taskId = await tx.createTask(SubtitleTranslationTask, taskInput, {
          ownership: { kind: "conversation" },
        });
        const d = await tx.doc(SubtitleJobDoc, conversation.id);
        d.job_key = effectiveJobKey;
        d.source_cues = normalizedCues;
        d.video_id = videoId;
        d.from_lang = fromLang;
        d.to_lang = toLang;
      }, this.context);

      if (taskId === undefined) throw new Error("Task creation did not return an ID");
      const createdTaskId = taskId;
      if (translatorMock || reviewerMock || revisorMock) {
        TaskMocks.set(taskId, { translatorMock, reviewerMock, revisorMock });
      }

      const jobRecord: JobRecord = {
        jobId,
        jobKey: effectiveJobKey,
        taskId,
        conversationId: conversation.id,
        videoId,
        title,
        fromLang,
        toLang,
        cues: normalizedCues,
        status: "running",
        emitter,
        taskPromise: null,
        aborted: false,
      };

      // Monitor task completion in background
      jobRecord.taskPromise = (async () => {
        try {
          await this.activeHarness.waitForTask(createdTaskId, this.context);
          const doc = await this.activeHarness.snapshot(SubtitleJobDoc, conversation.id, this.context);
          if (!doc) throw new Error("Subtitle job document is missing");
          jobRecord.status = doc.status || "succeeded";
          jobRecord.finalResult = doc.final_result;

          // Emit final cues and done
          const cuesList = doc?.final_result?.cues || [];
          for (const cue of cuesList) {
            if (cue.translation) {
              emitter.emit("cue", cue);
            }
          }

          emitter.emit("done", {
            total_cues: normalizedCues.length,
            failed_cues: doc?.final_result?.failed_cues || 0,
          });
        } catch (err) {
          jobRecord.status = "failed";
          jobRecord.error = err;
          emitter.emit("error", err);
        }
      })();

      this.jobs.set(effectiveJobKey, jobRecord);
      return jobRecord;
    })();

    this.pendingJobs.set(effectiveJobKey, createJobPromise);
    try {
      return await createJobPromise;
    } finally {
      this.pendingJobs.delete(effectiveJobKey);
    }
  }

  async abortJob(jobId: string) {
    let target = null;
    for (const job of this.jobs.values()) {
      if (job.jobId === jobId) {
        target = job;
        break;
      }
    }

    if (!target) return false;
    target.aborted = true;
    target.status = "cancelled";

    if (target.taskId !== null) await this.activeHarness.abortTask(target.taskId, this.context);
    target.emitter.emit("cancelled");
    return true;
  }

  /**
   * Observe job stream (SSE / WS style)
   */
  async *observeJobStream(jobRecord: JobRecord, { heartbeatIntervalMs = 5000, signal = null }: { heartbeatIntervalMs?: number; signal?: AbortSignal | null } = {}): AsyncGenerator<StreamEvent> {
    const total = jobRecord.cues.length;
    const doc = await this.activeHarness.snapshot(
      SubtitleJobDoc,
      jobRecord.conversationId,
      this.context
    );

    const published = doc?.published_cues || {};
    const completedCount = Object.keys(published).length;

    // 1. Meta event
    yield {
      type: "meta",
      video_id: jobRecord.videoId,
      title: jobRecord.title,
      from_lang: jobRecord.fromLang,
      to_lang: jobRecord.toLang,
      total_cues: total,
      completed_cues: completedCount,
    };

    // 2. Source cues with stable index
    for (let i = 0; i < total; i++) {
      yield {
        type: "source_cue",
        index: i,
        ...jobRecord.cues[i],
      };
    }

    // 3. Already published cues marked cached: true
    for (let i = 0; i < total; i++) {
      const cueId = jobRecord.cues[i].cue_id;
      if (published[cueId]) {
        yield {
          type: "cue",
          index: i,
          ...published[cueId],
          cached: true,
        };
      }
    }

    // If job already terminal
    const isTerminal =
      doc?.status === "succeeded" ||
      doc?.status === "partial" ||
      doc?.status === "failed" ||
      Boolean(doc?.final_result) ||
      jobRecord.status === "succeeded" ||
      jobRecord.status === "partial" ||
      jobRecord.status === "failed";

    if (isTerminal) {
      const failed = doc?.final_result?.failed_cues ?? 0;
      yield {
        type: "done",
        total_cues: total,
        failed_cues: failed,
      };
      return;
    }

    if (doc?.status === "cancelled" || jobRecord.status === "cancelled") {
      yield {
        type: "error",
        code: "task_cancelled",
        detail: "Translation task was cancelled",
      };
      return;
    }

    // Listen for live events with heartbeats
    const queue: StreamEvent[] = [];
    let resolveNext: ((value?: string) => void) | null = null;

    const push = (item: StreamEvent) => {
      queue.push(item);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    const cueListener = (cue: PublishedCue) => push({ type: "cue", index: cue.index, ...cue, cached: false });
    const doneListener = (done: { total_cues: number; failed_cues: number }) => push({ type: "done", ...done });
    const errListener = (err: unknown) => push({ type: "error", detail: err instanceof Error ? err.message : String(err) });

    jobRecord.emitter.on("cue", cueListener);
    jobRecord.emitter.on("done", doneListener);
    jobRecord.emitter.on("error", errListener);

    try {
      let isDone = false;
      while (!isDone) {
        if (signal?.aborted) {
          // Browser disconnect only detaches observation, does not abort job
          break;
        }

        if (queue.length > 0) {
          const item = queue.shift()!;
          yield item;
          if (item.type === "done" || item.type === "error") {
            isDone = true;
          }
          continue;
        }

        // Wait for next item or heartbeat
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waitPromise = new Promise<string | undefined>((resolve) => {
          resolveNext = resolve;
          timer = setTimeout(() => {
            resolveNext = null;
            resolve("keepalive");
          }, heartbeatIntervalMs);
        });

        const res = await waitPromise;
        clearTimeout(timer);

        if (res === "keepalive" && queue.length === 0) {
          yield { type: "keepalive" };
        }
      }
    } finally {
      jobRecord.emitter.off("cue", cueListener);
      jobRecord.emitter.off("done", doneListener);
      jobRecord.emitter.off("error", errListener);
    }
  }
}
