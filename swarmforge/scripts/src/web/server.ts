// Port of pack_web.bb --serve: the dashboard HTTP server on 127.0.0.1.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eprintln, exit, println } from "../core/cli.ts";
import { isBlank } from "../core/text.ts";
import { handleRequest } from "./routes.ts";
import { writePackWebPid } from "./teardown.ts";

export const usageText = "Usage:\n  pack_web.sh --serve <root> [port]";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveRequest(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const response = handleRequest(root, { method: (req.method ?? "GET").toUpperCase(), uri: req.url ?? "/", body });
  res.writeHead(response.status, response.headers ?? {});
  res.end(response.body);
}

function writeDashboardUrl(root: string, url: string): void {
  mkdirSync(join(root, ".swarmforge"), { recursive: true });
  writeFileSync(join(root, ".swarmforge", "dashboard-url"), `${url}\n`);
}

export function startServer(root: string | undefined, port: string | undefined): Promise<ReturnType<typeof createServer>> {
  if (isBlank(root)) exit(1, "Missing project root");
  const server = createServer((req, res) => {
    serveRequest(root!, req, res).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(isBlank(port) ? 0 : Number(port), "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      writePackWebPid(root!);
      writeDashboardUrl(root!, url);
      println(url);
      resolve(server);
    });
  });
}

export async function serve(root: string | undefined, port: string | undefined): Promise<void> {
  await startServer(root, port);
}

export async function main(args: string[]): Promise<number | void> {
  if (args[0] === "--serve") return serve(args[1], args[2]);
  eprintln(usageText);
  return 1;
}
