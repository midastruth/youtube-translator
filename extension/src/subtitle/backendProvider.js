/**
 * YouTubeBackendProvider — Drop-in backend-driven YouTube subtitle provider
 * for kiss-translator.
 *
 * Instead of intercepting YouTube timedtext XHR requests in-page, this provider
 * delegates subtitle fetching, segmentation, and translation to the
 * youtube-ingest backend service.
 *
 * Usage (inside kiss-translator's subtitle.js or equivalent):
 *
 *   import { YouTubeBackendProvider } from "./backendProvider.js";
 *   const provider = new YouTubeBackendProvider({
 *     backendUrl: "http://localhost:8787",
 *     videoEl: document.querySelector("video"),
 *     setting: {
 *       autoTranslate: true,
 *       segmentation: "statistical",
 *       toLang: "zh-CN",
 *       translateProvider: "openai",
 *       translateApiKey: "sk-...",
 *       isBilingual: true,
 *       originStyle: "color: #fff; font-size: 18px;",
 *       translationStyle: "color: #ff0; font-size: 16px;",
 *     },
 *     // Provide kiss-translator renderer constructors
 *     BilingualSubtitleManager,
 *     YouTubeSubtitleList,
 *     YouTubePlayerUi,
 *   });
 *
 *   await provider.initialize();
 *
 *   // Later:
 *   provider.updateSetting({ segmentation: "rule", toLang: "ja" });
 *   provider.downloadVtt();
 *   provider.destroy();
 */

const DEFAULT_BACKEND_URL = "http://localhost:8787";

export class YouTubeBackendProvider {
  // ── State ──────────────────────────────────────────────────────────
  #setting;
  #backendUrl;
  #subtitles = [];
  #progressedNum = 0;
  #fromLang = "auto";
  #processingVersion = 0;
  #abortController = null;
  #videoEl = null;

  // Renderer instances
  #manager = null;
  #subtitleList = null;
  #playerUi = null;
  #onSubtitleUpdate = null;

  // Kiss-translator constructors (injected at construction time)
  #BilingualSubtitleManager;
  #YouTubeSubtitleList;
  #YouTubePlayerUi;

  /**
   * @param {object} opts
   * @param {string} [opts.backendUrl="http://localhost:8787"]
   * @param {HTMLVideoElement} opts.videoEl
   * @param {object} opts.setting
   * @param {Function} [opts.BilingualSubtitleManager]
   * @param {Function} [opts.YouTubeSubtitleList]
   * @param {Function} [opts.YouTubePlayerUi]
   */
  constructor({
    backendUrl = DEFAULT_BACKEND_URL,
    videoEl,
    setting = {},
    BilingualSubtitleManager,
    YouTubeSubtitleList,
    YouTubePlayerUi,
  } = {}) {
    this.#backendUrl = backendUrl.replace(/\/$/, "");
    this.#videoEl = videoEl;
    this.#setting = {
      autoTranslate: true,
      fromLang: "en",
      toLang: "zh-CN",
      languages: ["en", "zh-Hans", "zh-Hant", "zh"],
      segmentation: "rule",
      translateProvider: "openai",
      isBilingual: true,
      displayOrder: "original-first",
      blurTranslation: false,
      originStyle: "",
      translationStyle: "",
      ...setting,
    };

    this.#BilingualSubtitleManager = BilingualSubtitleManager;
    this.#YouTubeSubtitleList = YouTubeSubtitleList;
    this.#YouTubePlayerUi = YouTubePlayerUi;
  }

  // ── Public accessors ──────────────────────────────────────────────

  get subtitles()   { return this.#subtitles; }
  get progressed()  { return this.#progressedNum; }

  set onSubtitleUpdate(fn) { this.#onSubtitleUpdate = fn; }

  /** Return the current YouTube video ID from the page URL. */
  get #videoId() {
    try {
      const url = new URL(document.location.href);
      return url.pathname === "/watch" ? url.searchParams.get("v") : null;
    } catch {
      return null;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Initialize: fetch tracks, pick best match, process + render. */
  async initialize() {
    const videoId = this.#videoId;
    if (!videoId) {
      console.warn("[YouTubeBackendProvider] No video ID found on page");
      return;
    }

    console.log("[YouTubeBackendProvider] Initializing for video:", videoId);

    try {
      const pageUrl = this.#pageUrl();
      if (!pageUrl) return;

      const tracksResp = await this.#apiGet(
        `/api/subtitle/tracks?url=${encodeURIComponent(pageUrl)}`
      );
      if (!tracksResp?.tracks?.length) {
        console.warn("[YouTubeBackendProvider] No subtitle tracks found");
        return;
      }

      const track = this.#pickTrack(tracksResp.tracks);
      if (!track) {
        console.warn("[YouTubeBackendProvider] No matching track");
        return;
      }

      console.log("[YouTubeBackendProvider] Selected:", track.language, track.source);
      await this.#processTrack(pageUrl, track);
    } catch (err) {
      console.error("[YouTubeBackendProvider] Initialize failed:", err);
    }
  }

  /**
   * Re-process with updated settings (e.g. different segmentation, target language).
   * @param {object} patch - Setting overrides.
   */
  async reprocess(patch = {}) {
    Object.assign(this.#setting, patch);

    const pageUrl = this.#pageUrl();
    if (!pageUrl) return;

    const tracksResp = await this.#apiGet(
      `/api/subtitle/tracks?url=${encodeURIComponent(pageUrl)}`
    );
    if (!tracksResp?.tracks?.length) return;

    const track = this.#pickTrack(tracksResp.tracks);
    if (!track) return;

    this.#processingVersion += 1;
    this.#abortController?.abort();
    this.#abortController = new AbortController();
    this.#subtitles = [];
    this.#progressedNum = 0;

    await this.#processTrack(pageUrl, track);
  }

  /**
   * Update a single setting and optionally trigger reprocess.
   * @param {object} param0
   * @param {string} param0.name
   * @param {*} param0.value
   */
  updateSetting({ name, value }) {
    if (this.#setting[name] === value) return;

    this.#setting[name] = value;

    // Settings that only affect rendering — pass to manager directly
    if (
      name === "isBilingual" ||
      name === "blurTranslation" ||
      name === "displayOrder" ||
      name === "originStyle" ||
      name === "translationStyle"
    ) {
      this.#manager?.updateSetting({ [name]: value });
      return;
    }

    // Settings that require re-processing
    if (
      name === "segmentation" ||
      name === "toLang" ||
      name === "translateProvider" ||
      name === "translateApiKey" ||
      name === "translateBaseUrl" ||
      name === "translateModel"
    ) {
      this.reprocess();
      return;
    }

    // autoTranslate toggle
    if (name === "autoTranslate") {
      if (value) {
        this.reprocess();
      } else {
        this.#manager?.destroy();
        this.#manager = null;
        this.#subtitleList?.destroy();
        this.#subtitleList = null;
      }
      return;
    }
  }

  /** Download dual-language subtitles as WebVTT file. */
  downloadVtt() {
    if (!this.#subtitles.length) {
      console.warn("[YouTubeBackendProvider] No subtitles to download");
      return;
    }
    const vtt = buildBilingualVtt(this.#subtitles);
    const blob = new Blob([vtt], { type: "text/vtt;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kiss-subtitles-${this.#videoId}_${Date.now()}.vtt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  destroy() {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#manager?.destroy();
    this.#manager = null;
    this.#subtitleList?.destroy();
    this.#subtitleList = null;
    this.#playerUi?.destroy?.();
    this.#playerUi = null;
    this.#subtitles = [];
  }

  // ── Internals ────────────────────────────────────────────────────

  #pageUrl() {
    const videoId = this.#videoId;
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
  }

  #pickTrack(tracks) {
    const langs = this.#setting.languages || ["en", "zh-Hans", "zh-Hant", "zh"];
    for (const source of ["manual", "automatic"]) {
      for (const lang of langs) {
        const prefix = lang.split("-")[0].toLowerCase();
        const match = tracks.find(
          (t) =>
            t.source === source &&
            t.language.toLowerCase().startsWith(prefix)
        );
        if (match) return match;
      }
    }
    return tracks[0] || null;
  }

  async #processTrack(pageUrl, track) {
    const version = ++this.#processingVersion;
    this.#abortController?.abort();
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    const body = {
      url: pageUrl,
      language: track.language,
      languages: [track.language],
      allow_automatic: true,
      segmentation: this.#setting.segmentation || "rule",
    };

    const toLang = this.#setting.autoTranslate ? this.#setting.toLang : null;
    if (toLang) {
      body.translate_to = toLang;
      body.translate_provider = this.#setting.translateProvider || "openai";
      if (this.#setting.translateApiKey) body.translate_api_key = this.#setting.translateApiKey;
      if (this.#setting.translateBaseUrl) body.translate_base_url = this.#setting.translateBaseUrl;
      if (this.#setting.translateModel) body.translate_model = this.#setting.translateModel;
    }

    // Use streaming endpoint for faster first-cue display
    const useStream = Boolean(toLang && this.#setting.translateProvider === "openai");

    if (useStream) {
      await this.#processStream(pageUrl, body, version, signal);
    } else {
      await this.#processBulk(pageUrl, body, version, signal);
    }
  }

  /** Streaming SSE path — renders each cue as translation arrives. */
  async #processStream(pageUrl, body, version, signal) {
    const resp = await fetch(`${this.#backendUrl}/api/subtitle/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Backend ${resp.status}: ${await resp.text().catch(() => "")}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // keep incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const event = JSON.parse(jsonStr);
          if (this.#processingVersion !== version) return; // stale

          switch (event.type) {
            case "meta":
              this.#fromLang = event.from_lang;
              break;
            case "cue":
              this.#upsertCue(event);
              break;
            case "cue_chunk":
              // Update an in-progress translation
              this.#upsertCue(event);
              break;
            case "done":
              this.#progressedNum = 100;
              this.#startRendererIfNeeded();
              break;
          }
        } catch { /* ignore parse errors on partial data */ }
      }
    }

    // Flush remaining
    if (buffer.startsWith("data: ")) {
      try {
        const event = JSON.parse(buffer.slice(6).trim());
        if (event.type === "done") {
          this.#progressedNum = 100;
          this.#startRendererIfNeeded();
        }
      } catch { /* ignore */ }
    }
  }

  /** Bulk POST path — faster for rule-based segmentation without translation. */
  async #processBulk(pageUrl, body, version, signal) {
    const resp = await this.#apiPost("/api/subtitle/process", body, signal);
    if (this.#processingVersion !== version) return;

    this.#subtitles = (resp.cues || []).map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: cue.translation || "",
      _isDraftTranslation: !cue.translation,
    }));
    this.#fromLang = resp.from_lang;
    this.#progressedNum = resp.progress || 100;

    if (this.#subtitles.length) {
      this.#startRendererIfNeeded();
    }
  }

  #upsertCue(cue) {
    const key = `${cue.start}:${cue.end}`;
    const existing = this.#subtitles.findIndex(
      (s) => `${s.start}:${s.end}` === key
    );

    const entry = {
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translation: cue.translation || "",
      _isDraftTranslation: cue.type === "cue_chunk",
    };

    if (existing >= 0) {
      this.#subtitles[existing] = entry;
    } else {
      this.#subtitles.push(entry);
    }

    // Keep sorted by start time
    this.#subtitles.sort((a, b) => a.start - b.start);

    // Incrementally show new cues
    if (this.#manager) {
      this.#manager.appendSubtitles([entry]);
      this.#subtitleList?.setBilingualSubtitles(this.#subtitles, this.#progressedNum);
    } else if (this.#subtitles.length >= 2) {
      // Start renderer after we have at least a couple cues
      this.#startRendererIfNeeded();
    }
  }

  #startRendererIfNeeded() {
    if (!this.#subtitles.length) return;
    if (this.#manager) return;
    if (!this.#videoEl) return;

    const CM = this.#BilingualSubtitleManager;
    if (!CM) {
      console.warn("[YouTubeBackendProvider] No BilingualSubtitleManager constructor — skipping renderer");
      return;
    }

    this.#manager = new CM({
      videoEl: this.#videoEl,
      formattedSubtitles: this.#subtitles,
      setting: {
        ...this.#setting,
        fromLang: this.#fromLang,
        apiSetting: this.#setting.apiSetting || {},
        onSubtitleTimeWindow: () => {},
      },
    });

    if (this.#onSubtitleUpdate) {
      this.#manager.onSubtitleUpdate = this.#onSubtitleUpdate;
    }

    this.#manager.start();

    // Also create the subtitle list sidebar
    const List = this.#YouTubeSubtitleList;
    if (List) {
      this.#subtitleList = new List(this.#videoEl, (msg) => msg, {
        enableHoverLookup: false,
        autoFavWord: false,
      });
      this.#subtitleList.initialize(this.#subtitles, this.#subtitles, 100);
      this.#subtitleList.turnOnAutoSub();
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  async #apiGet(path, signal) {
    const resp = await fetch(`${this.#backendUrl}${path}`, { signal });
    if (!resp.ok) {
      throw new Error(`Backend ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    return resp.json();
  }

  async #apiPost(path, body, signal) {
    const resp = await fetch(`${this.#backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Backend ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    return resp.json();
  }
}

// ── VTT builder ──────────────────────────────────────────────────────

function buildBilingualVtt(subtitles) {
  const lines = ["WEBVTT", ""];

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    const start = msToVttTime(sub.start);
    const end = msToVttTime(sub.end);

    lines.push(`${i + 1}`);
    lines.push(`${start} --> ${end}`);
    lines.push(sub.text);
    if (sub.translation) {
      lines.push(sub.translation);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function msToVttTime(ms) {
  const totalSec = ms / 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = s.toFixed(3).padStart(6, "0");
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
  }
  return `${String(m).padStart(2, "0")}:${ss}`;
}

export default YouTubeBackendProvider;
