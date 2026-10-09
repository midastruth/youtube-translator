import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { calculateJobKey } from "../worker/keys.js";
import { partitionCuesIntoBlocks } from "../worker/chunker.js";
import { validateOutputMapping } from "../worker/validator.js";
import { createWorkerServer } from "../worker/server.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { executeWithRetryAndBudget, NetworkError } from "../worker/network.js";

const cue = { cue_id: "c0", start: 100, end: 1100, text: "Hello" };

test("cache identity stays frozen across migration", () => {
  assert.equal(calculateJobKey({ videoId: "migration-video", sourceCues: [cue] }),
    "job:migration-video:8702a08ae1a75342b21ce2c4836358fdb3f9ffa93fef5680f86804a4b63d4b00");
  assert.notEqual(calculateJobKey({ sourceCues: [cue] }), calculateJobKey({ sourceCues: [{ ...cue, start: 101 }] }));
});

test("chunking retains each source once and continuous neighbours", () => {
  const cues = [cue, { ...cue, cue_id: "c1", text: "Goodbye" }];
  const blocks = partitionCuesIntoBlocks(cues, { maxCuesPerBlock: 1 });
  assert.deepEqual(blocks.flatMap(b => b.cues), cues);
  assert.deepEqual(blocks[0].contextAfter, [cues[1]]);
  assert.deepEqual(blocks[1].contextBefore, [cue]);
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

test("plain transport errors retain authentication classification and Retry-After", async () => {
  let attempts = 0;
  await assert.rejects(executeWithRetryAndBudget(async () => {
    attempts++; throw { status: 401, message: "Denied" };
  }, { sleepFn: async () => {} }), error => error instanceof NetworkError && error.errorType === "auth_error");
  assert.equal(attempts, 1);
  const delays: number[] = [];
  let call = 0;
  const result = await executeWithRetryAndBudget(async () => {
    if (call++ === 0) throw { response: { status: 429, headers: { "retry-after": "0.25" } }, message: "Rate limited" };
    return "ok";
  }, { sleepFn: async ms => { delays.push(ms); } });
  assert.equal(result, "ok"); assert.deepEqual(delays, [250]);
});

test("a missing completion document remains a failed job, never empty success", async () => {
  const directory = await fs.mkdtemp("./tmp/missing-document-");
  const worker = new AgentWorker({ storagePath: `${directory}/db.sqlite` });
  try {
    await worker.start();
    assert.ok(worker.harness);
    worker.harness.snapshot = async () => undefined;
    const job = await worker.submitOrAttachJob({ cues: [cue] });
    await job.taskPromise;
    assert.equal(job.status, "failed");
    assert.ok(job.error instanceof Error);
    assert.equal(job.finalResult, undefined);
  } finally { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("durable lookup restores the committed job without changing stored metadata", async () => {
  const directory = await fs.mkdtemp("./tmp/restore-job-");
  const worker = new AgentWorker({ storagePath: `${directory}/db.sqlite` });
  try {
    assert.equal(await worker.getJob("absent"), null);
    await worker.start();
    const job = await worker.submitOrAttachJob({ cues: [cue], videoId: "video", translatorMock: async () => ({ c0: "你好" }) });
    await job.taskPromise;
    assert.equal(await worker.getJob(job.jobId), job);
    worker.jobs.clear();
    const restored = await worker.getJob(job.conversationId);
    assert.ok(restored);
    assert.equal(restored.jobKey, job.jobKey); assert.equal(restored.videoId, "video");
    assert.equal(restored.jobId, `job-${job.conversationId}`);
    assert.deepEqual(restored.cues, [cue]); assert.equal(restored.status, "succeeded");
    assert.equal(await worker.getJob("absent"), null);
  } finally { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("a task exhausting its block budget retains already published cues", async () => {
  const directory = await fs.mkdtemp("./tmp/budget-job-");
  const worker = new AgentWorker({ storagePath: `${directory}/db.sqlite` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ cues: [cue, { ...cue, cue_id: "c1" }], budgetLimit: 1, maxCuesPerBlock: 1,
      translatorMock: async ({ cues }) => Object.fromEntries(cues.map(cue => [cue.cue_id, "译"])),
      reviewerMock: async () => ({ passed: true, issues: [] }),
    });
    await job.taskPromise;
    assert.equal(job.status, "budget_exceeded"); assert.equal(job.error, undefined);
    assert.ok(worker.harness);
    const { SubtitleJobDoc } = await import("../worker/task-definition.js");
    const doc = await worker.harness.snapshot(SubtitleJobDoc, job.conversationId, worker.context);
    assert.equal(doc?.network_attempts, 1);
    assert.deepEqual(doc?.published_cues.c0, { ...cue, translation: "译" });
    assert.equal(doc?.published_cues.c1, undefined);
  } finally { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("stream cardinality is captured before the asynchronous snapshot", async t => {
  const directory = await fs.mkdtemp("./tmp/stream-cardinality-");
  const worker = new AgentWorker({ storagePath: `${directory}/db.sqlite` });
  try {
    await worker.start();
    const job = await worker.submitOrAttachJob({ cues: [cue], translatorMock: async () => ({ c0: "你好" }) });
    await job.taskPromise;
    assert.ok(worker.harness);
    const snapshot = worker.harness.snapshot.bind(worker.harness);
    t.mock.method(worker.harness, "snapshot", async (...args: Parameters<typeof snapshot>) => {
      const doc = await snapshot(...args);
      job.cues.push({ ...cue, cue_id: "c1" });
      return doc;
    });
    const stream = worker.observeJobStream(job);
    const meta = await stream.next();
    assert.equal(job.cues.length, 2); assert.equal(meta.value?.total_cues, 1);
    await stream.return(undefined);
  } finally { await worker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("HTTP snapshot reads the committed document, not a missing definition", async () => {
  await fs.mkdir("./tmp", { recursive: true });
  const directory = await fs.mkdtemp("./tmp/worker-unit-");
  const { server, worker } = await createWorkerServer({ storagePath: `${directory}/db.sqlite`, port: 0 });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const job = await worker.submitOrAttachJob({ cues: [cue], translatorMock: async () => ({ c0: "你好" }), reviewerMock: async () => ({ passed: true, issues: [] }) });
    await job.taskPromise;
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/jobs/${job.jobId}`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.status, "succeeded");
    assert.deepEqual(snapshot.published_cues, [{ ...cue, translation: "你好" }]);
    assert.deepEqual(snapshot.final_result.cues, [{ index: 0, ...cue, translation: "你好" }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
