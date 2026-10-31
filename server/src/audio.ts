import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IngestError } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function ensureFfmpeg(timeoutMs: number = 10000): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: timeoutMs });
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.message?.includes("ENOENT")) {
      throw new IngestError("ffmpeg is required but was not found on PATH");
    }
    throw new IngestError(`ffmpeg check failed: ${error?.message || error}`);
  }
}

export async function splitAudio(
  audioPath: string,
  chunkSecondsOrOutputDir?: number | string,
  outputDirOrChunkSeconds?: string | number,
  timeoutMs: number = 120_000
): Promise<string[]> {
  let chunkSeconds = 600;
  let outputDir: string;

  if (typeof chunkSecondsOrOutputDir === "number") {
    chunkSeconds = chunkSecondsOrOutputDir;
    outputDir =
      typeof outputDirOrChunkSeconds === "string"
        ? outputDirOrChunkSeconds
        : path.join(path.dirname(audioPath), "chunks");
  } else if (typeof chunkSecondsOrOutputDir === "string") {
    outputDir = chunkSecondsOrOutputDir;
    if (typeof outputDirOrChunkSeconds === "number") {
      chunkSeconds = outputDirOrChunkSeconds;
    }
  } else {
    outputDir = path.join(path.dirname(audioPath), "chunks");
  }

  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new IngestError("chunk_seconds must be greater than zero");
  }

  await ensureFfmpeg();

  await fs.mkdir(outputDir, { recursive: true });
  const pattern = path.join(outputDir, "chunk_%03d.mp3");

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    audioPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    "-segment_start_number",
    "1",
    "-reset_timestamps",
    "1",
    pattern,
  ];

  try {
    await execFileAsync("ffmpeg", args, { timeout: timeoutMs });
  } catch (exc: any) {
    if (exc?.killed || exc?.signal === "SIGTERM") {
      throw new IngestError(`ffmpeg timed out after ${timeoutMs}ms`);
    }
    const stderr = (exc.stderr || exc.message || "").trim();
    throw new IngestError(`ffmpeg failed: ${stderr}`);
  }

  const entries = await fs.readdir(outputDir);
  const chunks = entries
    .filter((name) => /^chunk_\d+\.mp3$/.test(name))
    .sort()
    .map((name) => path.join(outputDir, name));

  if (chunks.length === 0) {
    throw new IngestError("ffmpeg did not produce any audio chunks");
  }

  return chunks;
}

export const split_audio = splitAudio;
