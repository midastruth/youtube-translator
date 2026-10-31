import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildYtDlpCommand,
  chooseSubtitle,
  IngestError,
  vttToText,
} from "../server/src/youtube.js";

describe("buildYtDlpCommand", () => {
  it("keeps YouTube extraction helpers optional by default", () => {
    const originalClient = process.env.YTDLP_YOUTUBE_CLIENT;
    const originalPot = process.env.YTDLP_POT_PROVIDER_URL;
    const originalCookies = process.env.YTDLP_COOKIES_FILE;
    delete process.env.YTDLP_YOUTUBE_CLIENT;
    delete process.env.YTDLP_POT_PROVIDER_URL;
    delete process.env.YTDLP_COOKIES_FILE;

    try {
      const { cmd, args } = buildYtDlpCommand(["--version"]);
      assert.equal(cmd, "yt-dlp");
      assert.deepEqual(args, ["--version"]);
      assert.ok(!args.includes("--extractor-args"));
    } finally {
      if (originalClient !== undefined) process.env.YTDLP_YOUTUBE_CLIENT = originalClient;
      if (originalPot !== undefined) process.env.YTDLP_POT_PROVIDER_URL = originalPot;
      if (originalCookies !== undefined) process.env.YTDLP_COOKIES_FILE = originalCookies;
    }
  });

  it("adds client and PO token provider helpers when environment variables are set", () => {
    const originalClient = process.env.YTDLP_YOUTUBE_CLIENT;
    const originalPot = process.env.YTDLP_POT_PROVIDER_URL;
    const originalCookies = process.env.YTDLP_COOKIES_FILE;

    process.env.YTDLP_YOUTUBE_CLIENT = "android,mweb";
    process.env.YTDLP_POT_PROVIDER_URL = "http://pot-provider:4416/";
    delete process.env.YTDLP_COOKIES_FILE;

    try {
      const { args } = buildYtDlpCommand(["--version"]);
      assert.ok(args.includes("youtube:player_client=android,mweb"));
      assert.ok(args.includes("youtubepot-bgutilhttp:base_url=http://pot-provider:4416"));
      assert.equal(args[args.length - 1], "--version");
    } finally {
      if (originalClient !== undefined) process.env.YTDLP_YOUTUBE_CLIENT = originalClient;
      else delete process.env.YTDLP_YOUTUBE_CLIENT;
      if (originalPot !== undefined) process.env.YTDLP_POT_PROVIDER_URL = originalPot;
      else delete process.env.YTDLP_POT_PROVIDER_URL;
      if (originalCookies !== undefined) process.env.YTDLP_COOKIES_FILE = originalCookies;
    }
  });

  it("adds cookies file to command when YTDLP_COOKIES_FILE is set", () => {
    const originalCookies = process.env.YTDLP_COOKIES_FILE;
    process.env.YTDLP_COOKIES_FILE = "/run/secrets/youtube-cookies.txt";

    try {
      const { args } = buildYtDlpCommand(["--version"]);
      assert.ok(args.includes("--cookies"));
      assert.ok(args.includes("/run/secrets/youtube-cookies.txt"));
    } finally {
      if (originalCookies !== undefined) process.env.YTDLP_COOKIES_FILE = originalCookies;
      else delete process.env.YTDLP_COOKIES_FILE;
    }
  });
});

describe("chooseSubtitle", () => {
  it("prefers manual subtitles over automatic ones", () => {
    const metadata = {
      subtitles: { en: [{ name: "English" }] },
      automatic_captions: { "zh-Hans": [{ name: "Chinese" }] },
    };
    const track = chooseSubtitle(metadata, ["zh", "en"]);
    assert.ok(track);
    assert.equal(track.language, "en");
    assert.equal(track.source, "manual");
    assert.equal(track.label, "English");

    // Tuple destructuring compatibility
    const [lang, source] = track as any;
    assert.equal(lang, "en");
    assert.equal(source, "manual");
  });

  it("supports language prefix matching", () => {
    const metadata = {
      subtitles: { "zh-Hant-TW": [{ name: "Traditional Chinese" }] },
    };
    const track = chooseSubtitle(metadata, ["zh-Hant"]);
    assert.ok(track);
    assert.equal(track.language, "zh-Hant-TW");
    assert.equal(track.source, "manual");
  });

  it("falls back to automatic captions when allowed", () => {
    const metadata = {
      automatic_captions: { ja: [{ name: "Japanese (auto)" }] },
    };
    const track = chooseSubtitle(metadata, ["ja"], true);
    assert.ok(track);
    assert.equal(track.language, "ja");
    assert.equal(track.source, "automatic");
  });

  it("returns null when no matching subtitle track is available", () => {
    const metadata = {
      subtitles: { fr: [{}] },
      automatic_captions: { de: [{}] },
    };
    assert.equal(chooseSubtitle(metadata, ["es"]), null);
    assert.equal(chooseSubtitle(metadata, ["de"], false), null);
    assert.equal(chooseSubtitle(null, ["en"]), null);
  });
});

describe("vttToText", () => {
  const sampleVtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
Hello

00:00:01.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:03.000
<c>Next &amp; final</c>

00:00:03.000 --> 00:00:04.000
1984
`;

  it("cleans VTT and collapses rolling cues from string content", () => {
    const text = vttToText(sampleVtt);
    assert.equal(text, "Hello world\nNext & final\n1984\n");
  });

  it("cleans VTT and collapses rolling cues from file path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vtt-test-"));
    const filePath = path.join(tmpDir, "sample.vtt");
    try {
      fs.writeFileSync(filePath, sampleVtt, "utf-8");
      const text = vttToText(filePath);
      assert.equal(text, "Hello world\nNext & final\n1984\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty string for empty input", () => {
    assert.equal(vttToText(""), "");
    assert.equal(vttToText("WEBVTT\n\n"), "");
  });
});

describe("IngestError", () => {
  it("creates Error with proper name", () => {
    const err = new IngestError("sample error");
    assert.equal(err.name, "IngestError");
    assert.equal(err.message, "sample error");
    assert.ok(err instanceof Error);
  });
});
