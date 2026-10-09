// Port of handoff_lib.bb: role lookup, handoff header I/O, sequence numbers.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, eprintln, out, println } from "../core/cli.ts";
import { writeFileAtomic } from "../core/fs-atomic.ts";
import { withDirLock } from "../core/lock.ts";
import { run } from "../core/proc.ts";
import {
  envRole,
  inferRoleFromWorktree,
  projectRoot,
  roleRows as projectRoleRows,
} from "../core/project.ts";
import { isBlank, splitLines, splitOnce } from "../core/text.ts";
import { idTimestamp, isoInstant } from "../core/time.ts";

export const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function script(name: string): string {
  return join(scriptsDir, name);
}

/** `.swarmforge/handoffs` of the current worktree (cwd). */
export function stateDir(cwd = process.cwd()): string {
  return join(cwd, ".swarmforge", "handoffs");
}

export function inboxDir(cwd = process.cwd()): string {
  return join(stateDir(cwd), "inbox");
}

export function roleRows(): string[][] {
  return projectRoleRows(projectRoot());
}

export function role(): string {
  return envRole() ?? inferRoleFromWorktree(roleRows()) ?? exit(1, "Set SWARMFORGE_ROLE.");
}

export function roleRow(name: string): string[] {
  return roleRows().find((cols) => cols[0] === name) ?? exit(1, `Unknown role: ${name}`);
}

export function roleKnown(name: string | undefined): boolean {
  return roleRows().some((cols) => cols[0] === name);
}

export function roleWorktreeName(name: string): string {
  return roleRow(name)[1] ?? "";
}

export function roleReceiveMode(name: string): string {
  const mode = roleRow(name)[6] ?? "";
  return isBlank(mode) ? "task" : mode;
}

export function rolePropagation(name: string): string {
  const mode = roleRow(name)[7] ?? "";
  return isBlank(mode) ? "forward-only" : mode;
}

export const timestamp = (): string => isoInstant();
export { idTimestamp };

export function validPriority(value: string | undefined): boolean {
  return /^[0-9][0-9]$/.test(value ?? "");
}

export function headerLines(text: string): string[] {
  const lines = splitLines(text);
  const end = lines.findIndex((line) => isBlank(line));
  return end < 0 ? lines : lines.slice(0, end);
}

export function headerField(file: string, field: string): string | undefined {
  const prefix = `${field}: `;
  for (const line of headerLines(readFileSync(file, "utf8"))) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

export function body(file: string): string {
  return splitOnce(readFileSync(file, "utf8"), "\n\n")[1] ?? "";
}

export function setHeaderLines(lines: string[], field: string, value: string): string[] {
  const prefix = `${field}: `;
  const end = lines.findIndex((line) => isBlank(line));
  const headers = end < 0 ? lines : lines.slice(0, end);
  const rest = end < 0 ? [] : lines.slice(end);
  const rewritten = headers.map((line) => (line.startsWith(prefix) ? prefix + value : line));
  if (!rewritten.some((line) => line.startsWith(prefix))) rewritten.push(prefix + value);
  return [...rewritten, ...rest];
}

export function setHeader(file: string, field: string, value: string): void {
  const lines = splitLines(readFileSync(file, "utf8"));
  writeFileAtomic(file, `${setHeaderLines(lines, field, value).join("\n")}\n`);
}

export function printTask(file: string): void {
  const taskName = headerField(file, "task");
  const taskId = headerField(file, "task_id");
  println("TASK:", file);
  println("FROM:", headerField(file, "from") ?? "unknown");
  println("TYPE:", headerField(file, "type") ?? "unknown");
  println("PRIORITY:", headerField(file, "priority") ?? "50");
  if (taskName !== undefined) println("TASK_NAME:", taskName);
  if (taskId !== undefined) println("TASK_ID:", taskId);
  println("PAYLOAD:");
  out(body(file));
}

export function handoffFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".handoff") && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

export function printBatch(batchDir: string): void {
  const files = handoffFiles(batchDir);
  if (files.length === 0) exit(2, `AMBIGUOUS_TASK_STATE: batch contains no tasks: ${batchDir}`);
  println("BATCH:", batchDir);
  println("COUNT:", files.length);
  const name = headerField(files[0]!, "task");
  if (name !== undefined) println("TASK_NAME:", name);
  println("PRIORITY:", headerField(files[0]!, "priority") ?? "50");
  files.forEach((file, index) => {
    println();
    println("BATCH_ITEM:", index + 1);
    printTask(file);
  });
}

function archiveCurrentRole(): void {
  const result = run(script("pack_board.sh"), ["archive", "--role", role(), "--root", projectRoot()]);
  if (result.error) throw result.error;
  if (result.exit !== 0) process.stderr.write(result.err + result.out);
}

export function announceFollowUp(): void {
  println(handoffFiles(join(inboxDir(), "new")).length > 0 ? "MAIL_WAITING" : "NO_TASK");
}

function safely(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "?";
  }
}

export function finishDone(): void {
  try {
    archiveCurrentRole();
  } catch (error) {
    eprintln(
      `archive failed role=${safely(role)} root=${safely(() => projectRoot())} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  announceFollowUp();
}

/** Next per-worktree handoff sequence, zero-padded to six digits. */
export function nextSequence(dir = stateDir()): string {
  mkdirSync(dir, { recursive: true });
  const seqFile = join(dir, "sequence");
  return withDirLock(join(dir, "sequence.lock"), () => {
    const last = existsSync(seqFile) ? readFileSync(seqFile, "utf8").trim() : "0";
    const next = (/^[0-9]+$/.test(last) ? Number(last) : 0) + 1;
    const formatted = String(next).padStart(6, "0");
    writeFileSync(seqFile, `${formatted}\n`);
    return formatted;
  });
}

const commands: Record<string, (args: string[]) => void | number> = {
  role: () => println(role()),
  "state-dir": () => println(stateDir()),
  "inbox-dir": () => println(inboxDir()),
  "project-root": () => println(projectRoot()),
  "role-known": (args) => (roleKnown(args[1]) ? 0 : 1),
  "role-worktree-name": (args) => println(roleWorktreeName(args[1] ?? "")),
  "role-receive-mode": (args) => println(roleReceiveMode(args[1] ?? "")),
  "role-propagation": (args) => println(rolePropagation(args[1] ?? "")),
  timestamp: () => println(timestamp()),
  "id-timestamp": () => println(idTimestamp()),
  "valid-priority": (args) => (validPriority(args[1]) ? 0 : 1),
  "header-field": (args) => {
    const value = headerField(args[1] ?? "", args[2] ?? "");
    if (value === undefined) return 1;
    println(value);
  },
  body: (args) => out(body(args[1] ?? "")),
  "set-header": (args) => setHeader(args[1] ?? "", args[2] ?? "", args[3] ?? ""),
  "print-task": (args) => printTask(args[1] ?? ""),
  "print-batch": (args) => printBatch(args[1] ?? ""),
  "next-sequence": () => println(nextSequence()),
  "finish-done": () => finishDone(),
};

export function main(args: string[]): void | number {
  const command = commands[args[0] ?? ""];
  if (!command) exit(2, "Usage: handoff_lib.sh <command> [args...]");
  return command(args);
}
