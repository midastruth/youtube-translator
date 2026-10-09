// Port of swarm_handoff.bb: validate a draft and queue handoffs in the outbox.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { eprintln, exit, out, println } from "../core/cli.ts";
import { ednEqual } from "../core/edn-lite.ts";
import { withDirLock } from "../core/lock.ts";
import { run, type RunResult } from "../core/proc.ts";
import { gitToplevel, projectRoot, rolesFile } from "../core/project.ts";
import { isBlank, javaSplit, notEmpty, splitLines, splitOnce } from "../core/text.ts";
import { idTimestamp, isoInstant } from "../core/time.ts";
import { batchDirs, handoffFiles, readHeaders, recursiveHandoffFiles } from "./inbox.ts";
import * as lib from "./lib.ts";
import { readAuditCandidate, writeAudit, type AuditCandidate as Candidate } from "./audit-record.ts";

export const usageText =
  "Usage:\n" +
  "  swarm_handoff.sh <draft-file>\n" +
  "  swarm_handoff.sh --help\n\n" +
  "Write the draft under ./tmp/ in the assigned worktree.\n" +
  "Do not use /tmp or the handoff outbox as scratch.\n\n" +
  "Draft formats:\n\n" +
  "type: git_handoff\n" +
  "to: <role>[,<role>...]\n" +
  "priority: NN\n" +
  "task: <short-stable-task-name>\n\n" +
  "The helper fills priority 50, commit, artifacts, and task_id from current work or the board card.\n" +
  "Do not type a SHA or a hidden task_id. Extra headers (coverage, CRAP) are invalid.\n" +
  "Extra lines after the headers are ignored.\n\n" +
  "type: note\n" +
  "to: <role>[,<role>...]\n" +
  "priority: NN\n" +
  "message: <one line, max 80 chars>";

const reservedFields = new Set([
  "id", "from", "role", "recipient", "created_at", "enqueued_at",
  "dequeued_at", "completed_at", "task_base_commit", "non-forwarding",
]);
const allowedFields = new Set(["type", "to", "priority", "task_id", "task", "commit", "message"]);
const allowedTypes = new Set(["git_handoff", "note"]);
const allowedFieldsByType: Record<string, Set<string>> = {
  git_handoff: new Set(["type", "to", "priority", "task_id", "task", "commit"]),
  note: new Set(["type", "to", "priority", "message"]),
};

export type Headers = Record<string, string>;

/** Seams overridden by unit tests. */
export const deps = {
  command: (dir: string, command: string, ...args: string[]): RunResult => run(command, args, { cwd: dir }),
  roleKnown: (role: string): boolean => lib.roleKnown(role),
  gitCwd: (): string => notEmpty(roleWorktree(lib.role())) ?? gitToplevel() ?? ".",
};

const git = (...args: string[]): RunResult => deps.command(deps.gitCwd(), "git", ...args);

// ---------------------------------------------------------------- board

interface Card {
  name: string;
  lane: string;
  id: string;
}

function boardFile(): string {
  return join(projectRoot(), ".swarmforge", "board", "tasks.tsv");
}

function boardCards(): Card[] {
  const file = boardFile();
  if (!existsSync(file)) return [];
  return splitLines(readFileSync(file, "utf8")).flatMap((line) => {
    const [name = "", lane = "", , , taskId = ""] = line.split("\t");
    return isBlank(name) ? [] : [{ name, lane, id: notEmpty(taskId) ?? name }];
  });
}

// ---------------------------------------------------------------- current work

const inProcessDir = (): string => join(process.cwd(), ".swarmforge", "handoffs", "inbox", "in_process");

function inProcessTaskFiles(): string[] {
  const dir = inProcessDir();
  return [...handoffFiles(dir), ...batchDirs(dir).flatMap(handoffFiles)];
}

const handoffTaskId = (file: string): string | undefined =>
  notEmpty(lib.headerField(file, "task_id")) ?? lib.headerField(file, "task");

function firstInProcess<T>(fn: (file: string) => T): T | undefined {
  const file = inProcessTaskFiles()[0];
  return file ? fn(file) : undefined;
}

const currentInProcessTaskId = (): string | undefined => firstInProcess(handoffTaskId);
const currentInProcessTask = (): string | undefined => firstInProcess((f) => lib.headerField(f, "task"));
const currentTaskBase = (): string | undefined => firstInProcess((f) => lib.headerField(f, "task_base_commit"));

export function currentWorkStateErrors(headers: Headers): string[] {
  if (headers.type !== "git_handoff") return [];
  const dir = inProcessDir();
  const files = handoffFiles(dir);
  const batches = batchDirs(dir);
  const empty = batches.filter((batch) => handoffFiles(batch).length === 0);
  const errors: string[] = [];
  if (files.length > 0 && batches.length > 0) errors.push("Ambiguous current work: both task and batch work are in process.");
  if (files.length > 1) errors.push("Ambiguous current work: multiple tasks are in process.");
  if (batches.length > 1) errors.push("Ambiguous current work: multiple batches are in process.");
  if (empty.length > 0) errors.push(`Ambiguous current work: empty in-process batch ${empty[0]}.`);
  return errors;
}

function completeCurrentAfterGitHandoff(headers: Headers): void {
  if (headers.type !== "git_handoff" || inProcessTaskFiles().length === 0) return;
  const result = run(lib.script("done_with_current.sh"), []);
  out(result.out);
  process.stderr.write(result.err);
  if (result.exit !== 0) exit(result.exit, "CURRENT COMPLETION FAILED after handoff queued.");
}

// ---------------------------------------------------------------- header filling

function withLaneTask(headers: Headers, sender: string): Headers {
  const cards = boardCards().filter((card) => card.lane === sender);
  const draftedId = headers.task_id;
  const drafted = headers.task;
  if (cards.some((card) => card.id === draftedId)) return headers;
  if (!isBlank(draftedId)) return headers;
  const named = cards.find((card) => card.name === drafted);
  if (named) return { ...headers, task_id: named.id, task: named.name };
  if (cards.length === 1) return { ...headers, task_id: cards[0]!.id, task: cards[0]!.name };
  return headers;
}

function withBoardTask(headers: Headers, sender: string): Headers {
  if (headers.type !== "git_handoff") return headers;
  if (!isBlank(headers.task_id)) return headers;
  const id = notEmpty(currentInProcessTaskId());
  if (id) {
    const name = notEmpty(currentInProcessTask());
    return { ...headers, task_id: id, ...(name ? { task: name } : {}) };
  }
  const card = boardCards().find((c) => c.name === headers.task);
  const filled = card ? { ...headers, task_id: card.id, task: card.name } : withLaneTask(headers, sender);
  return isBlank(filled.task_id) && !isBlank(filled.task) ? { ...filled, task_id: filled.task! } : filled;
}

function packRoleNames(): string[] {
  return splitLines(readFileSync(rolesFile(), "utf8"))
    .filter((line) => !isBlank(line))
    .map((line) => line.split("\t")[0]!);
}

const lastPackRole = (role: string): boolean => packRoleNames().at(-1) === role;

function reverseRoles(sender: string): string[] {
  const roles = packRoleNames();
  const index = roles.indexOf(sender);
  if (index < 0) return [];
  switch (lib.rolePropagation(sender)) {
    case "back-one":
      return index > 0 ? [roles[index - 1]!] : [];
    case "back-all":
      return roles.slice(0, index);
    default:
      return [];
  }
}

function withNonForwarding(headers: Headers, sender: string): Headers {
  return headers.type === "git_handoff" && lastPackRole(sender) ? { ...headers, "non-forwarding": "true" } : headers;
}

const inboundNonForwarding = (): boolean =>
  inProcessTaskFiles().some((file) => lib.headerField(file, "non-forwarding") === "true");

function roleWorktree(role: string): string | undefined {
  for (const line of splitLines(readFileSync(rolesFile(), "utf8"))) {
    const cols = line.split("\t");
    if (cols[0] === role && cols.length >= 3) return cols[2];
  }
  return undefined;
}

function worktreeHead(): string {
  const result = git("rev-parse", "--short=10", "HEAD");
  if (result.exit !== 0) exit(1, "Cannot read HEAD commit.");
  return result.out.trim();
}

const validPriority = (priority: string | undefined): boolean => /^[0-9][0-9]$/.test(priority ?? "");

export function prepareHeaders(input: Headers, sender: string): Headers {
  let headers = input.type === "git_handoff" ? { ...input, commit: worktreeHead() } : input;
  headers = withBoardTask(headers, sender);
  headers = withNonForwarding(headers, sender);
  return validPriority(headers.priority) ? headers : { ...headers, priority: "50" };
}

// ---------------------------------------------------------------- draft location

function worktreeTmp(): string {
  const dir = join(deps.gitCwd(), "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function requireWorktreeTmpDraft(draft: string): void {
  const file = realpathSync(draft);
  const dir = realpathSync(worktreeTmp());
  if (!file.startsWith(`${dir}/`)) exit(1, `Draft must live in ./tmp/ in the assigned worktree; got ${draft}`);
}

// ---------------------------------------------------------------- git checks

const commitOnSenderBranch = (sha: string): boolean => git("merge-base", "--is-ancestor", sha, "HEAD").exit === 0;
const commitDescendsFrom = (base: string, sha: string): boolean =>
  git("merge-base", "--is-ancestor", base, sha).exit === 0;

function namedFiles(result: RunResult): string[] {
  return [...new Set(splitLines(result.out).filter((line) => !isBlank(line)))];
}

function commitArtifacts(sha: string): string[] {
  const base = notEmpty(currentTaskBase());
  if (base) return namedFiles(git("diff", "--name-only", "--diff-filter=ACMRT", base, sha));
  const againstParent = git("diff", "--name-only", "--diff-filter=ACMRT", `${sha}^`, sha);
  if (againstParent.exit === 0) return namedFiles(againstParent);
  return namedFiles(git("diff-tree", "--root", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-r", sha));
}

// ---------------------------------------------------------------- audit gate

const stateDir = (): string => join(projectRoot(), ".swarmforge", "handoffs");
const auditPendingDir = (): string => join(stateDir(), "audit_pending");
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const senderAuditDir = (sender: string): string => join(auditPendingDir(), sha256(sender));
const auditTaskId = (headers: Headers): string | undefined => notEmpty(headers.task_id) ?? headers.task;
const auditFile = (sender: string, taskId: string | undefined): string =>
  join(senderAuditDir(sender), `${sha256(taskId ?? "")}.json`);
const legacyAuditFile = (sender: string, taskId: string | undefined): string =>
  join(senderAuditDir(sender), `${sha256(taskId ?? "")}.edn`);

function senderAuditFiles(sender: string): string[] {
  const dir = senderAuditDir(sender);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") || name.endsWith(".edn"))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile());
  } catch {
    return [];
  }
}

function withAuditLock<T>(fn: () => T): T {
  const dir = auditPendingDir();
  mkdirSync(dir, { recursive: true });
  return withDirLock(join(dir, ".lock"), fn);
}

function removeEmptySenderAuditDir(sender: string): void {
  const dir = senderAuditDir(sender);
  try {
    if (readdirSync(dir).every((name) => !statSync(join(dir, name)).isFile())) rmdirSync(dir);
  } catch {}
}

function deleteSenderAudits(sender: string): void {
  for (const path of senderAuditFiles(sender)) rmSync(path, { force: true });
  removeEmptySenderAuditDir(sender);
}

function draftFingerprint(draft: string): string {
  return sha256(readFileSync(draft, "utf8"));
}

function invocationFingerprint(draft: string, sender: string, headers: Headers): Candidate {
  return {
    sender,
    "task-id": auditTaskId(headers) ?? null,
    type: headers.type ?? null,
    recipients: (headers.to ?? "").split(","),
    priority: headers.priority ?? null,
    task: headers.task ?? null,
    commit: headers.commit ?? null,
    "task-base-commit": currentTaskBase() ?? "",
    "non-forwarding": headers["non-forwarding"] === "true",
    "draft-fingerprint": draftFingerprint(draft),
  };
}

function invalidateChangedInvocationAudits(sender: string, invocation: Candidate): void {
  withAuditLock(() => {
    for (const path of senderAuditFiles(sender)) {
      const candidate = readAuditCandidate(path) ?? {};
      const matches = Object.keys(invocation).every((key) => key in candidate && ednEqual(invocation[key], candidate[key]));
      if (!matches) rmSync(path, { force: true });
    }
    removeEmptySenderAuditDir(sender);
  });
}

function auditCandidate(
  draft: string, sender: string, headers: Headers, recipients: string[], commit: string | undefined, artifacts: string[],
): Candidate {
  return {
    version: 1,
    sender,
    "task-id": auditTaskId(headers) ?? null,
    type: headers.type ?? null,
    recipients,
    priority: headers.priority ?? null,
    task: headers.task ?? null,
    commit: commit ?? null,
    artifacts,
    "task-base-commit": currentTaskBase() ?? "",
    "non-forwarding": headers["non-forwarding"] === "true",
    "draft-fingerprint": draftFingerprint(draft),
  };
}

function printAuditRequired(candidate: Candidate): void {
  println("AUDIT_REQUIRED");
  println("HANDOFF_NOT_QUEUED");
  println("TASK_ID:", candidate["task-id"] ?? "");
  println("COMMIT:", candidate.commit ?? "");
  println();
  println("Re-read the complete inbound task payload and every source it references.");
  println("Compare the completed work product against every requirement and constraint,");
  println("including interactions, boundaries, failure cases, and negative requirements.");
  println("Establish requirement-to-evidence traceability appropriate to your role:");
  println("every requirement must be covered by the work, supported by relevant verification,");
  println("or identified as a gap.");
  println("Review the complete committed diff, tests and checks, generated artifacts,");
  println("and unrelated working-tree changes. Passing tools or clean formatting alone do");
  println("not establish that the task is complete.");
  println("Fix every finding, commit the corrections, rerun applicable checks, and repeat");
  println("this audit against the revised candidate before running the handoff command again.");
}

function incrementAuditCount(taskId: string): void {
  const root = projectRoot();
  const result = run(lib.script("pack_board.sh"), ["increment-audit", "--root", root, "--task-id", taskId], { cwd: root });
  if (result.exit !== 0) exit(1, `${result.err}\n${result.out}`.trim());
}

function submitAfterAudit(candidate: Candidate, submit: () => string[]): string[] | undefined {
  return withAuditLock(() => {
    const sender = candidate.sender as string;
    const taskId = candidate["task-id"] as string | null;
    const path = auditFile(sender, taskId ?? undefined);
    const previous = readAuditCandidate(existsSync(path) ? path : legacyAuditFile(sender, taskId ?? undefined));
    if (previous && ednEqual(candidate, previous)) {
      const result = submit();
      deleteSenderAudits(sender);
      return result;
    }
    deleteSenderAudits(sender);
    writeAudit(path, candidate);
    incrementAuditCount(taskId ?? "");
    printAuditRequired(candidate);
    return undefined;
  });
}

// ---------------------------------------------------------------- task / duplicate checks

function rejectedTask(card: Card | undefined): boolean {
  return !!card && !isBlank(card.name) && existsSync(join(projectRoot(), ".swarmforge", "notify", `reject-${card.name}`));
}

function boardCardErrors(card: Card | undefined, boardPresent: boolean, inProcessId: string | undefined, taskId: string | undefined): string[] {
  const errors: string[] = [];
  if (boardPresent && inProcessId === undefined && !card) {
    errors.push(`Handoff task_id '${taskId}' is not a current board task.`);
  }
  if (card?.lane === "done") errors.push(`Task '${card.name}' is done and cannot accept new handoffs.`);
  if (rejectedTask(card)) errors.push(`Task '${card!.name}' is rejected and must be retried before handoff.`);
  return errors;
}

export function taskStateErrors(headers: Headers, _sender: string): string[] {
  if (headers.type !== "git_handoff") return [];
  const taskId = notEmpty(headers.task_id) ?? headers.task;
  const inProcessId = currentInProcessTaskId();
  const card = boardCards().find((c) => c.id === taskId);
  const errors: string[] = [];
  if (isBlank(taskId)) errors.push("Missing required header 'task_id' for git_handoff.");
  if (inProcessId !== undefined && taskId !== inProcessId) {
    errors.push(`Handoff task_id '${taskId}' does not match current in-process task_id '${inProcessId}'.`);
  }
  errors.push(...boardCardErrors(card, existsSync(boardFile()), inProcessId, taskId));
  return errors;
}

function worktreesFromRoles(): string[] {
  return splitLines(readFileSync(rolesFile(), "utf8"))
    .map((line) => line.split("\t")[2])
    .filter((wt): wt is string => !isBlank(wt));
}

function activeStates(): [string, string[]][] {
  const handoffs = stateDir();
  const worktrees = worktreesFromRoles();
  return [
    ["pending approvals", [join(handoffs, "pending_approval")]],
    ["sent", [join(handoffs, "sent"), ...worktrees.map((wt) => join(wt, ".swarmforge", "handoffs", "sent"))]],
    [
      "recipient inbox",
      worktrees.flatMap((wt) => ["new", "in_process"].map((s) => join(wt, ".swarmforge", "handoffs", "inbox", s))),
    ],
  ];
}

function sameRecipients(theirsStr: string, oursList: string[]): boolean {
  const theirs = new Set(javaSplit(theirsStr, ","));
  return theirs.size === oursList.length && oursList.every((r) => theirs.has(r));
}

function sameActiveHandoff(sender: string, recipients: string[], headers: Headers, commit: string | undefined, path: string): boolean {
  const h = readHeaders(path);
  const taskId = notEmpty(headers.task_id) ?? headers.task;
  const otherId = notEmpty(h.get("task_id")) ?? h.get("task");
  return (
    h.get("from") === sender &&
    commit === h.get("commit") &&
    taskId === otherId &&
    sameRecipients(h.get("to") ?? "", recipients)
  );
}

function duplicateErrors(sender: string, recipients: string[], headers: Headers, commit: string | undefined): string[] {
  if (headers.type !== "git_handoff") return [];
  const matches: string[] = [];
  for (const [label, dirs] of activeStates()) {
    for (const dir of dirs) {
      for (const file of recursiveHandoffFiles(dir)) {
        if (sameActiveHandoff(sender, recipients, headers, commit, file)) matches.push(`${label}: ${file}`);
      }
    }
  }
  return matches.length > 0
    ? [`Duplicate active handoff for same from/to/task_id/commit exists: ${matches.join(", ")}`]
    : [];
}

function ancestryErrors(headers: Headers, commit: string | undefined): string[] {
  if (headers.type !== "git_handoff") return [];
  const base = currentTaskBase();
  if (!isBlank(base) && !isBlank(commit) && !commitDescendsFrom(base!, commit!)) {
    return [`Result commit ${commit} is not a descendant of task base ${base}.`];
  }
  return [];
}

// ---------------------------------------------------------------- draft parsing / validation

export interface ParsedDraft {
  headers: Headers;
  ordered: string[];
  errors: string[];
}

export function parseDraftText(text: string): ParsedDraft {
  const headers: Headers = {};
  const ordered: string[] = [];
  const errors: string[] = [];
  let bodySeen = false;
  splitLines(text).forEach((line, index) => {
    const lineNo = index + 1;
    if (bodySeen || isBlank(line) || !line.includes(": ")) {
      bodySeen = true;
      return;
    }
    const [field, value = ""] = splitOnce(line, ": ");
    if (isBlank(field) || isBlank(value)) errors.push(`Line ${lineNo}: field and value must both be non-empty.`);
    else if (reservedFields.has(field)) {
      errors.push(`Line ${lineNo}: header '${field}' is reserved and must not be written by agents.`);
    } else if (!allowedFields.has(field)) errors.push(`Line ${lineNo}: unknown header '${field}'.`);
    else if (field in headers) errors.push(`Line ${lineNo}: duplicate header '${field}'.`);
    else {
      headers[field] = value;
      ordered.push(field);
    }
  });
  return { headers, ordered, errors };
}

export const parseDraft = (draft: string): ParsedDraft => parseDraftText(readFileSync(draft, "utf8"));

export function validateRecipients(to: string | undefined): [string[], string[]] {
  if (isBlank(to)) return [[], []];
  const recipients = to!.split(",");
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const recipient of recipients) {
    if (isBlank(recipient)) errors.push("Header 'to' contains an empty recipient.");
    if (recipient.includes("_")) {
      errors.push(`Recipient role '${recipient}' is invalid; role names may not contain underscores.`);
    }
    if (seen.has(recipient)) errors.push(`Duplicate recipient '${recipient}'.`);
    if (!isBlank(recipient) && !deps.roleKnown(recipient)) errors.push(`Unknown recipient role '${recipient}'.`);
    seen.add(recipient);
  }
  return [recipients, errors];
}

function canonicalCommit(commit: string): [string | undefined, string | undefined] {
  const matches = splitLines(git("rev-parse", `--disambiguate=${commit}`).out);
  const count = matches.length === 1 && matches[0] === "" ? 0 : matches.length;
  if (count !== 1) {
    return [undefined, `Header 'commit' must resolve to exactly one Git object; '${commit}' matched ${count}.`];
  }
  const objectType = git("cat-file", "-t", matches[0]!).out.trim();
  if (objectType === "commit") return [git("rev-parse", "--short=10", matches[0]!).out.trim(), undefined];
  return [undefined, `Header 'commit' must resolve to a commit; '${commit}' resolves to '${objectType}'.`];
}

function fieldErrors(type: string | undefined, ordered: string[]): string[] {
  if (type === undefined) return [];
  return ordered
    .filter((field) => !allowedFieldsByType[type]?.has(field))
    .map((field) => `Header '${field}' is not allowed for type '${type}'.`);
}

function baseErrors(headers: Headers): string[] {
  const { type, to, priority } = headers;
  const errors: string[] = [];
  if (isBlank(type)) errors.push("Missing required header 'type'.");
  if (isBlank(to)) errors.push("Missing required header 'to'.");
  if (isBlank(priority)) errors.push("Missing required header 'priority'.");
  if (!isBlank(type) && !allowedTypes.has(type!)) {
    errors.push(`Header 'type' must be one of git_handoff or note; got '${type}'.`);
  }
  if (!isBlank(priority) && !validPriority(priority)) {
    errors.push(`Header 'priority' must be two digits from 00 to 99; got '${priority}'.`);
  }
  return errors;
}

function commitCheck(type: string | undefined, commit: string | undefined): [string | undefined, string | undefined] {
  if (type !== "git_handoff") return [undefined, undefined];
  if (isBlank(commit)) return [undefined, "Missing required header 'commit' for git_handoff."];
  if (!/^[0-9a-fA-F]{10}$/.test(commit!)) {
    return [undefined, `Header 'commit' must be exactly 10 hexadecimal characters; got '${commit}'.`];
  }
  return canonicalCommit(commit!);
}

function gitHeaderErrors(type: string | undefined, headers: Headers): string[] {
  const errors: string[] = [];
  const task = headers.task;
  if (type === "git_handoff") {
    if (isBlank(headers.task_id)) errors.push("Missing required header 'task_id' for git_handoff.");
    if (isBlank(task)) errors.push("Missing required header 'task' for git_handoff.");
    if ((task ?? "").length > 80) errors.push(`Header 'task' must be no longer than 80 characters; got ${task!.length}.`);
  } else {
    if (!isBlank(headers.commit)) errors.push("Header 'commit' is only allowed for git_handoff.");
    if (!isBlank(task)) errors.push("Header 'task' is only allowed for git_handoff.");
  }
  return errors;
}

function noteErrors(type: string | undefined, message: string | undefined): string[] {
  const errors: string[] = [];
  if (type === "note") {
    if (isBlank(message)) errors.push("Missing required header 'message' for note.");
    if ((message ?? "").length > 80) {
      errors.push(`Header 'message' must be no longer than 80 characters; got ${message!.length}.`);
    }
  } else if (!isBlank(message)) {
    errors.push("Header 'message' is only allowed for note.");
  }
  return errors;
}

export interface Validation {
  recipients: string[];
  canonicalCommit: string | undefined;
  errors: string[];
}

export function validate(headers: Headers, ordered: string[]): Validation {
  const type = headers.type;
  const [recipients, recipientErrors] = validateRecipients(headers.to);
  const [canonical, commitError] = commitCheck(type, headers.commit);
  return {
    recipients,
    canonicalCommit: canonical,
    errors: [
      ...baseErrors(headers),
      ...recipientErrors,
      ...fieldErrors(type, ordered),
      ...gitHeaderErrors(type, headers),
      ...(commitError ? [commitError] : []),
      ...noteErrors(type, headers.message),
    ],
  };
}

// ---------------------------------------------------------------- writing

function structureInstruction(handback: boolean): string {
  return handback
    ? "The inbound tree is the structure. Replay this role's current task onto that shape."
    : "This role's current tree is the structure. Replay the inbound work onto that shape.";
}

function handoffBody(type: string, sender: string, commit: string | undefined, message: string | undefined, handback: boolean): string {
  if (type === "git_handoff") {
    return `Re-read your role and constitution.\n\nmerge_and_process.sh ${sender} ${commit}\n\n${structureInstruction(handback)}`;
  }
  return `Re-read your role and constitution.\n\n${message}`;
}

interface WriteContext {
  headers: Headers;
  recipients: string[];
  canonicalCommit: string | undefined;
  artifacts: string | undefined;
  sender: string;
  priority?: string;
  nonForwarding?: boolean;
  reverse?: boolean;
}

function handoffPayloadLines(ctx: WriteContext, id: string, priority: string, nonForwarding: boolean, createdAt: string): string[] {
  const { headers, recipients, canonicalCommit: commit, sender } = ctx;
  const type = headers.type!;
  const taskBase = currentTaskBase();
  const lines = [`id: ${id}`, `from: ${sender}`, `to: ${recipients.join(",")}`, `priority: ${priority}`, `type: ${type}`];
  if (type === "git_handoff") {
    lines.push(`role: ${sender}`, `task_id: ${headers.task_id}`, `task: ${headers.task}`, `commit: ${commit}`, `artifacts: ${ctx.artifacts}`);
    if (!isBlank(taskBase)) lines.push(`task_base_commit: ${taskBase}`);
  }
  if (nonForwarding) lines.push("non-forwarding: true");
  if (type === "note") lines.push(`message: ${headers.message}`);
  lines.push(`created_at: ${createdAt}`, "", handoffBody(type, sender, commit, headers.message, !!(ctx.reverse || nonForwarding)));
  return lines;
}

function commitOutboxFile(tmpDir: string, outboxDir: string, filename: string, content: string): string {
  for (const dir of [tmpDir, outboxDir, join(stateDir(), "sent"), join(stateDir(), "failed")]) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpFile = join(tmpDir, `${filename}.tmp`);
  const outboxFile = join(outboxDir, filename);
  writeFileSync(tmpFile, content);
  if (existsSync(outboxFile)) exit(1, `Outbox file already exists: ${outboxFile}`);
  renameSync(tmpFile, outboxFile);
  return outboxFile;
}

function writeHandoff(ctx: WriteContext): string {
  const stamp = idTimestamp();
  const createdAt = isoInstant();
  const sequence = lib.nextSequence(stateDir());
  const id = `${stamp}_${sequence}_from_${ctx.sender}`;
  const priority = ctx.priority ?? ctx.headers.priority;
  const nonForwarding = ctx.nonForwarding ?? ctx.headers["non-forwarding"] === "true";
  const filename = `${priority}_${stamp}_${sequence}_from_${ctx.sender}_to_${ctx.recipients.join("_")}.handoff`;
  const outboxDir = join(stateDir(), "outbox");
  const lines = handoffPayloadLines(ctx, id, priority, nonForwarding, createdAt);
  return commitOutboxFile(join(outboxDir, "tmp"), outboxDir, filename, `${lines.join("\n")}\n`);
}

function writeHandoffs(ctx: WriteContext): string[] {
  const forward = writeHandoff({ ...ctx, reverse: false });
  if (ctx.headers.type !== "git_handoff") return [forward];
  const reverse = reverseRoles(ctx.sender).map((role) =>
    writeHandoff({ ...ctx, recipients: [role], priority: "00", nonForwarding: true, reverse: true }),
  );
  return [forward, ...reverse];
}

function errorReport(draft: string, errors: string[]): void {
  eprintln("HANDOFF INVALID:", draft);
  eprintln();
  eprintln("Errors:");
  for (const error of errors) eprintln("-", error);
  eprintln();
  eprintln(usageText);
}

function ensureField(ordered: string[], field: string): string[] {
  return ordered.includes(field) ? ordered : [...ordered, field];
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function parseMainArgs(args: string[]): string | undefined {
  if (args.some((arg) => arg === "--help" || arg === "-h") || args.length !== 1) {
    eprintln(usageText);
    return undefined;
  }
  return args[0];
}

function assertSenderEnvironment(draft: string, sender: string): void {
  if (!isRegularFile(draft)) exit(1, `Draft file not found: ${draft}`);
  if (!lib.roleKnown(sender)) exit(1, `Unknown sender role: ${sender}`);
  requireWorktreeTmpDraft(draft);
}

function assertInboundForwarding(headers: Headers, sha: string | undefined): void {
  if (headers.type !== "git_handoff") return;
  if (inboundNonForwarding()) {
    exit(1, "Current inbound handoff is non-forwarding; do not send a git_handoff.");
  }
  if (!commitOnSenderBranch(sha!)) {
    exit(1, `Result commit ${sha} is not reachable from sender worktree`);
  }
}

function collectDraftErrors(draft: string, sender: string, headers: Headers, ordered: string[]): ReturnType<typeof validate> | undefined {
  const validation = validate(headers, ordered);
  const errors = [
    ...validation.errors,
    ...currentWorkStateErrors(headers),
    ...taskStateErrors(headers, sender),
    ...ancestryErrors(headers, validation.canonicalCommit),
    ...duplicateErrors(sender, validation.recipients, headers, validation.canonicalCommit),
  ];
  if (errors.length > 0) {
    errorReport(draft, errors);
    return undefined;
  }
  return validation;
}

function submitHandoff(draft: string, sender: string, headers: Headers, validation: ReturnType<typeof validate>): string[] | undefined {
  const isGit = headers.type === "git_handoff";
  const files = isGit ? commitArtifacts(headers.commit!) : undefined;
  if (isGit && files!.length === 0) exit(1, `Result commit ${headers.commit} has no changed files`);
  const submit = (): string[] =>
    writeHandoffs({
      headers,
      recipients: validation.recipients,
      canonicalCommit: validation.canonicalCommit,
      artifacts: files?.join(","),
      sender,
    });
  return isGit
    ? submitAfterAudit(
        auditCandidate(draft, sender, headers, validation.recipients, validation.canonicalCommit, files!),
        submit,
      )
    : submit();
}

export function main(args: string[]): number | void {
  const draft = parseMainArgs(args);
  if (!draft) return args.length === 1 ? 0 : 1;
  const sender = lib.role();
  assertSenderEnvironment(draft, sender);

  const parsed = parseDraft(draft);
  const headers = prepareHeaders(parsed.headers, sender);
  let ordered = ensureField(parsed.ordered, "priority");
  if (headers.type === "git_handoff") ordered = ensureField(ordered, "commit");

  invalidateChangedInvocationAudits(sender, invocationFingerprint(draft, sender, headers));
  assertInboundForwarding(headers, headers.commit);
  if (parsed.errors.length > 0) {
    errorReport(draft, parsed.errors);
    return 2;
  }
  const validation = collectDraftErrors(draft, sender, headers, ordered);
  if (!validation) return 2;

  const outboxFiles = submitHandoff(draft, sender, headers, validation);
  if (!outboxFiles) return;
  rmSync(draft);
  for (const file of outboxFiles) println("HANDOFF QUEUED:", file);
  completeCurrentAfterGitHandoff(headers);
}
