import { EventEmitter } from "node:events";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";

import { openOwnedSqliteStorage } from "./storage.js";
import { WHITELIST_TOOLS } from "./tools.js";
import { SubtitleTranslationTask, SubtitleJobDoc, TaskMocks } from "./task-definition.js";
import { calculateJobKey } from "./keys.js";
import type { JobRecord, SubmitJobOptions, TaskResult, StreamEvent, JobDocument } from "./types.js";
import { observeJobEvents } from "./job-stream.js";
import { DocumentTranslationTask, DocumentResumeDoc, documentCredentials } from "./document-task.js";
import { modelConfig } from "./document-translation.js";
import type { DocumentInput } from "./document-translation.js";
import { SUBTITLE_AGENT_VERSION, SubtitleEditingTask, initialSubtitleAgentState } from "./subtitle-agent.js";
import { observeDocumentJob } from "./document-stream.js";
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
        tasks: [SubtitleTranslationTask, DocumentTranslationTask, SubtitleEditingTask],
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
    for (const job of this.jobs.values()) {
      if (job.engine === "document") {
        documentCredentials.delete(job.jobKey);
      }
    }
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
    return this.findStoredJob(jobKeyOrId);
  }

  private async findStoredJob(jobKeyOrId: string | ConversationId): Promise<JobRecord | null> {
    if (!this.storage || !this.harness) return null;
    let page = await this.storage.scanConversations({ order: "descending" }, 100, undefined, this.context);
    while (true) {
      for (const item of page.items || []) {
        const doc = await this.harness.snapshot(SubtitleJobDoc, item.id, this.context);
        if (doc && (doc.job_key === jobKeyOrId || doc.job_id === jobKeyOrId || item.id === jobKeyOrId)) {
          return this.restoreJob(item.id, doc);
        }
      }
      if (!page.next) break;
      page = await this.storage.scanConversations({ order: "descending" }, 100, page.next, this.context);
    }
    return null;
  }

  private restoreJob(conversationId: ConversationId, doc: JobDocument): JobRecord {
    const emitter = new EventEmitter();
    emitter.on("error", () => {});
    const jobRecord: JobRecord = {
      jobId: doc.job_id || `job-${conversationId}`, jobKey: doc.job_key,
      taskId: doc.task_id ? doc.task_id as TaskId<TaskResult> : null, conversationId, engine: doc.engine,
      videoId: doc.video_id, title: doc.title || "", fromLang: doc.from_lang, toLang: doc.to_lang,
      cues: doc.source_cues || [], status: doc.status || "succeeded", emitter,
      finalResult: doc.final_result, aborted: doc.cancelled || false,
    };
    this.jobs.set(doc.job_key, jobRecord);
    return jobRecord;
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
    model = process.env.TRANSLATION_AGENT_MODEL || "sol",
    baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    requestId = null,
    budgetLimit,
    maxCuesPerBlock = 10,
    translatorMock = null,
    reviewerMock = null,
    revisorMock = null,
    initialGlossary = null,
    engine, apiKey, contextTokens, outputTokens,
  }: SubmitJobOptions): Promise<JobRecord> {
    if (engine === "document") return this.submitDocumentJob({
      cues, videoId, title, fromLang, toLang, segmentation, provider, model, baseUrl,
      apiKey, contextTokens, outputTokens, budgetLimit,
    });
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
        budgetLimit: budgetLimit ?? 12,
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

  private async submitDocumentJob(options: SubmitJobOptions): Promise<JobRecord> {
    if (options.provider && options.provider !== "openai") throw new Error("全文高质量模式需要 OpenAI-compatible provider");
    const config = modelConfig({ model: options.model, baseUrl: options.baseUrl, contextTokens: options.contextTokens, outputTokens: options.outputTokens });
    const cues = (options.cues || []).map((c, index) => ({
      cue_id: c.cue_id || `c${index}`, start: typeof c.start === "number" ? c.start : NaN,
      end: typeof c.end === "number" ? c.end : NaN, text: String(c.text || ""),
    }));
    const jobKey = calculateJobKey({
      videoId: options.videoId, sourceCues: cues, fromLang: options.fromLang, toLang: options.toLang,
      segmentationVersion: options.segmentation, engine: "document", provider: "openai", model: config.model, baseUrl: config.baseUrl,
      workflowVersion: SUBTITLE_AGENT_VERSION, promptVersion: SUBTITLE_AGENT_VERSION, reviewVersion: SUBTITLE_AGENT_VERSION,
      styleConfig: JSON.stringify({
        context: config.contextTokens, output: config.outputTokens, title: options.title || "",
        // Preserve existing cache keys when reasoning is not explicitly enabled.
        ...(config.reasoningEffort !== "off" ? { reasoningEffort: config.reasoningEffort } : {}),
      }),
    });
    if (options.apiKey) documentCredentials.set(jobKey, options.apiKey);
    if (this.pendingJobs.has(jobKey)) return this.pendingJobs.get(jobKey)!;
    const pending = (async () => {
      const existing = await this.getJob(jobKey);
      if (existing) {
        // Restored jobs have no in-process completion watcher. Persistence is
        // authoritative, including failures that occurred since restoration.
        const doc = await this.activeHarness.snapshot(SubtitleJobDoc, existing.conversationId, this.context);
        if (!doc) throw new Error("Document job state missing");
        existing.status = doc.status;
        existing.finalResult = doc.final_result;
        existing.aborted = !!doc.cancelled;
        if (doc.error) existing.error = new Error(doc.error);
      }
      if (existing && !["failed", "cancelled"].includes(existing.status)) {
        if (existing.status === "succeeded") documentCredentials.delete(jobKey);
        return existing;
      }
      if (existing?.status === "failed") {
        const saved = await this.activeHarness.snapshot(DocumentResumeDoc, existing.conversationId, this.context);
        if (saved?.document) return this.resumeDocumentJob(existing, options);
      }
      if (existing) this.jobs.delete(jobKey);
      const input = {
        jobId: `doc-${crypto.randomUUID()}`, jobKey, videoId: options.videoId || "", title: options.title || "",
        fromLang: options.fromLang || "en", toLang: options.toLang || "zh-CN", cues, config, budgetLimit: options.budgetLimit ?? 128,
      };
      if (!Number.isSafeInteger(input.budgetLimit) || input.budgetLimit < 1 || input.budgetLimit > 1000) throw new Error("Invalid document request budget");
      initialSubtitleAgentState(input); // Validate before creating durable state.
      if (!documentCredentials.get(jobKey) && !process.env.OPENAI_API_KEY && !process.env.TRANSLATE_API_KEY) {
        throw new Error("全文翻译需要 API Key；请在扩展或 Worker 环境变量中配置");
      }
      const conversation = await this.activeHarness.createConversation({ ownership: { kind: "ownerless" } }, this.context);
      let taskId: TaskId<TaskResult> | undefined;
      await conversation.commit(async tx => {
        taskId = await tx.createTask(SubtitleEditingTask, input, { ownership: { kind: "conversation" } });
        const doc = await tx.doc(SubtitleJobDoc, conversation.id);
        doc.job_key = jobKey; doc.job_id = input.jobId; doc.task_id = taskId;
        doc.engine = "document"; doc.title = input.title; doc.video_id = input.videoId;
        doc.from_lang = input.fromLang; doc.to_lang = input.toLang; doc.source_cues = cues;
        doc.status = "running"; doc.stage = "editing"; doc.budget_limit = input.budgetLimit;
      }, this.context);
      if (!taskId) throw new Error("Document task creation failed");
      const emitter = new EventEmitter(); emitter.on("error", () => {});
      const job: JobRecord = {
        jobId: input.jobId, jobKey, taskId, conversationId: conversation.id, engine: "document",
        videoId: input.videoId, title: input.title, fromLang: input.fromLang, toLang: input.toLang,
        cues, status: "running", emitter, aborted: false,
      };
      this.watchDocumentJob(job);
      return job;
    })();
    this.pendingJobs.set(jobKey, pending);
    try { return await pending; }
    // Submission cleanup only; initialization/storage failures still propagate.
    catch (error) { documentCredentials.delete(jobKey); throw error; }
    finally { this.pendingJobs.delete(jobKey); }
  }

  private async resumeDocumentJob(existing: JobRecord, options: SubmitJobOptions): Promise<JobRecord> {
    if (!documentCredentials.get(existing.jobKey) && !process.env.OPENAI_API_KEY && !process.env.TRANSLATE_API_KEY) {
      throw new Error("全文翻译需要 API Key；请在扩展或 Worker 环境变量中配置");
    }
    const previous = existing.taskId && await this.activeHarness.getTask(existing.taskId, this.context);
    const saved = await this.activeHarness.snapshot(DocumentResumeDoc, existing.conversationId, this.context);
    if (!previous || !saved?.document) throw new Error("Translation checkpoint missing");
    const isEditor = saved.workflow === SubtitleEditingTask.definition.name;
    if (!isEditor && saved.workflow !== DocumentTranslationTask.definition.name) throw new Error("Translation checkpoint incompatible");
    const input = { ...(previous.input as unknown as DocumentInput), resume: true };
    input.budgetLimit = options.budgetLimit ?? input.budgetLimit;
    if (!Number.isSafeInteger(input.budgetLimit) || input.budgetLimit < 1 || input.budgetLimit > 1000) throw new Error("Invalid document request budget");
    let taskId: TaskId<TaskResult> | undefined;
    const conversation = await this.activeHarness.conversation(existing.conversationId, this.context);
    if (!conversation) throw new Error("Document job state missing");
    await conversation.commit(async tx => {
      const doc = await tx.doc(SubtitleJobDoc, existing.conversationId);
      if (doc.cancelled || doc.status !== "failed" || doc.task_id !== existing.taskId) throw new Error("Translation job is no longer resumable");
      // Retrying must not silently reset the shared request budget.
      if (doc.network_attempts >= input.budgetLimit) throw new Error("翻译请求预算已耗尽；请提高预算后继续");
      taskId = isEditor
        ? await tx.createTask(SubtitleEditingTask, input, { ownership: { kind: "conversation" } })
        : await tx.createTask(DocumentTranslationTask, input, { ownership: { kind: "conversation" } });
      doc.task_id = taskId; doc.status = "running"; doc.stage = String(saved.document!.stage);
      doc.budget_limit = input.budgetLimit; doc.final_result = null; doc.failed_cues = [];
      delete doc.error;
    }, this.context);
    if (!taskId) throw new Error("Document task creation failed");
    const emitter = new EventEmitter(); emitter.on("error", () => {});
    const job: JobRecord = { ...existing, taskId, status: "running", error: undefined, finalResult: null, taskPromise: null, emitter };
    this.watchDocumentJob(job);
    return job;
  }

  private watchDocumentJob(job: JobRecord) {
    this.jobs.set(job.jobKey, job);
    job.taskPromise = (async () => {
      try {
        await this.activeHarness.waitForTask(job.taskId!, this.context);
        const doc = await this.activeHarness.snapshot(SubtitleJobDoc, job.conversationId, this.context);
        if (!doc) throw new Error("Document job state missing");
        job.status = doc.status; job.finalResult = doc.final_result;
        if (doc.error) job.error = new Error(doc.error);
      } catch (error) {
        // Completion-observer boundary: never leave an unobserved rejection.
        job.status = "failed"; job.error = error;
      }
    })();
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

  /** Application snapshot; delivery adapters do not need durable document details. */
  async snapshotJob(job: JobRecord) {
    const doc = await this.activeHarness.snapshot(SubtitleJobDoc, job.conversationId, this.context);
    return {
      job_id: job.jobId,
      status: doc?.status || job.status,
      published_cues: Object.values(doc?.published_cues || {}),
      failed_cues: doc?.failed_cues || [],
      final_result: doc?.final_result,
    };
  }

  /**
   * Observe job stream (SSE / WS style)
   */
  async *observeJobStream(jobRecord: JobRecord, { heartbeatIntervalMs = 5000, signal = null }: { heartbeatIntervalMs?: number; signal?: AbortSignal | null } = {}): AsyncGenerator<StreamEvent> {
    // Preserve the original cardinality capture before the asynchronous snapshot.
    const sourceCueCount = jobRecord.cues.length;
    if (jobRecord.engine === "document") {
      yield* observeDocumentJob(jobRecord, () => this.activeHarness.snapshot(SubtitleJobDoc, jobRecord.conversationId, this.context), { heartbeatIntervalMs, signal });
      return;
    }
    const doc = await this.activeHarness.snapshot(SubtitleJobDoc, jobRecord.conversationId, this.context);
    yield* observeJobEvents(doc, jobRecord, { heartbeatIntervalMs, signal, sourceCueCount });
  }
}
