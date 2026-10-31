import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { calculateJobKey } from "../worker/keys.js";
import { validateOutputMapping } from "../worker/validator.js";
import { createWorkerServer } from "../worker/server.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { SubtitleJobDoc } from "../worker/job-document.js";
import { TranslationTeamTask } from "../worker/translation-team.js";

const cue = { cue_id: "c0", start: 100, end: 1100, text: "Hello" };

async function completedJob(worker: AgentWorker) {
  assert.ok(worker.harness);
  const conversation = await worker.harness.createConversation({ ownership: { kind: "ownerless" } }, worker.context);
  await conversation.commit(async tx => {
    const doc = await tx.doc(SubtitleJobDoc, conversation.id);
    doc.job_id = "completed-team-job"; doc.job_key = "team-key"; doc.engine = "document";
    doc.video_id = "video"; doc.source_cues = [cue]; doc.status = "succeeded";
    doc.published_cues = { c0: { ...cue, index: 0, translation: "你好" } };
    doc.final_result = { status: "succeeded", total_cues: 1, failed_cues: 0, published_cues: 1, cues: Object.values(doc.published_cues) };
  }, worker.context);
  const job = await worker.getJob(conversation.id);
  assert.ok(job);
  return job;
}

test("document cache identity is deterministic and includes source timing", () => {
  assert.equal(calculateJobKey({ videoId: "migration-video", sourceCues: [cue] }),
    "job:migration-video:2cad9ed3c4483863960b8dd1517e31ae5d0c89e198553c14254dae2b1a337de8");
  assert.notEqual(calculateJobKey({ sourceCues: [cue] }), calculateJobKey({ sourceCues: [{ ...cue, start: 101 }] }));
});

test("validation preserves milliseconds and rejects missing, duplicate, and non-string mappings", () => {
  const valid = validateOutputMapping([cue], { c0: "你好" });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.orderedCues, [{ ...cue, translation: "你好" }]);
  for (const output of [[], [{ cue_id: "c0", translation: 42 }], [
    { cue_id: "c0", translation: "你好" }, { cue_id: "c0", translation: "你好" },
  ]]) assert.equal(validateOutputMapping([cue], output).valid, false);
});

test("an unopened worker remains inspectable and reports not ready", async () => {
  const worker = new AgentWorker();
  assert.equal(worker.harness, null);
  assert.deepEqual(await worker.readinessCheck(), { ready: false, reason: "harness_not_open" });
  await worker.close();
  assert.equal(worker.harness, null);
});

test("removed engines are rejected before creating tasks or requesting a model", async () => {
  const worker = new AgentWorker();
  for (const engine of ["agent", "legacy", "subtitle_editing_agent", "unknown"]) {
    await assert.rejects(worker.submitOrAttachJob({ engine, cues: [cue] }), /only supports the document engine/);
  }
  assert.equal(worker.jobs.size, 0);
  assert.equal(worker.pendingJobs.size, 0);
});

test("worker registers only the translation team and restores its committed metadata", async () => {
  await fs.mkdir("./tmp", { recursive: true });
  const directory = await fs.mkdtemp("./tmp/restore-job-");
  const worker = new AgentWorker({ storagePath: `${directory}/db.sqlite` });
  try {
    assert.equal(await worker.getJob("absent"), null);
    await worker.start();
    assert.deepEqual(worker.extension?.tasks, [TranslationTeamTask]);
    const job = await completedJob(worker);
    assert.equal(await worker.getJob(job.jobId), job);
    worker.jobs.clear();
    const restored = await worker.getJob(job.conversationId);
    assert.ok(restored);
    assert.equal(restored.jobKey, job.jobKey); assert.equal(restored.videoId, "video");
    assert.equal(restored.jobId, "completed-team-job");
    assert.deepEqual(restored.cues, [cue]); assert.equal(restored.status, "succeeded");
    assert.equal(await worker.getJob("absent"), null);
    const events = []; for await (const event of worker.observeJobStream(restored)) events.push(event);
    assert.equal(events[0].type, "meta"); assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.filter(e => e.type === "cue").length, 1);
  } finally { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("HTTP snapshot delegates to the worker's committed application view", async t => {
  await fs.mkdir("./tmp", { recursive: true });
  const directory = await fs.mkdtemp("./tmp/worker-unit-");
  const { server, worker } = await createWorkerServer({ storagePath: `${directory}/db.sqlite`, port: 0 });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const job = await completedJob(worker);
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/jobs/${job.jobId}`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.status, "succeeded");
    assert.deepEqual(snapshot.published_cues, [{ ...cue, index: 0, translation: "你好" }]);
    assert.deepEqual(snapshot.final_result.cues, snapshot.published_cues);

    assert.ok(worker.harness);
    t.mock.method(worker.harness, "snapshot", async () => undefined);
    assert.deepEqual(await worker.snapshotJob(job), {
      job_id: job.jobId, status: job.status, published_cues: [], failed_cues: [], final_result: undefined,
      token_usage: 0, token_budget_used: 0, token_budget_limit: 0,
    });
    const applicationView = { job_id: "application-id", status: "application-status", published_cues: [], failed_cues: [], final_result: undefined };
    t.mock.method(worker, "snapshotJob", async (observedJob: typeof job) => {
      assert.equal(observedJob, job);
      return applicationView;
    });
    const delegated = await fetch(`http://127.0.0.1:${address.port}/internal/jobs/${job.jobId}`);
    assert.equal(delegated.status, 200);
    assert.deepEqual(await delegated.json(), JSON.parse(JSON.stringify(applicationView)));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
