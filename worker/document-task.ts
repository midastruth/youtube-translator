import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { SubtitleJobDoc } from "./task-definition.js";
import { advanceDocument, callDocumentModel, DocumentModelError, DocumentPermanentError, finalDocumentCues, initialDocumentState } from "./document-translation.js";
import type { DocumentInput, ModelCallOptions } from "./document-translation.js";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { PublishedCue, TaskResult } from "./domain-types.js";

// Credentials deliberately never enter task inputs, checkpoints, SQLite or model context.
export const documentCredentials = new Map<string, string>();
type DurableState = { stage: string; cursor: number; feedback: string };

// Terminal task receipts do not retain their checkpoint. Keep the last committed
// workspace separately so an explicit retry can create a successor task in the
// same conversation, even after a worker restart. Never store credentials here.
export const DocumentResumeDoc = defineDoc<{
  workflow: string; document: JsonObject | null;
}>({
  kind: "youtube.document_resume", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ workflow: "", document: null }),
});

/** Shared persistence, cancellation, retry and atomic-publication boundary. */
export const createDocumentTask = <State extends DurableState, Request, Response>(workflow: {
  name: string;
  initial: (input: DocumentInput) => State;
  advance: (input: DocumentInput, state: State, call: (request: Request) => Promise<Response>) => Promise<State>;
  call: (input: DocumentInput, state: State, request: Request, options: ModelCallOptions) => Promise<Response>;
  finalCues: (input: DocumentInput, state: State) => PublishedCue[];
  progress?: (input: DocumentInput, state: State) => string;
}) => defineTask<DocumentInput, { phase: string; document: State; failures: number }, TaskResult>({
  name: workflow.name,
  version: 1,
  initial: input => ({ phase: input.resume ? "restore" : "run", document: workflow.initial(input), failures: 0 }),
  phases: {
    restore: async (_task, runtime, context) => {
      const saved = await runtime.snapshot(DocumentResumeDoc, runtime.conversationId, context);
      if (!saved?.document || saved.workflow !== workflow.name) throw new Error("Translation checkpoint missing or incompatible");
      await runtime.commit(async () => ({
        status: "running", checkpoint: { phase: "run", document: saved.document as unknown as State, failures: 0 },
      }), context);
    },
    run: async (task, runtime, context) => {
      const input = task.input;
      const checkpoint = task.state.checkpoint;
      const current = await runtime.snapshot(SubtitleJobDoc, runtime.conversationId, context);
      if (current?.cancelled) return;
      try {
        if (checkpoint.document.stage === "publish") {
          const cues = workflow.finalCues(input, checkpoint.document);
          const result = { status: "succeeded", total_cues: cues.length, failed_cues: 0, published_cues: cues.length, cues };
          await runtime.commit(async tx => {
            const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            if (doc.cancelled) return { status: "terminal", outcome: { status: "completed", result: { cancelled: true, published_cues: [] } } };
            // Atomic publication: never expose an unsubmitted or invalid draft.
            doc.published_cues = Object.fromEntries(cues.map(c => [c.cue_id, c]));
            doc.final_result = result; doc.status = "succeeded"; doc.stage = "published";
            const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
            saved.document = null;
            return { status: "terminal", outcome: { status: "completed", result } };
          }, context);
          documentCredentials.delete(input.jobKey);
          return;
        }
        while (!documentCredentials.get(input.jobKey) && !process.env.OPENAI_API_KEY && !process.env.TRANSLATE_API_KEY) {
          // After restart, a browser-only key must be supplied again by reattaching.
          await runtime.commit(async tx => {
            const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            doc.stage = "awaiting_credentials";
          }, context);
          await runtime.sleep(runtime.now() + 1000, context);
        }
        await runtime.commit(async tx => {
          const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          doc.status = "running"; doc.stage = checkpoint.document.stage;
          doc.progress = workflow.progress?.(input, checkpoint.document) ?? `${checkpoint.document.cursor + 1}`;
        }, context);
        const next = await workflow.advance(input, checkpoint.document, request => workflow.call(input, checkpoint.document, request, {
          apiKey: documentCredentials.get(input.jobKey), signal: runtime.signal,
          reserve: async () => {
            await runtime.commit(async tx => {
              const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
              if (doc.cancelled) throw new Error("Task cancelled");
              if (doc.network_attempts >= input.budgetLimit) throw new DocumentPermanentError("budget", "Document translation exhausted its model request budget");
              doc.network_attempts++;
            }, context);
          },
        }));
        await runtime.commit(async tx => {
          const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          if (doc.cancelled) return { status: "terminal", outcome: { status: "completed", result: { cancelled: true, published_cues: [] } } };
          doc.stage = next.stage;
          doc.progress = workflow.progress?.(input, next) ?? `${next.cursor + 1}`;
          return { status: "running", checkpoint: { phase: "run", document: next, failures: 0 } };
        }, context);
      } catch (error) {
        // Durable task boundary: provider/schema failures receive bounded repair;
        // permanent failures become an explicit terminal failed job, never success.
        if (runtime.signal.aborted) return;
        const message = (error instanceof Error ? error.message : "Document translation failed").slice(0, 2000);
        const terminal = error instanceof DocumentPermanentError ||
          (error instanceof DocumentModelError && error.status >= 400 && error.status < 500 && ![429, 499].includes(error.status));
        if (!terminal && checkpoint.failures < 2) {
          if (error instanceof DocumentModelError) await runtime.sleep(runtime.now() + error.retryAfterMs * (checkpoint.failures + 1), context);
          await runtime.commit(async () => ({
            status: "running", checkpoint: {
              ...checkpoint, failures: checkpoint.failures + 1,
              document: { ...checkpoint.document, feedback: message },
            },
          }), context);
          return;
        }
        await runtime.commit(async tx => {
          const doc = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          doc.status = "failed"; doc.stage = "failed"; doc.error = message;
          const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
          saved.workflow = workflow.name;
          saved.document = JSON.parse(JSON.stringify(checkpoint.document)) as JsonObject;
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
      const saved = await tx.doc(DocumentResumeDoc, runtime.conversationId);
      saved.document = null;
      return { status: "terminal", outcome: { status: "completed", result: { cancelled: true, published_cues: [] } } };
    }, context);
  },
});

// Retained under its original task name so in-flight v1 jobs can still resume.
export const DocumentTranslationTask = createDocumentTask({
  name: "document_subtitle_translation", initial: initialDocumentState,
  advance: advanceDocument, call: callDocumentModel, finalCues: finalDocumentCues,
});
