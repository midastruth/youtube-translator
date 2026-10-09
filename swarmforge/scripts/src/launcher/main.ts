// Port of swarmforge.bb: start a pack swarm, a forge host, or a forge project.

import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { println } from "../core/cli.ts";
import { commandExists, run, runInteractive, runOut, spawnBackground } from "../core/proc.ts";
import { sleepSync } from "../core/sleep.ts";
import { isBlank, splitLines } from "../core/text.ts";
import { ensureCodexTrust, launchCommand } from "./agents.ts";
import {
  BOLD, type Ctx, context, CYAN, detectTerminalBackend, envLong, fail, GREEN, lieutenantRow, prepareCtx, RED, RESET,
  type RoleRow, YELLOW,
} from "./context.ts";
import { terminalOk, terminalOut } from "./terminal.ts";
import {
  bootSessions, detectTmuxBaseIndexes, ensureRuntimeGitExcludes, initializeGitRepo, installCommitMsgHook,
  prepareHandoffDirs, prepareWorkspace, prepareWorktrees, syncWorktreeScripts,
} from "./workspace.ts";

function checkDependency(command: string): void {
  if (!commandExists(command)) fail(`${RED}Error:${RESET} '${command}' is required but not installed.`);
}

function checkBackendDependencies(ctx: Ctx): void {
  for (const row of ctx.roles) checkDependency(row.agent);
}

export function stopHandoffDaemon(ctx: Ctx): void {
  run(join(ctx.scriptDir, "stop_handoff_daemon.sh"), [ctx.workingDir]);
}

function uname(): string {
  return run("uname", ["-s"]).out.trim();
}

function linuxSystemdRunning(): boolean {
  return ["running", "degraded"].includes(run("systemctl", ["is-system-running"]).out.trim());
}

/** Host facts that decide how to keep the machine awake; injectable for tests. */
export interface SleepProbes {
  os: () => string;
  has: (command: string) => boolean;
  systemdRunning: () => boolean;
}

const hostSleepProbes: SleepProbes = { os: uname, has: commandExists, systemdRunning: linuxSystemdRunning };
const CAFFEINATE = ["caffeinate", "-dims"];
const SYSTEMD_INHIBIT = ["systemd-inhibit", "--what=sleep:idle", "--who=SwarmForge", "--why=SwarmForge swarm is active"];

function linuxInhibitorAvailable(probes: SleepProbes): boolean {
  return probes.has("systemd-inhibit") && probes.has("systemctl") && probes.systemdRunning();
}

export function sleepInhibitorPrefix(probes: SleepProbes = hostSleepProbes): string[] {
  if (process.env.SWARMFORGE_PREVENT_SLEEP === "0") return [];
  const os = probes.os();
  if (os === "Darwin" && probes.has("caffeinate")) return CAFFEINATE;
  if (os === "Linux" && linuxInhibitorAvailable(probes)) return SYSTEMD_INHIBIT;
  return [];
}

function startHandoffDaemon(ctx: Ctx): void {
  rmSync(join(ctx.daemonDir, "stop"), { force: true });
  const command = [...sleepInhibitorPrefix(), join(ctx.scriptDir, "handoffd.sh"), ctx.workingDir];
  spawnBackground(command[0]!, command.slice(1), ctx.handoffDaemonLog);
  println(`${GREEN}Started handoff daemon${command.length > 2 ? " with OS sleep prevention" : ""}.${RESET}`);
}

const tmuxAgentTarget = (window: string, paneBase: number, session: string): string => `${session}:${window}.${paneBase}`;

function launchRole(ctx: Ctx, index: number, row: RoleRow): void {
  if (row.agent === "codex") ensureCodexTrust(row.worktreePath);
  const command = launchCommand(ctx, index, row);
  runOut("tmux", ["-S", ctx.tmuxSocket, "send-keys", "-t", tmuxAgentTarget(row.displayName, ctx.tmuxPaneBaseIndex, row.session), command, "Enter"]);
  println(`  ${CYAN}[${row.displayName}]${RESET} started in session ${row.session}`);
}

function launchRoles(ctx: Ctx): void {
  println(`${GREEN}Starting agents...${RESET}`);
  const delay = envLong("SWARMFORGE_AGENT_START_DELAY_MS", 1500);
  ctx.roles.forEach((row, index) => {
    if (index > 0) sleepSync(delay);
    launchRole(ctx, index, row);
  });
}

// ---------------------------------------------------------------- terminals

const skipTerminal = (row: RoleRow): boolean => !row.visible;
const tracksWindows = (ctx: Ctx): boolean => terminalOk(ctx, "terminal_backend_tracks_windows");

function recordWindow(ctx: Ctx, index: number, windowId: string, row: RoleRow): void {
  appendFileSync(ctx.windowIdsFile, `${windowId}\n`);
  appendFileSync(ctx.windowStateFile, `${index + 1}\t${windowId}\t${row.session}\tSwarmForge ${row.displayName}\n`);
}

function startWindowWatchdog(ctx: Ctx): void {
  spawnBackground(
    join(ctx.scriptDir, "swarm-window-watchdog.sh"),
    [ctx.windowStateFile, ctx.windowIdsFile, "1", ctx.tmuxSocket, ctx.workingDir, ctx.terminalBackend],
    ctx.windowWatchdogLog,
  );
}

export function openSessionsInTerminals(ctx: Ctx): void {
  println(`Opening separate ${terminalOut(ctx, "terminal_backend_label")} surfaces for each session...`);
  const tracking = tracksWindows(ctx);
  if (tracking) {
    writeFileSync(ctx.windowIdsFile, "");
    writeFileSync(ctx.windowStateFile, "");
  }
  let previous = "";
  ctx.roles.forEach((row, index) => {
    if (skipTerminal(row)) return;
    const windowId = terminalOut(ctx, "terminal_open_session", row.session, `SwarmForge ${row.displayName}`, previous);
    if (tracking) {
      recordWindow(ctx, index, windowId, row);
      previous = windowId;
    }
  });
  if (tracking) startWindowWatchdog(ctx);
  else {
    println(`${YELLOW}${terminalOut(ctx, "terminal_backend_label")} surfaces are not trackable; window watchdog is disabled for this backend.${RESET}`);
  }
}

function attachFallback(ctx: Ctx): void {
  const row = ctx.roles.find((r) => !skipTerminal(r)) ?? ctx.roles[0]!;
  println(`${YELLOW}No terminal backend found; attaching current shell to '${row.session}' instead.${RESET}`);
  runInteractive("tmux", ["-S", ctx.tmuxSocket, "attach-session", "-t", row.session]);
}

function openTerminalSurfaces(ctx: Ctx): void {
  if (ctx.roles.every(skipTerminal)) {
    writeFileSync(ctx.windowIdsFile, "");
    writeFileSync(ctx.windowStateFile, "");
    println(`${YELLOW}No visible Terminal surfaces; use the dashboard.${RESET}`);
  } else if (terminalOk(ctx, "terminal_backend_can_open_sessions")) {
    openSessionsInTerminals(ctx);
  } else {
    attachFallback(ctx);
  }
}

export function launchPlanLines(ctx: Ctx): string[] {
  return ["pack_web start", ...ctx.roles.map((row) => `${skipTerminal(row) ? "skip-terminal" : "open-terminal"} ${row.role}`)];
}

// ---------------------------------------------------------------- dashboard

const dashboardUrlFile = (ctx: Ctx): string => join(ctx.stateDir, "dashboard-url");
const packWebPidFile = (ctx: Ctx): string => join(ctx.stateDir, "pack_web.pid");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function stopExistingPackWeb(ctx: Ctx): void {
  const file = packWebPidFile(ctx);
  const pid = isFile(file) ? readFileSync(file, "utf8").trim() : "";
  if (pid) run("kill", ["-TERM", pid]);
  rmSync(file, { force: true });
  rmSync(dashboardUrlFile(ctx), { force: true });
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    sleepSync(50);
  }
  return true;
}

function startPackWeb(ctx: Ctx): string {
  stopExistingPackWeb(ctx);
  spawnBackground(join(ctx.scriptDir, "pack_web.sh"), ["--serve", ctx.workingDir], join(ctx.stateDir, "dashboard.log"));
  if (!waitForFile(dashboardUrlFile(ctx), 5000)) fail(`${RED}Error:${RESET} Dashboard did not start.`);
  const url = readFileSync(dashboardUrlFile(ctx), "utf8").trim();
  println(`${GREEN}Dashboard: ${url}${RESET}`);
  if (process.env.SWARMFORGE_OPEN_BROWSER !== "0" && commandExists("open")) run("open", [url]);
  return url;
}

// ---------------------------------------------------------------- run modes

function killExistingSessions(ctx: Ctx): void {
  for (const row of ctx.roles) {
    if (run("tmux", ["-S", ctx.tmuxSocket, "has-session", "-t", row.session]).exit === 0) {
      println(`${YELLOW}Existing SwarmForge session found: ${row.session}. Killing it...${RESET}`);
      runOut("tmux", ["-S", ctx.tmuxSocket, "kill-session", "-t", row.session]);
    }
  }
}

function announceReady(ctx: Ctx): void {
  println();
  println(`${GREEN}${BOLD}SwarmForge is ready.${RESET}`);
  println("Working directory:", ctx.workingDir);
  println("Sessions:");
  for (const row of ctx.roles) println(`  ${row.displayName}: ${row.session}`);
  println();
  println(`${GREEN}Tip: Write a handoff draft and run swarm_handoff.sh while the swarm is running.${RESET}`);
  println(`${GREEN}Tip: Reattach manually with 'tmux -S ${ctx.tmuxSocket} attach-session -t <session-name>' if needed.${RESET}`);
  println();
}

function banner(ctx: Ctx): void {
  println(`${CYAN}${BOLD}`);
  println("  SwarmForge v1.0 Starting");
  println("  Disciplined agents build better software");
  println(RESET);
  println(`${GREEN}Launching SwarmForge tmux sessions...${RESET}`);
  bootSessions(ctx);
}

function checkCoreDependencies(): void {
  for (const command of ["tmux", "git", "node"]) checkDependency(command);
}

function prepareSwarm(root: string): Ctx {
  checkCoreDependencies();
  let ctx = detectTmuxBaseIndexes(context(root));
  initializeGitRepo(ctx);
  ensureRuntimeGitExcludes(ctx);
  installCommitMsgHook(ctx);
  ctx = prepareCtx(ctx);
  checkBackendDependencies(ctx);
  prepareWorkspace(ctx);
  prepareWorktrees(ctx);
  prepareHandoffDirs(ctx);
  ctx = { ...ctx, terminalBackend: detectTerminalBackend() };
  stopHandoffDaemon(ctx);
  killExistingSessions(ctx);
  banner(ctx);
  syncWorktreeScripts(ctx);
  startHandoffDaemon(ctx);
  return ctx;
}

function runMainSwarm(root: string): void {
  const ctx = prepareSwarm(root);
  startPackWeb(ctx);
  launchRoles(ctx);
  announceReady(ctx);
  openTerminalSurfaces(ctx);
}

function runProject(root: string): void {
  const ctx = prepareSwarm(root);
  launchRoles(ctx);
  announceReady(ctx);
}

function sessionNamesFromFile(ctx: Ctx): string[] {
  if (!isFile(ctx.sessionsFile)) return [];
  return splitLines(readFileSync(ctx.sessionsFile, "utf8"))
    .filter((line) => !isBlank(line))
    .map((line) => line.split("\t")[2] ?? "");
}

export function runStopProject(root: string): void {
  const ctx = context(root);
  const socket = isFile(ctx.tmuxSocketFile) ? readFileSync(ctx.tmuxSocketFile, "utf8").trim() || undefined : undefined;
  stopHandoffDaemon(ctx);
  if (socket) run(join(ctx.scriptDir, "swarm-cleanup.sh"), [socket, ctx.windowIdsFile, ...sessionNamesFromFile(ctx)]);
}

function runHost(root: string): void {
  checkCoreDependencies();
  let ctx = detectTmuxBaseIndexes(context(root));
  ctx = { ...ctx, roles: [lieutenantRow(ctx)], host: true, terminalBackend: detectTerminalBackend() };
  const prompt = join(ctx.rolesDir, "lieutenant.prompt");
  if (!existsSync(prompt)) fail(`${RED}Error:${RESET} Missing lieutenant prompt at ${prompt}`);
  checkBackendDependencies(ctx);
  mkdirSync(join(ctx.workingDir, "projects"), { recursive: true });
  prepareWorkspace(ctx);
  const openFile = join(ctx.stateDir, "open-projects");
  const lingering = isFile(openFile)
    ? splitLines(readFileSync(openFile, "utf8")).map((line) => line.trim()).filter((line) => line !== "")
    : [];
  for (const name of lingering) runStopProject(join(ctx.workingDir, "projects", name));
  writeFileSync(openFile, "");
  killExistingSessions(ctx);
  banner(ctx);
  startPackWeb(ctx);
  launchRoles(ctx);
  announceReady(ctx);
  openTerminalSurfaces(ctx);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const LAUNCHER_USAGE = "Usage: swarmforge.sh [root] | --start-project [root] | --stop-project [root]";
const PROJECT_FLAGS = ["--start-project", "--stop-project"];

export interface LauncherArgs {
  mode: "run" | "--start-project" | "--stop-project";
  root: string;
}

export function parseLauncherArgs(args: string[], cwd = process.cwd()): LauncherArgs {
  const flag = args[0]?.startsWith("-") ? args[0] : undefined;
  if (flag !== undefined && !PROJECT_FLAGS.includes(flag)) fail(LAUNCHER_USAGE);
  const rest = flag === undefined ? args : args.slice(1);
  if (rest.length > 1) fail("Too many launcher arguments");
  return { mode: (flag ?? "run") as LauncherArgs["mode"], root: rest[0] ?? cwd };
}

export function main(args: string[]): void {
  const { mode, root } = parseLauncherArgs(args);
  if (mode === "--start-project") return runProject(root);
  if (mode === "--stop-project") return runStopProject(root);
  if (isDir(join(root, "packs"))) runHost(root);
  else runMainSwarm(root);
}
