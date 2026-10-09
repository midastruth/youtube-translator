// Port of ready_for_next_guard.bb: block taking new work while an outbound git handoff is active.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envRole, findProjectRoot, inferRoleFromWorktree } from "../core/project.ts";
import { isBlank } from "../core/text.ts";
import { readHeaders, recursiveHandoffFiles } from "./inbox.ts";

function roleRows(root: string | undefined): string[][] {
  if (!root) return [];
  const file = join(root, ".swarmforge", "roles.tsv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !isBlank(line))
    .map((line) => line.split("\t"));
}

export function currentRole(): string | undefined {
  return envRole() ?? inferRoleFromWorktree(roleRows(findProjectRoot()));
}

function activeOutboxDirs(root: string | undefined): string[] {
  const dirs = root ? [join(root, ".swarmforge", "handoffs", "outbox")] : [];
  for (const cols of roleRows(root)) {
    const worktree = cols[2];
    if (!isBlank(worktree)) dirs.push(join(worktree!, ".swarmforge", "handoffs", "outbox"));
  }
  return dirs;
}

function outboundGitFromRole(role: string, file: string): boolean {
  const headers = readHeaders(file);
  return headers.get("type") === "git_handoff" && headers.get("from") === role;
}

export function activeOutboundGitFiles(role: string | undefined): string[] {
  if (isBlank(role)) return [];
  const root = findProjectRoot();
  const pending = root ? recursiveHandoffFiles(join(root, ".swarmforge", "handoffs", "pending_approval")) : [];
  const outbox = activeOutboxDirs(root).flatMap((dir) => recursiveHandoffFiles(dir));
  return [...new Set([...pending, ...outbox])].filter((file) => outboundGitFromRole(role!, file));
}

export function waitMessage(active: readonly string[]): string[] {
  return ["WAITING_FOR_APPROVAL: current git handoff is still active", active.map((path) => `- ${path}`).join("\n")];
}
