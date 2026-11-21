import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../server/src/app.js";
import { SubtitleCache } from "../server/src/cache.js";
import { IngestError } from "../server/src/errors.js";
import { AgentWorker } from "../worker/agent-worker.js";

const metadata = { id: "fixture", title: "Test", subtitles: { en: [{ ext: "json3" }] } };
const detail = "Upstream caption service rejected this request";

for (const failure of ["metadata", "download", "wrapper", "empty", "cache"] as const) {
  test(`stream exposes a stable recovery code for ${failure} failures only`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yts-ingestion-"));
    const cache = new SubtitleCache(path.join(directory, "cache"));
    const worker = new AgentWorker({ storagePath: path.join(directory, "worker.db") });
    if (failure === "cache") cache.getJson3 = async () => { throw new Error("yt-dlp cache storage failed"); };
    const server = http.createServer(createApp({
      cache, worker,
      fetchMetadata: async () => {
        if (failure === "metadata") throw new IngestError(detail);
        return metadata;
      },
      fetchSubtitleJson3: async () => {
        if (failure === "download") throw new IngestError(detail);
        if (failure === "wrapper") throw new Error(detail);
        return null;
      },
    }));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await worker.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/subtitle/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://youtu.be/fixture", languages: ["en"] }),
    });
    assert.equal(response.status, failure === "metadata" || failure === "download" ? 400 : 500);
    const error = await response.json();
    assert.equal(error.code, failure === "cache" ? undefined : "subtitle_ingestion_failed");
    assert.equal(error.detail, failure === "cache" ? "yt-dlp cache storage failed" : failure === "empty" ? "Failed to download subtitle" : detail);
  });
}
