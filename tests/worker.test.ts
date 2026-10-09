import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { calculateJobKey } from "../worker/keys.js";
import { partitionCuesIntoBlocks } from "../worker/chunker.js";
import { validateOutputMapping } from "../worker/validator.js";
import { createWorkerServer } from "../worker/server.js";
import { AgentWorker } from "../worker/agent-worker.js";

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
