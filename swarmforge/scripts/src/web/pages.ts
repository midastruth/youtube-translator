// Read-only GET pages: dashboard html, agent pane page, docs, mission, task body.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../core/proc.ts";
import { isBlank, splitLines } from "../core/text.ts";
import { allowedDoc, existingPath, isFile, parseMessage, readText, taskIdOf } from "./files.ts";
import { gitRefExists, pathReviewHistory, rejectedLatest } from "./actions.ts";
import { paneContent } from "./pane.ts";
import { pendingFile } from "./state.ts";

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8" };
const HTML = { "Content-Type": "text/html; charset=utf-8" };
export const notFound = (): Response => ({ status: 404, body: "Not found" });
export const text = (body: string): Response => ({ status: 200, headers: TEXT, body });

const scriptsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const dashboardPage = (): Response => ({ status: 200, headers: HTML, body: readText(join(scriptsDir, "pack", "dashboard.html")) });

export function queryValue(uri: string | undefined, key: string): string | undefined {
  if (!uri || !uri.includes("?")) return undefined;
  const query = uri.slice(uri.indexOf("?") + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    if (k === key) return decodeForm(eq < 0 ? "" : pair.slice(eq + 1));
  }
  return undefined;
}

/** `java.net.URLDecoder/decode`: `+` is a space, `%XX` is a byte. */
export function decodeForm(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export const pathOf = (uri: string | undefined): string => (uri ?? "").split("?")[0]!;

export function htmlEscape(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const projectQuery = (project: string | undefined): string =>
  project ? `?project=${encodeURIComponent(project).replace(/%20/g, "+")}` : "";

export function panePage(role: string, snapshot: string, project?: string): string {
  const roleHtml = htmlEscape(role);
  const paneUrl = `/api/agents/${roleHtml}/pane${projectQuery(project)}`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>Agent ${roleHtml}</title>` +
    "<style>html,body{height:100%;margin:0;overflow:hidden;background:#111;color:#f4f4f4;" +
    "font-family:ui-monospace,Menlo,monospace}" +
    "body{display:flex;flex-direction:column}" +
    "header{height:42px;box-sizing:border-box;padding:10px 12px;border-bottom:1px solid #333;flex:0 0 auto}" +
    "h1{font:inherit;margin:0;font-size:14px}" +
    "#pane{flex:1 1 auto;margin:0;padding:12px;white-space:pre-wrap;overflow:auto;" +
    "min-height:0;height:calc(100vh - 42px);max-height:calc(100vh - 42px)}</style></head>" +
    `<body><header><h1>${roleHtml}</h1></header>` +
    `<pre id="pane">${htmlEscape(snapshot)}</pre>` +
    "<script>(function(){" +
    "const pane=document.getElementById('pane');" +
    "let stickBottom=true;" +
    "let firstPaint=true;" +
    "function nearBottom(){" +
    "return (pane.scrollHeight-pane.scrollTop-pane.clientHeight)<=64;}" +
    "function toEnd(){pane.scrollTop=pane.scrollHeight;stickBottom=true;}" +
    "function toEndSoon(){" +
    "toEnd();requestAnimationFrame(toEnd);" +
    "setTimeout(toEnd,0);setTimeout(toEnd,50);setTimeout(toEnd,200);}" +
    "pane.addEventListener('scroll',function(){stickBottom=nearBottom();},{passive:true});" +
    "async function refresh(){" +
    `const r=await fetch('${paneUrl}',{cache:'no-store'});` +
    "const text=await r.text();" +
    "const changed=text!==pane.textContent;" +
    "if(changed){pane.textContent=text;}" +
    "if(firstPaint||stickBottom){toEndSoon();firstPaint=false;}" +
    "}" +
    "refresh();setInterval(refresh,1000);" +
    "window.addEventListener('load',toEndSoon);" +
    "window.addEventListener('pageshow',toEndSoon);" +
    "})();</script></body></html>"
  );
}

export function agentRole(uri: string | undefined): string | undefined {
  const match = /^\/agent\/([^/]+)$/.exec(pathOf(uri));
  return match ? decodeForm(match[1]!) : undefined;
}

export function agentPaneRole(uri: string | undefined): string | undefined {
  const match = /^\/api\/agents\/([^/]+)\/pane$/.exec(pathOf(uri));
  return match ? decodeForm(match[1]!) : undefined;
}

export function getAgent(root: string, uri: string): Response {
  const role = agentRole(uri);
  if (!role) return notFound();
  return { status: 200, headers: HTML, body: panePage(role, paneContent(root, role), queryValue(uri, "project")) };
}

export function getAgentPane(root: string, uri: string): Response {
  const role = agentPaneRole(uri);
  return role ? text(paneContent(root, role)) : notFound();
}

export const taskQueryName = (uri: string | undefined): string | undefined =>
  (uri ?? "").startsWith("/task") ? queryValue(uri, "name") : undefined;

export function getTask(root: string, uri: string): Response {
  const name = taskQueryName(uri);
  if (isBlank(name) || name!.includes("/") || name!.includes("..")) return notFound();
  const file = join(root, ".swarmforge", "board", `${name}.txt`);
  return isFile(file) ? text(`${name}\n\n${readText(file)}`) : notFound();
}

export function getMission(root: string): Response {
  const file = join(root, "mission.md");
  return text(isFile(file) ? readText(file) : "");
}

export function getDoc(root: string, uri: string): Response {
  const rel = queryValue(uri, "path");
  return allowedDoc(root, rel) ? text(readText(existingPath(root, rel!)!)) : notFound();
}

export interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
}

export function parseUnifiedDiff(diff: string | undefined): DiffLine[] {
  const lines = splitLines(diff ?? "");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  if (start < 0) return [];
  return lines.slice(start + 1).flatMap((line): DiffLine[] => {
    if (line.startsWith("+")) return [{ type: "add", text: line.slice(1) }];
    if (line.startsWith("-")) return [{ type: "del", text: line.slice(1) }];
    if (line.startsWith("\\")) return [];
    if (line.startsWith(" ")) return [{ type: "same", text: line.slice(1) }];
    if (line.trim() === "") return [{ type: "same", text: "" }];
    return [{ type: "same", text: line }];
  });
}

function fileDiffLines(root: string, prior: string, commit: string, rel: string): DiffLine[] | undefined {
  const result = run("git", ["-C", root, "diff", "--no-color", "-U999999", prior, commit, "--", rel]);
  if (result.exit !== 0) return undefined;
  if (result.out.trim() === "") {
    return splitLines(readText(existingPath(root, rel)!)).map((line) => ({ type: "same" as const, text: line }));
  }
  return parseUnifiedDiff(result.out);
}

function pendingHeaders(root: string, id: string | undefined): Map<string, string> {
  if (isBlank(id)) return new Map();
  const file = pendingFile(root, id!);
  return isFile(file) ? parseMessage(file).headers : new Map();
}

function resolveDocDiff(root: string, taskId: string | undefined, commit: string | undefined, rel: string): DiffLine[] | undefined {
  if (!taskId || !commit) return undefined;
  const prior = rejectedLatest(taskId);
  if (!gitRefExists(root, prior)) return undefined;
  return fileDiffLines(root, prior, commit, rel);
}

export function getApiDoc(root: string, uri: string): Response {
  const rel = queryValue(uri, "path");
  if (!allowedDoc(root, rel)) return notFound();
  const docText = readText(existingPath(root, rel!)!);
  const headers = pendingHeaders(root, queryValue(uri, "id"));
  const taskId = taskIdOf(headers);
  const lines = resolveDocDiff(root, taskId, headers.get("commit"), rel!);
  return {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      path: rel,
      text: docText,
      has_diff: lines !== undefined,
      lines: lines ?? [],
      history: pathReviewHistory(root, taskId, rel!),
    }),
  };
}
