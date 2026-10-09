import { readFileSync } from "node:fs";

/** Split TSV text into rows, keeping empty trailing fields and skipping blank lines. */
export function parseTsv(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));
}

export function formatTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `${row.join("\t")}\n`).join("");
}

export function readTsv(file: string): string[][] {
  return parseTsv(readFileSync(file, "utf8"));
}

/** One line of `.swarmforge/roles.tsv`. */
export interface RoleRow {
  role: string;
  worktreeName: string;
  worktreePath: string;
  session: string;
  displayName: string;
  agent: string;
  receiveMode: string;
  propagation: string;
}

export function parseRoleRow(fields: readonly string[]): RoleRow {
  const [role = "", worktreeName = "", worktreePath = "", session = "", displayName = "",
    agent = "", receiveMode = "", propagation = ""] = fields;
  return { role, worktreeName, worktreePath, session, displayName, agent, receiveMode, propagation };
}

export function formatRoleRow(row: RoleRow): string[] {
  return [row.role, row.worktreeName, row.worktreePath, row.session, row.displayName,
    row.agent, row.receiveMode, row.propagation];
}
