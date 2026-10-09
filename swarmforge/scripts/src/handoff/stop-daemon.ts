// Port of stop_handoff_daemon.bb.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eprintln } from "../core/cli.ts";
import { pidAlive } from "../core/lock.ts";
import { sleepSync } from "../core/sleep.ts";

export const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 100;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {}
}

export function stop(projectRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  const daemonDir = join(projectRoot, ".swarmforge", "daemon");
  const pidFile = join(daemonDir, "handoffd.pid");
  const stopFile = join(daemonDir, "stop");
  mkdirSync(daemonDir, { recursive: true });
  if (!existsSync(stopFile)) writeFileSync(stopFile, "");
  if (existsSync(pidFile)) {
    const text = readFileSync(pidFile, "utf8").trim();
    if (/^[0-9]+$/.test(text)) {
      const pid = Number(text);
      if (pidAlive(pid)) {
        signal(pid, "SIGTERM");
        for (let waited = 0; waited < timeoutMs && pidAlive(pid); waited += POLL_MS) {
          sleepSync(POLL_MS);
        }
        if (pidAlive(pid)) {
          signal(pid, "SIGKILL");
          sleepSync(POLL_MS);
        }
      }
    }
    rmSync(pidFile, { force: true });
  }
  rmSync(stopFile, { force: true });
}

export function main(args: string[]): number {
  if (!args[0]) {
    eprintln("Usage: stop_handoff_daemon.sh <project-root>");
    return 1;
  }
  stop(args[0]);
  return 0;
}
