// Agent pane text: capture, status-sentence extraction, and activity heat.

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { isBlank, splitLines } from "../core/text.ts";
import { backendName, inProcessDir, inProcessFiles, isDir, isFile, parseMessage, readText, roleRow } from "./files.ts";
import { capturePane, seams } from "./tmux.ts";

const paneHeat = new Map<string, { bag: Map<string, number>; heat: number }>();
const paneStatus = new Map<string, string>();
const paneStatusLines = new Map<string, string[]>();

export function resetPaneCaches(): void {
  paneHeat.clear();
  paneStatus.clear();
  paneStatusLines.clear();
}

export const paneCacheKey = (root: string, role: string): string => `${root}\u0000${role}`;

export function lastNLines(text: string | undefined, n: number): string[] {
  return splitLines(text ?? "").slice(-n);
}

const foldApostrophe = (s: string | undefined): string => (s ?? "").replace(/\u2019/g, "'");

export function paneSentences(text: string | undefined): string[] {
  const joined = splitLines(text ?? "")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return joined
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const iStatus = (sentence: string): boolean => /(?<![A-Za-z0-9_])I(?:'(?:ll|m|ve))?(?![A-Za-z0-9_])/.test(foldApostrophe(sentence));

function otherStatus(sentence: string): boolean {
  const n = foldApostrophe(sentence).toLowerCase();
  return [/\blet me\b/, /hand off/, /handing off/, /handoff/, /continue/, /\breceived\b/, /\bsettled\b/, /\bresolved\b/, /\bcompleted\b/, /\bfound\b/]
    .some((re) => re.test(n));
}

const toolTrace = (sentence: string): boolean => /^(?:•\s*)?(?:ran|edited|added)\b/i.test(foldApostrophe(sentence));

export function mailBanner(sentence: string): boolean {
  const n = foldApostrophe(sentence).toLowerCase();
  return n.includes("you have new handoff mail") || /if idle, run ready_for_next/.test(n) || n.includes("rejected:");
}

function paneChrome(sentence: string): boolean {
  const n = foldApostrophe(sentence).toLowerCase();
  return n.includes("to view transcript") || n.includes("running the handoff command again");
}

export function statusSentence(sentence: string): boolean {
  return !mailBanner(sentence) && !toolTrace(sentence) && !paneChrome(sentence) && (iStatus(sentence) || otherStatus(sentence));
}

const stripBullet = (s: string): string => s.replace(/^[•*]\s*/, "");

function codexThrowawayBullet(sentence: string): boolean {
  const n = foldApostrophe(stripBullet(sentence)).toLowerCase();
  return (
    /^(?:working|ran|edited|added|searching|searched)\b/.test(n) ||
    /you have \d+ usage limit reset available/.test(n) ||
    mailBanner(sentence) ||
    paneChrome(sentence)
  );
}

export function codexBullets(text: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of splitLines(text ?? "")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[•*]\s*/.test(line)) out.push(line);
    else if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line}`;
  }
  return out;
}

export function dropMailLines(text: string | undefined): string {
  return splitLines(text ?? "").filter((line) => !mailBanner(line)).join("\n");
}

const paneSample = (text: string | undefined): string => dropMailLines(text);

function matchingStatusSentences(text: string | undefined, backend: string | undefined): string[] {
  const joined = lastNLines(paneSample(text), 20).join("\n");
  const fromSentences = paneSentences(joined).filter(statusSentence);
  if (backend === "codex") {
    const bullets = codexBullets(joined).filter((b) => !codexThrowawayBullet(b));
    if (bullets.length > 0) return bullets;
  }
  return fromSentences;
}

function imStatusLines(key: string, text: string | undefined, backend: string | undefined): string[] {
  const found = matchingStatusSentences(text, backend).slice(-2);
  if (found.length > 0) {
    paneStatusLines.set(key, found);
    paneStatus.set(key, found.at(-1)!);
    return found;
  }
  const cached = paneStatusLines.get(key);
  if (cached && cached.length > 0) return cached;
  const one = paneStatus.get(key) ?? "";
  return isBlank(one) ? [] : [one];
}

function paneFiles(root: string, role: string): string[] {
  const dir = join(root, ".swarmforge", "sessions", role);
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name, "pane.txt"))
    .filter(isFile);
}

function inProcessTask(root: string, role: string): string | undefined {
  const worktree = roleRow(root, role)?.[2];
  if (!worktree) return undefined;
  for (const file of inProcessFiles(inProcessDir(worktree))) {
    const task = parseMessage(file).headers.get("task");
    if (task !== undefined) return task;
  }
  return undefined;
}

export function recordedPane(root: string, role: string): string | undefined {
  const direct = join(root, ".swarmforge", "sessions", role, "pane.txt");
  if (isFile(direct)) return readText(direct);
  const files = paneFiles(root, role);
  const task = inProcessTask(root, role);
  const forTask = task ? files.find((file) => file.split("/").at(-2) === task) : undefined;
  const chosen = forTask ?? [...files].sort().at(-1);
  return chosen ? readText(chosen) : undefined;
}

export function livePaneText(root: string, role: string): string | undefined {
  if (seams.paneText !== undefined) return seams.paneText;
  const row = roleRow(root, role);
  return (row ? capturePane(root, row) : undefined) ?? recordedPane(root, role);
}

export function paneContent(root: string, role: string): string {
  const row = roleRow(root, role);
  return (row ? capturePane(root, row) || undefined : undefined) ?? (recordedPane(root, role) || undefined) ??
    `(no pane capture for ${role})\n`;
}

export function paneStatusLinesFor(root: string, role: string): string[] {
  const row = roleRow(root, role);
  if (!row) return [];
  return imStatusLines(paneCacheKey(root, role), livePaneText(root, role), backendName(row));
}

export const paneStatusFor = (root: string, role: string): string => paneStatusLinesFor(root, role).at(-1) ?? "";

function frequencies(lines: string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const line of lines) bag.set(line, (bag.get(line) ?? 0) + 1);
  return bag;
}

function bagDiff(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) n += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
  return n;
}

function recordHeat(key: string, text: string | undefined): number {
  const bag = frequencies(lastNLines(paneSample(text), 20));
  const prev = paneHeat.get(key);
  const heat = Math.min(6, prev ? bagDiff(prev.bag, bag) : 0);
  paneHeat.set(key, { bag, heat });
  return heat;
}

export function roleHeat(root: string, role: string, alive: boolean, text: string | undefined): number {
  return alive ? recordHeat(paneCacheKey(root, role), text) : 0;
}
