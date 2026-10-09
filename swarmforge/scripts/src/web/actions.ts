// Mutating dashboard operations: tasks, chat, clarifications, approvals, retry/delete.

import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readAuditCandidate } from "../handoff/audit-record.ts";
import { run } from "../core/proc.ts";
import { isBlank, trimEnd } from "../core/text.ts";
import { isoInstant } from "../core/time.ts";
import { createTask as boardCreate, deleteTask as boardDelete, incrementAuditCount, masterLaneName, newTaskId } from "../board/board.ts";
import { chatId, clarificationDir, renderRequest, requestDir } from "../board/dashboard-request.ts";
import { recursiveHandoffFiles } from "../handoff/inbox.ts";
import { commaList, isFile, parseMessage, readText, roleRow, roleRows, taskIdOf } from "./files.ts";
import { HttpError } from "./http-error.ts";
import { boardTasks, parseChat, pendingFile, readJsonObject, readReviews, rejectedTask, reviewsFile } from "./state.ts";
import { injectMaster, injectRole } from "./tmux.ts";

// ---------------------------------------------------------------- new task

function slugUnderscore(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "_");
}

function queueNewTaskNote(root: string, taskId: string, name: string, text: string): void {
  const to = masterLaneName(root);
  const now = isoInstant();
  const stamp = now.replace(/[^0-9A-Za-z]/g, "");
  const outbox = join(root, ".swarmforge", "handoffs", "outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(
    join(outbox, `50_${stamp}_from_New_Task_to_${slugUnderscore(to)}.handoff`),
    `id: ${stamp}_from_New_Task\nfrom: (New Task)\nto: ${to}\npriority: 50\ntype: note\n` +
      `task_id: ${taskId}\ntask: ${name}\ncreated_at: ${now}\n\n${text}${text.endsWith("\n") ? "" : "\n"}`,
  );
}

export function createTask(root: string, name: string | undefined, text: string | undefined): void {
  if (isBlank(name)) throw new HttpError(400, "Missing task name");
  const taskId = newTaskId(name!);
  boardCreate(root, name!, masterLaneName(root), taskId, text ?? "");
  queueNewTaskNote(root, taskId, name!, text ?? "");
}

// ---------------------------------------------------------------- chat

export const chatWake = (id: string, text: string): string => (text.includes("\n") ? `[${id}]\n${text}` : `[${id}] ${text}`);

export function postChat(root: string, text: string): void {
  if (isBlank(text)) return;
  const id = chatId();
  const file = join(requestDir(root, "pending"), `${id}.request`);
  mkdirSync(requestDir(root, "pending"), { recursive: true });
  writeFileSync(file, `id: ${id}\nstatus: pending\ncreated_at: ${isoInstant()}\n\n${text}${text.endsWith("\n") ? "" : "\n"}`);
  injectMaster(root, chatWake(id, text));
}

// ---------------------------------------------------------------- clarifications

export const clarPendingFile = (root: string, id: string): string => join(clarificationDir(root, "pending"), `${id}.request`);

function clarWake(id: string, role: string, question: string, answer: string): string {
  return `[${id}]\nClarification requested from: ${role}\nQuestion:\n${trimEnd(question)}\nAnswer:\n${trimEnd(answer)}`;
}

export function answerClarification(root: string, id: string, text: string): void {
  const src = clarPendingFile(root, id);
  if (!isFile(src)) throw new HttpError(404, `Unknown clarification: ${id}`);
  const entry = parseChat(src, true);
  const dest = join(clarificationDir(root, "done"), `${id}.request`);
  mkdirSync(clarificationDir(root, "done"), { recursive: true });
  writeFileSync(
    dest,
    renderRequest({ id: entry.id, status: "done", role: entry.role, body: entry.body, response: text, created_at: entry.created_at }),
  );
  rmSync(src, { force: true });
  injectRole(root, entry.role, clarWake(id, entry.role ?? "", entry.body, text));
}

// ---------------------------------------------------------------- reviews

const taskReviewsFile = (root: string, taskId: string): string => join(root, ".swarmforge", "rejected-tasks", taskId, "reviews.json");

function readTaskReviews(root: string, taskId: string | undefined): Record<string, unknown> {
  return isBlank(taskId) ? {} : readJsonObject(taskReviewsFile(root, taskId!));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const dropReviews = (root: string, id: string): void => rmSync(reviewsFile(root, id), { force: true });

function dropTaskReviews(root: string, taskId: string | undefined): void {
  if (!isBlank(taskId)) rmSync(taskReviewsFile(root, taskId!), { force: true });
}

function appendTaskReview(root: string, taskId: string | undefined, path: string, comments: string | undefined): void {
  const text = (comments ?? "").trim();
  if (isBlank(taskId) || isBlank(path) || text === "") return;
  const store = readTaskReviews(root, taskId);
  const history = Array.isArray(store[path]) ? (store[path] as unknown[]) : [];
  writeJson(taskReviewsFile(root, taskId!), { ...store, [path]: [...history, { at: isoInstant(), text }] });
}

export interface ReviewItem {
  at: unknown;
  text: unknown;
}

export function pathReviewHistory(root: string, taskId: string | undefined, path: string): ReviewItem[] {
  const history = readTaskReviews(root, taskId)[path];
  if (!Array.isArray(history)) return [];
  return history.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return { at: entry.at ?? null, text: entry.text ?? null };
  });
}

// ---------------------------------------------------------------- approvals

function requirePending(root: string, id: string): string {
  const path = pendingFile(root, id);
  if (!isFile(path)) throw new HttpError(404, `Unknown approval: ${id}`);
  return path;
}

export function withApproved(content: string): string {
  return /^approved: /m.test(content) ? content : content.replace("\n\n", "\napproved: true\n\n");
}

export function approve(root: string, id: string): void {
  const src = requirePending(root, id);
  const headers = parseMessage(src).headers;
  const dest = join(root, ".swarmforge", "handoffs", "outbox", basename(src));
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, withApproved(readText(src)));
  rmSync(src, { force: true });
  dropReviews(root, id);
  dropTaskReviews(root, taskIdOf(headers));
}

export function saveReview(root: string, id: string, path: string | undefined, comments: string | undefined): void {
  if (isBlank(path)) throw new HttpError(400, "Missing path");
  const src = requirePending(root, id);
  const text = (comments ?? "").trim();
  writeJson(reviewsFile(root, id), { ...readReviews(root, id), [path!]: text });
  appendTaskReview(root, taskIdOf(parseMessage(src).headers), path!, text);
}

// ---------------------------------------------------------------- git

function gitOut(root: string, ...args: string[]): string {
  const result = run("git", ["-C", root, ...args]);
  if (result.exit !== 0) throw new HttpError(500, `${result.err}\n${result.out}`.trim());
  return result.out.trim();
}

const gitOk = (root: string, ...args: string[]): boolean => run("git", ["-C", root, ...args]).exit === 0;
const gitRepo = (root: string): boolean => gitOk(root, "rev-parse", "--is-inside-work-tree");
export const rejectedLatest = (taskId: string): string => `rejected/${taskId}/latest`;
export const gitRefExists = (root: string, ref: string): boolean => gitOk(root, "show-ref", "--verify", "--quiet", `refs/heads/${ref}`);

function nextRejectedN(root: string, taskId: string): number {
  let n = 1;
  while (gitRefExists(root, `rejected/${taskId}/${n}`)) n++;
  return n;
}

function snapshotRejected(root: string, taskId: string | undefined, commit: string, n: number): void {
  if (!gitRepo(root) || isBlank(taskId)) return;
  gitOut(root, "branch", "-f", `rejected/${taskId}/${n}`, commit);
  gitOut(root, "branch", "-f", rejectedLatest(taskId!), commit);
}

function restoreCommit(worktree: string, commit: string): void {
  if (!gitRepo(worktree) || !gitOk(worktree, "rev-parse", "--verify", commit)) return;
  if (gitOut(worktree, "rev-parse", "HEAD") !== gitOut(worktree, "rev-parse", commit)) {
    gitOut(worktree, "reset", "--hard", commit);
  }
}

function rollbackTarget(root: string, headers: Map<string, string>): string | undefined {
  const base = headers.get("task_base_commit");
  if (base) return base;
  const commit = headers.get("commit");
  if (!commit || !gitRepo(root)) return undefined;
  return gitOut(root, "rev-parse", "--short=10", `${commit}^`) || undefined;
}

function rollbackToBase(root: string, headers: Map<string, string>): void {
  const target = rollbackTarget(root, headers);
  if (target && gitRepo(root)) gitOut(root, "reset", "--hard", target);
}

function worktreeFor(root: string, role: string | undefined): string {
  return roleRow(root, role)?.[2] || root;
}

// ---------------------------------------------------------------- task archive / cleanup

function handoffDirs(root: string): string[] {
  const worktrees = roleRows(root).map((row) => row[2]).filter((wt): wt is string => !isBlank(wt));
  return [...new Set([root, ...worktrees])].map((wt) => join(wt, ".swarmforge", "handoffs"));
}

function taskHandoffs(root: string, ...ids: (string | undefined)[]): string[] {
  const wanted = new Set(ids.filter((id): id is string => !isBlank(id)));
  return handoffDirs(root)
    .flatMap((dir) => recursiveHandoffFiles(dir))
    .filter((path) => {
      const id = taskIdOf(parseMessage(path).headers);
      return id !== undefined && wanted.has(id);
    });
}

function copyInto(dir: string, path: string): void {
  if (isFile(path)) copyFileSync(path, join(dir, basename(path)));
}

const rejectNotify = (root: string, name: string): string => join(root, ".swarmforge", "notify", `reject-${name}`);

function archiveRejected(root: string, taskId: string, name: string | undefined): void {
  const dir = join(root, ".swarmforge", "rejected-tasks", taskId);
  mkdirSync(dir, { recursive: true });
  copyInto(dir, join(root, ".swarmforge", "board", `${name}.txt`));
  copyInto(dir, rejectNotify(root, name ?? ""));
  for (const path of taskHandoffs(root, taskId, name)) copyInto(dir, path);
}

function dropTaskHandoffs(root: string, ...ids: (string | undefined)[]): void {
  for (const path of taskHandoffs(root, ...ids)) rmSync(path, { force: true });
}

function auditTaskId(path: string): string | undefined {
  const id = readAuditCandidate(path)?.["task-id"];
  return typeof id === "string" ? id : undefined;
}

function dropTaskAudits(root: string, ...ids: (string | undefined)[]): void {
  const wanted = new Set(ids.filter((id): id is string => !isBlank(id)));
  const dir = join(root, ".swarmforge", "handoffs", "audit_pending");
  const files = [".json", ".edn"].flatMap((extension) => recursiveHandoffFiles(dir, extension));
  for (const path of files) {
    const id = auditTaskId(path);
    if (id !== undefined && wanted.has(id)) rmSync(path, { force: true });
  }
}

function boardDelete400(root: string, name: string | undefined): void {
  boardDelete(root, name ?? "");
}

export function deleteTask(root: string, name: string | undefined): void {
  if (isBlank(name)) throw new HttpError(400, "Missing task name");
  if (!rejectedTask(root, name!)) throw new HttpError(400, `Not rejected: ${name}`);
  const taskId = boardTasks(root).find((task) => task.name === name)?.id ?? name!;
  archiveRejected(root, taskId, name);
  dropTaskHandoffs(root, taskId, name);
  dropTaskAudits(root, taskId, name);
  dropTaskReviews(root, taskId);
  boardDelete400(root, name);
  rmSync(rejectNotify(root, name!), { force: true });
}

// ---------------------------------------------------------------- retry

function reviewFindings(reviews: Record<string, unknown>): string {
  return Object.entries(reviews)
    .filter(([, text]) => String(text ?? "").trim() !== "")
    .map(([path, text]) => `${path}:\n${String(text).trim()}`)
    .join("\n\n");
}

export function retryMessage(task: string, comments: string | undefined, reviews: Record<string, unknown>): string {
  const extra = (comments ?? "").trim();
  const findings = reviewFindings(reviews);
  return (
    `Retry audit for ${task}. Re-read tasks/${task}.md as operator intent. Read the remedial comments as audit findings.` +
    (extra ? `\n\n${extra}` : "") +
    (findings ? `\n\n${findings}` : "")
  );
}

function taskInboxFiles(worktree: string, state: string, taskId: string | undefined, task: string | undefined): string[] {
  const wanted = new Set([taskId, task].filter((id): id is string => !isBlank(id)));
  return recursiveHandoffFiles(join(worktree, ".swarmforge", "handoffs", "inbox", state)).filter((path) => {
    const id = taskIdOf(parseMessage(path).headers);
    return id !== undefined && wanted.has(id);
  });
}

function writeRetryInProcess(worktree: string, headers: Map<string, string>): void {
  const taskId = taskIdOf(headers);
  if (isBlank(taskId)) return;
  const task = headers.get("task") ?? taskId;
  const base = headers.get("task_base_commit") || undefined;
  const dir = join(worktree, ".swarmforge", "handoffs", "inbox", "in_process");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `50_retry_${taskId!.replace(/[^A-Za-z0-9]+/g, "_")}.handoff`),
    `from: (Retry)\nto: ${headers.get("from") ?? ""}\npriority: 50\ntype: note\ntask_id: ${taskId}\ntask: ${task}\n` +
      (base ? `task_base_commit: ${base}\n` : "") +
      "\nRetry audit.\n",
  );
}

function restoreTaskBase(root: string, headers: Map<string, string>): void {
  const taskId = taskIdOf(headers);
  const task = headers.get("task");
  const worktree = worktreeFor(root, headers.get("from"));
  if (taskInboxFiles(worktree, "in_process", taskId, task).length > 0) return;
  const done = taskInboxFiles(worktree, "completed", taskId, task);
  if (done.length > 0) {
    const destDir = join(worktree, ".swarmforge", "handoffs", "inbox", "in_process");
    mkdirSync(destDir, { recursive: true });
    renameSync(done[0]!, join(destDir, basename(done[0]!)));
  } else {
    writeRetryInProcess(worktree, headers);
  }
}

export function retryApproval(root: string, id: string, comments: string | undefined): void {
  const src = requirePending(root, id);
  const headers = parseMessage(src).headers;
  const task = headers.get("task");
  const taskId = taskIdOf(headers);
  const commit = headers.get("commit") || undefined;
  const n = gitRepo(root) ? nextRejectedN(root, taskId ?? "") : 1;
  const worktree = worktreeFor(root, headers.get("from"));
  const reviews = readReviews(root, id);
  const docPaths = [...new Set([...commaList(headers.get("artifacts")), ...Object.keys(reviews)])];
  for (const path of docPaths) appendTaskReview(root, taskId, path, comments);
  if (commit) {
    snapshotRejected(root, taskId, commit, n);
    restoreCommit(worktree, commit);
  }
  rmSync(src, { force: true });
  dropReviews(root, id);
  dropTaskAudits(root, taskId, task);
  restoreTaskBase(root, headers);
  if (!isBlank(taskId)) incrementAuditCount(root, taskId!);
  if (!isBlank(task)) injectMaster(root, retryMessage(task!, comments, reviews));
}

export function deleteApproval(root: string, id: string): void {
  const src = requirePending(root, id);
  const headers = parseMessage(src).headers;
  const task = headers.get("task");
  const taskId = taskIdOf(headers) ?? "";
  const commit = headers.get("commit") || undefined;
  const n = gitRepo(root) ? nextRejectedN(root, taskId) : 1;
  if (commit) snapshotRejected(root, taskId, commit, n);
  rollbackToBase(worktreeFor(root, headers.get("from")), headers);
  archiveRejected(root, taskId, task);
  dropTaskHandoffs(root, taskId, task);
  dropTaskAudits(root, taskId, task);
  boardDelete400(root, task);
  rmSync(rejectNotify(root, task ?? ""), { force: true });
  dropReviews(root, id);
  dropTaskReviews(root, taskId);
}
