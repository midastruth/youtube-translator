// Shared inbox/queue primitives used by ready_for_next / done_with_current / swarm_handoff.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { headerMap } from "../core/text.ts";

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `*.handoff` regular files directly in `dir`, sorted by name. */
export function handoffFiles(dir: string): string[] {
  return entries(dir)
    .filter((name) => name.endsWith(".handoff"))
    .map((name) => join(dir, name))
    .filter(isFile);
}

/** `batch_*` directories directly in `dir`, sorted by name. */
export function batchDirs(dir: string): string[] {
  return entries(dir)
    .filter((name) => name.startsWith("batch_"))
    .map((name) => join(dir, name))
    .filter(isDir);
}

/** All `*.handoff` files under `dir`, recursively, skipping hidden entries (like `fs/glob`). */
export function recursiveHandoffFiles(dir: string, extension = ".handoff"): string[] {
  if (!isDir(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of entries(current)) {
      if (name.startsWith(".")) continue;
      const path = join(current, name);
      if (isDir(path)) walk(path);
      else if (name.endsWith(extension) && isFile(path)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

export function readHeaders(file: string): Map<string, string> {
  return headerMap(readFileSync(file, "utf8"));
}

export function inboxDirs(worktree = process.cwd()): { inbox: string; newDir: string; inProcess: string; completed: string } {
  const inbox = join(worktree, ".swarmforge", "handoffs", "inbox");
  return {
    inbox,
    newDir: join(inbox, "new"),
    inProcess: join(inbox, "in_process"),
    completed: join(inbox, "completed"),
  };
}

export function bulletList(paths: readonly string[]): string {
  return paths.map((path) => `- ${path}`).join("\n");
}

export { existsSync };
