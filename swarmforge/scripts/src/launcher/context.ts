// Launcher context and swarmforge.conf parsing (port of swarmforge.bb, part 1).

import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { exit } from "../core/cli.ts";
import { commandExists } from "../core/proc.ts";
import { isBlank, splitLines } from "../core/text.ts";
import { normalizeTerminalBackend } from "./terminal.ts";

export const RED = "\u001b[0;31m";
export const GREEN = "\u001b[0;32m";
export const YELLOW = "\u001b[1;33m";
export const CYAN = "\u001b[0;36m";
export const BOLD = "\u001b[1m";
export const RESET = "\u001b[0m";

export const defaultScriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RoleRow {
  role: string;
  agent: string;
  session: string;
  displayName: string;
  worktreeName: string;
  worktreePath: string;
  receiveMode: string;
  propagation: string;
  extraArgs: string | undefined;
  visible: boolean;
}

export interface Ctx {
  workingDir: string;
  scriptDir: string;
  swarmForgeDir: string;
  worktreesDir: string;
  configFile: string;
  rolesDir: string;
  constitutionFile: string;
  stateDir: string;
  notifyDir: string;
  windowIdsFile: string;
  windowStateFile: string;
  windowWatchdogLog: string;
  sessionsFile: string;
  rolesFile: string;
  promptsDir: string;
  daemonDir: string;
  handoffDaemonLog: string;
  tmuxSocketDir: string;
  tmuxSocket: string;
  tmuxSocketFile: string;
  tmuxEnvFile: string;
  tmuxWindowBaseIndex: number;
  tmuxPaneBaseIndex: number;
  terminalBackend: string;
  roles: RoleRow[];
  host?: boolean;
}

export function context(dir: string): Ctx {
  const workingDir = resolve(dir);
  const swarmForgeDir = join(workingDir, "swarmforge");
  const stateDir = join(workingDir, ".swarmforge");
  const daemonDir = join(stateDir, "daemon");
  const socketId = String(crc32(Buffer.from(workingDir, "utf8")));
  const tmuxSocketDir = join("/tmp", `swarmforge-${process.env.UID || userInfo().username}`);
  return {
    workingDir,
    scriptDir: defaultScriptDir,
    swarmForgeDir,
    worktreesDir: join(workingDir, ".worktrees"),
    configFile: join(swarmForgeDir, "swarmforge.conf"),
    rolesDir: join(swarmForgeDir, "roles"),
    constitutionFile: join(swarmForgeDir, "constitution.prompt"),
    stateDir,
    notifyDir: join(stateDir, "notify"),
    windowIdsFile: join(stateDir, "window-ids"),
    windowStateFile: join(stateDir, "windows.tsv"),
    windowWatchdogLog: join(stateDir, "window-watchdog.log"),
    sessionsFile: join(stateDir, "sessions.tsv"),
    rolesFile: join(stateDir, "roles.tsv"),
    promptsDir: join(stateDir, "prompts"),
    daemonDir,
    handoffDaemonLog: join(daemonDir, "handoffd.log"),
    tmuxSocketDir,
    tmuxSocket: join(tmuxSocketDir, `${socketId}.sock`),
    tmuxSocketFile: join(stateDir, "tmux-socket"),
    tmuxEnvFile: join(stateDir, "tmux-env"),
    tmuxWindowBaseIndex: 0,
    tmuxPaneBaseIndex: 0,
    terminalBackend: "none",
    roles: [],
  };
}

export function fail(message: string): never {
  exit(1, message);
}

export const configFail = (message: string): never => fail(`${RED}Error:${RESET} ${message}`);

function rejectIf(condition: boolean, message: string): void {
  if (condition) configFail(message);
}

export function detectTerminalBackend(): string {
  const configured = process.env.SWARMFORGE_TERMINAL;
  if (configured) return normalizeTerminalBackend(configured);
  if (commandExists("osascript")) return process.env.TERM_PROGRAM === "iTerm.app" ? "iterm2" : "terminal-app";
  if (commandExists("wt.exe")) return "windows-terminal";
  return "none";
}

export function displayNameForRole(role: string): string {
  return role
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export const sessionNameForRole = (role: string): string => `swarmforge-${role}`;
export const skipConfigLine = (line: string): boolean => isBlank(line) || line.startsWith("#");
export const specialWorktree = (worktree: string): boolean => worktree === "none" || worktree === "master";

export function visibleWindow(directive: string, lineNo: number): boolean {
  if (directive === "window") return true;
  if (directive === "window-invisible") return false;
  return configFail(`Unknown config directive on line ${lineNo}: ${directive}`);
}

const receiveModes = new Set(["task", "batch"]);
const propagationModes = new Set(["forward-only", "back-one", "back-all"]);
export const knownAgents = new Set(["claude", "codex", "copilot", "grok", "pi"]);

function receiveFields(trailing: string[]): [string, string, string[]] {
  let rest = trailing;
  let receiveMode = "task";
  if (rest[0] !== undefined && receiveModes.has(rest[0])) [receiveMode, ...rest] = rest as [string, ...string[]];
  let propagation = "forward-only";
  if (rest[0] !== undefined && propagationModes.has(rest[0])) [propagation, ...rest] = rest as [string, ...string[]];
  return [receiveMode, propagation, rest];
}

export const extraArgsStr = (tokens: string[]): string | undefined => (tokens.length > 0 ? tokens.join(" ") : undefined);

export function windowRow(
  ctx: Ctx, role: string, agent: string, worktree: string, receiveMode: string, propagation: string,
  extraArgs: string | undefined, visible: boolean,
): RoleRow {
  return {
    role,
    agent,
    session: sessionNameForRole(role),
    displayName: displayNameForRole(role),
    worktreeName: worktree,
    worktreePath: specialWorktree(worktree) ? ctx.workingDir : join(ctx.worktreesDir, worktree),
    receiveMode,
    propagation,
    extraArgs,
    visible,
  };
}

function parseWindowLine(ctx: Ctx, lineNo: number, line: string, roles: Set<string>, worktrees: Set<string>): RoleRow {
  const fields = line.split(/\s+/);
  rejectIf(fields.length < 4, `Invalid config line ${lineNo}: ${line}`);
  const [directive, role, rawAgent, worktree, ...trailing] = fields as [string, string, string, string, ...string[]];
  const agent = rawAgent.toLowerCase();
  const [receiveMode, propagation, extra] = receiveFields(trailing);
  const visible = visibleWindow(directive, lineNo);
  rejectIf(role.includes("_"), `Invalid role '${role}' on line ${lineNo}: role names may not contain underscores`);
  rejectIf(roles.has(role), `Duplicate role '${role}' in ${ctx.configFile}`);
  rejectIf(!specialWorktree(worktree) && worktrees.has(worktree), `Duplicate worktree '${worktree}' in ${ctx.configFile}`);
  rejectIf(worktree.includes("/") || worktree === "." || worktree === "..", `Invalid worktree '${worktree}' for role '${role}'`);
  rejectIf(!knownAgents.has(agent), `Unsupported agent '${agent}' for role '${role}'`);
  rejectIf(
    !receiveModes.has(receiveMode),
    `Invalid receive mode '${receiveMode}' for role '${role}' on line ${lineNo}: expected task or batch`,
  );
  const prompt = join(ctx.rolesDir, `${role}.prompt`);
  rejectIf(!existsSync(prompt), `Missing role prompt ${prompt}`);
  return windowRow(ctx, role, agent, worktree, receiveMode, propagation, extraArgsStr(extra), visible);
}

export function parseConfig(ctx: Ctx): Ctx {
  if (!existsSync(ctx.configFile)) configFail(`Config not found at ${ctx.configFile}`);
  if (!existsSync(ctx.constitutionFile)) configFail(`Constitution prompt not found at ${ctx.constitutionFile}`);
  const rows: RoleRow[] = [];
  const roles = new Set<string>();
  const worktrees = new Set<string>();
  splitLines(readFileSync(ctx.configFile, "utf8")).forEach((raw, index) => {
    const line = raw.trim();
    if (skipConfigLine(line)) return;
    const row = parseWindowLine(ctx, index + 1, line, roles, worktrees);
    rows.push(row);
    roles.add(row.role);
    if (!specialWorktree(row.worktreeName)) worktrees.add(row.worktreeName);
  });
  rejectIf(rows.length === 0, `No windows defined in ${ctx.configFile}`);
  rejectIf(rows.filter((row) => row.worktreeName === "master").length !== 1, "Config must name exactly one master worktree");
  return { ...ctx, roles: rows };
}

export const prepareCtx = (ctx: Ctx): Ctx => ({ ...parseConfig(ctx), terminalBackend: detectTerminalBackend() });

function readConfigFileLines(file: string): string[] {
  try {
    return statSync(file).isFile() ? splitLines(readFileSync(file, "utf8")) : [];
  } catch {
    return [];
  }
}

export function parseLieutenantConfig(ctx: Ctx): { agent: string; extraArgs: string | undefined } {
  const fallback = (process.env.SWARMFORGE_LIEUTENANT_AGENT || "pi").toLowerCase();
  for (const raw of readConfigFileLines(ctx.configFile)) {
    const line = raw.trim();
    if (skipConfigLine(line)) continue;
    const fields = line.split(/\s+/);
    if (fields.length >= 2 && fields[0]!.toLowerCase() === "lieutenant") {
      const agent = fields[1]!.toLowerCase();
      rejectIf(!knownAgents.has(agent), `Unsupported agent '${fields[1]}' for lieutenant`);
      return { agent, extraArgs: extraArgsStr(fields.slice(2)) };
    }
  }
  return { agent: fallback, extraArgs: undefined };
}

export function lieutenantRow(ctx: Ctx): RoleRow {
  const { agent, extraArgs } = parseLieutenantConfig(ctx);
  return windowRow(ctx, "lieutenant", agent, "master", "task", "forward-only", extraArgs, false);
}

export function envLong(name: string, defaultValue: number): number {
  const value = process.env[name];
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : defaultValue;
}
