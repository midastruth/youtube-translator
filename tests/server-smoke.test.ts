import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

describe("Server Compiled Artifact & Health HTTP Smoke Test", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yts-smoke-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("dist/server/src/server.js exists and is an executable compiled entrypoint", async () => {
    const serverPath = path.resolve("dist/server/src/server.js");
    const stat = await fs.stat(serverPath);
    assert.ok(stat.isFile(), "dist/server/src/server.js should exist as a compiled file");
    assert.ok(stat.size > 0, "dist/server/src/server.js should not be empty");
  });

  it("starts compiled server process and passes /api/health check", { timeout: 20_000 }, async () => {
    const port = await getFreePort();
    const serverPath = path.resolve("dist/server/src/server.js");
    const cacheDir = path.join(tmpDir, "cache");
    const storagePath = path.join(tmpDir, "worker.db");

    const child = spawn(process.execPath, [serverPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        CACHE_DIR: cacheDir,
        TRANSLATION_AGENT_STORAGE: storagePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (d) => { output += d.toString(); });
    child.stderr?.on("data", (d) => { output += d.toString(); });

    const stopProcess = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      let exited = false;
      let timer: NodeJS.Timeout | null = null;
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once("exit", () => {
            exited = true;
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!exited) {
              try { child.kill("SIGKILL"); } catch { /* ignore */ }
            }
            resolve();
          }, 3000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    };

    try {
      const healthUrl = `http://127.0.0.1:${port}/api/health`;
      let ok = false;
      let lastError: any = null;

      // Poll until server is ready or timeout (max 10s)
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            const data = await res.json() as any;
            assert.equal(res.status, 200);
            assert.equal(data.status, "ok");
            assert.equal(data.version, "0.3.0");
            ok = true;
            break;
          }
        } catch (err) {
          lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (!ok) {
        throw new Error(`Server failed to respond to /api/health on port ${port}. Last error: ${lastError?.message}. Process output:\n${output}`);
      }
    } finally {
      await stopProcess();
    }
  });

  it("can import startServer from dist/server/src/server.js and respond to HTTP health", { timeout: 15_000 }, async () => {
    const serverMod = await import(path.resolve("dist/server/src/server.js"));
    const { SubtitleCache } = await import(path.resolve("dist/server/src/cache.js"));
    const { AgentWorker } = await import(path.resolve("dist/worker/agent-worker.js"));
    assert.equal(typeof serverMod.startServer, "function");

    const progCacheDir = path.join(tmpDir, "prog-cache");
    const progStoragePath = path.join(tmpDir, "prog-worker.db");
    const cache = new SubtitleCache(progCacheDir);
    const worker = new AgentWorker({ storagePath: progStoragePath });

    const running = await serverMod.startServer({
      port: 0,
      host: "127.0.0.1",
      cache,
      worker,
    });

    try {
      const healthUrl = `http://127.0.0.1:${running.port}/api/health`;
      const res = await fetch(healthUrl);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.status, "ok");
      assert.equal(data.version, "0.3.0");
    } finally {
      await running.close();
    }
  });

  it("loads config from .env via node --env-file-if-exists=.env in working directory", { timeout: 20_000 }, async () => {
    const envPort = await getFreePort();
    const envTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yts-env-test-"));
    const serverPath = path.resolve("dist/server/src/server.js");

    try {
      // Write a local .env in the temporary working directory
      const envContent = [
        "HOST=127.0.0.1",
        `PORT=${envPort}`,
        "CACHE_DIR=./custom-env-cache",
        "TRANSLATION_AGENT_STORAGE=./custom-env-cache/custom-worker.db",
      ].join("\n");

      await fs.writeFile(path.join(envTmpDir, ".env"), envContent, "utf-8");

      // Spawn using the exact command used by npm start / npm run server:
      // node --env-file-if-exists=.env <serverPath>
      // Clean process.env from PORT and CACHE_DIR to prove .env is the source
      const cleanEnv = { ...process.env };
      delete cleanEnv.PORT;
      delete cleanEnv.CACHE_DIR;
      delete cleanEnv.TRANSLATION_AGENT_STORAGE;

      const child = spawn(process.execPath, ["--env-file-if-exists=.env", serverPath], {
        cwd: envTmpDir,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      child.stdout?.on("data", (d) => { output += d.toString(); });
      child.stderr?.on("data", (d) => { output += d.toString(); });

      const stopProcess = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        let exited = false;
        let timer: NodeJS.Timeout | null = null;
        await Promise.race([
          new Promise<void>((resolve) => {
            child.once("exit", () => {
              exited = true;
              resolve();
            });
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              if (!exited) {
                try { child.kill("SIGKILL"); } catch { /* ignore */ }
              }
              resolve();
            }, 3000);
          }),
        ]);
        if (timer) clearTimeout(timer);
      };

      try {
        const healthUrl = `http://127.0.0.1:${envPort}/api/health`;
        let ok = false;
        let lastError: any = null;

        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
            if (res.ok) {
              const data = await res.json() as any;
              assert.equal(res.status, 200);
              assert.equal(data.status, "ok");
              assert.equal(data.version, "0.3.0");
              ok = true;
              break;
            }
          } catch (err) {
            lastError = err;
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        if (!ok) {
          throw new Error(`Server failed to start on port ${envPort} specified in .env. Output:\n${output}`);
        }

        // Verify that custom-env-cache directory was created from .env
        const customCacheStat = await fs.stat(path.join(envTmpDir, "custom-env-cache"));
        assert.ok(customCacheStat.isDirectory(), "Should create CACHE_DIR specified in .env");
      } finally {
        await stopProcess();
      }
    } finally {
      await fs.rm(envTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
