// /api/state: board, approvals, work in flight, chat, clarifications.

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isBlank } from "../core/text.ts";
import { laneNames, masterLaneName, readRows, tasksFile } from "../board/board.ts";
import { clarificationDir, listFiles, requestDir } from "../board/dashboard-request.ts";
import {
  allowedDoc,
  batchDirs,
  commaList,
  handoffFiles,
  inProcessDir,
  inProcessForRow,
  inProcessTaskNames,
  isFile,
  parseMessage,
  roleRow,
  roleRows,
  sessionName,
  taskIdOf,
  tmuxSocket,
  type Row,
} from "./files.ts";
import * as forge from "./forge.ts";
import { livePaneText, paneStatusFor, paneStatusLinesFor, roleHeat } from "./pane.ts";
import { seams, sessionAlive } from "./tmux.ts";

export function displayNameForRole(role: string): string {
  return role
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export interface Task {
  name: string;
  id: string;
  lane: string;
  updated_at: string;
  audit_count: number;
  status?: string;
  batch?: string;
  merging?: boolean;
  project?: string;
}

export function taskEntry(line: string): Task {
  const [name = "", lane = "", , updated = "", taskId = "", auditCount = ""] = line.split("\t");
  return {
    name,
    id: taskId || name,
    lane,
    updated_at: updated,
    audit_count: /^[0-9]+$/.test(auditCount) ? Number(auditCount) : 0,
  };
}

export const boardTasks = (root: string): Task[] => readRows(tasksFile(root)).map(taskEntry);

// ---------------------------------------------------------------- approvals

export const pendingDir = (root: string): string => join(root, ".swarmforge", "handoffs", "pending_approval");
export const pendingFile = (root: string, id: string): string => join(pendingDir(root), `${id}.handoff`);
export const reviewsFile = (root: string, id: string): string => join(pendingDir(root), `${id}.reviews.json`);

export function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const readReviews = (root: string, id: string): Record<string, unknown> => readJsonObject(reviewsFile(root, id));

export interface Approval {
  id: string;
  gate: string;
  task_id: string | undefined;
  task: string | undefined;
  artifacts: string[];
  reviews: Record<string, unknown>;
  project?: string;
}

function approvalEntry(root: string, path: string): Approval {
  const headers = parseMessage(path).headers;
  const id = basename(path).replace(/\.handoff$/, "");
  return {
    id,
    gate: `spec → ${commaList(headers.get("to"))[0] ?? ""}`,
    task_id: taskIdOf(headers),
    task: headers.get("task"),
    artifacts: commaList(headers.get("artifacts")).filter((rel) => allowedDoc(root, rel)),
    reviews: readReviews(root, id),
  };
}

export const approvals = (root: string): Approval[] => handoffFiles(pendingDir(root)).map((path) => approvalEntry(root, path));

// ---------------------------------------------------------------- task status

export const rejectedTask = (root: string, name: string): boolean =>
  isFile(join(root, ".swarmforge", "notify", `reject-${name}`));

function activeCardNames(root: string, role: string, board: Task[]): Set<string> {
  const row = roleRow(root, role);
  const names = row ? inProcessTaskNames(inProcessForRow(row)) : [];
  if (names.length > 0) return new Set(names);
  const cards = board.filter((task) => task.lane === role);
  return cards.length === 1 ? new Set([cards[0]!.name]) : new Set();
}

function taskWithStatus(root: string, task: Task, board: Task[], pending: Approval[]): Task {
  const role = task.lane;
  let status: string;
  if (role === "done") status = "";
  else if (rejectedTask(root, task.name)) status = "REJECTED";
  else if (pending.some((a) => (!isBlank(a.task_id) && a.task_id === task.id) || (!isBlank(a.task) && a.task === task.name))) {
    status = "Waiting for approval";
  } else if (activeCardNames(root, role, board).has(task.name)) status = paneStatusFor(root, role);
  else status = "waiting in queue";
  return { ...task, status };
}

function multiBatches(dir: string): [string, string[]][] {
  return batchDirs(dir)
    .map((batch): [string, string[]] => [basename(batch), inProcessTaskNames(handoffFiles(batch))])
    .filter(([, names]) => names.length > 1);
}

function batchIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of roleRows(root)) {
    const worktree = row[2];
    if (isBlank(worktree)) continue;
    const pairs = [
      ...multiBatches(join(worktree!, ".swarmforge", "handoffs", "inbox", "completed")),
      ...multiBatches(inProcessDir(worktree!)),
    ];
    for (const [id, names] of pairs) for (const name of names) index.set(name, id);
  }
  return index;
}

function reverseHandoff(path: string): boolean {
  const h = parseMessage(path).headers;
  return h.get("type") === "git_handoff" && h.get("non-forwarding") === "true";
}

function mergingCard(row: Row): Task | undefined {
  const file = inProcessForRow(row).find(reverseHandoff);
  if (!file) return undefined;
  const h = parseMessage(file).headers;
  const name = h.get("task") ?? h.get("task_id");
  if (isBlank(name)) return undefined;
  return {
    name: name!,
    id: `merging-${h.get("task_id") ?? name}`,
    lane: row[0]!,
    updated_at: h.get("dequeued_at") || "",
    audit_count: 0,
    merging: true,
    status: `Merging ${(h.get("from") ?? "").trim()}`,
  };
}

export function tasks(root: string): Task[] {
  const index = batchIndex(root);
  const board = boardTasks(root);
  const pending = approvals(root);
  const merging = roleRows(root).map(mergingCard).filter((card): card is Task => !!card);
  const withStatus = board.map((task) => {
    const entry = taskWithStatus(root, task, board, pending);
    const batch = index.get(task.name);
    return batch ? { ...entry, batch } : entry;
  });
  return [...merging, ...withStatus];
}

// ---------------------------------------------------------------- work in flight

export interface WorkRow {
  task: string;
  tasks: string[];
  batch_tasks: string[];
  role: string;
  state: "no_session" | "live" | "idle";
  updated_at: string;
  activity: number;
  project?: string;
}

function isoMtime(path: string): string {
  return statSync(path).mtime.toISOString().replace(/\.000Z$/, "Z");
}

function inProcessBatchTaskNames(row: Row): string[] {
  if (isBlank(row[2])) return [];
  const batches = batchDirs(inProcessDir(row[2]!));
  return batches.length === 1 ? inProcessTaskNames(handoffFiles(batches[0]!)) : [];
}

function roleTaskNames(files: string[], cards: Task[]): string[] {
  const fromFiles = inProcessTaskNames(files);
  return fromFiles.length > 0 ? fromFiles : cards.map((c) => c.name);
}

function roleUpdatedAt(path: string | undefined, card: Task | undefined): string {
  if (path) {
    const dequeued = parseMessage(path).headers.get("dequeued_at");
    return dequeued || isoMtime(path);
  }
  return card?.updated_at ?? "";
}

function roleState(alive: boolean, busy: boolean): "no_session" | "live" | "idle" {
  if (!alive) return "no_session";
  return busy ? "live" : "idle";
}

function workRowForRole(root: string, socket: string | undefined, row: Row, allTasks: Task[]): WorkRow {
  const role = row[0]!;
  const files = inProcessForRow(row);
  const cards = allTasks.filter((task) => task.lane === role);
  const card = cards[0];
  const busy = files.length > 0 || card !== undefined;
  const alive = sessionAlive(socket, sessionName(row));
  const text = livePaneText(root, role);
  const names = roleTaskNames(files, cards);
  return {
    task: names[0] ?? "",
    tasks: names,
    batch_tasks: inProcessBatchTaskNames(row),
    role,
    state: roleState(alive, busy),
    updated_at: roleUpdatedAt(files[0], card),
    activity: roleHeat(root, role, alive || seams.paneText !== undefined, text),
  };
}

export function workInFlight(root: string): WorkRow[] {
  const socket = tmuxSocket(root);
  const allTasks = tasks(root);
  return roleRows(root).map((row) => workRowForRole(root, socket, row, allTasks));
}

// ---------------------------------------------------------------- chat & clarifications

export interface ChatItem {
  id: string | undefined;
  status: string | undefined;
  role?: string | undefined;
  body: string;
  response: string;
  created_at: string | undefined;
  project?: string;
}

export function parseChat(path: string, withRole = false): ChatItem {
  const { headers, body } = parseMessage(path);
  return {
    id: headers.get("id"),
    status: headers.get("status"),
    ...(withRole ? { role: headers.get("role") } : {}),
    body,
    response: (headers.get("response") ?? "").replace(/\\n/g, "\n"),
    created_at: headers.get("created_at"),
  };
}

export function listChat(root: string): ChatItem[] {
  return [...listFiles(requestDir(root, "pending")), ...listFiles(requestDir(root, "done"))].map((p) => parseChat(p));
}

export function listClarifications(root: string): ChatItem[] {
  return [...listFiles(clarificationDir(root, "pending")), ...listFiles(clarificationDir(root, "done"))].map((p) =>
    parseChat(p, true),
  );
}

// ---------------------------------------------------------------- whole state

export function dashboardState(root: string): Record<string, unknown> {
  const master = masterLaneName(root);
  return {
    master_role: master,
    master_display: displayNameForRole(master),
    lanes: laneNames(root),
    tasks: tasks(root),
    approvals: approvals(root),
    work_in_flight: workInFlight(root),
    chat: listChat(root),
    clarifications: listClarifications(root),
  };
}

const tagged = <T extends object>(project: string, items: T[]): (T & { project: string })[] =>
  items.map((item) => ({ ...item, project }));

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function projectSlice(root: string, name: string): { name: string; open: true; lanes: string[]; tasks: Task[]; work_in_flight: WorkRow[] } {
  const projectRoot = forge.projectDir(root, name);
  return safe(
    () => ({
      name,
      open: true as const,
      lanes: laneNames(projectRoot),
      tasks: tagged(name, tasks(projectRoot)),
      work_in_flight: tagged(name, workInFlight(projectRoot)),
    }),
    { name, open: true as const, lanes: [], tasks: [], work_in_flight: [] },
  );
}

export function forgeDashboardState(root: string): Record<string, unknown> {
  const open = forge.readOpenProjects(root);
  const projects = open.map((name) => projectSlice(root, name));
  return {
    forge: true,
    master_role: "lieutenant",
    master_display: "Lieutenant",
    packs: forge.listPackNames(root).map((name) => ({ name, conf: forge.packConf(root, name) ?? "" })),
    all_projects: forge.listProjectNames(root),
    open_projects: open,
    projects,
    approvals: open.flatMap((name) => safe(() => tagged(name, approvals(forge.projectDir(root, name))), [])),
    clarifications: open.flatMap((name) => safe(() => tagged(name, listClarifications(forge.projectDir(root, name))), [])),
    chat: listChat(root),
    lieutenant_status: paneStatusLinesFor(root, "lieutenant"),
    lanes: [],
    tasks: [],
    work_in_flight: projects.flatMap((project) => project.work_in_flight),
  };
}

export const apiState = (root: string): Record<string, unknown> =>
  forge.isForge(root) ? forgeDashboardState(root) : dashboardState(root);

