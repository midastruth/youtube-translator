// POST /api/teardown: stop every project, the swarm, handoffd, tmux, and this server.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eprintln } from "../core/cli.ts";
import { run } from "../core/proc.ts";
import { tmuxSocket } from "./files.ts";
import * as forge from "./forge.ts";
import { killAllSessionsOnSocket, listSessions } from "./tmux.ts";

export const TEARDOWN_DELAY_MS = 250;
const scriptsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export function confirmTeardown(body: string | undefined): boolean {
  const text = (body ?? "").trim();
  if (text === "TEARDOWN") return true;
  try {
    return (JSON.parse(text) as { confirm?: unknown })?.confirm === "TEARDOWN";
  } catch {
    return false;
  }
}

const pidFile = (root: string): string => join(root, ".swarmforge", "pack_web.pid");

export function writePackWebPid(root: string): void {
  mkdirSync(join(root, ".swarmforge"), { recursive: true });
  writeFileSync(pidFile(root), `${process.pid}\n`);
}

function stopPackWeb(root: string): void {
  const file = pidFile(root);
  const pid = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (pid && pid !== String(process.pid)) run("kill", ["-TERM", pid]);
  rmSync(file, { force: true });
}

function swarmCleanup(root: string, socket: string | undefined): void {
  run(join(scriptsDir, "swarm-cleanup.sh"), [socket ?? "none", join(root, ".swarmforge", "window-ids"), ...listSessions(socket)]);
}

function closeSwarm(root: string): void {
  const bin = join(scriptsDir, "..", "..", "close-swarm");
  if (existsSync(bin)) run(bin, [root]);
  else swarmCleanup(root, tmuxSocket(root));
}

/** Seam for tests that need a failing teardown. */
export const teardownImpl = {
  run(root: string): void {
    if (forge.isForge(root)) forge.closeAllProjects(root);
    closeSwarm(root);
    run(join(scriptsDir, "stop_handoff_daemon.sh"), [root]);
    killAllSessionsOnSocket(tmuxSocket(root));
    stopPackWeb(root);
  },
};

/** Run teardown now; return false (after logging) on failure. */
export function runTeardownSync(root: string): boolean {
  try {
    teardownImpl.run(root);
    return true;
  } catch (error) {
    eprintln(`teardown failed root=${root} error=${(error as Error).message}`);
    return false;
  }
}

/** Run teardown after the response is flushed, then exit the server. */
export function scheduleTeardown(root: string): void {
  setTimeout(() => process.exit(runTeardownSync(root) ? 0 : 1), TEARDOWN_DELAY_MS);
}
