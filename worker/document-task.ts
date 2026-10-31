import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { SubtitleJobDoc } from "./job-document.js";
import { checkTokenBudget } from "./token-budget.js";
import { DocumentModelError, DocumentPermanentError } from "./document-translation.js";
import type { DocumentInput, ModelCallOptions } from "./document-translation.js";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { PublishedCue, TaskResult } from "./domain-types.js";

// Credentials deliberately never enter task inputs, checkpoints, SQLite or model context.
export const documentCredentials = new Map<string, string>();
type DurableState = { stage: string; cursor: number; feedback: string };
export type DocumentAdvanceControl<State> = {
  signal: AbortSignal;
  /** Save a completed model/tool turn without waiting for sibling agents. */
  save: (state: State) => Promise<void>;
};

// Terminal task receipts do not retain their checkpoint. Keep the last committed
// workspace separately so an explicit retry can create a successor task in the
// same conversation, even after a worker restart. Never store credentials here.
export const DocumentResumeDoc = defineDoc<{
  workflow: string; document: JsonObject | null;
}>({
  kind: "youtube.document_resume", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ workflow: "", document: null }),
  // Rarely written and always replaced wholesale, so store each change as a base.
  checkpointWhen: () => true,
});

/** Shared persistence, cancellation, retry and atomic-publication boundary. */
export const createDocumentTask = <State extends DurableState, Request, Response>(workflow: {
  name: string;
  initial: (input: DocumentInput) => State;
  advance: (input: DocumentInput, state: State, call: (request: Request, cacheKey?: string) => Promise<Response>, control?: DocumentAdvanceControl<State>) => Promise<State>;
  call: (input: DocumentInput, state: State, request: Request, options: ModelCallOptions) => Promise<Response>;
  finalCues: (input: DocumentInput, state: State) => PublishedCue[];
  previewCues?: (input: DocumentInput, state: State) => PublishedCue[];
  progress?: (input: DocumentInput, state: State) => string;
  resume?: (state: State) => State;
  wakeAt?: (state: State) => number;
}) => defineTask<DocumentInput, { phase: string; document: State; failures: number }, TaskResult>({
  name: workflow.name,
  version: 1,
  initial: input => ({ phase: input.resume ? "restore" : "run", document: workflow.initial(input), failures: 0 }),
  phases: {
    restore: async (_task, runtime, context) => {
      const saved = await runtime.snapshot(DocumentResumeDoc, runtime.conversationId, context);
      if (!saved?.document || saved.workflow !== workflow.name) throw new Error("Translation checkpoint missing or incompatible");
      const restored = saved.document as State;
      await runtime.commit(async () => ({
        status: "running", checkpoint: { phase: "run", document: workflow.resume?.(restored) ?? restored, failures: 0 },
      }), context);
    },
    run: async (task, runtime, context) => {
      const input = task.input;
      const checkpoint = task.state.checkpoint;
      const current = await runtime.snapshot(SubtitleJobDoc, runtime.conversationId, context);
      if (current?.cancelled) return;
      let latest = checkpoint.document;
      // Serialize checkpoint writes and snapshot at enqueue time: a faster child
      // must never be overwritten by an older sibling snapshot finishing later.
      let saves = Promise.resolve();
      const save = (state: State): Promise<void> => {
        const snapshot = structuredClone(state);
        const pending = saves.then(async () => {
          if (runtime.signal.aborted) throw new Error("Task cancelled");
          await runtime.commit(async tx => {
            const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            if (doc.cancelled) throw new Error("Task cancelled");
            doc.stage = snapshot.stage;
            doc.progress = workflow.progress?.(input, snapshot) ?? `${snapshot.cursor + 1}`;
            if (workflow.previewCues) {
              const cues = workflow.previewCues(input, snapshot);
              doc.preview_cues = Object.fromEntries(cues.map(c => [c.cue_id, c]));
            }
            return { status: "running", checkpoint: { phase: "run", document: snapshot, failures: 0 } };
          }, context);
          latest = snapshot;
        });
        saves = pending;
        return pending;
      };
      try {
        if (checkpoint.document.stage === "publish") {
          const cues = workflow.finalCues(input, checkpoint.document);
          const result = { status: "succeeded", total_cues: cues.length, failed_cues: 0, published_cues: cues.length, cues };
          await runtime.commit(async tx => {
            const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            if (doc.cancelled) return { status: "terminal", outcome: { status: "completed", result: { cancelled: true, published_cues: [] } } };
            // Atomic publication: never expose an unsubmitted or invalid draft.
            doc.published_cues = Object.fromEntries(cues.map(c => [c.cue_id, c]));
            doc.preview_cues = {};
            doc.final_result = result; doc.status = "succeeded"; doc.stage = "published";
            const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
            saved.document = null;
            return { status: "terminal", outcome: { status: "completed", result } };
          }, context);
          documentCredentials.delete(input.jobKey);
          return;
        }
        if (!documentCredentials.get(input.jobKey) && !process.env.OPENAI_API_KEY && !process.env.TRANSLATE_API_KEY) {
          // After restart, a browser-only key must be supplied again by reattaching.
          // Durable sleep ends this phase; it reruns from the top once due.
          await runtime.commit(async tx => {
            const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            doc.stage = "awaiting_credentials";
            return { status: "sleeping", until: runtime.now() + 1000, checkpoint };
          }, context);
          return;
        }
        await runtime.commit(async tx => {
          const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          doc.status = "running"; doc.stage = checkpoint.document.stage;
          doc.progress = workflow.progress?.(input, checkpoint.document) ?? `${checkpoint.document.cursor + 1}`;
        }, context);
        const wakeAt = workflow.wakeAt?.(checkpoint.document) ?? 0;
        if (wakeAt > runtime.now()) return await runtime.sleepUntil(wakeAt, checkpoint, context);
        const next = await workflow.advance(input, checkpoint.document, (request, cacheKey) => workflow.call(input, checkpoint.document, request, {
          apiKey: documentCredentials.get(input.jobKey), signal: runtime.signal, cacheKey,
          reserve: async () => {
            await runtime.commit(async tx => {
              const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
              if (doc.cancelled) throw new Error("Task cancelled");
              if (input.budgetLimit > 0 && doc.network_attempts >= input.budgetLimit) throw new DocumentPermanentError("budget", `翻译请求预算已耗尽（已用 ${doc.network_attempts} 次，上限 ${input.budgetLimit} 次，主/子 Agent 共享）；请提高 TRANSLATION_REQUEST_BUDGET 或 translate_request_budget 后继续，已保存草稿会保留`);
              checkTokenBudget(input.tokenBudget, (doc.token_usage ?? 0) - (doc.token_budget_start ?? 0));
              doc.network_attempts++;
            }, context);
          },
          recordTokens: async tokens => {
            await runtime.commit(async tx => {
              const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
              doc.token_usage = (doc.token_usage ?? 0) + tokens;
            }, context);
          },
        }), { signal: runtime.signal, save });
        await save(next);
      } catch (error) {
        // Durable task boundary: provider/schema failures receive bounded repair;
        // permanent failures become an explicit terminal failed job, never success.
        if (runtime.signal.aborted) return;
        const message = (error instanceof Error ? error.message : "Document translation failed").slice(0, 2000);
        const terminal = error instanceof DocumentPermanentError ||
          (error instanceof DocumentModelError && error.status >= 400 && error.status < 500 && ![429, 499].includes(error.status));
        if (!terminal && checkpoint.failures < 2) {
          const next = {
            ...checkpoint, failures: checkpoint.failures + 1,
            document: { ...latest, feedback: message },
          };
          // Back off with a durable sleep so a restart does not restart the wait.
          await runtime.commit(async () => error instanceof DocumentModelError
            ? { status: "sleeping", until: runtime.now() + error.retryAfterMs * (checkpoint.failures + 1), checkpoint: next }
            : { status: "running", checkpoint: next }, context);
          return;
        }
        await runtime.commit(async tx => {
          const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          doc.status = "failed"; doc.stage = "failed"; doc.error = message;
          const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
          saved.workflow = workflow.name;
          saved.document = JSON.parse(JSON.stringify(latest)) as JsonObject;
          doc.failed_cues = input.cues.map(c => c.cue_id);
          const result = { status: "failed", total_cues: input.cues.length, failed_cues: input.cues.length, published_cues: 0, cues: [] };
          doc.final_result = result;
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
        documentCredentials.delete(input.jobKey);
      }
    },
  },
  abort: async (task, runtime, context) => {
    documentCredentials.delete(task.input.jobKey);
    await runtime.commit(async tx => {
      const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
      doc.cancelled = true; doc.status = "cancelled"; doc.stage = "cancelled";
      doc.preview_cues = {};
      const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
      saved.document = null;
      return { status: "terminal", outcome: { status: "completed", result: { cancelled: true, published_cues: [] } } };
    }, context);
  },
});
