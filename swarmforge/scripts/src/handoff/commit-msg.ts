// Port of commit_msg_hook.bb: append `By <role>.` to commit messages.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envRole, gitCommonDir, gitToplevel, samePath } from "../core/project.ts";
import { splitLines, trimEnd } from "../core/text.ts";

function rolesFile(): string | undefined {
  const root = gitToplevel();
  if (!root) return undefined;
  const direct = join(root, ".swarmforge", "roles.tsv");
  if (existsSync(direct)) return direct;
  const common = gitCommonDir();
  const candidate = common ? join(dirname(common), ".swarmforge", "roles.tsv") : undefined;
  return candidate && existsSync(candidate) ? candidate : undefined;
}

function inferRole(): string | undefined {
  const file = rolesFile();
  if (!file) return undefined;
  const here = gitToplevel() ?? process.cwd();
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    const [role, , worktree] = line.split("\t");
    if (role && worktree && samePath(worktree, here)) return role;
  }
  return undefined;
}

export const byline = (role: string): string => `By ${role}.`;

export function appendByline(text: string, role: string): string {
  return `${trimEnd(text)}\n\n${byline(role)}\n`;
}

export function main(args: string[]): number {
  if (args.length !== 1) return 0;
  const role = envRole() ?? inferRole();
  if (role) {
    const file = args[0]!;
    const text = readFileSync(file, "utf8");
    if (!text.includes(byline(role))) writeFileSync(file, appendByline(text, role));
  }
  return 0;
}
