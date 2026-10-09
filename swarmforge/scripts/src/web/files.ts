// Read-side helpers over .swarmforge state shared by the dashboard modules.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { isBlank, splitLines, splitOnce } from "../core/text.ts";
import { batchDirs, handoffFiles } from "../handoff/inbox.ts";

export type Row = string[];

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function roleRows(root: string): Row[] {
  const file = join(root, ".swarmforge", "roles.tsv");
  if (!existsSync(file)) return [];
  return splitLines(readText(file))
    .filter((line) => !isBlank(line))
    .map((line) => line.split("\t"));
}

export const roleRow = (root: string, role: string | undefined): Row | undefined =>
  roleRows(root).find((row) => row[0] === role);

export const masterRow = (root: string): Row | undefined => roleRows(root).find((row) => row[1] === "master");

export function tmuxSocket(root: string): string | undefined {
  const file = join(root, ".swarmforge", "tmux-socket");
  if (!existsSync(file)) return undefined;
  return readText(file).trim() || undefined;
}

export function sessionName(row: Row): string {
  return isBlank(row[3]) ? `swarmforge-${row[0]}` : row[3]!;
}

export function paneTarget(row: Row): string {
  const session = sessionName(row);
  return isBlank(row[4]) ? session : `${session}:${row[4]}.0`;
}

export const backendName = (row: Row): string => (row[5] ?? "").toLowerCase();

export interface Message {
  headers: Map<string, string>;
  body: string;
}

export function parseMessageText(content: string): Message {
  const [header, body] = splitOnce(content, "\n\n");
  const headers = new Map<string, string>();
  for (const line of splitLines(header)) {
    const [key, value] = splitOnce(line, ": ");
    if (value !== undefined) headers.set(key, value);
  }
  return { headers, body: body ?? "" };
}

export const parseMessage = (path: string): Message => parseMessageText(readText(path));

export function commaList(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export const inProcessDir = (worktree: string): string => join(worktree, ".swarmforge", "handoffs", "inbox", "in_process");

export function inProcessFiles(dir: string): string[] {
  return [...handoffFiles(dir), ...batchDirs(dir).flatMap(handoffFiles)];
}

export function inProcessForRow(row: Row): string[] {
  return isBlank(row[2]) ? [] : inProcessFiles(inProcessDir(row[2]!));
}

export function inProcessTaskNames(files: string[]): string[] {
  const names = files.map((file) => parseMessage(file).headers.get("task")).filter((name): name is string => !isBlank(name));
  return [...new Set(names)];
}

export function taskIdOf(headers: Map<string, string>): string | undefined {
  return headers.get("task_id") || headers.get("task");
}

export function existingPath(root: string, rel: string): string | undefined {
  try {
    return realpathSync(join(root, rel));
  } catch {
    return undefined;
  }
}

function underDir(file: string | undefined, dir: string | undefined): boolean {
  return !!file && !!dir && (file === dir || file.startsWith(dir + sep));
}

/** Only regular files under features/, qa/, or tasks/ may be served as documents. */
export function allowedDoc(root: string, rel: string | undefined): boolean {
  if (isBlank(rel)) return false;
  const file = existingPath(root, rel!);
  if (!file || !isFile(file)) return false;
  return ["features", "qa", "tasks"].some((dir) => underDir(file, existingPath(root, dir)));
}

export { batchDirs, handoffFiles };
