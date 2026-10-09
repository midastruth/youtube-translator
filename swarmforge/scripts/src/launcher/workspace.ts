// Git, worktrees, state files, hooks, tmux sessions (port of swarmforge.bb, part 3).

import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { run, runOut } from "../core/proc.ts";
import { sq, splitLines } from "../core/text.ts";
import { type Ctx, fail, RED, RESET } from "./context.ts";

export const PANE_HISTORY_LIMIT = 10000;
const AGENT_WINDOW = "swarm";

const shOut = (command: string, ...args: string[]): string => runOut(command, args);

function ensureInFile(file: string, pattern: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "");
  if (!new Set(splitLines(readFileSync(file, "utf8"))).has(pattern)) appendFileSync(file, `${pattern}\n`);
}

export function initializeGitRepo(ctx: Ctx): void {
  if (existsSync(join(ctx.workingDir, ".git"))) return;
  runOut("git", ["init", ctx.workingDir]);
  runOut("git", ["-C", ctx.workingDir, "branch", "-M", "master"]);
  const gitignore = join(ctx.workingDir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, ".swarmforge/\n.worktrees/\n");
  else {
    ensureInFile(gitignore, ".swarmforge/");
    ensureInFile(gitignore, ".worktrees/");
  }
  runOut("git", ["-C", ctx.workingDir, "add", "."]);
  runOut("git", ["-C", ctx.workingDir, "commit", "-m", "Initial swarmforge repository"]);
}

export function ensureRuntimeGitExcludes(ctx: Ctx): void {
  const exclude = shOut("git", "-C", ctx.workingDir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  ensureInFile(exclude, ".swarmforge/");
  ensureInFile(exclude, ".worktrees/");
}

export function gitHooksDir(ctx: Ctx): string {
  const path = shOut("git", "-C", ctx.workingDir, "rev-parse", "--git-path", "hooks");
  return isAbsolute(path) ? path : join(ctx.workingDir, path);
}

export function installCommitMsgHook(ctx: Ctx): void {
  const dir = gitHooksDir(ctx);
  const hook = join(dir, "commit-msg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(hook, `#!/usr/bin/env zsh\nset -euo pipefail\nexec ${sq(join(ctx.scriptDir, "commit-msg-hook.sh"))} "$@"\n`);
  chmodSync(hook, 0o755);
}

export const requiredHelpers = [
  "handoff_lib.sh", "swarm_handoff.sh", "swarm_tool.sh", "commit-msg-hook.sh", "merge_and_process.sh",
  "ready_for_next.sh", "done_with_current.sh", "ready_for_next_task.sh", "done_with_current_task.sh",
  "ready_for_next_batch.sh", "done_with_current_batch.sh", "handoffd.sh", "stop_handoff_daemon.sh",
  "swarm-cleanup.sh", "swarm-window-watchdog.sh", "swarm-terminal-adapter.sh", "swarmforge.sh",
  "pack_board.sh", "pack_web.sh", "pack_dashboard_request.sh",
];

const terminalHelpers = ["terminal-app.sh", "iterm2.sh", "ghostty.sh", "windows-terminal.sh", "none.sh"];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkHelperScripts(ctx: Ctx): void {
  for (const module of ["package.json", "src/bin/swarmforge.ts", "src/bin/handoffd.ts", "src/bin/pack-web.ts"]) {
    const path = join(ctx.scriptDir, module);
    if (!existsSync(path)) fail(`${RED}Error:${RESET} Required runtime module not found: ${path}`);
  }
  for (const helper of requiredHelpers) {
    const path = join(ctx.scriptDir, helper);
    if (!executable(path)) fail(`${RED}Error:${RESET} Required helper script not found or not executable: ${path}`);
  }
  for (const helper of terminalHelpers) {
    const path = join(ctx.scriptDir, "terminal-adapters", helper);
    if (!executable(path)) fail(`${RED}Error:${RESET} Required terminal adapter not found or not executable: ${path}`);
  }
}

export function writeSessionsFile(ctx: Ctx): void {
  writeFileSync(
    ctx.sessionsFile,
    ctx.roles.map((row, i) => `${i + 1}\t${row.role}\t${row.session}\t${row.displayName}\t${row.agent}\n`).join(""),
  );
}

export function writeRolesFile(ctx: Ctx): void {
  writeFileSync(
    ctx.rolesFile,
    ctx.roles
      .map((r) =>
        `${[r.role, r.worktreeName, r.worktreePath, r.session, r.displayName, r.agent, r.receiveMode, r.propagation].join("\t")}\n`,
      )
      .join(""),
  );
}

export function prepareWorkspace(ctx: Ctx): void {
  for (const dir of [ctx.stateDir, ctx.notifyDir, ctx.promptsDir, ctx.worktreesDir, ctx.tmuxSocketDir, ctx.daemonDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(ctx.tmuxSocketFile, `${ctx.tmuxSocket}\n`);
  checkHelperScripts(ctx);
  writeSessionsFile(ctx);
  writeRolesFile(ctx);
}

export function prepareWorktrees(ctx: Ctx): void {
  for (const row of ctx.roles) {
    if (row.worktreeName === "none" || row.worktreeName === "master") continue;
    if (existsSync(join(row.worktreePath, ".git"))) continue;
    runOut("git", ["-C", ctx.workingDir, "worktree", "add", "--force", "-B", `swarmforge-${row.worktreeName}`, row.worktreePath, "HEAD"]);
  }
}

export function prepareHandoffDirs(ctx: Ctx): void {
  for (const row of ctx.roles) {
    for (const dir of ["outbox/tmp", "sent", "failed", "inbox/new", "inbox/in_process", "inbox/completed"]) {
      mkdirSync(join(row.worktreePath, ".swarmforge", "handoffs", dir), { recursive: true });
    }
  }
}

function writeTmuxEnvFile(ctx: Ctx): void {
  writeFileSync(
    ctx.tmuxEnvFile,
    `${shOut("tmux", "-S", ctx.tmuxSocket, "display-message", "-p", "#{socket_path},#{pid},#{pane_id}")}\n`,
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function copyTreeInto(src: string, dest: string): void {
  if (!isDir(src)) return;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

function syncWorktreeRoles(ctx: Ctx, worktree: string): void {
  copyTreeInto(ctx.rolesDir, join(worktree, "swarmforge", "roles"));
  copyTreeInto(join(ctx.swarmForgeDir, "constitution"), join(worktree, "swarmforge", "constitution"));
  if (existsSync(ctx.constitutionFile)) {
    mkdirSync(join(worktree, "swarmforge"), { recursive: true });
    copyFileSync(ctx.constitutionFile, join(worktree, "swarmforge", "constitution.prompt"));
  }
}

export function syncWorktreeScripts(ctx: Ctx): void {
  for (const row of ctx.roles) {
    if (row.worktreePath === ctx.workingDir) continue;
    const scriptsDir = join(row.worktreePath, "swarmforge", "scripts");
    const stateDir = join(row.worktreePath, ".swarmforge");
    mkdirSync(scriptsDir, { recursive: true });
    for (const name of readdirSync(ctx.scriptDir)) {
      if (name === "node_modules") continue;
      cpSync(join(ctx.scriptDir, name), join(scriptsDir, name), { recursive: true, force: true });
    }
    syncWorktreeRoles(ctx, row.worktreePath);
    mkdirSync(join(stateDir, "notify"), { recursive: true });
    copyFileSync(ctx.sessionsFile, join(stateDir, "sessions.tsv"));
    copyFileSync(ctx.rolesFile, join(stateDir, "roles.tsv"));
    copyFileSync(ctx.tmuxSocketFile, join(stateDir, "tmux-socket"));
    copyFileSync(ctx.tmuxEnvFile, join(stateDir, "tmux-env"));
  }
}

function tmuxOption(socket: string, option: string, scope: "session" | "window", fallback: number): number {
  const flag = scope === "session" ? "-gqv" : "-gwqv";
  const value = run("tmux", ["-S", socket, "show-options", flag, option]).out.trim();
  return /^[0-9]+$/.test(value) ? Number(value) : fallback;
}

export function detectTmuxBaseIndexes(ctx: Ctx): Ctx {
  mkdirSync(ctx.tmuxSocketDir, { recursive: true });
  let probe: string | undefined;
  if (run("tmux", ["-S", ctx.tmuxSocket, "info"]).exit !== 0) {
    probe = `swarmforge-probe-${process.pid}`;
    runOut("tmux", ["-S", ctx.tmuxSocket, "new-session", "-d", "-s", probe, "sleep 60"]);
  }
  const tmuxWindowBaseIndex = tmuxOption(ctx.tmuxSocket, "base-index", "session", 0);
  const tmuxPaneBaseIndex = tmuxOption(ctx.tmuxSocket, "pane-base-index", "window", 0);
  if (probe) run("tmux", ["-S", ctx.tmuxSocket, "kill-session", "-t", probe]);
  return { ...ctx, tmuxWindowBaseIndex, tmuxPaneBaseIndex };
}

export function createRoleSession(socket: string, session: string, title: string): void {
  runOut("tmux", ["-S", socket, "new-session", "-d", "-s", session, "-n", AGENT_WINDOW]);
  runOut("tmux", ["-S", socket, "set-option", "-t", session, "history-limit", String(PANE_HISTORY_LIMIT)]);
  runOut("tmux", ["-S", socket, "rename-window", "-t", `${session}:${AGENT_WINDOW}`, title]);
  runOut("tmux", ["-S", socket, "set-window-option", "-t", `${session}:${title}`, "allow-rename", "off"]);
}

export function bootSessions(ctx: Ctx): void {
  for (const row of ctx.roles) createRoleSession(ctx.tmuxSocket, row.session, row.displayName);
  writeTmuxEnvFile(ctx);
}
