// Port of pack_dashboard_request.bb: lieutenant chat requests and agent clarifications.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eprintln, exit, println } from "../core/cli.ts";
import { envRole, inferRoleFromWorktree, projectRoot } from "../core/project.ts";
import { isBlank, splitLines, splitOnce } from "../core/text.ts";
import { isoInstant } from "../core/time.ts";

export const usageText =
  "Usage:\n" +
  "  pack_dashboard_request.sh answer <id> <answer-file>\n" +
  "  pack_dashboard_request.sh clarify <question-file>\n" +
  "  pack_dashboard_request.sh create --root <dir> --body <text>\n" +
  "  pack_dashboard_request.sh list --root <dir>\n";

const dashboardDir = (root: string): string => join(root, ".swarmforge", "dashboard");
export const requestDir = (root: string, state: "pending" | "done"): string => join(dashboardDir(root), "requests", state);
export const clarificationDir = (root: string, state: "pending" | "done"): string =>
  join(dashboardDir(root), "clarifications", state);
const requestFile = (dir: string, id: string): string => join(dir, `${id}.request`);

const compactStamp = (): string => isoInstant().replace(/[^0-9A-Za-z]/g, "");
export const chatId = (): string => `req-${compactStamp()}`;
export const clarId = (): string => `clar-${compactStamp()}`;

export type RequestFields = Record<string, string | undefined>;

export function parseKv(text: string | undefined): RequestFields {
  const [header, body] = splitOnce(text ?? "", "\n\n");
  const fields: RequestFields = {};
  for (const line of splitLines(header)) {
    const [key, value] = splitOnce(line, ": ");
    if (value !== undefined) fields[key] = value;
  }
  fields.body = fields.body ?? body ?? "";
  return fields;
}

function optionalHeader(key: string, value: string | undefined, escapeNewline = false): string[] {
  if (isBlank(value)) return [];
  const text = escapeNewline ? value!.replace(/\n/g, "\\n") : value!;
  return [`${key}: ${text}`];
}

export function renderRequest(r: RequestFields): string {
  const headers = [
    `id: ${r.id ?? ""}`,
    `status: ${r.status ?? ""}`,
    ...optionalHeader("role", r.role),
    `created_at: ${r.created_at ?? ""}`,
    ...optionalHeader("updated_at", r.updated_at),
    ...optionalHeader("response", r.response, true),
  ];
  const body = r.body ?? "";
  const suffix = body.endsWith("\n") ? body : `${body}\n`;
  return `${headers.join("\n")}\n\n${suffix}`;
}

export interface RequestEntry {
  id: string | undefined;
  status: string | undefined;
  role: string | undefined;
  body: string;
  response: string;
  created_at: string | undefined;
  updated_at: string | undefined;
}

export function requestEntry(path: string): RequestEntry {
  const m = parseKv(readFileSync(path, "utf8"));
  return {
    id: m.id,
    status: m.status,
    role: m.role,
    body: m.body ?? "",
    response: (m.response ?? "").replace(/\\n/g, "\n"),
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".request"))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function senderRole(root: string): string {
  const file = join(root, ".swarmforge", "roles.tsv");
  const rows = existsSync(file) ? splitLines(readFileSync(file, "utf8")).map((line) => line.split("\t")) : [];
  return envRole() ?? inferRoleFromWorktree(rows) ?? exit(1, "Set SWARMFORGE_ROLE.");
}

export function createClarification(root: string, role: string, body: string): string {
  if (isBlank(body)) exit(1, "Missing clarification question");
  const id = clarId();
  const file = requestFile(clarificationDir(root, "pending"), id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderRequest({ id, status: "pending", role, body, created_at: isoInstant() }));
  return id;
}

function clarify(questionFile: string | undefined): void {
  if (!questionFile || !isFile(questionFile)) exit(1, `Question file not found: ${questionFile ?? ""}`);
  const root = projectRoot();
  println(createClarification(root, senderRole(root), readFileSync(questionFile, "utf8")));
}

export function listRequests(root: string): RequestEntry[] {
  return [...listFiles(requestDir(root, "pending")), ...listFiles(requestDir(root, "done"))].map(requestEntry);
}

export function createRequest(root: string, body: string): RequestEntry {
  if (isBlank(body)) exit(1, "Missing request body");
  const id = chatId();
  const now = isoInstant();
  const file = requestFile(requestDir(root, "pending"), id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderRequest({ id, status: "pending", body, created_at: now }));
  return { id, status: "pending", role: undefined, body, response: "", created_at: now, updated_at: undefined };
}

function answerExistingRequest(src: string, dest: string, answerFile: string, id: string): void {
  const entry = requestEntry(src);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    renderRequest({
      id: entry.id,
      status: "done",
      body: entry.body,
      response: readFileSync(answerFile, "utf8").trim(),
      created_at: entry.created_at,
      updated_at: isoInstant(),
    }),
  );
  rmSync(src, { force: true });
  println("ANSWERED:", id);
}

function answerRequest(root: string, id: string | undefined, answerFile: string | undefined): void {
  if (isBlank(id)) exit(1, "Missing request id");
  if (!answerFile || !isFile(answerFile)) exit(1, `Answer file not found: ${answerFile ?? ""}`);
  const src = requestFile(requestDir(root, "pending"), id!);
  if (isFile(src)) {
    answerExistingRequest(src, requestFile(requestDir(root, "done"), id!), answerFile, id!);
    return;
  }
  if (isFile(requestFile(clarificationDir(root, "done"), id!))) {
    println("ANSWERED:", id);
    return;
  }
  exit(1, `Unknown pending request: ${id}`);
}

function flag(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
}

type CommandAction = (args: string[]) => void;

const COMMANDS: Record<string, CommandAction> = {
  answer: (args) => { answerRequest(projectRoot(), args[1], args[2]); },
  clarify: (args) => { clarify(args[1]); },
  create: (args) => {
    println(createRequest(flag(args, "--root") ?? projectRoot(), flag(args, "--body") ?? "").id);
  },
  list: (args) => {
    for (const item of listRequests(flag(args, "--root") ?? projectRoot())) {
      println(`${item.id}\t${item.status}\t${item.body}`);
    }
  },
};

export function main(args: string[]): number {
  const action = COMMANDS[args[0] ?? ""];
  if (action) {
    action(args);
    return 0;
  }
  eprintln(usageText);
  return 1;
}
