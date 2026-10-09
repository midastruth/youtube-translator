import fs from "node:fs";
import path from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export class StorageOwnershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageOwnershipConflictError";
  }
}

export class StorageOwnershipManager {
  storagePath: string;
  workerId: string;
  lockPath: string;
  acquired: boolean;
  constructor(storagePath: string, workerId = `worker-${process.pid}`) {
    this.storagePath = path.resolve(storagePath);
    this.workerId = workerId;
    this.lockPath = `${this.storagePath}.owner`;
    this.acquired = false;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });

    this.removeStaleOwner();

    try {
      const lockData = {
        workerId: this.workerId,
        pid: process.pid,
        time: Date.now(),
      };
      fs.writeFileSync(this.lockPath, JSON.stringify(lockData), { flag: "wx" });
      this.acquired = true;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "EEXIST") {
        const conflictMsg = `Storage ownership conflict: storage ${this.storagePath} is already owned by another worker`;
        console.error(conflictMsg);
        throw new StorageOwnershipConflictError(conflictMsg);
      }
      throw err;
    }
  }

  private removeStaleOwner() {
    if (!fs.existsSync(this.lockPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, "utf-8"));
      if (data.workerId !== this.workerId && ownerIsAlive(data)) {
        const message = `Storage ownership conflict: storage ${this.storagePath} is already owned by worker ${data.workerId} (pid ${data.pid})`;
        console.error(message);
        throw new StorageOwnershipConflictError(message);
      }
      this.unlinkOwner();
    } catch (error) {
      if (error instanceof StorageOwnershipConflictError) throw error;
      this.unlinkOwner();
    }
  }

  private unlinkOwner() {
    try { fs.unlinkSync(this.lockPath); } catch { /* Already removed or inaccessible. */ }
  }

  release() {
    if (this.acquired && fs.existsSync(this.lockPath)) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
      this.acquired = false;
    }
  }
}

function ownerIsAlive(owner: { pid?: number }) {
  try {
    if (!owner.pid) return false;
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function openOwnedSqliteStorage(storagePath: string, workerId: string) {
  const manager = new StorageOwnershipManager(storagePath, workerId);
  manager.acquire();

  try {
    const storage = await openNodeSqliteStorage(storagePath);
    const originalClose = storage.close.bind(storage);
    storage.close = async (context) => {
      try {
        await originalClose(context);
      } finally {
        manager.release();
      }
    };
    return { storage, ownershipManager: manager };
  } catch (err) {
    manager.release();
    throw err;
  }
}
