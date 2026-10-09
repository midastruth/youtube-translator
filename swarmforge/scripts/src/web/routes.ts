// HTTP routing for the dashboard. `handleRequest` is pure request → response so it can be
// exercised in-process by tests; `server.ts` adapts it to node:http.

import { CliExit } from "../core/cli.ts";
import { isBlank } from "../core/text.ts";
import * as actions from "./actions.ts";
import { isFile } from "./files.ts";
import * as forge from "./forge.ts";
import { HttpError, messageOf, statusOf } from "./http-error.ts";
import * as pages from "./pages.ts";
import { notFound, pathOf, queryValue, type Response } from "./pages.ts";
import { apiState, pendingFile } from "./state.ts";
import { confirmTeardown, scheduleTeardown } from "./teardown.ts";

export interface Request {
  method: string;
  uri: string;
  body?: string;
}

/** Test seam: when set, teardown runs through this instead of being scheduled. */
export const teardownHooks: { schedule: (root: string) => void } = { schedule: scheduleTeardown };

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (value: unknown, status = 200): Response => ({ status, headers: JSON_HEADERS, body: JSON.stringify(value) });
const ok = (extra: Record<string, unknown> = {}): Response => json({ ok: true, ...extra });
const httpError = (status: number, message: string): Response => json({ error: message }, status);

type Body = Record<string, unknown>;

function bodyMap(body: string | undefined): Body {
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

/** Like cheshire's parse-string: invalid JSON is an error the caller surfaces. */
function strictBody(body: string | undefined): Body {
  const parsed: unknown = JSON.parse(body || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Body) : {};
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : value == null ? undefined : String(value));

function errorStatus(error: unknown, fallback: number): number {
  if (error instanceof CliExit) return error.message.includes("Duplicate") ? 409 : 400;
  return statusOf(error, fallback);
}

function guarded(fallback: number, fn: () => Response): Response {
  try {
    return fn();
  } catch (error) {
    return httpError(errorStatus(error, fallback), messageOf(error));
  }
}

// ---------------------------------------------------------------- project scoping (forge)

function requestProjectRoot(root: string, uri: string): string {
  if (!forge.isForge(root)) return root;
  const project = queryValue(uri, "project");
  return project ? forge.projectDir(root, project) : root;
}

function findOpenProjectRoot(root: string, file: (projectRoot: string) => string, label: string, id: string | undefined): string {
  for (const name of forge.readOpenProjects(root)) {
    const projectRoot = forge.projectDir(root, name);
    if (id !== undefined && isFile(file(projectRoot))) return projectRoot;
  }
  throw new HttpError(404, `Unknown ${label}: ${id}`);
}

function approvalRoute(uri: string): { id: string; action: string } | undefined {
  const match = /^\/api\/approvals\/([^/]+)\/(approve|reject|comments)$/.exec(pathOf(uri));
  return match ? { id: pages.decodeForm(match[1]!), action: match[2]! } : undefined;
}

function clarificationRoute(uri: string): string | undefined {
  const match = /^\/api\/clarifications\/([^/]+)\/answer$/.exec(pathOf(uri));
  return match ? pages.decodeForm(match[1]!) : undefined;
}

function scopedApprovalRoot(root: string, uri: string, body: string | undefined): string {
  if (!forge.isForge(root)) return root;
  const m = bodyMap(body);
  const id = approvalRoute(uri)?.id ?? str(m.id);
  const project = str(m.project);
  if (!isBlank(project)) return forge.projectDir(root, project!);
  if (!isBlank(id)) return findOpenProjectRoot(root, (p) => pendingFile(p, id!), "approval", id);
  throw new HttpError(400, "Missing project");
}

function scopedClarRoot(root: string, uri: string): string {
  if (!forge.isForge(root)) return root;
  const id = clarificationRoute(uri);
  return findOpenProjectRoot(root, (p) => actions.clarPendingFile(p, id ?? ""), "clarification", id);
}

// ---------------------------------------------------------------- GET

function staticGet(root: string, uri: string): Response | undefined {
  if (uri === "/") return pages.dashboardPage();
  if (uri === "/api/state") return json(apiState(root));
  return undefined;
}

function dynamicGet(root: string, uri: string): Response {
  const path = pathOf(uri);
  const projRoot = requestProjectRoot(root, uri);
  if (pages.agentPaneRole(uri)) return pages.getAgentPane(projRoot, uri);
  if (pages.agentRole(uri)) return pages.getAgent(projRoot, uri);
  if (pages.taskQueryName(uri) !== undefined) return pages.getTask(projRoot, uri);
  if (path.startsWith("/api/doc")) return pages.getApiDoc(projRoot, uri);
  if (uri.startsWith("/doc")) return pages.getDoc(projRoot, uri);
  if (path === "/api/mission") return pages.getMission(projRoot);
  return notFound();
}

export function handleGet(root: string, uri: string): Response {
  return staticGet(root, uri) ?? dynamicGet(root, uri);
}

// ---------------------------------------------------------------- POST

function postTasks(root: string, body: string | undefined): Response {
  return guarded(400, () => {
    const { name, text, project } = strictBody(body);
    const isForge = forge.isForge(root);
    if (isForge && isBlank(str(project))) throw new HttpError(400, "Missing project");
    const dest = isForge ? forge.projectDir(root, str(project)!) : root;
    actions.createTask(dest, str(name), str(text));
    return ok();
  });
}

function postDeleteTask(root: string, body: string | undefined): Response {
  return guarded(400, () => {
    const { name, id } = strictBody(body);
    if (!isBlank(str(id))) actions.deleteApproval(root, str(id)!);
    else actions.deleteTask(root, str(name));
    return ok();
  });
}

function postRetryTask(root: string, body: string | undefined): Response {
  return guarded(400, () => {
    const { id, comments } = strictBody(body);
    if (isBlank(str(id))) throw new HttpError(400, "Missing approval id");
    actions.retryApproval(root, str(id)!, str(comments));
    return ok();
  });
}

function postApproval(root: string, uri: string, body: string | undefined): Response {
  const route = approvalRoute(uri);
  if (!route) return notFound();
  if (route.action === "approve") {
    actions.approve(root, route.id);
    return ok();
  }
  if (route.action === "comments") {
    const { path, comments } = strictBody(body);
    actions.saveReview(root, route.id, str(path), str(comments));
    return ok();
  }
  return json({ error: "Reject opens the dialog; use Retry, Delete, or Accept." }, 400);
}

function postClarification(root: string, uri: string, body: string | undefined): Response {
  const id = clarificationRoute(uri);
  if (!id) return notFound();
  actions.answerClarification(root, id, str(strictBody(body).text) ?? "");
  return ok();
}

function teardownResponse(root: string, body: string | undefined): Response {
  if (!confirmTeardown(body)) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Teardown requires confirm=TEARDOWN (JSON {"confirm":"TEARDOWN"}).\n',
    };
  }
  teardownHooks.schedule(root);
  return ok({ status: "teardown_started" });
}

type PostHandler = (root: string, uri: string, body: string | undefined) => Response;

const STATIC_POST: Record<string, PostHandler> = {
  "/api/projects": (root, _uri, body) => {
    const created = forge.instantiate(root, bodyMap(body) as forge.NewProject);
    forge.openProject(root, created.name);
    return ok(created);
  },
  "/api/projects/open": (root, _uri, body) => ok(forge.openProject(root, str(bodyMap(body).name))),
  "/api/projects/close": (root, _uri, body) => ok(forge.closeProject(root, str(bodyMap(body).name))),
  "/api/tasks": (root, _uri, body) => postTasks(root, body),
  "/api/tasks/delete": (root, uri, body) => postDeleteTask(scopedApprovalRoot(root, uri, body), body),
  "/api/tasks/retry": (root, uri, body) => postRetryTask(scopedApprovalRoot(root, uri, body), body),
  "/api/chat": (root, _uri, body) => {
    actions.postChat(root, str(strictBody(body).text) ?? "");
    return ok();
  },
  "/api/teardown": (root, _uri, body) => teardownResponse(root, body),
};

export function handlePost(root: string, uri: string, body: string | undefined): Response {
  const staticHandler = STATIC_POST[uri];
  if (staticHandler) return staticHandler(root, uri, body);
  if (uri.startsWith("/api/approvals/")) return postApproval(scopedApprovalRoot(root, uri, body), uri, body);
  if (uri.startsWith("/api/clarifications/")) return postClarification(scopedClarRoot(root, uri), uri, body);
  return notFound();
}

export function handleRequest(root: string, request: Request): Response {
  try {
    if (request.method === "GET") return handleGet(root, request.uri);
    if (request.method === "POST") return handlePost(root, request.uri, request.body);
    return notFound();
  } catch (error) {
    return httpError(errorStatus(error, 500), messageOf(error));
  }
}
