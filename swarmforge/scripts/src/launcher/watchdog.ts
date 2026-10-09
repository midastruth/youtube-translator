// Port of swarm_window_watchdog.bb: reopen closed terminal windows; tear down the swarm when
// the cleanup-owner window stays closed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "../core/proc.ts";
import { isBlank, splitLines } from "../core/text.ts";
import { terminalOk, terminalOut, type TerminalContext } from "./terminal.ts";

export const MISSING_THRESHOLD = 3;
const POLL_MS = 2000;
const scriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface WindowRow {
  index: string;
  windowId: string;
  session: string;
  title: string;
}

export function readRows(file: string): WindowRow[] {
  if (!existsSync(file)) return [];
  return splitLines(readFileSync(file, "utf8"))
    .filter((line) => !isBlank(line))
    .map((line) => {
      const [index = "", windowId = "", session = "", title = ""] = line.split("\t");
      return { index, windowId, session, title };
    });
}

function writeRows(stateFile: string, idsFile: string, rows: WindowRow[]): void {
  writeFileSync(stateFile, rows.map((r) => `${r.index}\t${r.windowId}\t${r.session}\t${r.title}\n`).join(""));
  writeFileSync(idsFile, rows.map((r) => `${r.windowId}\n`).join(""));
}

export function rewriteWindowId(stateFile: string, idsFile: string, targetIndex: string, replacementId: string): void {
  writeRows(
    stateFile,
    idsFile,
    readRows(stateFile).map((row) => (row.index === targetIndex ? { ...row, windowId: replacementId } : row)),
  );
}

export interface WatchdogEffects {
  sessionExists(session: string): boolean;
  windowExists(id: string): boolean;
  openWindow(session: string, title: string, ownerId: string): string;
  stopDaemon(): void;
  killSession(session: string): void;
  closeWindow(id: string): void;
}

function defaultEffects(ctx: TerminalContext): WatchdogEffects {
  return {
    sessionExists: (session) => run("tmux", ["-S", ctx.tmuxSocket, "has-session", "-t", session]).exit === 0,
    windowExists: (id) => terminalOk(ctx, "terminal_window_exists", id),
    openWindow: (session, title, ownerId) => terminalOut(ctx, "terminal_open_session", session, title, ownerId),
    stopDaemon: () => { run(join(ctx.scriptDir, "stop_handoff_daemon.sh"), [ctx.workingDir]); },
    killSession: (session) => { run("tmux", ["-S", ctx.tmuxSocket, "kill-session", "-t", session]); },
    closeWindow: (id) => { terminalOk(ctx, "terminal_close_window", id); },
  };
}

function killAllSessions(stateFile: string, effects: WatchdogEffects): void {
  effects.stopDaemon();
  const rows = readRows(stateFile);
  for (const { session } of rows) if (!isBlank(session)) effects.killSession(session);
  for (const { windowId } of rows) if (!isBlank(windowId)) effects.closeWindow(windowId);
}

/** One watchdog pass. Returns false when the swarm was torn down or there is nothing to watch. */
function checkOwnerWindow(
  stateFile: string,
  owner: WindowRow,
  missing: Map<string, number>,
  effects: WatchdogEffects,
): boolean {
  if (effects.windowExists(owner.windowId)) {
    missing.set(owner.index, 0);
    return true;
  }
  const count = (missing.get(owner.index) ?? 0) + 1;
  if (count >= MISSING_THRESHOLD) {
    killAllSessions(stateFile, effects);
    return false;
  }
  missing.set(owner.index, count);
  return true;
}

function checkWorkerRow(
  stateFile: string,
  idsFile: string,
  row: WindowRow,
  ownerWindowId: string,
  missing: Map<string, number>,
  effects: WatchdogEffects,
): void {
  if (effects.windowExists(row.windowId)) {
    missing.set(row.index, 0);
    return;
  }
  const count = (missing.get(row.index) ?? 0) + 1;
  if (count < MISSING_THRESHOLD) {
    missing.set(row.index, count);
    return;
  }
  const newId = effects.openWindow(row.session, row.title, ownerWindowId);
  if (!isBlank(newId)) rewriteWindowId(stateFile, idsFile, row.index, newId);
  missing.set(row.index, 0);
}

/** One watchdog pass. Returns false when the swarm was torn down or there is nothing to watch. */
export function watchOnce(
  ctx: TerminalContext,
  stateFile: string,
  idsFile: string,
  ownerIndex: string,
  missing: Map<string, number>,
  effects: WatchdogEffects = defaultEffects(ctx),
): boolean {
  if (!existsSync(stateFile)) return false;
  const rows = readRows(stateFile);
  const owner = rows.find((row) => row.index === ownerIndex);
  if (!owner || !effects.sessionExists(owner.session)) return false;
  if (!checkOwnerWindow(stateFile, owner, missing, effects)) return false;
  for (const row of rows) {
    if (row.index !== ownerIndex && effects.sessionExists(row.session)) {
      checkWorkerRow(stateFile, idsFile, row, owner.windowId, missing, effects);
    }
  }
  return true;
}
export function watchdogContext(workingDir: string, tmuxSocket: string, backend?: string): TerminalContext {
  return { scriptDir, workingDir, tmuxSocket, terminalBackend: backend || "terminal-app" };
}

export async function main(args: string[]): Promise<number> {
  if (args[0] === "--rewrite-window-id") {
    const [, state, ids, target, replacement] = args;
    rewriteWindowId(state ?? "", ids ?? "", target ?? "", replacement ?? "");
    return 0;
  }
  const [stateFile = "", idsFile = "", ownerIndex = "", tmuxSocket = "", workingDir = "", backend] = args;
  const ctx = watchdogContext(workingDir, tmuxSocket, backend);
  const missing = new Map<string, number>();
  while (watchOnce(ctx, stateFile, idsFile, ownerIndex, missing)) await sleep(POLL_MS);
  return 0;
}
