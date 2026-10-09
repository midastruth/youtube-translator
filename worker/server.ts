import http from "node:http";
import { AgentWorker } from "./agent-worker.js";
import { SubtitleJobDoc } from "./task-definition.js";
import type { SubmitJobOptions } from "./types.js";

const PORT = Number(process.env.TRANSLATION_AGENT_PORT) || 8788;
const STORAGE_PATH = process.env.TRANSLATION_AGENT_STORAGE || "./cache/worker-storage.db";

export async function createWorkerServer({ storagePath = STORAGE_PATH, port = PORT } = {}) {
  const worker = new AgentWorker({ storagePath });
  await worker.start();

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/internal/health") {
        const readiness = await worker.readinessCheck();
        res.writeHead(readiness.ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(readiness));
        return;
      }

      if (req.method === "POST" && url.pathname === "/internal/jobs") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data: SubmitJobOptions = JSON.parse(body || "{}");

        const job = await worker.submitOrAttachJob(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            job_id: job.jobId,
            job_key: job.jobKey,
            status: job.status,
          })
        );
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/internal/jobs/")) {
        const parts = url.pathname.split("/");
        const jobId = parts[3];
        const isStream = parts[4] === "stream";

        const job = await worker.getJob(jobId);
        if (!job) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Job not found" }));
          return;
        }

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const abortController = new AbortController();
          req.on("close", () => abortController.abort());

          for await (const event of worker.observeJobStream(job, {
            signal: abortController.signal,
          })) {
            if (event.type === "keepalive") {
              res.write(": keepalive\n\n");
            } else {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
          res.end();
          return;
        }

        // Snapshot
        if (!worker.harness) throw new Error("Worker harness is not open");
        const doc = await worker.harness.snapshot(
          SubtitleJobDoc,
          job.conversationId,
          worker.context
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            job_id: job.jobId,
            status: doc?.status || job.status,
            published_cues: Object.values(doc?.published_cues || {}),
            failed_cues: doc?.failed_cues || [],
            final_result: doc?.final_result,
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/abort")) {
        const parts = url.pathname.split("/");
        const jobId = parts[3];
        const success = await worker.abortJob(jobId);
        res.writeHead(success ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      console.error("Worker server error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return { server, worker };
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  createWorkerServer().then(({ server }) => {
    server.listen(PORT, () => {
      console.log(`Durable translation worker listening on port ${PORT}`);
    });
  });
}
