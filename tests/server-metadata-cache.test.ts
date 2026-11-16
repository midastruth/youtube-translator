import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import { getMetadataCacheKey, getMetadataCacheProfile, getWhisperCacheProfile, processSubtitleFlow, resolveDependencies } from "../server/src/app.js";
import { SubtitleCache } from "../server/src/cache.js";
import { IngestError } from "../server/src/errors.js";
import { startServer, type RunningServer } from "../server/src/server.js";
import type { SubtitleRequest } from "../server/src/types.js";
import { AgentWorker } from "../worker/agent-worker.js";
import { trustModelEndpoint } from "./support/model-endpoint.js";
import { respondAsSubtitleAgent } from "./support/subtitle-agent-model.js";

const url = "https://www.youtube.com/watch?v=stale_video";
const metadata = { id: "stale_video", title: "Cached video", subtitles: { en: [{ ext: "json3" }] } };
const cues = [{ cue_id: "c0", start: 0, end: 1000, text: "A database transaction." }];
const request: SubtitleRequest = { url, languages: ["en"], segmentation: "rule" };
const expired = new Date(Date.now() - 25 * 3600 * 1000);
function metadataKey() {
  const key = getMetadataCacheKey(url), profile = getMetadataCacheProfile();
  return profile ? `${key}-metadata-${profile}` : key;
}

describe("Expired metadata must not block cached subtitles (#4)", () => {
  let directory: string;
  let cache: SubtitleCache;
  let worker: AgentWorker;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "yts-stale-metadata-"));
    cache = new SubtitleCache(path.join(directory, "cache"));
    worker = new AgentWorker({ storagePath: path.join(directory, "worker.db") });
    await cache.putMetadata(metadataKey(), metadata);
    await cache.putCues(metadata.id, "en", "rule", null, cues, { profile: "segment-v1" });
    await fs.utimes(cache._path(metadataKey(), "metadata.json"), expired, expired);
  });
  afterEach(async () => {
    await worker.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses cached source cues before attempting to refresh expired metadata", async () => {
    let fetches = 0;
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      fetches++;
      throw new IngestError("YouTube bot check");
    } });
    const result = await processSubtitleFlow(request, deps);
    assert.deepEqual(result.cues, cues);
    assert.equal(result.meta.video_id, metadata.id);
    assert.equal(result.meta.title, metadata.title);
    assert.equal(result.meta.from_lang, "en");
    assert.equal(fetches, 0);
    assert.equal(await cache.getMetadata(metadataKey()), null, "reuse must not make metadata fresh");
  });

  it("keeps the locator usable after maintenance and a cache restart", async () => {
    await cache.purgeExpired();
    cache = new SubtitleCache(cache.cacheDir);
    await cache.maintain();
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      assert.fail("cached cues must not depend on yt-dlp after restart");
    } });
    assert.deepEqual((await processSubtitleFlow(request, deps)).cues, cues);
  });

  it("refreshes metadata when the requested segmentation has no cached cues", async () => {
    let fetches = 0;
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      fetches++;
      throw new IngestError("YouTube bot check");
    } });
    await assert.rejects(processSubtitleFlow({ ...request, segmentation: "statistical" }, deps), /YouTube bot check/);
    assert.equal(fetches, 1);
  });

  it("refreshes metadata and downloads subtitles normally when source cues are missing", async () => {
    await cache.putCues(metadata.id, "en", "rule", null, [], { profile: "segment-v1" });
    let fetches = 0, downloads = 0;
    const fresh = { ...metadata, title: "Updated title" };
    const deps = await resolveDependencies({ cache, worker,
      fetchMetadata: async () => { fetches++; return fresh; },
      fetchSubtitleJson3: async () => {
        downloads++;
        return { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Fresh source." }] }] };
      },
    });
    const result = await processSubtitleFlow(request, deps);
    assert.equal(fetches, 1);
    assert.equal(downloads, 1);
    assert.equal(result.meta.title, fresh.title);
    assert.equal(result.cues[0].text, "Fresh source.");
    assert.deepEqual(await cache.getMetadata(metadataKey()), fresh);
  });

  it("does not reuse another language or forbidden automatic captions", async () => {
    let fetches = 0;
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      fetches++;
      throw new IngestError("refresh required");
    } });
    await assert.rejects(processSubtitleFlow({ ...request, languages: ["ja"] }, deps), /refresh required/);
    await cache.putMetadata(metadataKey(), { ...metadata, subtitles: {}, automatic_captions: metadata.subtitles });
    await fs.utimes(cache._path(metadataKey(), "metadata.json"), expired, expired);
    await assert.rejects(processSubtitleFlow({ ...request, allow_automatic: false }, deps), /refresh required/);
    assert.equal(fetches, 2);
  });

  it("refreshes missing or corrupt metadata instead of guessing the source track", async () => {
    let fetches = 0;
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      fetches++;
      return metadata;
    } });
    for (const corrupt of [true, false]) {
      const file = cache._path(metadataKey(), "metadata.json");
      if (corrupt) await fs.writeFile(file, "not JSON");
      else await fs.unlink(file);
      assert.deepEqual((await processSubtitleFlow(request, deps)).cues, cues);
      assert.deepEqual(await cache.getMetadata(metadataKey()), metadata);
    }
    assert.equal(fetches, 2);
  });

  it("also reuses matching Whisper cues, but not another Whisper profile", async () => {
    await cache.putMetadata(metadataKey(), { ...metadata, subtitles: {} });
    await fs.utimes(cache._path(metadataKey(), "metadata.json"), expired, expired);
    const profile = getWhisperCacheProfile("en");
    await cache.putCues(metadata.id, profile, "whisper-timed-v1", null, cues, { kind: "whisper" });
    let fetches = 0;
    const deps = await resolveDependencies({ cache, worker, fetchMetadata: async () => {
      fetches++;
      throw new IngestError("refresh required");
    } });
    const whisperRequest = { ...request, whisper_enabled: true, whisper_language: "en" };
    const result = await processSubtitleFlow(whisperRequest, deps);
    assert.deepEqual(result.cues, cues);
    assert.equal(result.meta.source, "whisper");
    assert.equal(fetches, 0);
    await assert.rejects(processSubtitleFlow({ ...whisperRequest, whisper_language: "ja" }, deps), /refresh required/);
    assert.equal(fetches, 1);
  });

  it("replays a durable document translation over SSE after metadata expiry and restart without any network calls", { timeout: 15000 }, async () => {
    let modelCalls = 0, metadataCalls = 0;
    const modelServer = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      modelCalls++;
      respondAsSubtitleAgent(JSON.parse(raw), res, id => `测试译文：${id}`);
    });
    await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const restoreEndpoint = trustModelEndpoint(baseUrl);
    let running: RunningServer | undefined;
    const start = async () => {
      running = await startServer({ port: 0, host: "127.0.0.1", cache, worker,
        fetchMetadata: async () => { metadataCalls++; throw new IngestError("YouTube bot check"); },
        fetchSubtitleJson3: async () => { assert.fail("source cues are already cached"); },
      });
    };
    const stream = async () => {
      const response = await fetch(`http://127.0.0.1:${running!.port}/api/subtitle/stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, translate_engine: "document", translate_to: "zh-CN",
          translate_base_url: baseUrl, translate_api_key: "test-key", translate_request_budget: 512 }),
      });
      assert.equal(response.status, 200);
      return (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    };
    try {
      // Create the original durable translation while metadata is still fresh.
      await cache.putMetadata(metadataKey(), metadata);
      await start();
      const first = await stream();
      assert.equal(first.at(-1)?.type, "done", JSON.stringify(first));
      assert.ok(modelCalls > 0);
      const previousCalls = modelCalls;
      await running!.close(); running = undefined;
      await fs.utimes(cache._path(metadataKey(), "metadata.json"), expired, expired);
      cache = new SubtitleCache(cache.cacheDir);
      await cache.maintain();
      worker = new AgentWorker({ storagePath: path.join(directory, "worker.db") });
      await start();
      const replay = await stream();
      assert.equal(replay.at(-1)?.type, "done", JSON.stringify(replay));
      const translated = replay.filter(event => event.type === "cue");
      assert.equal(translated.length, cues.length);
      assert.ok(translated.every(event => event.cached && event.translation.startsWith("测试译文：")));
      assert.equal(modelCalls, previousCalls, "durable result must not be translated again");
      assert.equal(metadataCalls, 0, "metadata expiry must not require yt-dlp");
    } finally {
      if (running) await running.close();
      restoreEndpoint();
      modelServer.closeAllConnections();
      await new Promise<void>(resolve => modelServer.close(() => resolve()));
    }
  });
});
