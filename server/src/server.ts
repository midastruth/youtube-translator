import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, createDefaultCache, resolveDependencies, type AppDependencies } from "./app.js";
import { SubtitleCache } from "./cache.js";
import { AgentWorker } from "../../worker/agent-worker.js";
import { attachWebSocket } from "./websocket.js";

export interface ServerOptions extends AppDependencies {
  port?: number;
  host?: string;
}

export interface RunningServer {
  server: http.Server;
  worker: AgentWorker;
  cache: SubtitleCache;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export function createServer(options?: Partial<ServerOptions>): {
  server: http.Server;
  cache: SubtitleCache;
  worker: AgentWorker;
  ready: Promise<void>;
  close: () => Promise<void>;
} {
  const cache = options?.cache || createDefaultCache();

  const cacheDir = cache.cacheDir || process.env.CACHE_DIR || "./cache";
  const storagePath =
    process.env.TRANSLATION_AGENT_STORAGE ||
    path.join(cacheDir, "durable-storage.db");
  const worker = options?.worker || new AgentWorker({ storagePath });

  const app = createApp({
    ...options,
    cache,
    worker,
  });

  const server = http.createServer(app);

  let wsCleanup: (() => Promise<void> | void) | null = null;

  // Resolve dependencies once and attach WebSocket without creating a second worker
  const resolvedDepsPromise = resolveDependencies({ ...options, cache, worker });
  const ready = (async () => {
    const resolvedDeps = await resolvedDepsPromise;
    wsCleanup = attachWebSocket(server, resolvedDeps);
  })();

  const close = async () => {
    try {
      await ready;
      if (wsCleanup) {
        await wsCleanup();
        wsCleanup = null;
      }
    } catch {
      // ignore
    }
    try {
      server.closeAllConnections?.();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      await worker.close();
    } catch {
      // ignore
    }
  };

  return {
    server,
    cache,
    worker,
    ready,
    close,
  };
}

export async function startServer(options?: Partial<ServerOptions>): Promise<RunningServer> {
  const rawPort = options?.port ?? process.env.PORT ?? 8787;
  const port = Number(rawPort);
  const host = options?.host ?? process.env.HOST ?? "0.0.0.0";

  const { server, cache, worker, ready, close } = createServer(options);

  // Validate port range before attempting to bind, ensuring worker is cleaned up on invalid port
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    await close();
    throw new RangeError(`Port must be an integer between 0 and 65535, received: ${rawPort}`);
  }

  // Start worker and wait for WebSocket attachment; do not swallow failures
  try {
    await worker.start();
    await ready;
  } catch (err) {
    await close();
    throw new Error(`Server initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      server.once("error", async (err) => {
        if (!settled) {
          settled = true;
          try {
            await close();
          } catch {
            // ignore
          }
          reject(err);
        }
      });

      try {
        server.listen(port, host, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          close().finally(() => reject(err));
        }
      }
    });
  } catch (err) {
    try {
      await close();
    } catch {
      // ignore
    }
    throw err;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    worker,
    cache,
    port: actualPort,
    host,
    close,
  };
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const running = await startServer();
  console.log(`YouTube Ingest & Translate server running at http://${running.host}:${running.port}`);

  const shutdown = async () => {
    console.log("Shutting down gracefully...");
    await running.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
