// Port of pack_board.bb: the task board in .swarmforge/board/tasks.tsv.
// Row: name ⇥ lane ⇥ created ⇥ updated ⇥ task-id ⇥ audit-count

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eprintln, exit, out, println } from "../core/cli.ts";
import { writeFileAtomic } from "../core/fs-atomic.ts";
import { withDirLock } from "../core/lock.ts";
import { run } from "../core/proc.ts";
import { projectRoot } from "../core/project.ts";
import { isBlank, javaSplit, notEmpty, splitLines } from "../core/text.ts";
import { isoInstant } from "../core/time.ts";

export const usageText =
  "Usage:\n" +
  "  pack_board.sh create --name <name> --lane <lane> [--root <dir>] [--text <text>]\n" +
  "  pack_board.sh create <name> <lane>\n" +
  "  pack_board.sh move --name <name> --lane <lane> [--root <dir>]\n" +
  "  pack_board.sh move <name> <lane>\n" +
  "  pack_board.sh done --name <name> [--root <dir>]\n" +
  "  pack_board.sh done <name>\n" +
  "  pack_board.sh list [--root <dir>]\n" +
  "  pack_board.sh lanes [--root <dir>]\n" +
  "  pack_board.sh master-lane [--root <dir>]\n" +
  "  pack_board.sh archive --role <role> [--root <dir>]\n" +
  "  pack_board.sh archive <role>\n" +
  "  pack_board.sh archive-all [--root <dir>]\n" +
  "  pack_board.sh increment-audit --task-id <task-id> [--root <dir>]\n" +
  "  pack_board.sh delete --name <name> [--root <dir>]\n" +
  "  pack_board.sh delete <name>";

const FLAGS: Record<string, keyof Opts> = {
  "--root": "root", "--name": "name", "--lane": "lane", "--text": "text", "--role": "role", "--task-id": "taskId",
};

export interface Opts {
  positional: string[];
  root?: string;
  name?: string;
  lane?: string;
  text?: string;
  role?: string;
  taskId?: string;
}

export function parseArgs(args: readonly string[]): Opts {
  const opts: Opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = FLAGS[args[i]!];
    if (!flag) {
      opts.positional.push(args[i]!);
      continue;
    }
    if (args[i + 1] === undefined) exit(1, `Missing value for ${args[i]}`);
    (opts as unknown as Record<string, string>)[flag] = args[++i]!;
  }
  return opts;
}

const resolveRoot = (opts: Opts): string => opts.root ?? projectRoot();
export const boardDir = (root: string): string => join(root, ".swarmforge", "board");
export const tasksFile = (root: string): string => join(boardDir(root), "tasks.tsv");
export const taskBodyFile = (root: string, name: string): string => join(boardDir(root), `${name}.txt`);
const taskDocFile = (root: string, name: string): string => join(root, "tasks", `${name}.md`);

export function withBoardLock<T>(root: string, fn: () => T): T {
  mkdirSync(boardDir(root), { recursive: true });
  return withDirLock(join(boardDir(root), "tasks.lockdir"), fn);
}

function writeBody(root: string, name: string, text: string | undefined): void {
  if (text === undefined) return;
  const file = taskBodyFile(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function writeTaskDoc(root: string, name: string, text: string | undefined): void {
  const file = taskDocFile(root, name);
  const body = text ?? "";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${name}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`);
}

/** `yyyyMMdd'T'HHmmssSSSSSS'Z'` (microseconds) in UTC. */
export function idTimestamp(date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const micros = Number(process.hrtime.bigint() / 1000n % 1000n);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `${pad(date.getUTCMilliseconds(), 3)}${pad(micros, 3)}Z`
  );
}

export function slug(text: string | undefined): string {
  const slugged = (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  return slugged === "" ? "task" : slugged;
}

export const newTaskId = (name: string): string => `${idTimestamp()}-${slug(name)}`;

export function readRows(file: string): string[] {
  return existsSync(file) ? splitLines(readFileSync(file, "utf8")).filter((line) => !isBlank(line)) : [];
}

function writeRows(file: string, rows: string[]): void {
  writeFileAtomic(file, rows.length > 0 ? `${rows.join("\n")}\n` : "");
}

const rowName = (line: string): string | undefined => line.split("\t")[0];
const sameName = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const findTask = (rows: string[], name: string): string | undefined => rows.find((row) => sameName(name, rowName(row)));

export function taskRow(name: string, lane: string, now: string, taskId = newTaskId(name)): string {
  return [name, lane, now, now, taskId, "0"].join("\t");
}

const taskName = (opts: Opts): string | undefined => opts.name ?? opts.positional[1];
const taskLane = (opts: Opts): string | undefined => opts.lane ?? opts.positional[2];

function requireValue(value: string | undefined, label: string): asserts value is string {
  if (isBlank(value)) exit(1, `Missing ${label}`);
}

export function createTask(root: string, name: string, lane: string, taskId?: string, text?: string): void {
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (findTask(rows, name)) exit(1, `Duplicate task name: ${name}`);
    writeRows(tasksFile(root), [...rows, taskRow(name, lane, isoInstant(), taskId ?? newTaskId(name))]);
    writeBody(root, name, text);
    writeTaskDoc(root, name, text);
  });
}

function create(opts: Opts): void {
  const name = taskName(opts);
  const lane = taskLane(opts);
  requireValue(name, "task name");
  requireValue(lane, "lane");
  createTask(resolveRoot(opts), name, lane, opts.taskId, opts.text);
}

export function rewriteLane(line: string, name: string, lane: string): string {
  const [row = "", , created = "", , taskId = "", auditCount = ""] = line.split("\t");
  if (!sameName(name, row)) return line;
  return [row, lane, created, isoInstant(), taskId, notEmpty(auditCount) ?? "0"].join("\t");
}

function setLane(opts: Opts, lane: string | undefined): void {
  const name = taskName(opts);
  const root = resolveRoot(opts);
  requireValue(name, "task name");
  requireValue(lane, "lane");
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (!findTask(rows, name)) exit(1, `Unknown task name: ${name}`);
    writeRows(tasksFile(root), rows.map((row) => rewriteLane(row, name, lane)));
  });
}

function list(opts: Opts): void {
  const file = tasksFile(resolveRoot(opts));
  if (existsSync(file)) out(readFileSync(file, "utf8"));
}

function roleRows(root: string): string[][] {
  return readRows(join(root, ".swarmforge", "roles.tsv")).map((line) => line.split("\t"));
}

export function laneNames(root: string): string[] {
  return roleRows(root).map((cols) => cols[0]!);
}

export function masterLaneName(root: string): string {
  const masters = roleRows(root).filter((cols) => cols[1] === "master");
  if (masters.length !== 1) exit(1, "Config must name exactly one master worktree");
  return masters[0]![0]!;
}

function lanes(opts: Opts): void {
  for (const lane of laneNames(resolveRoot(opts))) println(lane);
}

function masterLane(opts: Opts): void {
  println(masterLaneName(resolveRoot(opts)));
}

function tmuxSocket(root: string): string | undefined {
  const file = join(root, ".swarmforge", "tmux-socket");
  return existsSync(file) ? notEmpty(readFileSync(file, "utf8").trim()) : undefined;
}

function sessionForRole(root: string, role: string): string | undefined {
  const row = roleRows(root).find((cols) => cols[0] === role);
  if (!row) return undefined;
  return isBlank(row[3]) ? `swarmforge-${role}` : row[3];
}

function paneText(root: string, role: string): string | undefined {
  const stub = process.env.SWARMFORGE_PANE_STUB;
  if (stub) return stub;
  const socket = tmuxSocket(root);
  const session = sessionForRole(root, role);
  if (!socket || !session) return undefined;
  const result = run("tmux", ["-S", socket, "capture-pane", "-p", "-t", session, "-S", "-"]);
  return result.exit === 0 ? result.out : undefined;
}

function archiveSession(root: string, role: string): void {
  if (isBlank(role)) return;
  const text = paneText(root, role);
  if (text === undefined) return;
  const file = join(root, ".swarmforge", "sessions", role, "pane.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function archive(opts: Opts): void {
  const role = opts.role ?? opts.positional[1];
  requireValue(role, "role");
  archiveSession(resolveRoot(opts), role);
}

function archiveAll(opts: Opts): void {
  const root = resolveRoot(opts);
  const roles = new Set<string>();
  for (const line of readRows(tasksFile(root))) {
    const [name, lane] = javaSplit(line, "\t");
    if (!isBlank(name) && !isBlank(lane) && lane !== "done") roles.add(lane!);
  }
  for (const role of roles) archiveSession(root, role);
}

export const parseCount = (value: string | undefined): number => (/^[0-9]+$/.test(value ?? "") ? Number(value) : 0);

function rowKey(cols: string[]): string | undefined {
  return notEmpty(cols[4]) ?? cols[0];
}

export function incrementAuditCount(root: string, taskId: string): void {
  withBoardLock(root, () => {
    const file = tasksFile(root);
    if (!existsSync(file)) return;
    const rows = readRows(file);
    if (!rows.some((row) => rowKey(row.split("\t")) === taskId)) exit(1, `Unknown task ID: ${taskId}`);
    writeRows(
      file,
      rows.map((row) => {
        const cols = row.split("\t");
        if (rowKey(cols) !== taskId) return row;
        const [name = "", lane = "", created = "", updated = "", id = "", count] = cols;
        return [name, lane, created, updated, id, String(parseCount(count) + 1)].join("\t");
      }),
    );
  });
}

function incrementAudit(opts: Opts): void {
  requireValue(opts.taskId, "task ID");
  incrementAuditCount(resolveRoot(opts), opts.taskId);
}

export function deleteTask(root: string, name: string): void {
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (!findTask(rows, name)) exit(1, `Unknown task name: ${name}`);
    writeRows(tasksFile(root), rows.filter((row) => !sameName(name, rowName(row))));
    rmSync(taskBodyFile(root, name), { force: true });
  });
}

function remove(opts: Opts): void {
  const name = taskName(opts);
  requireValue(name, "task name");
  deleteTask(resolveRoot(opts), name);
}

const commands: Record<string, (opts: Opts) => void> = {
  create,
  move: (opts) => setLane(opts, taskLane(opts)),
  done: (opts) => setLane(opts, "done"),
  list,
  lanes,
  "master-lane": masterLane,
  archive,
  "archive-all": archiveAll,
  "increment-audit": incrementAudit,
  delete: remove,
};

export function main(args: string[]): number {
  const opts = parseArgs(args);
  const command = commands[opts.positional[0] ?? ""];
  if (!command) {
    eprintln(usageText);
    return 1;
  }
  command(opts);
  return 0;
}
