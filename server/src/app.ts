import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { sendSSE as writeSSE, withHeartbeats } from "./streaming.js";

import type {
  SubtitleTrack,
  SubtitleCue,
  SubtitleRequest,
  SubtitleResponse,
  TracksResponse,
  HealthResponse,
  AbortJobRequest,
  AbortJobResponse,
  FlatEvent,
  PreparedEvents,
} from "./types.js";
import { IngestError, TranslateError } from "./errors.js";
import { AgentWorker } from "../../worker/agent-worker.js";
import { SubtitleCache, getTranslationProfile, type SubtitleCacheOptions } from "./cache.js";
import {
  fetchMetadata as defaultFetchMetadata,
  chooseSubtitle as defaultChooseSubtitle,
  fetchSubtitleJson3Raw as defaultFetchSubtitleJson3Raw,
  downloadAudio as defaultDownloadAudio,
} from "./youtube.js";
import {
  prepareTimedTextEvents as defaultPrepareTimedTextEvents,
  intelligentSentenceBreakWithMode as defaultIntelligentSentenceBreakWithMode,
} from "./subtitle-processing.js";
import { translateSubtitles as defaultTranslateSubtitles, type TranslateOptions } from "./translate.js";
import { splitAudio as defaultSplitAudio } from "./audio.js";
import { WhisperClient as DefaultWhisperClient, transcribeTimedChunks as defaultTranscribeTimedChunks } from "./transcribe.js";

export { IngestError, TranslateError };

export interface AppDependencies {
  cache?: SubtitleCache;
  worker?: AgentWorker;
  fetchMetadata?: (url: string) => Promise<any>;
  chooseSubtitle?: (metadata: any, languages: string[], allowAutomatic?: boolean) => any;
  fetchSubtitleJson3?: (url: string, lang: string) => Promise<any>;
  prepareTimedTextEvents?: (rawEvents: any[]) => PreparedEvents;
  intelligentSentenceBreakWithMode?: (flatEvents: FlatEvent[], mode?: string, lang?: string, rawEvents?: any[]) => SubtitleCue[];
  translateSubtitles?: (subtitles: SubtitleCue[], fromLang: string, toLang: string, options?: TranslateOptions) => Promise<SubtitleCue[]>;
  downloadAudio?: (url: string, destDir: string) => Promise<string>;
  splitAudio?: (audioPath: string, chunkSeconds?: number, outputDir?: string) => Promise<string[]>;
  WhisperClient?: typeof DefaultWhisperClient;
  transcribeTimedChunks?: typeof defaultTranscribeTimedChunks;
}

export type ResolvedDependencies = {
  cache: SubtitleCache;
  worker: AgentWorker;
  fetchMetadata: (url: string) => Promise<any>;
  chooseSubtitle: (metadata: any, languages: string[], allowAutomatic?: boolean) => any;
  fetchSubtitleJson3: (url: string, lang: string) => Promise<any>;
  prepareTimedTextEvents: (rawEvents: any[]) => PreparedEvents;
  intelligentSentenceBreakWithMode: (flatEvents: FlatEvent[], mode?: string, lang?: string, rawEvents?: any[]) => SubtitleCue[];
  translateSubtitles: (subtitles: SubtitleCue[], fromLang: string, toLang: string, options?: TranslateOptions) => Promise<SubtitleCue[]>;
  downloadAudio: (url: string, destDir: string) => Promise<string>;
  splitAudio: (audioPath: string, chunkSeconds?: number, outputDir?: string) => Promise<string[]>;
  WhisperClient: typeof DefaultWhisperClient;
  transcribeTimedChunks: typeof defaultTranscribeTimedChunks;
};

// Concurrency de-duplication for in-flight whisper transcriptions
const whisperActiveJobs = new Map<string, Promise<SubtitleCue[]>>();

// ── Helpers ─────────────────────────────────────────────────────────────

export function getMetadataCacheKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    let videoId = "";
    if (host === "youtu.be" || host === "www.youtu.be") {
      videoId = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
    } else if (host.endsWith("youtube.com")) {
      const pathname = parsed.pathname.replace(/\/+$/, "");
      if (pathname === "/watch") {
        videoId = parsed.searchParams.get("v") || "";
      } else {
        const parts = pathname.split("/").filter(Boolean);
        if (parts.length >= 2 && ["embed", "live", "shorts"].includes(parts[0])) {
          videoId = parts[1];
        }
      }
    }
    if (/^[A-Za-z0-9_-]{6,64}$/.test(videoId)) {
      return videoId;
    }
  } catch {
    // Fall back to sha256 of rawUrl
  }
  const digest = crypto.createHash("sha256").update(rawUrl.trim()).digest("hex").slice(0, 24);
  return `url-${digest}`;
}

export function getMetadataCacheProfile(): string {
  const client = (process.env.YTDLP_YOUTUBE_CLIENT || "").trim();
  const provider = (process.env.YTDLP_POT_PROVIDER_URL || "").trim().replace(/\/+$/, "");
  if (!client && !provider) {
    return "";
  }
  const material = `metadata-v2\n${client}\n${provider}`;
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function getWhisperCacheProfile(
  language?: string | null,
  baseUrl?: string | null,
  model?: string | null
): string {
  const effectiveLanguage = language || "auto";
  const effectiveBaseUrl = (
    baseUrl ||
    process.env.WHISPER_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.groq.com/openai/v1"
  ).replace(/\/+$/, "");
  const effectiveModel = model || process.env.WHISPER_MODEL || "whisper-large-v3";
  const material = ["whisper-timed-v1", effectiveLanguage, effectiveBaseUrl, effectiveModel].join("\n");
  const digest = crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  const safeLang = effectiveLanguage.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `whisper-${safeLang}-${digest}`;
}

export function browserSourceEvents(
  sourceEvents?: any[] | null,
  sourceCues?: any[] | null
): any[] {
  if (Array.isArray(sourceEvents) && sourceEvents.length > 0) {
    const events: any[] = [];
    for (const event of sourceEvents) {
      if (!event || typeof event !== "object") continue;
      const start = Number(event.tStartMs ?? 0);
      const duration = Number(event.dDurationMs ?? 0);
      if (Number.isNaN(start) || Number.isNaN(duration)) continue;
      const segs: any[] = [];
      for (const seg of event.segs || []) {
        if (!seg || typeof seg !== "object") continue;
        const s: any = { utf8: String(seg.utf8 ?? "") };
        if (typeof seg.tOffsetMs === "number" && !Number.isNaN(seg.tOffsetMs)) {
          s.tOffsetMs = seg.tOffsetMs;
        }
        segs.push(s);
      }
      const normalized: any = { tStartMs: start, dDurationMs: duration, segs };
      if (event.aAppend === 1) {
        normalized.aAppend = 1;
      }
      events.push(normalized);
    }
    if (events.length > 0) return events;
  }

  const events: any[] = [];
  for (const cue of sourceCues || []) {
    if (!cue || typeof cue !== "object") continue;
    const start = Number(cue.start);
    const end = Number(cue.end);
    const text = String(cue.text ?? "").trim();
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start && text) {
      events.push({
        tStartMs: start,
        dDurationMs: end - start,
        segs: [{ utf8: text }],
      });
    }
  }
  return events;
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  setCorsHeaders(res);
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: http.ServerResponse, statusCode: number, detail: string): void {
  sendJson(res, statusCode, { detail });
}

export function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export async function parseJsonBody<T = any>(req: http.IncomingMessage): Promise<T> {
  const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB limit to prevent OOM
  return new Promise((resolve, reject) => {
    let bytesReceived = 0;
    let exceeded = false;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_BODY_BYTES) {
        if (!exceeded) {
          exceeded = true;
          const err = new Error("Payload Too Large");
          (err as any).statusCode = 413;
          reject(err);
        }
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      if (exceeded) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err: any) {
        const error = new Error(`Invalid JSON body: ${err?.message || String(err)}`);
        (error as any).statusCode = 400;
        reject(error);
      }
    });

    req.on("error", (err) => {
      if (!exceeded) reject(err);
    });
  });
}

// ── Validation ──────────────────────────────────────────────────────────

export function validateSubtitleRequest(body: any): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const err = new Error("Request body must be a JSON object");
    (err as any).statusCode = 400;
    throw err;
  }

  // 1. url is ALWAYS required according to the contract
  if (!body.url || typeof body.url !== "string" || !body.url.trim()) {
    const err = new Error("Field 'url' is required");
    (err as any).statusCode = 422;
    throw err;
  }

  try {
    const parsed = new URL(body.url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error();
    }
  } catch {
    const err = new Error("Field 'url' must be a valid HTTP or HTTPS URL");
    (err as any).statusCode = 422;
    throw err;
  }

  // 2. 检查是否有 source_events 或 source_cues
  if (body.source_cues !== undefined && body.source_cues !== null) {
    if (!Array.isArray(body.source_cues)) {
      const err = new Error("source_cues must be an array");
      (err as any).statusCode = 422;
      throw err;
    }
    for (const cue of body.source_cues) {
      if (!cue || typeof cue !== "object" || Array.isArray(cue)) {
        const err = new Error("Invalid cue in source_cues");
        (err as any).statusCode = 422;
        throw err;
      }
      const s = cue.start;
      const e = cue.end;
      if (s === null || s === undefined || typeof s !== "number" || !Number.isFinite(s) || s < 0) {
        const err = new Error("cue start time must be a non-negative finite number");
        (err as any).statusCode = 422;
        throw err;
      }
      if (e === null || e === undefined || typeof e !== "number" || !Number.isFinite(e) || e <= s) {
        const err = new Error("cue end time must be greater than start time and finite");
        (err as any).statusCode = 422;
        throw err;
      }
      if (typeof cue.text !== "string" || !cue.text.trim()) {
        const err = new Error("cue text must be a non-empty string");
        (err as any).statusCode = 422;
        throw err;
      }
    }
  }

  if (body.source_events !== undefined && body.source_events !== null) {
    if (!Array.isArray(body.source_events)) {
      const err = new Error("source_events must be an array");
      (err as any).statusCode = 422;
      throw err;
    }
    for (const ev of body.source_events) {
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
        const err = new Error("Invalid event in source_events");
        (err as any).statusCode = 422;
        throw err;
      }
      if (ev.tStartMs !== undefined && (typeof ev.tStartMs !== "number" || !Number.isFinite(ev.tStartMs) || ev.tStartMs < 0)) {
        const err = new Error("event tStartMs must be a non-negative finite number");
        (err as any).statusCode = 422;
        throw err;
      }
      if (ev.dDurationMs !== undefined && (typeof ev.dDurationMs !== "number" || !Number.isFinite(ev.dDurationMs) || ev.dDurationMs < 0)) {
        const err = new Error("event dDurationMs must be a non-negative finite number");
        (err as any).statusCode = 422;
        throw err;
      }
      if (ev.segs !== undefined) {
        if (!Array.isArray(ev.segs)) {
          const err = new Error("event segs must be an array");
          (err as any).statusCode = 422;
          throw err;
        }
        for (const seg of ev.segs) {
          if (!seg || typeof seg !== "object") {
            const err = new Error("Invalid segment in event");
            (err as any).statusCode = 422;
            throw err;
          }
          if (seg.utf8 !== undefined && typeof seg.utf8 !== "string") {
            const err = new Error("segment utf8 must be a string");
            (err as any).statusCode = 422;
            throw err;
          }
          if (seg.tOffsetMs !== undefined && (typeof seg.tOffsetMs !== "number" || !Number.isFinite(seg.tOffsetMs) || seg.tOffsetMs < 0)) {
            const err = new Error("segment tOffsetMs must be a non-negative finite number");
            (err as any).statusCode = 422;
            throw err;
          }
        }
      }
    }
  }

  // 3. 枚举和核心字段校验
  if (body.translate_engine !== undefined && body.translate_engine !== null) {
    if (!["legacy", "agent", "document"].includes(body.translate_engine)) {
      const err = new Error("Invalid translate_engine");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.segmentation !== undefined && body.segmentation !== null) {
    if (!["rule", "statistical"].includes(body.segmentation)) {
      const err = new Error("Invalid segmentation mode");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.languages !== undefined && body.languages !== null) {
    if (!Array.isArray(body.languages) || !body.languages.every((l: any) => typeof l === "string")) {
      const err = new Error("languages must be an array of strings");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.allow_automatic !== undefined && body.allow_automatic !== null) {
    if (typeof body.allow_automatic !== "boolean") {
      const err = new Error("allow_automatic must be a boolean");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.whisper_enabled !== undefined && body.whisper_enabled !== null) {
    if (typeof body.whisper_enabled !== "boolean") {
      const err = new Error("whisper_enabled must be a boolean");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  // 4. 可选 string 字段校验，防止传入 object/number 等造成 runtime 500
  const stringFields = [
    "translate_to",
    "translate_provider",
    "translate_api_key",
    "translate_base_url",
    "translate_model",
    "whisper_api_key",
    "whisper_base_url",
    "whisper_model",
    "whisper_language",
    "source_video_id",
    "source_title",
    "source_language",
  ];
  for (const field of stringFields) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
      const err = new Error(`Field '${field}' must be a string`);
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.translate_whole !== undefined && body.translate_whole !== null && typeof body.translate_whole !== "boolean") {
    const err = new Error("translate_whole must be a boolean");
    (err as any).statusCode = 422;
    throw err;
  }

  if (body.translate_context_tokens !== undefined && body.translate_context_tokens !== null) {
    if (typeof body.translate_context_tokens !== "number" || !Number.isFinite(body.translate_context_tokens) || body.translate_context_tokens <= 0) {
      const err = new Error("translate_context_tokens must be a positive number");
      (err as any).statusCode = 422;
      throw err;
    }
  }

  if (body.translate_output_tokens !== undefined && body.translate_output_tokens !== null) {
    if (typeof body.translate_output_tokens !== "number" || !Number.isFinite(body.translate_output_tokens) || body.translate_output_tokens <= 0) {
      const err = new Error("translate_output_tokens must be a positive number");
      (err as any).statusCode = 422;
      throw err;
    }
  }
}

// ── Cache Factory ────────────────────────────────────────────────────────

export function createDefaultCache(cacheDirOverride?: string): SubtitleCache {
  const cacheDir = cacheDirOverride || process.env.CACHE_DIR || "./cache";

  const parseNum = (val: string | undefined): number | undefined => {
    if (val === undefined || val === null || val.trim() === "") return undefined;
    const num = Number(val);
    return Number.isFinite(num) ? num : undefined;
  };

  const legacyTtl = parseNum(process.env.CACHE_TTL_SECONDS);
  const maxBytes = parseNum(process.env.CACHE_MAX_BYTES) ?? 5 * 1024 * 1024 * 1024;
  const maintenanceInterval = parseNum(process.env.CACHE_MAINTENANCE_INTERVAL_SECONDS) ?? 86400;

  const options: SubtitleCacheOptions = {
    cacheDir,
    maxBytes,
    maintenanceIntervalSeconds: maintenanceInterval,
  };

  if (legacyTtl !== undefined) {
    options.ttlSeconds = legacyTtl;
  } else {
    options.metadataTtlSeconds = parseNum(process.env.CACHE_METADATA_TTL_SECONDS) ?? 86400;
    options.json3TtlSeconds = parseNum(process.env.CACHE_JSON3_TTL_SECONDS) ?? 30 * 86400;
    options.cuesTtlSeconds = parseNum(process.env.CACHE_CUES_TTL_SECONDS) ?? 0;
    options.translationTtlSeconds = parseNum(process.env.CACHE_TRANSLATION_TTL_SECONDS) ?? 0;
    options.whisperTtlSeconds = parseNum(process.env.CACHE_WHISPER_TTL_SECONDS) ?? 0;
  }

  return new SubtitleCache(cacheDir, options);
}

// ── Dependency Resolution ───────────────────────────────────────────────

export async function resolveDependencies(deps?: Partial<AppDependencies>): Promise<ResolvedDependencies> {
  const cache = deps?.cache || createDefaultCache();

  let worker = deps?.worker;
  if (!worker) {
    const storagePath =
      process.env.TRANSLATION_AGENT_STORAGE ||
      path.join(cache.cacheDir || "./cache", "durable-storage.db");
    worker = new AgentWorker({ storagePath });
    await worker.start();
  }

  const fetchMetadata = deps?.fetchMetadata || defaultFetchMetadata;
  const chooseSubtitle = deps?.chooseSubtitle || defaultChooseSubtitle;
  const fetchSubtitleJson3 = deps?.fetchSubtitleJson3 || defaultFetchSubtitleJson3Raw;
  const prepareTimedTextEvents = deps?.prepareTimedTextEvents || defaultPrepareTimedTextEvents;
  const intelligentSentenceBreakWithMode = deps?.intelligentSentenceBreakWithMode || defaultIntelligentSentenceBreakWithMode;
  const translateSubtitles = deps?.translateSubtitles || defaultTranslateSubtitles;
  const downloadAudio = deps?.downloadAudio || defaultDownloadAudio;
  const splitAudio = deps?.splitAudio || defaultSplitAudio;
  const WhisperClient = deps?.WhisperClient || DefaultWhisperClient;
  const transcribeTimedChunks = deps?.transcribeTimedChunks || defaultTranscribeTimedChunks;

  return {
    cache,
    worker,
    fetchMetadata,
    chooseSubtitle,
    fetchSubtitleJson3,
    prepareTimedTextEvents,
    intelligentSentenceBreakWithMode,
    translateSubtitles,
    downloadAudio,
    splitAudio,
    WhisperClient,
    transcribeTimedChunks,
  };
}

// ── Core Subtitle Processing Pipeline ───────────────────────────────────

export interface SubtitleProcessResult {
  meta: {
    video_id: string;
    title: string;
    from_lang: string;
    source: string;
  };
  cues: SubtitleCue[];
}

/**
 * Restores seconds (from Pane 1 toSubtitleCues) back to integer milliseconds.
 */
export function normalizeCuesToMilliseconds(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((c) => ({
    ...c,
    start: Math.round(Number(c.start) * 1000),
    end: Math.round(Number(c.end) * 1000),
  }));
}

export async function processSubtitleFlow(
  req: SubtitleRequest,
  deps: ResolvedDependencies
): Promise<SubtitleProcessResult> {
  const segmentation = req.segmentation || "rule";

  // Branch 1: Browser fallback via source_events or source_cues
  if (req.source_events !== undefined || req.source_cues !== undefined) {
    const rawEvents = browserSourceEvents(req.source_events, req.source_cues);
    if (!rawEvents || rawEvents.length === 0) {
      const err = new Error("Browser returned no usable subtitle cues");
      (err as any).statusCode = 422;
      throw err;
    }

    const videoId = req.url ? getMetadataCacheKey(req.url) : "browser-video";
    const fromLang = req.source_language || (req.languages && req.languages[0]) || "auto";

    const prepared = deps.prepareTimedTextEvents(rawEvents);
    const flatEvents = prepared.flat_events || (prepared as any).flatEvents || [];
    if (!flatEvents || flatEvents.length === 0) {
      const err = new Error("Browser returned no usable subtitle cues");
      (err as any).statusCode = 422;
      throw err;
    }

    const rawCues = deps.intelligentSentenceBreakWithMode(flatEvents, segmentation, fromLang, prepared.events);
    return {
      meta: {
        video_id: videoId,
        title: req.source_title || req.source_video_id || videoId,
        from_lang: fromLang,
        source: "browser",
      },
      cues: normalizeCuesToMilliseconds(rawCues),
    };
  }

  // Branch 2: yt-dlp pipeline
  let cacheKey = getMetadataCacheKey(req.url);
  const profile = getMetadataCacheProfile();
  if (profile) {
    cacheKey = `${cacheKey}-metadata-${profile}`;
  }

  let metadata = await deps.cache.getMetadata(cacheKey);
  if (!metadata) {
    metadata = await deps.fetchMetadata(req.url);
    await deps.cache.putMetadata(cacheKey, metadata);
  }

  const videoId = String(metadata?.id || "unknown");
  const title = String(metadata?.title || videoId);

  const languages = req.languages && req.languages.length > 0 ? req.languages : ["zh-Hans", "zh-Hant", "zh", "en"];
  const allowAutomatic = req.allow_automatic !== false;

  const selected = deps.chooseSubtitle(metadata, languages, allowAutomatic);

  // Whisper fallback branch if no matching subtitle track is available
  if (!selected) {
    if (!req.whisper_enabled) {
      const err = new Error("No matching subtitle track found");
      (err as any).statusCode = 404;
      throw err;
    }

    const whisperProfile = getWhisperCacheProfile(
      req.whisper_language,
      req.whisper_base_url,
      req.whisper_model
    );

    const cachedWhisperCues = await deps.cache.getCues(
      videoId,
      whisperProfile,
      "whisper-timed-v1",
      null,
      { kind: "whisper" }
    );

    if (cachedWhisperCues && Array.isArray(cachedWhisperCues) && cachedWhisperCues.length > 0) {
      return {
        meta: {
          video_id: videoId,
          title,
          from_lang: req.whisper_language || "auto",
          source: "whisper",
        },
        cues: cachedWhisperCues,
      };
    }

    // De-duplicate concurrent Whisper jobs for the same video & profile
    const lockKey = `${videoId}:${whisperProfile}`;
    let jobPromise = whisperActiveJobs.get(lockKey);

    if (!jobPromise) {
      jobPromise = (async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-ingest-"));
        try {
          const audioPath = await deps.downloadAudio(req.url, tmpDir);
          const chunksDir = path.join(tmpDir, "chunks");
          const chunks = await deps.splitAudio(audioPath, 600, chunksDir);
          const client = new deps.WhisperClient({
            apiKey: req.whisper_api_key || process.env.WHISPER_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
            baseUrl: req.whisper_base_url || process.env.WHISPER_BASE_URL,
            model: req.whisper_model || process.env.WHISPER_MODEL,
          });
          const rawCues = await deps.transcribeTimedChunks(
            chunks,
            client,
            req.whisper_language || undefined,
            600
          );

          if (!rawCues || rawCues.length === 0) {
            const err = new Error("Whisper returned no timed transcript");
            (err as any).statusCode = 500;
            throw err;
          }

          // Convert Whisper seconds output to integer milliseconds
          const cues: SubtitleCue[] = normalizeCuesToMilliseconds(rawCues);

          await deps.cache.putCues(
            videoId,
            whisperProfile,
            "whisper-timed-v1",
            null,
            cues,
            { kind: "whisper" }
          );

          return cues;
        } finally {
          whisperActiveJobs.delete(lockKey);
          try {
            await fs.rm(tmpDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      })();
      whisperActiveJobs.set(lockKey, jobPromise);
    }

    const transcribedCues = await jobPromise;
    return {
      meta: {
        video_id: videoId,
        title,
        from_lang: req.whisper_language || "auto",
        source: "whisper",
      },
      cues: transcribedCues,
    };
  }

  let selectedLang: string;
  let sourceType: string;
  if (Array.isArray(selected)) {
    selectedLang = selected[0];
    sourceType = selected[1];
  } else {
    selectedLang = selected.language;
    sourceType = selected.source;
  }

  // Check cached processed cues first
  const cachedCues = await deps.cache.getCues(videoId, selectedLang, segmentation, null, { profile: "segment-v1" });
  if (cachedCues && Array.isArray(cachedCues) && cachedCues.length > 0) {
    return {
      meta: {
        video_id: videoId,
        title,
        from_lang: selectedLang,
        source: sourceType,
      },
      cues: cachedCues,
    };
  }

  // Validate downloads before persisting: malformed JSON must not poison cache.
  let downloadedJson3 = false;
  let json3Text = await deps.cache.getJson3(videoId, selectedLang);
  if (!json3Text) {
    const downloaded = await deps.fetchSubtitleJson3(req.url, selectedLang);
    if (!downloaded) {
      const err = new Error("Failed to download subtitle");
      (err as any).statusCode = 500;
      throw err;
    }
    json3Text = typeof downloaded === "string" ? downloaded : JSON.stringify(downloaded);
    downloadedJson3 = true;
  }

  const json3Data = JSON.parse(json3Text.replace(/^\ufeff/, ""));
  if (!json3Data || !Array.isArray(json3Data.events)) throw new Error("Invalid subtitle JSON: expected events array");

  const rawEvents = json3Data.events;
  const prepared = deps.prepareTimedTextEvents(rawEvents);
  const flatEvents = prepared.flat_events || (prepared as any).flatEvents || [];

  if (!flatEvents || flatEvents.length === 0) {
    const err = new Error("No usable subtitle text found");
    (err as any).statusCode = 404;
    throw err;
  }

  if (downloadedJson3) await deps.cache.putJson3(videoId, selectedLang, json3Text);
  const rawCues = deps.intelligentSentenceBreakWithMode(flatEvents, segmentation, selectedLang, prepared.events);
  const cues = normalizeCuesToMilliseconds(rawCues);

  await deps.cache.putCues(videoId, selectedLang, segmentation, null, cues, { profile: "segment-v1" });

  return {
    meta: {
      video_id: videoId,
      title,
      from_lang: selectedLang,
      source: sourceType,
    },
    cues,
  };
}

// ── Application Handler ─────────────────────────────────────────────────

export function createApp(deps?: Partial<AppDependencies>): http.RequestListener {
  const activeLegacyStreams = new Set<string>();
  let resolvedDepsPromise: Promise<ResolvedDependencies> | null = null;
  const getDeps = () => {
    if (!resolvedDepsPromise) {
      resolvedDepsPromise = resolveDependencies(deps);
    }
    return resolvedDepsPromise;
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Host is untrusted and irrelevant to routing. Parse inside the boundary.
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;
      const method = req.method?.toUpperCase();
      const resolved = await getDeps();

      // ── GET /api/health ───────────────────────────────────────────────
      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { status: "ok", version: "0.3.0" } satisfies HealthResponse);
        return;
      }

      // ── GET /api/subtitle/tracks ──────────────────────────────────────
      if (method === "GET" && pathname === "/api/subtitle/tracks") {
        const videoUrl = url.searchParams.get("url");
        if (!videoUrl || !videoUrl.trim()) {
          sendError(res, 422, "Field 'url' is required");
          return;
        }

        try {
          const parsed = new URL(videoUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        } catch {
          sendError(res, 422, "Field 'url' must be a valid HTTP or HTTPS URL");
          return;
        }

        const languagesParam = url.searchParams.get("languages") || "zh-Hans,zh-Hant,zh,en";
        const langList = languagesParam.split(",").map((l) => l.trim()).filter(Boolean);

        let metadata: any;
        try {
          let cacheKey = getMetadataCacheKey(videoUrl);
          const profile = getMetadataCacheProfile();
          if (profile) cacheKey = `${cacheKey}-metadata-${profile}`;

          metadata = await resolved.cache.getMetadata(cacheKey);
          if (!metadata) {
            metadata = await resolved.fetchMetadata(videoUrl);
            await resolved.cache.putMetadata(cacheKey, metadata);
          }
        } catch (err: any) {
          if (err instanceof IngestError || err?.name === "IngestError") {
            sendError(res, 400, err.message);
            return;
          }
          sendError(res, 500, err?.message || String(err));
          return;
        }

        const videoId = String(metadata?.id || "unknown");
        const title = String(metadata?.title || videoId);
        const tracks: SubtitleTrack[] = [];

        const categories = [
          { key: "subtitles", source: "manual" as const },
          { key: "automatic_captions", source: "automatic" as const },
        ];

        for (const cat of categories) {
          const available = metadata?.[cat.key] || {};
          for (const langCode of Object.keys(available)) {
            const matches = langList.some((l) =>
              langCode.toLowerCase().startsWith(l.toLowerCase().slice(0, 2))
            );
            if (matches) {
              tracks.push({
                language: langCode,
                source: cat.source,
                label: `${langCode}${cat.source === "automatic" ? " (auto)" : ""}`,
              });
            }
          }
        }

        sendJson(res, 200, { video_id: videoId, title, tracks } satisfies TracksResponse);
        return;
      }

      // ── POST /api/subtitle/process ────────────────────────────────────
      if (method === "POST" && pathname === "/api/subtitle/process") {
        const body = await parseJsonBody<SubtitleRequest>(req);
        validateSubtitleRequest(body);

        if (body.translate_engine === "document") {
          sendError(res, 422, "全文高质量模式为后台任务，请使用 /api/subtitle/stream 获取进度与结果");
          return;
        }

        let meta: SubtitleProcessResult["meta"];
        let cues: SubtitleCue[];
        try {
          const result = await processSubtitleFlow(body, resolved);
          meta = result.meta;
          cues = result.cues;
        } catch (err: any) {
          const status = err?.statusCode || (err instanceof IngestError ? 400 : 500);
          sendError(res, status, err?.message || String(err));
          return;
        }

        const toLang = body.translate_to;
        if (!toLang || cues.length === 0) {
          sendJson(res, 200, {
            video_id: meta.video_id,
            title: meta.title,
            from_lang: meta.from_lang,
            to_lang: undefined,
            segmentation: body.segmentation || "rule",
            source: meta.source as any,
            cues,
            progress: 100,
            translation_status: "not_requested",
            failed_cues: 0,
          } satisfies SubtitleResponse);
          return;
        }

        if (body.translate_engine === "agent") {
          const provider = body.translate_provider || "openai";
          if (!["openai", "deepl", "mock"].includes(provider)) {
            sendError(res, 400, "Invalid agent model, credentials, or worker configuration");
            return;
          }

          try {
            const job = await resolved.worker.submitOrAttachJob({
              cues,
              videoId: meta.video_id,
              title: meta.title,
              fromLang: meta.from_lang,
              toLang,
              segmentation: body.segmentation || "rule",
              provider,
              model: body.translate_model || undefined,
              baseUrl: body.translate_base_url,
              apiKey: body.translate_api_key,
            });

            let snapshot: any = null;
            let pollFinished = false;
            for (let i = 0; i < 60; i++) {
              snapshot = await resolved.worker.snapshotJob(job);
              if (["succeeded", "partial", "failed", "budget_exceeded", "cancelled"].includes(snapshot.status)) {
                pollFinished = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 200));
            }

            const total = cues.length;

            if (!pollFinished || snapshot?.status === "failed" || snapshot?.status === "cancelled") {
              sendJson(res, 200, {
                video_id: meta.video_id,
                title: meta.title,
                from_lang: meta.from_lang,
                to_lang: toLang,
                segmentation: body.segmentation || "rule",
                source: meta.source as any,
                cues,
                progress: 0,
                translation_status: "failed",
                failed_cues: total,
                job_id: job.jobId,
              } satisfies SubtitleResponse);
              return;
            }

            const pubMap = new Map<string, string>();
            for (const pc of snapshot?.published_cues || []) {
              if (pc.cue_id) pubMap.set(pc.cue_id, pc.translation || "");
            }

            const resultCues: SubtitleCue[] = cues.map((c, idx) => {
              const cueId = c.cue_id || `c${idx}`;
              return {
                ...c,
                cue_id: cueId,
                translation: pubMap.get(cueId) || "",
              };
            });

            let failedCount = 0;
            for (const c of resultCues) {
              const tr = (c.translation || "").trim();
              if (!tr || tr === "[Translation failed]") {
                failedCount++;
              }
            }

            let status: "succeeded" | "partial" | "failed" = "succeeded";
            if (failedCount === 0) {
              status = "succeeded";
            } else if (failedCount >= total) {
              status = "failed";
            } else {
              status = "partial";
            }

            const progress = total === 0 ? 100 : Math.round(((total - failedCount) / total) * 100);

            sendJson(res, 200, {
              video_id: meta.video_id,
              title: meta.title,
              from_lang: meta.from_lang,
              to_lang: toLang,
              segmentation: body.segmentation || "rule",
              source: meta.source as any,
              cues: resultCues,
              progress,
              translation_status: status,
              failed_cues: failedCount,
              job_id: job.jobId,
            } satisfies SubtitleResponse);
            return;
          } catch (err: any) {
            sendError(res, 503, `Agent translation service unavailable: ${err?.message || String(err)}`);
            return;
          }
        }

        // Legacy translation path
        const strategy = body.translate_whole ? "rest-whole-v1" : "rest-batch-v1";
        const profileKey = getTranslationProfile({
          cues,
          provider: body.translate_provider,
          baseUrl: body.translate_base_url,
          model: body.translate_model,
          strategy,
          engine: "legacy",
          fromLang: meta.from_lang,
          toLang,
          segmentation: body.segmentation || "rule",
        });

        let working = cues.map((c) => ({ ...c }));
        const cached = await resolved.cache.getTranslation(
          meta.video_id,
          meta.from_lang,
          body.segmentation || "rule",
          toLang,
          profileKey
        );

        const isFullyCached =
          Array.isArray(cached) &&
          cached.length === working.length &&
          cached.every((c) => c.translation && c.translation !== "[Translation failed]");

        let translationAttemptFailed = false;
        if (isFullyCached) {
          working = cached;
        } else {
          try {
            working = await resolved.translateSubtitles(working, meta.from_lang, toLang, {
              provider: body.translate_provider,
              apiKey: body.translate_api_key,
              baseUrl: body.translate_base_url,
              model: body.translate_model,
              whole: body.translate_whole,
            });
          } catch (error) {
            // REST provider boundary: known provider failures retain the explicit
            // failed status contract; JSON/configuration/storage errors propagate.
            if (!(error instanceof TranslateError)) throw error;
            translationAttemptFailed = true;
          }
        }

        const total = working.length;
        let failedCount = 0;
        for (const c of working) {
          const tr = (c.translation || "").trim();
          if (!tr || tr === "[Translation failed]") {
            failedCount++;
          }
        }

        if (translationAttemptFailed && failedCount === 0) {
          failedCount = total;
        }

        let status: "succeeded" | "partial" | "failed" = "succeeded";
        if (failedCount === 0) {
          status = "succeeded";
        } else if (failedCount >= total) {
          status = "failed";
        } else {
          status = "partial";
        }

        const progress = total === 0 ? 100 : Math.round(((total - failedCount) / total) * 100);

        if (status !== "failed") {
          await resolved.cache.putTranslation(
            meta.video_id,
            meta.from_lang,
            body.segmentation || "rule",
            toLang,
            profileKey,
            working
          );
        }

        sendJson(res, 200, {
          video_id: meta.video_id,
          title: meta.title,
          from_lang: meta.from_lang,
          to_lang: toLang,
          segmentation: body.segmentation || "rule",
          source: meta.source as any,
          cues: working,
          progress,
          translation_status: status,
          failed_cues: failedCount,
        } satisfies SubtitleResponse);
        return;
      }

      // ── POST /api/subtitle/stream ─────────────────────────────────────
      if (method === "POST" && pathname === "/api/subtitle/stream") {
        const body = await parseJsonBody<SubtitleRequest>(req);
        validateSubtitleRequest(body);

        if (body.translate_engine === "document" && body.translate_provider && body.translate_provider !== "openai") {
          sendError(res, 422, "全文高质量模式需要 OpenAI-compatible 模型，不支持逐句 DeepL 翻译");
          return;
        }

        let meta: SubtitleProcessResult["meta"];
        let cues: SubtitleCue[];
        try {
          const result = await processSubtitleFlow(body, resolved);
          meta = result.meta;
          cues = result.cues;
        } catch (err: any) {
          const status = err?.statusCode || (err instanceof IngestError ? 400 : 500);
          sendError(res, status, err?.message || String(err));
          return;
        }

        // Establish SSE stream
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*",
        });

        const abortController = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        };
        res.on("close", onClose);

        const sendSSE = (data: unknown) => writeSSE(res, data, abortController.signal);

        const toLang = body.translate_to;
        if (!toLang || cues.length === 0) {
          try {
            await sendSSE({
              type: "meta",
              ...meta,
              to_lang: null,
              segmentation: body.segmentation || "rule",
              total_cues: cues.length,
            });
            for (let i = 0; i < cues.length; i++) {
              await sendSSE({ type: "cue", index: i, ...cues[i] });
            }
            await sendSSE({ type: "done", total_cues: cues.length, failed_cues: 0 });
          } finally {
            res.removeListener("close", onClose);
            res.end();
          }
          return;
        }

        // Branch A: Document & Agent Translation Engine (Direct In-Memory Worker Integration)
        if (body.translate_engine === "document" || body.translate_engine === "agent") {
          let job: any;
          try {
            job = await resolved.worker.submitOrAttachJob({
              cues,
              videoId: meta.video_id,
              title: meta.title,
              fromLang: meta.from_lang,
              toLang,
              segmentation: body.segmentation || "rule",
              provider: body.translate_provider || "openai",
              model: body.translate_model || undefined,
              baseUrl: body.translate_base_url,
              apiKey: body.translate_api_key,
              engine: body.translate_engine,
              contextTokens: body.translate_context_tokens,
              outputTokens: body.translate_output_tokens,
            });
          } catch (err: any) {
            // Submission boundary: expose a failed submission as an SSE error.
            await sendSSE({ type: "error", detail: err?.message || String(err) });
            res.removeListener("close", onClose);
            res.end();
            return;
          }

          try {
            for await (const event of resolved.worker.observeJobStream(job, {
              signal: abortController.signal,
              heartbeatIntervalMs: 5000,
            })) {
              if (abortController.signal.aborted) break;
              await sendSSE(event);
            }
          } catch (err: any) {
            // Observer boundary: durable/model failures become stream errors;
            // detaching a disconnected observer must not cancel its durable job.
            if (!abortController.signal.aborted) {
              await sendSSE({ type: "error", detail: err?.message || String(err) });
            }
          } finally {
            res.removeListener("close", onClose);
            if (!res.writableEnded) {
              res.end();
            }
          }
          return;
        }

        // Branch B: Legacy Translation Stream
        let legacyLock: string | undefined;
        try {
          const total = cues.length;
          const useWhole = body.translate_whole || total >= 100;
          const chunkSize = 10;
          const strategy = `sse-${useWhole ? "context" : "batch"}-${chunkSize}-v1`;

          const profileKey = getTranslationProfile({
            cues,
            provider: body.translate_provider,
            baseUrl: body.translate_base_url,
            model: body.translate_model,
            strategy,
            engine: "legacy",
            fromLang: meta.from_lang,
            toLang,
            segmentation: body.segmentation || "rule",
          });

          legacyLock = `${meta.video_id}:${profileKey}`;
          if (activeLegacyStreams.has(legacyLock)) {
            legacyLock = undefined;
            await sendSSE({ type: "error", detail: "Translation already in progress for this profile" });
            return;
          }
          activeLegacyStreams.add(legacyLock);

          const working = cues.map((c) => ({ ...c }));
          const cached = await resolved.cache.getTranslation(
            meta.video_id,
            meta.from_lang,
            body.segmentation || "rule",
            toLang,
            profileKey
          );

          const completedIndices = new Set<number>();
          if (Array.isArray(cached) && cached.length === total) {
            for (let i = 0; i < total; i++) {
              const tr = cached[i]?.translation;
              if (tr && tr !== "[Translation failed]" && cached[i]?.text === working[i]?.text) {
                working[i].translation = tr;
                completedIndices.add(i);
              }
            }
          }

          await sendSSE({
            type: "meta",
            ...meta,
            to_lang: toLang,
            segmentation: body.segmentation || "rule",
            total_cues: total,
            completed_cues: completedIndices.size,
          });

          for (let idx = 0; idx < total; idx++) {
            await sendSSE({ type: "source_cue", index: idx, ...working[idx] });
          }

          for (const idx of Array.from(completedIndices).sort((a, b) => a - b)) {
            await sendSSE({ type: "cue", index: idx, ...working[idx], cached: true });
          }

          const pendingIndices = Array.from({ length: total }, (_, i) => i).filter((i) => !completedIndices.has(i));
          if (pendingIndices.length === 0) {
            await sendSSE({ type: "done", total_cues: total, failed_cues: 0 });
            return;
          }

          // Chunk-by-chunk translation
          let failedCount = 0;
          for (let i = 0; i < pendingIndices.length; i += chunkSize) {
            if (abortController.signal.aborted) break;
            const chunkIndices = pendingIndices.slice(i, i + chunkSize);
            const chunkCues = chunkIndices.map((idx) => working[idx]);

            const translatedChunk = await withHeartbeats(
              resolved.translateSubtitles(chunkCues, meta.from_lang, toLang, {
                provider: body.translate_provider,
                apiKey: body.translate_api_key,
                baseUrl: body.translate_base_url,
                model: body.translate_model,
                whole: useWhole,
                wholeFallbackToBatch: true,
                signal: abortController.signal,
              }),
              () => sendSSE({ type: "keepalive" }),
            );

            for (let j = 0; j < chunkIndices.length; j++) {
              const idx = chunkIndices[j];
              const tr = translatedChunk[j]?.translation || "";
              if (!tr || tr === "[Translation failed]") {
                failedCount++;
              } else {
                working[idx].translation = tr;
                await sendSSE({ type: "cue", index: idx, ...working[idx] });
              }
            }

            await resolved.cache.putTranslation(
              meta.video_id,
              meta.from_lang,
              body.segmentation || "rule",
              toLang,
              profileKey,
              working
            );
          }

          await sendSSE({ type: "done", total_cues: total, failed_cues: failedCount });
        } catch (error) {
          // SSE boundary: provider/cache failures are explicit errors, not failed
          // cue counts or a successful done event. A disconnect needs no reply.
          if (!abortController.signal.aborted) {
            await sendSSE({ type: "error", detail: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          if (legacyLock) activeLegacyStreams.delete(legacyLock);
          res.removeListener("close", onClose);
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      // ── POST /api/subtitle/abort & /api/subtitle/cancel ───────────────
      if (method === "POST" && (pathname === "/api/subtitle/abort" || pathname === "/api/subtitle/cancel")) {
        const body = await parseJsonBody<AbortJobRequest>(req);
        if (!body || typeof body !== "object" || typeof body.job_id !== "string" || !body.job_id.trim()) {
          sendError(res, 400, "Field 'job_id' is required");
          return;
        }
        const success = await resolved.worker.abortJob(body.job_id);
        sendJson(res, 200, { success: !!success, job_id: body.job_id } satisfies AbortJobResponse);
        return;
      }

      // ── DELETE /api/cache/:videoId ────────────────────────────────────
      const cacheVideoMatch = pathname.match(/^\/api\/cache\/([^/]+)$/);
      if (method === "DELETE" && cacheVideoMatch && cacheVideoMatch[1] !== "purge") {
        const videoId = decodeURIComponent(cacheVideoMatch[1]);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) {
          sendError(res, 400, "Invalid video_id");
          return;
        }
        const removed = await resolved.cache.clearVideo(videoId);
        sendJson(res, 200, { removed });
        return;
      }

      // ── DELETE /api/cache ─────────────────────────────────────────────
      if (method === "DELETE" && pathname === "/api/cache") {
        const removed = await resolved.cache.clearAll();
        sendJson(res, 200, { removed });
        return;
      }

      // ── POST /api/cache/purge ─────────────────────────────────────────
      if (method === "POST" && pathname === "/api/cache/purge") {
        const removed = await resolved.cache.purgeExpired();
        sendJson(res, 200, { removed });
        return;
      }

      // ── 404 Route Not Found ───────────────────────────────────────────
      sendError(res, 404, "Not Found");
    } catch (err: any) {
      // HTTP boundary: before headers, translate failures to JSON. Once a
      // streaming response started, never write JSON or attempt new headers.
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const status = err?.statusCode || 500;
      sendError(res, status, err?.message || String(err));
    }
  };
}
