// Cross-process directory lock shared by every SwarmForge helper.
// Protocol (docs/runtime-contract.md §4):
//   acquire: mkdir <lock>; then atomically write <lock>/owner = "<pid>\n"
//   release: rm -r <lock>
//   stale:   owner pid is dead, or owner is missing and the dir is older than ORPHAN_MS;
//            a waiter renames the dir aside, deletes it, and retries.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.ts";
import { sleepSync } from "./sleep.ts";

export const POLL_MS = 50;
export const ORPHAN_MS = 10_000;

const held = new Set<string>();
let hooksInstalled = false;

function releaseAllHeld(): void {
  for (const dir of held) {
    rmSync(dir, { recursive: true, force: true });
  }
  held.clear();
}

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", releaseAllHeld);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    if (process.listenerCount(signal) > 0) continue;
    process.once(signal, () => {
      releaseAllHeld();
      process.kill(process.pid, signal);
    });
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockDir: string): number | undefined {
  try {
    const text = readFileSync(join(lockDir, "owner"), "utf8").trim();
    return /^[0-9]+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

export function lockStale(lockDir: string, now = Date.now()): boolean {
  try {
    const owner = readOwner(lockDir);
    if (owner !== undefined) return !pidAlive(owner);
    return now - statSync(lockDir).mtimeMs > ORPHAN_MS;
  } catch {
    return false;
  }
}

function reclaim(lockDir: string): void {
  const grave = join(
    dirname(lockDir),
    `${basename(lockDir)}.stale.${process.pid}.${process.hrtime.bigint()}`,
  );
  try {
    renameSync(lockDir, grave);
    rmSync(grave, { recursive: true, force: true });
  } catch {}
}

function tryCreate(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function acquireDirLock(lockDir: string): void {
  mkdirSync(dirname(lockDir), { recursive: true });
  installExitHooks();
  while (!tryCreate(lockDir)) {
    if (lockStale(lockDir)) reclaim(lockDir);
    sleepSync(POLL_MS);
  }
  held.add(lockDir);
  writeFileAtomic(join(lockDir, "owner"), `${process.pid}\n`);
}

export function releaseDirLock(lockDir: string): void {
  held.delete(lockDir);
  rmSync(lockDir, { recursive: true, force: true });
}

export function withDirLock<T>(lockDir: string, fn: () => T): T {
  acquireDirLock(lockDir);
  try {
    return fn();
  } finally {
    releaseDirLock(lockDir);
  }
}
