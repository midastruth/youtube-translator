// Ports of ready_for_next(.bb|_task|_batch) and done_with_current(.bb|_task|_batch).

import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { exit, println } from "../core/cli.ts";
import { run } from "../core/proc.ts";
import { idTimestamp, isoInstant } from "../core/time.ts";
import { activeOutboundGitFiles, currentRole, waitMessage } from "./guard.ts";
import { batchDirs, bulletList, handoffFiles, inboxDirs, readHeaders } from "./inbox.ts";
import { finishDone, headerField, printBatch, printTask, role, roleReceiveMode, script, setHeader } from "./lib.ts";

function fail(code: number, ...lines: string[]): never {
  exit(code, lines.join("\n"));
}

function currentHead(): string {
  return run("git", ["rev-parse", "--short=10", "HEAD"]).out.trim();
}

function mergeGitHandoff(file: string): void {
  const headers = readHeaders(file);
  if (headers.get("type") !== "git_handoff") return;
  const from = headers.get("from");
  const commit = headers.get("commit");
  if (from === undefined || commit === undefined) return;
  const result = run(script("merge_and_process.sh"), [from, commit]);
  if (result.exit !== 0) fail(1, `${result.err}\n${result.out}`.trim());
}

function guardOutbound(): void {
  const active = activeOutboundGitFiles(currentRole());
  if (active.length > 0) fail(2, ...waitMessage(active));
}

function dequeue(source: string, targetDir: string, what: string): string {
  const target = join(targetDir, basename(source));
  if (existsSync(target)) fail(2, `AMBIGUOUS_TASK_STATE: target ${what} file already exists: ${target}`);
  renameSync(source, target);
  setHeader(target, "dequeued_at", isoInstant());
  setHeader(target, "task_base_commit", currentHead());
  return target;
}

export function readyForNextTask(): void {
  const { newDir, inProcess, completed } = inboxDirs();
  for (const dir of [newDir, inProcess, completed]) mkdirSync(dir, { recursive: true });
  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (batches.length > 0) {
    fail(2, "TASK_IN_PROCESS_IS_BATCH: use ready_for_next.sh or done_with_current.sh.", bulletList(batches));
  }
  if (files.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple tasks are already in process.", bulletList(files));
  if (files.length === 1) {
    mergeGitHandoff(files[0]!);
    printTask(files[0]!);
    return;
  }
  const queued = handoffFiles(newDir);
  guardOutbound();
  if (queued.length === 0) {
    println("NO_TASK");
    return;
  }
  const target = dequeue(queued[0]!, inProcess, "in-process");
  mergeGitHandoff(target);
  printTask(target);
}

function newBatchDir(inProcess: string): string {
  for (let suffix = 1; ; suffix++) {
    const dir = join(inProcess, `batch_${idTimestamp()}_${String(suffix).padStart(6, "0")}`);
    if (!existsSync(dir)) return dir;
  }
}

const priorityOf = (file: string): string => headerField(file, "priority") ?? "50";

function inProcessBatchDir(inProcess: string): string | undefined {
  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (files.length > 0) {
    fail(2, "TASK_IN_PROCESS_IS_SINGLE: use ready_for_next.sh or done_with_current.sh.", bulletList(files));
  }
  if (batches.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple batches are already in process.", bulletList(batches));
  return batches[0];
}

function dequeueNextBatch(newDir: string, inProcess: string): string | undefined {
  const queued = handoffFiles(newDir);
  guardOutbound();
  if (queued.length === 0) return undefined;
  const priority = priorityOf(queued[0]!);
  const batchDir = newBatchDir(inProcess);
  const selected = queued.filter((file) => priorityOf(file) === priority);
  mkdirSync(batchDir);
  for (const source of selected) dequeue(source, batchDir, "batch");
  return batchDir;
}

export function readyForNextBatch(): void {
  const { newDir, inProcess, completed } = inboxDirs();
  for (const dir of [newDir, inProcess, completed]) mkdirSync(dir, { recursive: true });
  const existing = inProcessBatchDir(inProcess);
  if (existing) {
    handoffFiles(existing).forEach(mergeGitHandoff);
    printBatch(existing);
    return;
  }
  const batchDir = dequeueNextBatch(newDir, inProcess);
  if (!batchDir) {
    println("NO_TASK");
    return;
  }
  handoffFiles(batchDir).forEach(mergeGitHandoff);
  printBatch(batchDir);
}

export function doneWithCurrentTask(): void {
  const { inProcess, completed } = inboxDirs();
  for (const dir of [inProcess, completed]) mkdirSync(dir, { recursive: true });
  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (batches.length > 0) fail(2, "CURRENT_WORK_IS_BATCH: use done_with_current.sh.", bulletList(batches));
  if (files.length === 0) fail(1, "NO_CURRENT_TASK");
  if (files.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple tasks are in process.", bulletList(files));
  const source = files[0]!;
  const target = join(completed, basename(source));
  rmSync(target, { force: true });
  setHeader(source, "completed_at", isoInstant());
  renameSync(source, target);
  println("COMPLETED:", target);
  finishDone();
}

function currentInProcessBatch(inProcess: string): string {
  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (files.length > 0) fail(2, "CURRENT_WORK_IS_SINGLE_TASK: use done_with_current.sh.", bulletList(files));
  if (batches.length === 0) fail(1, "NO_CURRENT_BATCH");
  if (batches.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple batches are in process.", bulletList(batches));
  return batches[0]!;
}

function archiveBatchFiles(sourceDir: string, targetDir: string): void {
  const batchFiles = handoffFiles(sourceDir);
  const completedAt = isoInstant();
  if (batchFiles.length === 0) fail(2, `AMBIGUOUS_TASK_STATE: batch contains no tasks: ${sourceDir}`);
  if (existsSync(targetDir)) fail(2, `AMBIGUOUS_TASK_STATE: completed batch already exists: ${targetDir}`);
  mkdirSync(targetDir);
  for (const source of batchFiles) {
    setHeader(source, "completed_at", completedAt);
    const target = join(targetDir, basename(source));
    if (existsSync(target)) fail(2, `AMBIGUOUS_TASK_STATE: completed batch file already exists: ${target}`);
    renameSync(source, target);
    println("COMPLETED:", target);
  }
  rmdirSync(sourceDir);
}

export function doneWithCurrentBatch(): void {
  const { inProcess, completed } = inboxDirs();
  for (const dir of [inProcess, completed]) mkdirSync(dir, { recursive: true });
  const sourceDir = currentInProcessBatch(inProcess);
  const targetDir = join(completed, basename(sourceDir));
  archiveBatchFiles(sourceDir, targetDir);
  println("COMPLETED_BATCH:", targetDir);
  finishDone();
}
function dispatch(task: () => void, batch: () => void): void {
  const name = role();
  const mode = roleReceiveMode(name);
  if (mode === "batch") batch();
  else if (mode === "task") task();
  else exit(2, `INVALID_RECEIVE_MODE: ${mode} for role ${name}`);
}

export const readyForNext = (): void => dispatch(readyForNextTask, readyForNextBatch);
export const doneWithCurrent = (): void => dispatch(doneWithCurrentTask, doneWithCurrentBatch);
