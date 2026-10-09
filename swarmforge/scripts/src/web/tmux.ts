// tmux access for the dashboard, with the SWARMFORGE_TMUX_STUB recorder used by tests.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { eprintln } from "../core/cli.ts";
import { run } from "../core/proc.ts";
import { sleepSync } from "../core/sleep.ts";
import { isBlank } from "../core/text.ts";
import { masterRow, paneTarget, roleRow, sessionName, tmuxSocket, type Row } from "./files.ts";

export const PANE_CAPTURE_LINES = 2000;

/** Test seams: overrides for the tmux recorder and the captured pane text. */
export const seams: { tmuxStub?: string; paneText?: string } = {};

const tmuxStub = (): string | undefined => seams.tmuxStub ?? (process.env.SWARMFORGE_TMUX_STUB || undefined);

/** Append argv as one JSON array per line. */
function recordArgv(file: string, argv: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(argv)}\n`);
}

function sendKeys(socket: string, target: string, ...keys: string[]): void {
  const argv = ["tmux", "-S", socket, "send-keys", "-t", target, ...keys];
  const stub = tmuxStub();
  if (stub) {
    recordArgv(stub, argv);
    return;
  }
  const result = run(argv[0]!, argv.slice(1));
  if (result.exit !== 0) throw new Error("tmux send-keys failed");
}

export function injectTarget(socket: string, target: string, text: string): void {
  if (isBlank(text)) return;
  sendKeys(socket, target, "-l", text);
  if (!tmuxStub()) sleepSync(150);
  sendKeys(socket, target, "C-m");
  if (!tmuxStub()) sleepSync(50);
  sendKeys(socket, target, "C-j");
}

export function injectRole(root: string, role: string | undefined, text: string): void {
  try {
    const socket = tmuxSocket(root);
    const row = roleRow(root, role);
    const target = row ? paneTarget(row) : undefined;
    if (!socket || !target) throw new Error("missing tmux target");
    injectTarget(socket, target, text);
  } catch (error) {
    eprintln(`inject failed role=${role} socket=${tmuxSocket(root)} error=${(error as Error).message}`);
  }
}

export function injectMaster(root: string, text: string): void {
  const row = masterRow(root);
  if (row) injectRole(root, row[0], text);
}

export function sessionAlive(socket: string | undefined, session: string | undefined): boolean {
  if (!socket || !session) return false;
  return run("tmux", ["-S", socket, "has-session", "-t", session]).exit === 0;
}

export function tmuxCapture(socket: string, target: string): string | undefined {
  const result = run("tmux", ["-S", socket, "capture-pane", "-p", "-t", target, "-S", `-${PANE_CAPTURE_LINES}`]);
  return result.exit === 0 ? result.out : undefined;
}

export function capturePane(root: string, row: Row): string | undefined {
  const socket = tmuxSocket(root);
  if (!socket) return undefined;
  return tmuxCapture(socket, paneTarget(row)) ?? tmuxCapture(socket, sessionName(row));
}

export function listSessions(socket: string | undefined): string[] {
  if (isBlank(socket)) return [];
  const result = run("tmux", ["-S", socket!, "list-sessions", "-F", "#{session_name}"]);
  return result.exit === 0 ? result.out.split("\n").filter((line) => line.trim() !== "") : [];
}

export function killAllSessionsOnSocket(socket: string | undefined): void {
  if (isBlank(socket)) return;
  for (const session of listSessions(socket)) {
    run("tmux", ["-S", socket!, "kill-session", "-t", `=${session}`]);
    run("tmux", ["-S", socket!, "kill-session", "-t", session]);
  }
  run("tmux", ["-S", socket!, "kill-server"]);
}
