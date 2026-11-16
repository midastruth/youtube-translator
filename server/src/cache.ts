import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue } from "./types.js";
import { LEGACY_TRANSLATION_VERSION } from "./translate.js";

type CacheIdentity = { videoId: string; kind: string };
type CacheEnvelope = { cacheFormat: "subtitle-cache-v3"; videoId: string; kind: string; value: string };
function envelope(text: string): CacheEnvelope | null {
  try {
    const value = JSON.parse(text);
    return value?.cacheFormat === "subtitle-cache-v3" && typeof value.videoId === "string" &&
      typeof value.kind === "string" && typeof value.value === "string" ? value : null;
  } catch { return null; }
}

export const TRANSLATION_CACHE_VERSION = "translation-v2";

export interface SubtitleCacheOptions {
  cacheDir?: string;
  cache_dir?: string;
  ttlSeconds?: number | null;
  ttl_seconds?: number | null;
  metadataTtlSeconds?: number | null;
  metadata_ttl_seconds?: number | null;
  json3TtlSeconds?: number | null;
  json3_ttl_seconds?: number | null;
  cuesTtlSeconds?: number | null;
  cues_ttl_seconds?: number | null;
  translationTtlSeconds?: number | null;
  translation_ttl_seconds?: number | null;
  whisperTtlSeconds?: number | null;
  whisper_ttl_seconds?: number | null;
  maxBytes?: number | null;
  max_bytes?: number | null;
  maintenanceIntervalSeconds?: number;
  maintenance_interval_seconds?: number;
}

export interface TranslationProfileParams {
  cues: Array<{ start?: number; end?: number; text?: string }>;
  provider?: string;
  baseUrl?: string | null;
  model?: string | null;
  strategy?: string;
  engine?: string;
  fromLang?: string;
  toLang?: string;
  segmentation?: string;
  promptVersion?: string;
  reviewVersion?: string;
  workflowVersion?: string;
  glossaryVersion?: string;
  styleConfig?: string;
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`
  );
  return `{${pairs.join(",")}}`;
}

export function getTranslationProfile(params: TranslationProfileParams): string {
  const effectiveProvider = (params.provider || "openai").toLowerCase().trim();
  let effectiveBaseUrl: string;
  let effectiveModel: string;

  if (effectiveProvider === "openai") {
    effectiveBaseUrl = (
      params.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    effectiveModel = params.model || "gpt-3.5-turbo";
  } else if (effectiveProvider === "deepl") {
    effectiveBaseUrl = "https://api-free.deepl.com/v2";
    effectiveModel = params.model || "default";
  } else {
    effectiveBaseUrl = (params.baseUrl || "default").replace(/\/+$/, "");
    effectiveModel = params.model || "default";
  }

  const sourceCues = params.cues.map((cue) => ({
    start: cue.start,
    end: cue.end,
    text: cue.text ?? "",
  }));

  const payload: Record<string, unknown> = {
    version: TRANSLATION_CACHE_VERSION,
    engine: params.engine || "legacy",
    provider: effectiveProvider,
    endpoint: effectiveBaseUrl,
    model: effectiveModel,
    strategy: params.strategy || "batch",
    from_lang: params.fromLang || "en",
    to_lang: params.toLang || "zh-CN",
    segmentation: params.segmentation || "rule",
    prompt_version: params.promptVersion || LEGACY_TRANSLATION_VERSION,
    review_version: params.reviewVersion || LEGACY_TRANSLATION_VERSION,
    workflow_version: params.workflowVersion || LEGACY_TRANSLATION_VERSION,
    glossary_version: params.glossaryVersion || "glossary-v1",
    style_config: params.styleConfig || "standard",
    source_cues: sourceCues,
  };

  const material = stableStringify(payload);
  const digest = crypto.createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24);
  return `${TRANSLATION_CACHE_VERSION}-${digest}`;
}

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const res = this.queue.then(fn, fn);
    this.queue = res.then(
      () => {},
      () => {}
    );
    return res;
  }
}

function pickOption<T>(camelVal: T | undefined, snakeVal: T | undefined, defaultVal: T): T {
  if (camelVal !== undefined) return camelVal;
  if (snakeVal !== undefined) return snakeVal;
  return defaultVal;
}

export class SubtitleCache {
  public static readonly DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

  public cacheDir: string;
  public ttlSeconds: number | null = null;
  public ttls: Record<string, number | null>;
  public maxBytes: number | null = null;
  public maintenanceIntervalSeconds: number;

  private _lock = new AsyncLock();
  private _lastMaintenance = Date.now();
  private _lastTouch = new Map<string, number>();

  constructor(
    cacheDirOrOptions: string | SubtitleCacheOptions = "./cache",
    ttlSecondsOrOptions?: number | SubtitleCacheOptions | null,
    extraOptions?: SubtitleCacheOptions
  ) {
    let opts: SubtitleCacheOptions = {};
    let resolvedDir = "./cache";

    if (typeof cacheDirOrOptions === "string") {
      resolvedDir = cacheDirOrOptions;
      if (typeof ttlSecondsOrOptions === "number" || ttlSecondsOrOptions === null) {
        opts = { ttlSeconds: ttlSecondsOrOptions, ...extraOptions };
      } else if (typeof ttlSecondsOrOptions === "object" && ttlSecondsOrOptions !== null) {
        opts = { ...ttlSecondsOrOptions };
      }
    } else if (typeof cacheDirOrOptions === "object" && cacheDirOrOptions !== null) {
      opts = { ...cacheDirOrOptions };
      resolvedDir = opts.cacheDir || opts.cache_dir || "./cache";
    }

    this.cacheDir = path.resolve(resolvedDir);

    const ttlSeconds = pickOption(opts.ttlSeconds, opts.ttl_seconds, null);
    let metadataTtl = pickOption(opts.metadataTtlSeconds, opts.metadata_ttl_seconds, 86400);
    let json3Ttl = pickOption(opts.json3TtlSeconds, opts.json3_ttl_seconds, 30 * 86400);
    let cuesTtl = pickOption(opts.cuesTtlSeconds, opts.cues_ttl_seconds, null);
    let translationTtl = pickOption(opts.translationTtlSeconds, opts.translation_ttl_seconds, null);
    let whisperTtl = pickOption(opts.whisperTtlSeconds, opts.whisper_ttl_seconds, null);

    if (ttlSeconds !== null && ttlSeconds !== undefined) {
      metadataTtl = ttlSeconds;
      json3Ttl = ttlSeconds;
      cuesTtl = ttlSeconds;
      translationTtl = ttlSeconds;
      whisperTtl = ttlSeconds;
    }

    this.ttlSeconds = ttlSeconds;
    this.ttls = {
      metadata: this._normalizeTtl(metadataTtl),
      json3: this._normalizeTtl(json3Ttl),
      cues: this._normalizeTtl(cuesTtl),
      translation: this._normalizeTtl(translationTtl),
      whisper: this._normalizeTtl(whisperTtl),
    };

    const maxBytesOpt = pickOption(opts.maxBytes, opts.max_bytes, SubtitleCache.DEFAULT_MAX_BYTES);
    this.maxBytes =
      typeof maxBytesOpt === "number" && maxBytesOpt > 0 ? Math.floor(maxBytesOpt) : null;

    const maintenanceIntervalOpt = pickOption(
      opts.maintenanceIntervalSeconds,
      opts.maintenance_interval_seconds,
      86400
    );
    this.maintenanceIntervalSeconds = Math.max(0, maintenanceIntervalOpt ?? 86400);

    try {
      fsSync.mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // Ignore mkdirSync failure
    }

    this.maintain().catch(() => {});
  }

  // Alias properties for snake_case compatibility
  get cache_dir(): string {
    return this.cacheDir;
  }
  set cache_dir(value: string) {
    this.cacheDir = value;
  }
  get max_bytes(): number | null {
    return this.maxBytes;
  }
  set max_bytes(value: number | null) {
    this.maxBytes = value;
  }

  private _normalizeTtl(value: number | null | undefined): number | null {
    if (value !== null && value !== undefined && value > 0) {
      return Number(value);
    }
    return null;
  }

  public _path(...parts: string[]): string {
    const safe = parts.map((p) => String(p).replace(/\//g, "_").replace(/\\/g, "_"));
    return path.join(this.cacheDir, safe.join("_"));
  }

  public isManagedCacheFile(fileName: string): boolean {
    if (fileName.startsWith(".cache-tmp-")) return true;
    return this._kindForPath(fileName) !== null;
  }

  private async _isFresh(filePath: string, kind: string = "cues"): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      const mtime = stat.mtimeMs / 1000;
      const ttl = this.ttls[kind];
      return ttl === null || ttl === undefined || Date.now() / 1000 - mtime < ttl;
    } catch {
      return false;
    }
  }

  private async _touchAccess(filePath: string): Promise<void> {
    const now = Date.now();
    if (now - (this._lastTouch.get(filePath) || 0) < 60_000) return;
    this._lastTouch.set(filePath, now);
    try {
      const stat = await fs.stat(filePath);
      await fs.utimes(filePath, now / 1000, stat.mtimeMs / 1000);
    } catch {
      // Ignore utimes failure
    }
  }

  private async _readText(filePath: string, kind: string, allowStale = false): Promise<string | null> {
    if (!allowStale && !(await this._isFresh(filePath, kind))) {
      return null;
    }
    try {
      const value = await fs.readFile(filePath, "utf-8");
      await this._touchAccess(filePath);
      const elapsed = (Date.now() - this._lastMaintenance) / 1000;
      if (this.maintenanceIntervalSeconds === 0 || elapsed >= this.maintenanceIntervalSeconds) {
        await this.maintain();
      }
      return envelope(value)?.value ?? value;
    } catch {
      return null;
    }
  }

  // ── internal unlocked helpers (called with _lock already held) ─

  private async _writeTextUnlocked(filePath: string, value: string, identity: CacheIdentity): Promise<void> {
    // Keep legacy paths readable, but persist explicit ownership and TTL class.
    // Neither video IDs nor language/profile strings are safe filename delimiters.
    value = JSON.stringify({ cacheFormat: "subtitle-cache-v3", ...identity, value } satisfies CacheEnvelope);
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tempName = path.join(
      this.cacheDir,
      `.cache-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    let tempCreated = false;
    try {
      await fs.writeFile(tempName, value, "utf-8");
      tempCreated = true;
      const handle = await fs.open(tempName, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempName, filePath);
      tempCreated = false;
    } finally {
      if (tempCreated) {
        try {
          await fs.unlink(tempName);
        } catch {
          // Ignore unlink error
        }
      }
    }
    await this._maybeMaintainUnlocked();
  }

  private _kindForPath(fileName: string): string | null {
    if (fileName.endsWith("_metadata.json")) return "metadata";
    if (fileName.endsWith("_json3.txt")) return "json3";
    if (!fileName.endsWith(".cues.json")) return null;
    const legacy = this._legacyIdentity(fileName);
    return legacy?.kind || "translation";
  }

  /** Read old unwrapped files without prefix guessing (IDs may contain underscores). */
  private _legacyIdentity(fileName: string): CacheIdentity | null {
    if (fileName.endsWith("_metadata.json")) {
      return { videoId: fileName.slice(0, -"_metadata.json".length).replace(/-metadata-[a-f0-9]{16,64}$/, ""), kind: "metadata" };
    }
    const json3 = fileName.match(/^(.*)_([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)_json3\.txt$/);
    if (json3) return { videoId: json3[1], kind: "json3" };
    const cues = fileName.match(/^(.*)_([^_]+)_(rule|statistical|whisper-timed-v1|whisper-v1)_([^_]+)(?:_(.+))?\.cues\.json$/);
    if (!cues) return null;
    return { videoId: cues[1], kind: cues[3].startsWith("whisper-") ? "whisper" : cues[4] === "none" ? "cues" : "translation" };
  }

  private async _identity(fileName: string): Promise<CacheIdentity | null> {
    const text = await fs.readFile(path.join(this.cacheDir, fileName), "utf8");
    const stored = envelope(text);
    if (stored) return stored;
    if (fileName.endsWith("_metadata.json")) {
      try {
        const data = JSON.parse(text);
        if (typeof data?.id === "string") return { videoId: data.id, kind: "metadata" };
      } catch { /* Legacy corrupt metadata still has a recognizable filename. */ }
    }
    return this._legacyIdentity(fileName);
  }

  private async _purgeExpiredUnlocked(): Promise<number> {
    let removed = 0;
    const now = Date.now() / 1000;
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!this.isManagedCacheFile(entry)) continue;
      const filePath = path.join(this.cacheDir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        if (entry.startsWith(".cache-tmp-")) {
          // Other cache instances may be writing; only collect crash leftovers.
          if (now - stat.mtimeMs / 1000 >= 3600) { await fs.unlink(filePath); removed++; }
          continue;
        }
        const kind = (await this._identity(entry))?.kind;
        // Metadata TTL controls freshness, not retention: stale metadata locates
        // expensive source/translation caches without requiring yt-dlp. It is
        // still subject to size-based eviction and explicit cache deletion.
        if (kind === "metadata") continue;
        const ttl = kind ? this.ttls[kind] : null;
        if (ttl !== null && ttl !== undefined && now - stat.mtimeMs / 1000 >= ttl) {
          await fs.unlink(filePath);
          this._lastTouch.delete(filePath);
          removed++;
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  private async _enforceSizeLimitUnlocked(): Promise<number> {
    if (this.maxBytes === null || this.maxBytes === undefined) {
      return 0;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch {
      return 0;
    }
    const fileList: Array<{ atimeMs: number; size: number; filePath: string }> = [];
    let total = 0;
    for (const entry of entries) {
      if (!this.isManagedCacheFile(entry)) continue;
      if (entry.startsWith(".cache-tmp-")) continue;

      const filePath = path.join(this.cacheDir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        total += stat.size;
        fileList.push({ atimeMs: stat.atimeMs, size: stat.size, filePath });
      } catch {
        continue;
      }
    }

    if (total <= this.maxBytes) {
      return 0;
    }

    fileList.sort((a, b) => a.atimeMs - b.atimeMs);
    let removed = 0;
    for (const item of fileList) {
      try {
        await fs.unlink(item.filePath);
        this._lastTouch.delete(item.filePath);
        total -= item.size;
        removed++;
        if (total <= this.maxBytes) {
          break;
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  private async _maintainUnlocked(): Promise<number> {
    const p = await this._purgeExpiredUnlocked();
    const s = await this._enforceSizeLimitUnlocked();
    this._lastMaintenance = Date.now();
    return p + s;
  }

  private async _maybeMaintainUnlocked(): Promise<void> {
    const elapsed = (Date.now() - this._lastMaintenance) / 1000;
    const due =
      this.maintenanceIntervalSeconds === 0 || elapsed >= this.maintenanceIntervalSeconds;
    if (due) {
      await this._maintainUnlocked();
    }
  }

  private async _clearVideoUnlocked(videoId: string): Promise<number> {
    const safeId = videoId.replace(/\//g, "_").replace(/\\/g, "_");
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if ((entry.startsWith(`${safeId}_`) || entry.startsWith(`${safeId}-metadata-`)) && this.isManagedCacheFile(entry)) {
        try {
          if ((await this._identity(entry))?.videoId !== videoId) continue;
          const filePath = path.join(this.cacheDir, entry);
          await fs.unlink(filePath);
          this._lastTouch.delete(filePath);
          removed++;
        } catch {
          continue;
        }
      }
    }
    return removed;
  }

  private async _clearAllUnlocked(): Promise<number> {
    this._lastTouch.clear();
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!this.isManagedCacheFile(entry)) continue;
      const filePath = path.join(this.cacheDir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          await fs.unlink(filePath);
          removed++;
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  // ── metadata ─────────────────────────────────────────────────

  async getMetadata(videoId: string, options?: { allowStale?: boolean }): Promise<any | null> {
    const text = await this._readText(this._path(videoId, "metadata.json"), "metadata", options?.allowStale);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  async get_metadata(videoId: string, options?: { allowStale?: boolean }): Promise<any | null> {
    return this.getMetadata(videoId, options);
  }

  async putMetadata(videoId: string, data: any): Promise<void> {
    await this._lock.acquire(() =>
      this._writeTextUnlocked(this._path(videoId, "metadata.json"), JSON.stringify(data), {
        videoId: typeof data?.id === "string" ? data.id : videoId, kind: "metadata",
      })
    );
  }
  async put_metadata(videoId: string, data: any): Promise<void> {
    return this.putMetadata(videoId, data);
  }

  // ── raw subtitle json3 ────────────────────────────────────────

  async getJson3(videoId: string, lang: string): Promise<string | null> {
    return this._readText(this._path(videoId, lang, "json3.txt"), "json3");
  }
  async get_json3(videoId: string, lang: string): Promise<string | null> {
    return this.getJson3(videoId, lang);
  }

  async putJson3(videoId: string, lang: string, data: string): Promise<void> {
    await this._lock.acquire(() =>
      this._writeTextUnlocked(this._path(videoId, lang, "json3.txt"), data, { videoId, kind: "json3" })
    );
  }
  async put_json3(videoId: string, lang: string, data: string): Promise<void> {
    return this.putJson3(videoId, lang, data);
  }

  // ── processed cues ────────────────────────────────────────────

  private _cuesPath(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang?: string | null,
    profile?: string | null
  ): string {
    const parts = [videoId, lang, segmentation];
    if (profile) {
      parts.push(toLang || "none", `${profile}.cues.json`);
    } else {
      parts.push(`${toLang || "none"}.cues.json`);
    }
    return this._path(...parts);
  }

  async getCues(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang?: string | null,
    options?: { kind?: string; profile?: string | null }
  ): Promise<SubtitleCue[] | null> {
    const kind = options?.kind || "cues";
    const profile = options?.profile || null;
    const text = await this._readText(
      this._cuesPath(videoId, lang, segmentation, toLang, profile),
      kind
    );
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  async get_cues(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang?: string | null,
    options?: { kind?: string; profile?: string | null }
  ): Promise<SubtitleCue[] | null> {
    return this.getCues(videoId, lang, segmentation, toLang, options);
  }

  async putCues(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string | null | undefined,
    cues: SubtitleCue[],
    options?: { kind?: string; profile?: string | null }
  ): Promise<void> {
    const kind = options?.kind || "cues";
    const profile = options?.profile || null;
    if (!(kind in this.ttls)) {
      throw new Error(`Unknown cache kind: ${kind}`);
    }
    await this._lock.acquire(() =>
      this._writeTextUnlocked(
        this._cuesPath(videoId, lang, segmentation, toLang, profile),
        JSON.stringify(cues), { videoId, kind }
      )
    );
  }
  async put_cues(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string | null | undefined,
    cues: SubtitleCue[],
    options?: { kind?: string; profile?: string | null }
  ): Promise<void> {
    return this.putCues(videoId, lang, segmentation, toLang, cues, options);
  }

  async getTranslation(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string,
    profile: string
  ): Promise<SubtitleCue[] | null> {
    return this.getCues(videoId, lang, segmentation, toLang, {
      kind: "translation",
      profile,
    });
  }
  async get_translation(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string,
    profile: string
  ): Promise<SubtitleCue[] | null> {
    return this.getTranslation(videoId, lang, segmentation, toLang, profile);
  }

  async putTranslation(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string,
    profile: string,
    cues: SubtitleCue[]
  ): Promise<void> {
    await this.putCues(videoId, lang, segmentation, toLang, cues, {
      kind: "translation",
      profile,
    });
  }
  async put_translation(
    videoId: string,
    lang: string,
    segmentation: string,
    toLang: string,
    profile: string,
    cues: SubtitleCue[]
  ): Promise<void> {
    return this.putTranslation(videoId, lang, segmentation, toLang, profile, cues);
  }

  getTranslationProfile(params: TranslationProfileParams): string {
    return getTranslationProfile(params);
  }

  // ── maintenance public methods ───────────────────────────────

  async purgeExpired(): Promise<number> {
    return this._lock.acquire(() => this._purgeExpiredUnlocked());
  }
  async purge_expired(): Promise<number> {
    return this.purgeExpired();
  }

  async enforceSizeLimit(): Promise<number> {
    return this._lock.acquire(() => this._enforceSizeLimitUnlocked());
  }
  async enforce_size_limit(): Promise<number> {
    return this.enforceSizeLimit();
  }

  async maintain(): Promise<number> {
    return this._lock.acquire(() => this._maintainUnlocked());
  }

  async clearVideo(videoId: string): Promise<number> {
    return this._lock.acquire(() => this._clearVideoUnlocked(videoId));
  }
  async clear_video(videoId: string): Promise<number> {
    return this.clearVideo(videoId);
  }

  async clearAll(): Promise<number> {
    return this._lock.acquire(() => this._clearAllUnlocked());
  }
  async clear_all(): Promise<number> {
    return this.clearAll();
  }
}
