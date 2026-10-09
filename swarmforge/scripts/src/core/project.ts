// Locate the SwarmForge project root and the current role.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { exit } from "./cli.ts";
import { run } from "./proc.ts";

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

export function gitToplevel(cwd = process.cwd()): string | undefined {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const out = result.exit === 0 ? result.out.trim() : "";
  return out || undefined;
}

export function gitCommonDir(cwd = process.cwd()): string | undefined {
  const result = run("git", ["rev-parse", "--git-common-dir"], { cwd });
  const out = result.exit === 0 ? result.out.trim() : "";
  if (!out) return undefined;
  return isAbsolute(out) ? out : resolve(cwd, out);
}

export function rolesAt(root: string | undefined): root is string {
  return !!root && existsSync(join(root, ".swarmforge", "roles.tsv"));
}

/** Project root: the main checkout of the worktree, else git toplevel, else cwd. */
export function findProjectRoot(cwd = process.cwd()): string | undefined {
  const common = gitCommonDir(cwd);
  const parent = common ? dirname(common) : undefined;
  if (rolesAt(parent)) return parent;
  const top = gitToplevel(cwd);
  if (rolesAt(top)) return top;
  if (rolesAt(cwd)) return cwd;
  return undefined;
}

export function projectRoot(cwd = process.cwd()): string {
  return findProjectRoot(cwd) ?? exit(1, "Cannot find SwarmForge project root");
}

export function rolesFile(root = projectRoot()): string {
  return join(root, ".swarmforge", "roles.tsv");
}

/** Raw `roles.tsv` rows (all lines, fields split keeping empties). */
export function roleRows(root = projectRoot()): string[][] {
  return readFileSync(rolesFile(root), "utf8")
    .split("\n")
    .filter((line, index, all) => !(line === "" && index === all.length - 1))
    .map((line) => line.split("\t"));
}

export function inferRoleFromWorktree(rows: string[][], cwd = process.cwd()): string | undefined {
  const here = gitToplevel(cwd) ?? cwd;
  for (const cols of rows) {
    const role = cols[0];
    const worktree = cols[2];
    if (role && worktree && samePath(worktree, here)) return role;
  }
  return undefined;
}

export function envRole(): string | undefined {
  return process.env.SWARMFORGE_ROLE || undefined;
}
