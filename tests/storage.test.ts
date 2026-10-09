import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { StorageOwnershipManager, StorageOwnershipConflictError } from "../worker/storage.js";

test("storage recovers corrupt, dead, and same-worker locks without touching active foreign ownership", t => {
  const directory = fs.mkdtempSync("./tmp/ownership-");
  const manager = new StorageOwnershipManager(`${directory}/storage.db`, "unit-worker");
  try {
    for (const previous of ["invalid", "null", JSON.stringify({ workerId: "dead", pid: 2147483647 }), JSON.stringify({ workerId: "unit-worker", pid: process.pid }), JSON.stringify({ workerId: "dead" })]) {
      fs.writeFileSync(manager.lockPath, previous);
      manager.acquire();
      assert.equal(manager.acquired, true);
      assert.equal(JSON.parse(fs.readFileSync(manager.lockPath, "utf8")).workerId, "unit-worker");
      manager.release(); assert.equal(manager.acquired, false); assert.equal(fs.existsSync(manager.lockPath), false);
      manager.release();
    }
    const errors: string[] = [];
    t.mock.method(console, "error", (message: string) => errors.push(message));
    const foreign = JSON.stringify({ workerId: "foreign", pid: process.pid });
    fs.writeFileSync(manager.lockPath, foreign);
    assert.throws(() => manager.acquire(), StorageOwnershipConflictError);
    assert.equal(fs.readFileSync(manager.lockPath, "utf8"), foreign);
    assert.equal(errors.length, 1); assert.match(errors[0], /foreign/);
  } finally { manager.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});
