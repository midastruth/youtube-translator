import fs from "node:fs/promises";
import path from "node:path";
import { IngestError } from "./errors.js";
import type { SubtitleCue } from "./types.js";

const SENTENCE_BOUNDARY = /(?<=[.!?。！？])(?:\s+|$|\n+)|\n+/;

export function fallbackSegments(
  text: string,
  durationSeconds: number
): Array<{ start: number; end: number; text: string }> {
  const parts = text
    .split(SENTENCE_BOUNDARY)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  const duration = Math.max(Number(durationSeconds) || 0, parts.length * 0.5);
  const weights = parts.map((part) => Math.max(part.length, 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let elapsed = 0;
  const segments: Array<{ start: number; end: number; text: string }> = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const weight = weights[index];
    const start = elapsed;
    elapsed = index === parts.length - 1 ? duration : elapsed + (duration * weight) / totalWeight;
    segments.push({ start, end: elapsed, text: part });
  }

  return segments;
}

export interface WhisperClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutSeconds?: number;
  retries?: number;
}

export class WhisperClient {
  public apiKey?: string;
  public baseUrl: string;
  public model: string;
  public timeoutSeconds: number;
  public retries: number;

  constructor(options?: WhisperClientOptions) {
    this.apiKey =
      options?.apiKey ||
      process.env.WHISPER_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.OPENAI_API_KEY;
    this.baseUrl = (
      options?.baseUrl ||
      process.env.WHISPER_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.groq.com/openai/v1"
    ).replace(/\/+$/, "");
    this.model = options?.model || process.env.WHISPER_MODEL || "whisper-large-v3";
    this.timeoutSeconds = options?.timeoutSeconds ?? 180.0;
    this.retries = options?.retries ?? 3;

    if (!this.apiKey) {
      throw new IngestError("Set WHISPER_API_KEY (or GROQ_API_KEY) before audio transcription");
    }
  }

  private async _request(
    audioPath: string,
    language?: string,
    responseFormat: string = "json",
    timestamps: boolean = false
  ): Promise<any> {
    const fileName = path.basename(audioPath);
    const endpoint = `${this.baseUrl}/audio/transcriptions`;

    const fileBuffer = await fs.readFile(audioPath);
    const blob = new Blob([fileBuffer], { type: "audio/mpeg" });

    let lastError: any = null;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Transcription request timed out")),
        this.timeoutSeconds * 1000
      );
      try {
        const formData = new FormData();
        formData.append("file", blob, fileName);
        formData.append("model", this.model);
        formData.append("response_format", responseFormat);
        formData.append("temperature", "0");
        if (timestamps) {
          formData.append("timestamp_granularities[]", "segment");
        }
        if (language && typeof language === "string") {
          formData.append("language", language);
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: formData,
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new IngestError(`transcription API returned ${res.status}: ${errText}`);
        }

        const payload = await res.json();
        if (!payload || typeof payload !== "object") {
          throw new IngestError(`transcription API returned invalid JSON for ${fileName}`);
        }
        return payload;
      } catch (err: any) {
        if (
          controller.signal.aborted ||
          err?.name === "AbortError" ||
          err?.message?.includes("timed out")
        ) {
          lastError = new IngestError(
            `transcription API timed out after ${this.timeoutSeconds}s for ${fileName}`
          );
        } else {
          lastError = err;
        }
        if (attempt + 1 < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError instanceof IngestError) {
      throw lastError;
    }
    throw new IngestError(`transcription failed for ${fileName}: ${lastError?.message || lastError}`);
  }

  async transcribe(audioPath: string, language?: string): Promise<string> {
    const payload = await this._request(audioPath, language, "json");
    const text = String(payload.text || "").trim();
    if (!text) {
      throw new IngestError(`transcription API returned no text for ${path.basename(audioPath)}`);
    }
    return text;
  }

  async transcribeTimed(
    audioPath: string,
    language?: string
  ): Promise<{
    text: string;
    segments: Array<{ start: number; end: number; text: string }>;
    duration?: number;
    language?: string;
  }> {
    let payload: any;
    try {
      payload = await this._request(audioPath, language, "verbose_json", true);
    } catch {
      const text = await this.transcribe(audioPath, language);
      return {
        text,
        segments: [],
        language,
      };
    }

    const segments: Array<{ start: number; end: number; text: string }> = [];
    const rawSegments = payload.segments;
    if (Array.isArray(rawSegments)) {
      for (const raw of rawSegments) {
        if (!raw || typeof raw !== "object") continue;
        const text = String(raw.text || "").trim();
        const start = Number(raw.start);
        const end = Number(raw.end);
        if (!text || isNaN(start) || isNaN(end) || start < 0 || end <= start) {
          continue;
        }
        segments.push({ start, end, text });
      }
    }

    let text = String(payload.text || "").trim();
    if (!text && segments.length > 0) {
      text = segments.map((s) => s.text).join(" ");
    }
    if (!text) {
      throw new IngestError(`transcription API returned no text for ${path.basename(audioPath)}`);
    }

    return {
      text,
      segments,
      duration: payload.duration !== undefined ? Number(payload.duration) : undefined,
      language: payload.language || language,
    };
  }

  async transcribeTimedChunks(
    chunks: string[],
    langHint?: string,
    chunkSeconds: number = 600
  ): Promise<SubtitleCue[]> {
    return transcribeTimedChunks(chunks, this, langHint, chunkSeconds);
  }
}

export type TranscribeTimedChunksOptions = {
  client?: WhisperClient;
  language?: string;
  langHint?: string;
  chunkSeconds?: number;
};

export async function transcribeTimedChunks(
  chunks: string[],
  clientOrLangHintOrOptions?: WhisperClient | string | TranscribeTimedChunksOptions,
  langHintOrOptions?: string | TranscribeTimedChunksOptions,
  chunkSecondsOpt: number = 600
): Promise<SubtitleCue[]> {
  let client: WhisperClient;
  let language: string | undefined;
  let chunkSeconds = chunkSecondsOpt;

  if (
    clientOrLangHintOrOptions &&
    typeof (clientOrLangHintOrOptions as any).transcribeTimed === "function"
  ) {
    client = clientOrLangHintOrOptions as WhisperClient;
    if (typeof langHintOrOptions === "object" && langHintOrOptions !== null) {
      language = langHintOrOptions.language || langHintOrOptions.langHint;
      chunkSeconds = langHintOrOptions.chunkSeconds ?? 600;
    } else if (typeof langHintOrOptions === "string") {
      language = langHintOrOptions;
    }
  } else if (typeof clientOrLangHintOrOptions === "string") {
    client = new WhisperClient();
    language = clientOrLangHintOrOptions;
    if (typeof langHintOrOptions === "number") {
      chunkSeconds = langHintOrOptions;
    }
  } else if (
    typeof clientOrLangHintOrOptions === "object" &&
    clientOrLangHintOrOptions !== null
  ) {
    const opts = clientOrLangHintOrOptions as TranscribeTimedChunksOptions;
    client = opts.client || new WhisperClient();
    language = opts.language || opts.langHint;
    chunkSeconds = opts.chunkSeconds ?? 600;
  } else {
    client = new WhisperClient();
    if (typeof langHintOrOptions === "string") {
      language = langHintOrOptions;
    }
  }

  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new IngestError("chunk_seconds must be greater than zero");
  }

  const cues: SubtitleCue[] = [];
  let cueCounter = 1;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const transcript = await client.transcribeTimed(chunk, language);
    let segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    if (segments.length === 0) {
      const duration = typeof transcript.duration === "number" ? transcript.duration : chunkSeconds;
      segments = fallbackSegments(transcript.text || "", duration);
    }

    const offsetSeconds = chunkIndex * chunkSeconds;
    for (const segment of segments) {
      const text = String(segment.text || "").trim();
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!text || isNaN(start) || isNaN(end) || start < 0 || end <= start) {
        continue;
      }
      cues.push({
        start: offsetSeconds + start,
        end: offsetSeconds + end,
        text,
        translation: "",
        cue_id: `c${cueCounter++}`,
      });
    }
  }

  return cues;
}
