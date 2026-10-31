/**
 * YouTube extraction helpers via yt-dlp CLI.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IngestError } from "./errors.js";
import type { SubtitleTrack } from "./types.js";

export { IngestError };
export type { SubtitleTrack };

export function buildYtDlpCommand(extraArgs: string[]): { cmd: string; args: string[] } {
  const cmd = process.env.YTDLP_PATH?.trim() || "yt-dlp";
  const args: string[] = [];

  const youtubeClient = process.env.YTDLP_YOUTUBE_CLIENT?.trim();
  if (youtubeClient) {
    args.push("--extractor-args", `youtube:player_client=${youtubeClient}`);
  }

  const potProviderUrl = process.env.YTDLP_POT_PROVIDER_URL?.trim().replace(/\/+$/, "");
  if (potProviderUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${potProviderUrl}`);
  }

  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }

  args.push(...extraArgs);

  return { cmd, args };
}

export const build_yt_dlp_command = buildYtDlpCommand;

export function runYtDlp(args: string[]): Promise<string> {
  const { cmd, args: finalArgs } = buildYtDlpCommand(args);
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      finalArgs,
      { maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message || "").trim();
          reject(new IngestError(`yt-dlp failed: ${detail}`));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

export async function fetchMetadata(url: string): Promise<any> {
  const raw = await runYtDlp(["--dump-single-json", "--skip-download", "--no-warnings", url]);
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new IngestError("yt-dlp returned invalid metadata JSON");
  }
}

export async function fetchSubtitleJson3Raw(url: string, lang: string): Promise<string | null> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytdlp-sub-"));
  try {
    const outTmpl = path.join(tmpDir, "sub");
    const args = [
      "--skip-download",
      "--write-sub",
      "--write-auto-sub",
      "--sub-langs",
      lang,
      "--sub-format",
      "json3",
      "--output",
      outTmpl,
      "--no-warnings",
      url,
    ];
    await runYtDlp(args);
    const files = await fs.promises.readdir(tmpDir);
    const candidates = files
      .filter(f => f.startsWith("sub") && f.endsWith(".json3"))
      .sort();
    if (!candidates.length) {
      return null;
    }
    const filePath = path.join(tmpDir, candidates[0]);
    return await fs.promises.readFile(filePath, "utf-8");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fetchSubtitleJson3(url: string, lang: string): Promise<any> {
  const raw = await fetchSubtitleJson3Raw(url, lang);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err: any) {
    throw new IngestError(`yt-dlp returned invalid json3 subtitle: ${err.message}`);
  }
}

function createSubtitleTrack(
  language: string,
  source: "manual" | "automatic",
  formatList?: any,
): SubtitleTrack {
  let label = language;
  if (Array.isArray(formatList) && formatList.length > 0 && formatList[0]?.name) {
    label = formatList[0].name;
  } else if (formatList?.name) {
    label = formatList.name;
  }

  const track = {
    language,
    source,
    label,
    0: language,
    1: source,
    length: 2,
    [Symbol.iterator]: function* () {
      yield language;
      yield source;
    },
  };

  return track as unknown as SubtitleTrack;
}

export function chooseSubtitle(
  metadata: any,
  languages: string[],
  allowAutomatic: boolean = true,
): SubtitleTrack | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const requested = (languages || [])
    .map(lang => (typeof lang === "string" ? lang.trim() : ""))
    .filter(Boolean);

  const manualCaptions = metadata.subtitles || {};
  const autoCaptions = (allowAutomatic && metadata.automatic_captions) || {};

  const sources: Array<{ name: "manual" | "automatic"; available: Record<string, any> }> = [
    { name: "manual", available: manualCaptions },
  ];
  if (allowAutomatic) {
    sources.push({ name: "automatic", available: autoCaptions });
  }

  for (const { name: sourceName, available } of sources) {
    const keys = Object.keys(available);
    for (const requestedLanguage of requested) {
      const exact = keys.find(k => k.toLowerCase() === requestedLanguage.toLowerCase());
      if (exact) {
        return createSubtitleTrack(exact, sourceName, available[exact]);
      }
      const prefix = requestedLanguage.toLowerCase().split("-")[0];
      const related = keys.find(k => k.toLowerCase().split("-")[0] === prefix);
      if (related) {
        return createSubtitleTrack(related, sourceName, available[related]);
      }
    }
  }

  return null;
}

export const choose_subtitle = chooseSubtitle;

const TIMING_RE = /^\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}/;
const TAG_RE = /<[^>]+>/g;

function unescapeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function vttToText(vttInput: string): string {
  if (!vttInput) {
    return "";
  }
  let content = vttInput;
  if (typeof vttInput === "string" && !vttInput.includes("\n") && fs.existsSync(vttInput)) {
    content = fs.readFileSync(vttInput, "utf-8");
  }
  content = content.replace(/^\uFEFF/, "");

  const lines: string[] = [];
  let previous = "";
  const rawLines = content.split(/\r?\n/);

  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index].trim();
    const nextLine = index + 1 < rawLines.length ? rawLines[index + 1].trim() : "";

    if (
      !line ||
      line === "WEBVTT" ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.startsWith("NOTE") ||
      line.startsWith("STYLE") ||
      line.startsWith("REGION") ||
      TIMING_RE.test(line) ||
      (/^\d+$/.test(line) && TIMING_RE.test(nextLine))
    ) {
      continue;
    }

    const cleaned = unescapeHtml(line.replace(TAG_RE, "")).trim();
    if (!cleaned || cleaned === previous) {
      continue;
    }

    if (previous && cleaned.startsWith(previous)) {
      lines[lines.length - 1] = cleaned;
    } else {
      lines.push(cleaned);
    }
    previous = cleaned;
  }

  const result = lines.join("\n").trim();
  return result ? result + "\n" : "";
}

export const vtt_to_text = vttToText;

export async function downloadSubtitle(
  url: string,
  language: string,
  sourceDir: string,
): Promise<string> {
  await fs.promises.mkdir(sourceDir, { recursive: true });
  const template = path.join(sourceDir, "subtitle.%(ext)s");
  await runYtDlp([
    "--skip-download",
    "--write-sub",
    "--write-auto-sub",
    "--sub-langs",
    language,
    "--sub-format",
    "vtt",
    "--output",
    template,
    "--no-warnings",
    url,
  ]);
  const entries = await fs.promises.readdir(sourceDir);
  const candidates = entries
    .filter(f => f.startsWith("subtitle") && f.endsWith(".vtt"))
    .sort()
    .map(f => path.join(sourceDir, f));
  if (!candidates.length) {
    throw new IngestError(`yt-dlp did not produce a VTT subtitle for ${language}`);
  }
  return candidates[0];
}

export async function downloadAudio(
  url: string,
  sourceDir: string,
): Promise<string> {
  await fs.promises.mkdir(sourceDir, { recursive: true });
  const template = path.join(sourceDir, "audio.%(ext)s");
  const output = await runYtDlp([
    "--format",
    "bestaudio/best",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5",
    "--output",
    template,
    "--print",
    "after_move:filepath",
    "--no-warnings",
    url,
  ]);
  const reportedPaths = output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  for (let i = reportedPaths.length - 1; i >= 0; i--) {
    if (fs.existsSync(reportedPaths[i])) {
      return reportedPaths[i];
    }
  }
  const entries = await fs.promises.readdir(sourceDir);
  const candidates = entries
    .filter(f => f.startsWith("audio."))
    .sort()
    .map(f => path.join(sourceDir, f));
  if (!candidates.length) {
    throw new IngestError("yt-dlp did not produce an audio file");
  }
  return candidates[0];
}

export const download_subtitle = downloadSubtitle;
export const download_audio = downloadAudio;
