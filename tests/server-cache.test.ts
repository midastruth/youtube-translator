import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { SubtitleCache, getTranslationProfile } from "../server/src/cache.js";
import type { SubtitleCue } from "../server/src/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SubtitleCache", () => {
  let tmpDir: string;
  let cache: SubtitleCache;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-cache-test-"));
    cache = new SubtitleCache(tmpDir, 3600);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("test_cache_dir_created", async () => {
    const stat = await fs.stat(tmpDir);
    assert.ok(stat.isDirectory());
  });

  it("test_put_and_get_metadata", async () => {
    const data = { id: "abc", title: "Test Video" };
    await cache.putMetadata("abc", data);
    const result = await cache.getMetadata("abc");
    assert.deepEqual(result, data);
  });

  it("test_get_missing_metadata", async () => {
    const result = await cache.getMetadata("nonexistent");
    assert.equal(result, null);
  });

  it("test_put_and_get_json3", async () => {
    const data = '{"events": []}';
    await cache.putJson3("abc", "en", data);
    const result = await cache.getJson3("abc", "en");
    assert.equal(result, data);
  });

  it("test_get_missing_json3", async () => {
    const result = await cache.getJson3("abc", "unknown");
    assert.equal(result, null);
  });

  it("test_put_and_get_cues", async () => {
    const cues: SubtitleCue[] = [{ start: 0, end: 0.5, text: "Hello", translation: "" }];
    await cache.putCues("abc", "en", "rule", null, cues);
    const result = await cache.getCues("abc", "en", "rule", null);
    assert.deepEqual(result, cues);
  });

  it("test_get_cues_with_to_lang", async () => {
    const cues: SubtitleCue[] = [{ start: 0, end: 0.5, text: "Hello", translation: "你好" }];
    await cache.putCues("abc", "en", "statistical", "zh-CN", cues);
    const result = await cache.getCues("abc", "en", "statistical", "zh-CN");
    assert.deepEqual(result, cues);
  });

  it("test_cues_different_to_lang_not_confused", async () => {
    const cuesEn: SubtitleCue[] = [{ start: 0, end: 0.5, text: "Hello" }];
    const cuesNone: SubtitleCue[] = [{ start: 0, end: 0.5, text: "Hello", translation: "" }];
    await cache.putCues("abc", "en", "rule", "zh-CN", cuesEn);
    await cache.putCues("abc", "en", "rule", null, cuesNone);
    assert.deepEqual(await cache.getCues("abc", "en", "rule", "zh-CN"), cuesEn);
    assert.deepEqual(await cache.getCues("abc", "en", "rule", null), cuesNone);
  });

  it("test_clear_video", async () => {
    await cache.putMetadata("abc", { id: "abc" });
    await cache.putJson3("abc", "en", "{}");
    await cache.putCues("abc", "en", "rule", null, []);
    await cache.putMetadata("xyz", { id: "xyz" });
    await cache.putJson3("xyz", "en", "{}");

    const removed = await cache.clearVideo("abc");
    assert.equal(removed, 3);
    assert.equal(await cache.getMetadata("abc"), null);
    assert.equal(await cache.getJson3("abc", "en"), null);
    assert.notEqual(await cache.getMetadata("xyz"), null);
    assert.notEqual(await cache.getJson3("xyz", "en"), null);
  });

  it("test_purge_expired", async () => {
    const shortCache = new SubtitleCache(tmpDir, 0.05);
    await shortCache.putMetadata("abc", { id: "abc" });
    await shortCache.putJson3("abc", "en", "{}");

    await sleep(80);

    const removed = await shortCache.purgeExpired();
    assert.equal(removed, 2);
    assert.equal(await shortCache.getMetadata("abc"), null);
    assert.equal(await shortCache.getJson3("abc", "en"), null);
  });

  it("test_ttl_expiry", async () => {
    const shortCache = new SubtitleCache(tmpDir, 0.05);
    await shortCache.putMetadata("abc", { id: "abc" });
    assert.notEqual(await shortCache.getMetadata("abc"), null);

    await sleep(80);
    assert.equal(await shortCache.getMetadata("abc"), null);
  });

  it("test_corrupted_json_returns_none", async () => {
    const p = cache._path("abc", "metadata.json");
    await fs.writeFile(p, "not valid json{{{", "utf-8");
    assert.equal(await cache.getMetadata("abc"), null);
  });

  it("test_special_characters_in_keys", async () => {
    const cues: SubtitleCue[] = [{ start: 0, end: 1, text: "test" }];
    await cache.putCues("video/with\\special", "zh-Hans", "rule", "en-US", cues);
    const result = await cache.getCues("video/with\\special", "zh-Hans", "rule", "en-US");
    assert.deepEqual(result, cues);

    const entries = await fs.readdir(tmpDir);
    assert.ok(entries.some((n) => n.startsWith("video_with_special_")));
  });

  it("test_clear_nonexistent_video", async () => {
    const removed = await cache.clearVideo("nonexistent");
    assert.equal(removed, 0);
  });

  it("test_purge_empty_cache", async () => {
    const removed = await cache.purgeExpired();
    assert.equal(removed, 0);
  });

  it("test_kind_specific_ttls_keep_expensive_results", async () => {
    const customCache = new SubtitleCache(tmpDir, {
      metadataTtlSeconds: 0.05,
      json3TtlSeconds: 0.05,
      cuesTtlSeconds: 0,
      translationTtlSeconds: 0,
      whisperTtlSeconds: 0,
      maxBytes: 0,
    });

    await customCache.putMetadata("abc", { id: "abc" });
    await customCache.putJson3("abc", "en", "{}");
    await customCache.putCues("abc", "en", "rule", null, [{ start: 0, end: 1, text: "source" }]);
    await customCache.putTranslation("abc", "en", "rule", "zh-CN", "profile-a", [
      { start: 0, end: 1, text: "source", translation: "译文" },
    ]);
    await customCache.putCues(
      "abc",
      "whisper-auto-profile",
      "whisper-v1",
      null,
      [{ start: 0, end: 1, text: "transcript" }],
      { kind: "whisper" }
    );

    await sleep(80);
    const removed = await customCache.purgeExpired();
    assert.equal(removed, 2);

    assert.equal(await customCache.getMetadata("abc"), null);
    assert.equal(await customCache.getJson3("abc", "en"), null);
    assert.notEqual(await customCache.getCues("abc", "en", "rule", null), null);
    assert.notEqual(await customCache.getTranslation("abc", "en", "rule", "zh-CN", "profile-a"), null);
    assert.notEqual(
      await customCache.getCues("abc", "whisper-auto-profile", "whisper-v1", null, { kind: "whisper" }),
      null
    );
  });

  it("test_translation_profiles_are_isolated", async () => {
    const first: SubtitleCue[] = [{ start: 0, end: 1, text: "Hello", translation: "你好" }];
    const second: SubtitleCue[] = [{ start: 0, end: 1, text: "Hello", translation: "您好" }];

    await cache.putTranslation("abc", "en", "rule", "zh-CN", "model-a", first);
    await cache.putTranslation("abc", "en", "rule", "zh-CN", "model-b", second);

    assert.deepEqual(await cache.getTranslation("abc", "en", "rule", "zh-CN", "model-a"), first);
    assert.deepEqual(await cache.getTranslation("abc", "en", "rule", "zh-CN", "model-b"), second);
  });

  it("test_get_translation_profile_isolation", () => {
    const cues = [{ start: 0, end: 1, text: "Hello world" }];
    const profileModelA = getTranslationProfile({ cues, model: "gpt-4o", toLang: "zh-CN" });
    const profileModelB = getTranslationProfile({ cues, model: "gpt-3.5-turbo", toLang: "zh-CN" });
    const profileLangJa = getTranslationProfile({ cues, model: "gpt-4o", toLang: "ja" });

    assert.notEqual(profileModelA, profileModelB);
    assert.notEqual(profileModelA, profileLangJa);
    assert.ok(profileModelA.startsWith("translation-v2-"));
  });

  it("test_size_limit_evicts_least_recently_used", async () => {
    const lruCache = new SubtitleCache(tmpDir, { maxBytes: 0 });
    await lruCache.putJson3("old", "en", "old-value");
    await lruCache.putJson3("new", "en", "new-value");

    const oldPath = lruCache._path("old", "en", "json3.txt");
    const newPath = lruCache._path("new", "en", "json3.txt");

    const now = Math.floor(Date.now() / 1000);
    await fs.utimes(oldPath, now - 100, now - 100);
    await fs.utimes(newPath, now, now);

    const newStat = await fs.stat(newPath);
    lruCache.maxBytes = newStat.size;

    const removed = await lruCache.enforceSizeLimit();
    assert.equal(removed, 1);

    const oldExists = await fs.stat(oldPath).then(() => true).catch(() => false);
    const newExists = await fs.stat(newPath).then(() => true).catch(() => false);

    assert.equal(oldExists, false);
    assert.equal(newExists, true);
  });

  it("test_writes_are_atomic_and_leave_no_temp_files", async () => {
    await cache.putJson3("abc", "en", '{"events": []}');
    const entries = await fs.readdir(tmpDir);
    assert.ok(!entries.some((entry) => entry.startsWith(".cache-tmp-")));
  });

  it("test_clear_all", async () => {
    await cache.putMetadata("abc", { id: "abc" });
    await cache.putJson3("abc", "en", "{}");
    await cache.putCues("abc", "en", "rule", null, []);

    const removed = await cache.clearAll();
    assert.equal(removed, 3);
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  });

  it("regression_no_deadlock_on_nested_or_concurrent_operations", { timeout: 5000 }, async () => {
    // Tests that concurrent writes with automatic maintenance, explicit maintain,
    // and enforceSizeLimit do not self-deadlock.
    const concurrentOps = [
      cache.putMetadata("v1", { title: "Video 1" }),
      cache.putJson3("v1", "en", '{"text":"1"}'),
      cache.putCues("v1", "en", "rule", null, [{ start: 0, end: 1, text: "c1" }]),
      cache.maintain(),
      cache.putMetadata("v2", { title: "Video 2" }),
      cache.enforceSizeLimit(),
      cache.purgeExpired(),
      cache.putJson3("v2", "en", '{"text":"2"}'),
    ];

    await Promise.all(concurrentOps);

    const m1 = await cache.getMetadata("v1");
    const m2 = await cache.getMetadata("v2");
    assert.equal(m1.title, "Video 1");
    assert.equal(m2.title, "Video 2");
  });

  it("test_mixed_directory_sentinels_protected", { timeout: 5000 }, async () => {
    // Sentinel files that a worker, SQLite, or other tooling may place in the directory
    const sentinels = [
      "worker.db",
      "worker.db-wal",
      "worker.db-shm",
      "worker.lock",
      "config.json",
    ];

    for (const name of sentinels) {
      await fs.writeFile(path.join(tmpDir, name), "sentinel-data", "utf-8");
    }

    // Write normal cache files
    await cache.putMetadata("vid1", { id: "vid1" });
    await cache.putJson3("vid1", "en", "data1");
    await cache.putCues("vid1", "en", "rule", null, [{ start: 0, end: 1, text: "c1" }]);

    // Trigger size enforcement with small budget
    cache.maxBytes = 10;
    await cache.enforceSizeLimit();

    // Sentinel files must NOT be touched or deleted
    for (const name of sentinels) {
      const exists = await fs.stat(path.join(tmpDir, name)).then(() => true).catch(() => false);
      assert.equal(exists, true, `Sentinel file ${name} should not be deleted by enforceSizeLimit`);
    }

    // Write new cache files before clearAll
    await cache.putMetadata("vid2", { id: "vid2" });
    await cache.putJson3("vid2", "en", "data2");

    // Trigger clearAll
    const removed = await cache.clearAll();
    // Only cache files were deleted
    assert.ok(removed >= 1);

    // Sentinel files must STILL be intact after clearAll
    for (const name of sentinels) {
      const exists = await fs.stat(path.join(tmpDir, name)).then(() => true).catch(() => false);
      assert.equal(exists, true, `Sentinel file ${name} should not be deleted by clearAll`);
    }
  });

  it("test_explicit_null_options_not_overridden", () => {
    // CamelCase explicit null
    const cacheCamel = new SubtitleCache(tmpDir, {
      metadataTtlSeconds: null,
      json3TtlSeconds: null,
      maxBytes: null,
    });
    assert.equal(cacheCamel.ttls.metadata, null);
    assert.equal(cacheCamel.ttls.json3, null);
    assert.equal(cacheCamel.maxBytes, null);

    // Snake_case explicit null
    const cacheSnake = new SubtitleCache(tmpDir, {
      metadata_ttl_seconds: null,
      json3_ttl_seconds: null,
      max_bytes: null,
    });
    assert.equal(cacheSnake.ttls.metadata, null);
    assert.equal(cacheSnake.ttls.json3, null);
    assert.equal(cacheSnake.maxBytes, null);
  });
});


