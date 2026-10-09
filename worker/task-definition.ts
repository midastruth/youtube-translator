import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { partitionCuesIntoBlocks } from "./chunker.js";
import { validateOutputMapping } from "./validator.js";
import { reviewTranslations } from "./reviewer.js";
import { defaultDraft, reviseDefaultDraft } from "./default-draft.js";

import type { TaskId } from "@earendil-works/pi-durable";
import type { JobDocument, TaskInput, TaskCheckpoint, TaskResult, ModelMocks, Draft, ReviewResult, CueBlock } from "./types.js";

export const TaskMocks = new Map<TaskId<TaskResult>, ModelMocks>(); // taskId -> { translatorMock, reviewerMock, revisorMock }

export const SubtitleJobDoc = defineDoc<JobDocument>({
  kind: "youtube.subtitle_job",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    job_key: "",
    video_id: "",
    from_lang: "en",
    to_lang: "zh-CN",
    status: "pending",
    stage: "prepare",
    source_cues: [],
    published_cues: {}, // cue_id -> { cue_id, start, end, text, translation }
    failed_cues: [], // list of cue_ids that failed
    glossary: {}, // persistent terms
    network_attempts: 0,
    budget_limit: 12,
    revisions: {},
    cancelled: false,
    final_result: null,
  }),
});

function nextBlockCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  const blockIndex = checkpoint.blockIndex + 1;
  return {
    ...checkpoint, phase: blockIndex >= checkpoint.blocks.length ? "publish" : "translate",
    blockIndex, draft: null, revisions: 0,
  };
}

function markBlockFailed(doc: JobDocument, block: CueBlock) {
  for (const cue of block.cues) doc.failed_cues.push(cue.cue_id);
}

async function translationDraft(block: CueBlock, doc: JobDocument, attempt: number, mocks?: ModelMocks): Promise<Draft> {
  if (mocks?.translatorMock) {
    return mocks.translatorMock({
      cues: block.cues, contextBefore: block.contextBefore, contextAfter: block.contextAfter,
      glossary: doc.glossary, attempt,
    });
  }
  return defaultDraft(block.cues, doc.glossary || {});
}

/**
 * Durable Task: subtitle_translation
 */
export const SubtitleTranslationTask = defineTask<TaskInput, TaskCheckpoint, TaskResult>({
  name: "subtitle_translation",
  version: 1,
  initial: (input) => ({
    phase: "prepare",
    blockIndex: 0,
    revisions: 0,
    draft: null,
    issues: [],
    blocks: [],
    networkAttempts: 0,
  }),
  phases: {
    prepare: async (task, runtime, context) => {
      const input = task.input;
      const blocks = partitionCuesIntoBlocks(input.cues || [], {
        contextWindow: input.contextWindow || 4096,
        reserveOutputTokens: input.reserveOutputTokens || 1024,
        maxCuesPerBlock: input.maxCuesPerBlock || 10,
      });

      await runtime.commit(async (tx) => {
        const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
        d.job_key = input.jobKey;
        d.video_id = input.videoId || "";
        d.from_lang = input.fromLang || "en";
        d.to_lang = input.toLang || "zh-CN";
        d.source_cues = input.cues || [];
        d.status = "running";
        d.stage = "prepare";
        if (input.initialGlossary) {
          d.glossary = { ...d.glossary, ...input.initialGlossary };
        }

        return {
          status: "running",
          checkpoint: {
            phase: "translate",
            blockIndex: 0,
            revisions: 0,
            draft: null,
            issues: [],
            blocks,
            networkAttempts: d.network_attempts || 0,
          },
        };
      }, context);
    },

    translate: async (task, runtime, context) => {
      const cp = task.state.checkpoint;
      const blocks = cp.blocks || [];
      const block = blocks[cp.blockIndex];
      const doc = await runtime.snapshot(SubtitleJobDoc, runtime.conversationId, context);

      if (!doc) throw new Error("Subtitle job document is missing");
      if (!block) {
        await runtime.commit(async () => {
          return {
            status: "running",
            checkpoint: { ...cp, phase: "publish" },
          };
        }, context);
        return;
      }

      // Check if draft was already committed (e.g. before a crash during review)
      if (cp.draft) {
        await runtime.commit(async () => {
          return {
            status: "running",
            checkpoint: { ...cp, phase: "review" },
          };
        }, context);
        return;
      }

      // Check budget
      const budgetLimit = task.input.budgetLimit || 12;
      const currentAttempts = (doc.network_attempts || 0) + 1;
      if (currentAttempts > budgetLimit) {
        await runtime.commit(async (tx) => {
          const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          d.status = "budget_exceeded";
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                status: "budget_exceeded",
                published_cues: Object.values(d.published_cues || {}),
                failed_cues: d.source_cues
                  .map((c) => c.cue_id)
                  .filter((id) => !d.published_cues?.[id]),
              },
            },
          };
        }, context);
        return;
      }

      // Generate translation draft
      const draft = await translationDraft(block, doc, currentAttempts, TaskMocks.get(task.id));

      await runtime.commit(async (tx) => {
        const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
        d.network_attempts = currentAttempts;
        d.stage = "review";

        return {
          status: "running",
          checkpoint: {
            ...cp,
            phase: "review",
            draft,
            networkAttempts: currentAttempts,
          },
        };
      }, context);
    },

    review: async (task, runtime, context) => {
      const cp = task.state.checkpoint;
      const block = cp.blocks[cp.blockIndex];
      const doc = await runtime.snapshot(SubtitleJobDoc, runtime.conversationId, context);

      if (!doc) throw new Error("Subtitle job document is missing");
      let reviewResult: ReviewResult = { passed: true, issues: [] };
      const mocks = TaskMocks.get(task.id);
      if (mocks?.reviewerMock) {
        reviewResult = await mocks.reviewerMock({
          cues: block.cues,
          draft: cp.draft || {},
          revisions: cp.revisions,
        });
      } else {
        reviewResult = await reviewTranslations(block.cues, cp.draft, {
          glossary: doc.glossary,
        });
      }

      if (reviewResult.passed) {
        await runtime.commit(async () => {
          return {
            status: "running",
            checkpoint: { ...cp, phase: "validate", issues: [] },
          };
        }, context);
        return;
      }

      // Review failed
      if (cp.revisions < 2) {
        // Directed revision (max 2 revisions)
        await runtime.commit(async () => {
          return {
            status: "running",
            checkpoint: {
              ...cp,
              phase: "revise",
              issues: reviewResult.issues,
            },
          };
        }, context);
      } else {
        // Reached max 2 revisions without passing -> mark block cues as failed!
        await runtime.commit(async (tx) => {
          const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
          markBlockFailed(d, block);
          return {
            status: "running",
            checkpoint: { ...nextBlockCheckpoint(cp), issues: [] },
          };
        }, context);
      }
    },

    revise: async (task, runtime, context) => {
      const cp = task.state.checkpoint;
      const block = cp.blocks[cp.blockIndex];

      let revisedDraft = { ...cp.draft };
      const mocks = TaskMocks.get(task.id);
      if (mocks?.revisorMock) {
        revisedDraft = await mocks.revisorMock({
          cues: block.cues,
          draft: cp.draft || {},
          issues: cp.issues,
          revisions: cp.revisions + 1,
        });
      } else {
        revisedDraft = reviseDefaultDraft(block.cues, cp.draft);
      }

      await runtime.commit(async () => {
        return {
          status: "running",
          checkpoint: {
            ...cp,
            phase: "review",
            draft: revisedDraft,
            revisions: cp.revisions + 1,
          },
        };
      }, context);
    },

    validate: async (task, runtime, context) => {
      const cp = task.state.checkpoint;
      const block = cp.blocks[cp.blockIndex];
      const validation = validateOutputMapping(block.cues, cp.draft);

      if (!validation.valid) {
        if (cp.revisions < 2) {
          await runtime.commit(async () => {
            return {
              status: "running",
              checkpoint: {
                ...cp,
                phase: "revise",
                revisions: cp.revisions + 1,
                issues: validation.errors.map((e) => ({
                  cue_id: block.cues[0]?.cue_id,
                  reason: "validation_error",
                  details: e,
                })),
              },
            };
          }, context);
          return;
        } else {
          // Validation failed after max revisions
          await runtime.commit(async (tx) => {
            const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
            markBlockFailed(d, block);
            return {
              status: "running",
              checkpoint: nextBlockCheckpoint(cp),
            };
          }, context);
          return;
        }
      }

      // Valid: Commit published cues and update glossary
      await runtime.commit(async (tx) => {
        const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
        for (const cue of validation.orderedCues || []) {
          d.published_cues[cue.cue_id] = cue;
          if (cue.text.includes("database transaction")) {
            d.glossary["transaction"] = "事务";
          }
          if (cue.text.includes("embedding")) {
            d.glossary["embedding"] = "嵌入";
          }
        }

        return {
          status: "running",
          checkpoint: { ...nextBlockCheckpoint(cp), issues: [] },
        };
      }, context);
    },

    publish: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
        const total = d.source_cues.length;
        const publishedCount = Object.keys(d.published_cues || {}).length;
        const failedCount = (d.failed_cues || []).length;

        let status = "succeeded";
        if (failedCount > 0 && publishedCount > 0) {
          status = "partial";
        } else if (failedCount > 0 && publishedCount === 0) {
          status = "failed";
        }

        d.status = status;
        d.stage = "published";

        const orderedResult = d.source_cues.map((c, idx) => {
          const pub = d.published_cues[c.cue_id];
          return {
            index: idx,
            cue_id: c.cue_id,
            start: c.start,
            end: c.end,
            text: c.text,
            translation: pub ? pub.translation : "",
          };
        });

        d.final_result = {
          status,
          total_cues: total,
          failed_cues: failedCount,
          published_cues: publishedCount,
          cues: orderedResult,
        };

        return {
          status: "terminal",
          outcome: {
            status: "completed",
            result: d.final_result,
          },
        };
      }, context);
    },
  },

  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const d = await tx.doc(SubtitleJobDoc, runtime.conversationId);
      d.status = "cancelled";
      d.cancelled = true;

      return {
        status: "terminal",
        outcome: {
          status: "aborted",
          result: {
            cancelled: true,
            published_cues: Object.values(d.published_cues || {}),
          },
        },
      };
    }, context);
  },
});
