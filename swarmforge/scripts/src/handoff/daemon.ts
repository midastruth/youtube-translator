// Port of handoffd.bb: deliver outbox handoffs into recipient inboxes and wake agents.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eprintln } from "../core/cli.ts";
import { moveNoReplace } from "../core/fs-atomic.ts";
import { run } from "../core/proc.ts";
import { sleepSync } from "../core/sleep.ts";
import { isBlank, notEmpty, splitLines, splitOnce } from "../core/text.ts";
import { isoInstant } from "../core/time.ts";
import { submitKeys } from "../core/tmux-input.ts";
import { script } from "./lib.ts";

export const POLL_MS = 1000;
export const WAKE_MESSAGE = "You have new handoff mail. If idle, run ready_for_next.sh.";

export interface RoleInfo {
  role: string;
  worktreeName: string;
  worktreePath: string;
  session: string;
  display: string;
  agent: string;
  receiveMode: string;
}

export type Roles = Map<string, RoleInfo>;
export type Headers = Map<string, string>;

export interface Message {
  headers: Headers;
  body: string;
  content: string;
}

export class Daemon {
  readonly stateDir: string;
  readonly daemonDir: string;
  readonly rolesFile: string;
  readonly socketFile: string;
  readonly pidFile: string;
  readonly stopFile: string;
  readonly logFile: string;
  stopping = false;
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.stateDir = join(projectRoot, ".swarmforge");
    this.daemonDir = join(this.stateDir, "daemon");
    this.rolesFile = join(this.stateDir, "roles.tsv");
    this.socketFile = join(this.stateDir, "tmux-socket");
    this.pidFile = join(this.daemonDir, "handoffd.pid");
    this.stopFile = join(this.daemonDir, "stop");
    this.logFile = join(this.daemonDir, "handoffd.log");
  }

  log(...parts: unknown[]): void {
    mkdirSync(this.daemonDir, { recursive: true });
    appendFileSync(this.logFile, `${isoInstant()} ${parts.map(String).join(" ")}\n`);
  }

  private readLines(path: string): string[] {
    return existsSync(path) ? splitLines(readFileSync(path, "utf8")) : [];
  }

  loadRoles(): Roles {
    const roles: Roles = new Map();
    for (const line of this.readLines(this.rolesFile)) {
      if (isBlank(line)) continue;
      const [role = "", worktreeName = "", worktreePath = "", session = "", display = "", agent = "", receiveMode] =
        line.split("\t");
      roles.set(role, { role, worktreeName, worktreePath, session, display, agent, receiveMode: receiveMode || "task" });
    }
    return roles;
  }

  notify(socket: string, session: string, agent = ""): void {
    const text = run("tmux", ["-S", socket, "send-keys", "-t", session, "-l", WAKE_MESSAGE]);
    if (text.exit !== 0) throw new Error("tmux send text failed");
    sleepSync(150);
    for (const key of submitKeys(agent)) {
      const result = run("tmux", ["-S", socket, "send-keys", "-t", session, key]);
      if (result.exit !== 0) throw new Error(`tmux send ${key} failed`);
      sleepSync(50);
    }
  }

  moveWithCollision(source: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    const base = basename(source);
    const target = join(targetDir, base);
    moveNoReplace(source, existsSync(target) ? join(targetDir, `${isoInstant()}_${base}`) : target);
  }

  fail(path: string, reason: string): void {
    this.log("failed", path, reason);
    writeFileSync(`${path}.error`, `${reason}\n`);
    this.moveWithCollision(path, join(dirname(dirname(path)), "failed"));
  }

  // ---------------------------------------------------------------- board

  private boardFile(): string {
    return join(this.projectRoot, ".swarmforge", "board", "tasks.tsv");
  }

  private packBoard(...args: string[]): void {
    const result = run(script("pack_board.sh"), [...args, "--root", this.projectRoot]);
    if (result.exit !== 0) {
      this.log("pack-board-failed", JSON.stringify(args), result.err, result.out);
      throw new Error(`${result.err}\n${result.out}`.trim());
    }
  }

  private archiveSender(headers: Headers): void {
    const from = headers.get("from");
    if (!isBlank(from) && !/^\(.+\)$/.test(from!)) this.packBoard("archive", "--role", from!);
  }

  private packRoleNames(): string[] {
    return this.readLines(this.rolesFile)
      .filter((line) => !isBlank(line))
      .map((line) => line.split("\t")[0]!);
  }

  private inboxHandoffs(info: RoleInfo, state: string): string[] {
    const dir = join(info.worktreePath, ".swarmforge", "handoffs", "inbox", state);
    return [...listedHandoffs(dir), ...listedBatches(dir).flatMap(listedHandoffs)];
  }

  private finishedTaskKeys(info: RoleInfo | undefined): Set<string> {
    if (!info) return new Set();
    return new Set(
      [...this.inboxHandoffs(info, "completed"), ...this.inboxHandoffs(info, "in_process")]
        .map((file) => taskKey(parseMessage(file).headers))
        .filter((key): key is string => !isBlank(key)),
    );
  }

  private boardRows(): string[][] {
    return this.readLines(this.boardFile()).map((line) => line.split("\t"));
  }

  private keysInLane(lane: string | undefined): string[] {
    return this.boardRows()
      .filter((cols) => !(cols.length === 1 && isBlank(cols[0])) && cols[1] === lane)
      .flatMap((cols) => [...new Set([boardRowKey(cols), cols[0]!])]);
  }

  private terminalTaskKeys(roles: Roles, headers: Headers): string[] {
    const from = headers.get("from");
    const finished = this.finishedTaskKeys(from === undefined ? undefined : roles.get(from));
    const inLane = new Set(this.keysInLane(from));
    const keys = [taskKey(headers), ...[...inLane].filter((key) => finished.has(key))];
    return [...new Set(keys.filter((key): key is string => !isBlank(key)))];
  }

  private boardNameForKey(key: string | undefined): string | undefined {
    for (const cols of this.boardRows()) {
      if (key === boardRowKey(cols) || key === cols[0]) return cols[0];
    }
    return undefined;
  }

  private completeTerminalTasks(roles: Roles, headers: Headers): void {
    for (const key of this.terminalTaskKeys(roles, headers)) {
      const name = this.boardNameForKey(key) ?? headers.get("task");
      if (!isBlank(name)) this.packBoard("done", "--name", name!);
    }
  }

  private moveIntermediateTask(headers: Headers, destinationLane: string): void {
    if (nonForwarding(headers)) return;
    const task = this.boardNameForKey(taskKey(headers)) ?? headers.get("task");
    if (!isBlank(task)) this.packBoard("move", "--name", task!, "--lane", destinationLane);
  }

  updateBoard(roles: Roles, headers: Headers): void {
    const recipients = recipientList(headers);
    if (!existsSync(this.boardFile()) || headers.get("type") !== "git_handoff" || !recipients) return;
    if (this.packRoleNames().at(-1) === headers.get("from")) {
      this.completeTerminalTasks(roles, headers);
    } else {
      this.moveIntermediateTask(headers, recipients[0]!);
    }
  }

  // ---------------------------------------------------------------- approval hold

  private pendingDir(): string {
    return join(this.stateDir, "handoffs", "pending_approval");
  }

  shouldHold(roles: Roles, headers: Headers): boolean {
    const master = [...roles.values()].find((info) => info.worktreeName === "master")?.role;
    return (
      headers.get("type") === "git_handoff" &&
      roles.has("specifier") &&
      headers.get("from") === master &&
      recipientList(headers)?.length === 1 &&
      isBlank(headers.get("approved"))
    );
  }

  private hold(path: string): void {
    this.moveWithCollision(path, this.pendingDir());
    this.log("held", path);
  }

  private sentDir(roles: Roles, sender: string): string {
    if (phantomSender(sender)) return join(this.projectRoot, ".swarmforge", "handoffs", "sent");
    const info = roles.get(sender);
    if (!info) throw new Error(`unknown sender ${sender}`);
    return join(info.worktreePath, ".swarmforge", "handoffs", "sent");
  }

  outboxFiles(worktreePath: string): string[] {
    return listedHandoffs(join(worktreePath, ".swarmforge", "handoffs", "outbox")).sort((a, b) =>
      basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0,
    );
  }

  private allOutboxFiles(roles: Roles): string[] {
    const paths = [...roles.values()].flatMap((info) => this.outboxFiles(info.worktreePath));
    return [...new Set([...paths, ...this.outboxFiles(this.projectRoot)])];
  }

  private activeOutboundGitFiles(roles: Roles, sender: string): string[] {
    if (isBlank(sender)) return [];
    return [...listedHandoffs(this.pendingDir()), ...this.allOutboxFiles(roles)].filter((file) => {
      const headers = parseMessage(file).headers;
      return headers.get("type") === "git_handoff" && headers.get("from") === sender;
    });
  }

  private senderReadyWork(roles: Roles, sender: string): boolean {
    const info = roles.get(sender);
    if (!info) return false;
    return (
      this.inboxHandoffs(info, "new").length > 0 &&
      this.inboxHandoffs(info, "in_process").length === 0 &&
      this.activeOutboundGitFiles(roles, sender).length === 0
    );
  }

  private maybeNotifyUnblockedSender(roles: Roles, socket: string, headers: Headers, sender: string): void {
    const approvedGit = headers.get("type") === "git_handoff" && !isBlank(headers.get("approved"));
    if (approvedGit && this.senderReadyWork(roles, sender) && !(recipientList(headers) ?? []).includes(sender)) {
      const info = roles.get(sender)!;
      this.notify(socket, info.session, info.agent);
      this.log("notified-unblocked-sender", sender);
    }
  }

  // ---------------------------------------------------------------- delivery

  deliver(roles: Roles, socket: string, sender: string, path: string): void {
    const filename = basename(path);
    const message = parseMessage(path);
    const recipients = recipientList(message.headers);
    if (!recipients) {
      this.fail(path, "missing to header");
      return;
    }
    this.updateBoard(roles, message.headers);
    for (const recipient of recipients) {
      const info = roles.get(recipient);
      if (!info) throw new Error(`unknown recipient ${recipient}`);
      const target = join(info.worktreePath, ".swarmforge", "handoffs", "inbox", "new", filename);
      const headers = new Map(message.headers);
      headers.set("recipient", recipient);
      headers.set("enqueued_at", isoInstant());
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, renderMessage(headers, message.body));
      this.notify(socket, info.session, info.agent);
    }
    this.moveWithCollision(path, this.sentDir(roles, sender));
    this.archiveSender(message.headers);
    this.maybeNotifyUnblockedSender(roles, socket, message.headers, sender);
    this.log("delivered", path);
  }

  shouldStop(): boolean {
    return this.stopping || existsSync(this.stopFile);
  }

  private processOutboxFile(roles: Roles, socket: string, path: string): void {
    const headers = parseMessage(path).headers;
    if (this.shouldHold(roles, headers)) this.hold(path);
    else this.deliver(roles, socket, headers.get("from") ?? "", path);
  }

  private handleOutboxError(path: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.log("error", path, reason);
    try {
      this.fail(path, reason);
    } catch (nested) {
      this.log("failed-to-archive", path, nested instanceof Error ? nested.message : String(nested));
    }
  }

  pollOnce(): void {
    if (this.shouldStop()) return;
    const roles = this.loadRoles();
    const socket = readFileSync(this.socketFile, "utf8").trim();
    for (const path of this.allOutboxFiles(roles)) {
      if (this.shouldStop()) break;
      try {
        this.processOutboxFile(roles, socket, path);
      } catch (error) {
        this.handleOutboxError(path, error);
      }
    }
  }

  private shutdown(): void {
    this.stopping = true;
    try {
      rmSync(this.pidFile, { force: true });
      this.log("stopped");
    } catch {}
  }

  async run(): Promise<void> {
    mkdirSync(this.daemonDir, { recursive: true });
    rmSync(this.stopFile, { force: true });
    writeFileSync(this.pidFile, `${process.pid}\n`);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, () => {
        this.shutdown();
        process.exit(0);
      });
    }
    this.log("started");
    try {
      while (!this.shouldStop()) {
        this.pollOnce();
        for (let waited = 0; waited < POLL_MS && !this.shouldStop(); waited += 100) await sleep(100);
      }
    } finally {
      rmSync(this.pidFile, { force: true });
      this.log("stopped");
    }
  }
}

// ---------------------------------------------------------------- pure helpers

function listedHandoffs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".handoff"))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile());
  } catch {
    return [];
  }
}

function listedBatches(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith("batch_"))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isDirectory());
  } catch {
    return [];
  }
}

export function parseMessage(path: string): Message {
  const content = readFileSync(path, "utf8");
  const [header, body] = splitOnce(content, "\n\n");
  const headers: Headers = new Map();
  for (const line of splitLines(header)) {
    const [key, value] = splitOnce(line, ": ");
    if (value !== undefined) headers.set(key, value);
  }
  return { headers, body: body ?? "", content };
}

const PREFERRED = [
  "id", "from", "to", "recipient", "priority", "type", "role", "task_id", "task", "commit",
  "artifacts", "task_base_commit", "message", "created_at", "enqueued_at", "dequeued_at", "completed_at",
];

export function renderMessage(headers: Headers, body: string): string {
  const remaining = [...headers.keys()].filter((key) => !PREFERRED.includes(key)).sort();
  const lines = [...PREFERRED, ...remaining].flatMap((key) => {
    const value = headers.get(key);
    return value === undefined ? [] : [`${key}: ${value}`];
  });
  return `${lines.join("\n")}\n\n${body}`;
}

export function recipientList(headers: Headers): string[] | undefined {
  const to = headers.get("to");
  if (to === undefined) return undefined;
  const list = to.split(",").map((r) => r.trim()).filter((r) => r !== "");
  return list.length > 0 ? list : undefined;
}

export const nonForwarding = (headers: Headers): boolean => headers.get("non-forwarding") === "true";
export const phantomSender = (from: string | undefined): boolean => /^\(.+\)$/.test(from ?? "");
const taskKey = (headers: Headers): string | undefined => notEmpty(headers.get("task_id")) ?? headers.get("task");
const boardRowKey = (cols: string[]): string => notEmpty(cols[4]) ?? cols[0] ?? "";

export async function main(args: string[]): Promise<number> {
  const once = args.includes("--once");
  const root = args.find((arg) => arg !== "--once");
  if (!root) {
    eprintln("Usage: handoffd.sh [--once] <project-root>");
    return 1;
  }
  const daemon = new Daemon(root);
  if (once) daemon.pollOnce();
  else await daemon.run();
  return 0;
}
