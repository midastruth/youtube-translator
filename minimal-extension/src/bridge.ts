/* Capture YouTube's own timed-text response before yt-dlp needs to access it.
 * This runs in the page's MAIN world. It is a fallback for servers whose IP is
 * challenged by YouTube; no cookies or credentials leave the browser.
 *
 * Protocol (details are JSON strings so they cross Chrome/Firefox worlds):
 *   content.js → bridge: "yts-request-subtitles" {videoId, languages}
 *   bridge → content.js: "yts-browser-subtitles" {videoId, title, language, events?, cues?}
 */
import { normalizeJson3, record } from "./types.js";
import type { BrowserSubtitles, SubtitlePayload, CaptionTrack, PlayerResponse } from "./types.js";

(() => {
  const EVENT = "yts-browser-subtitles";
  const REQUEST = "yts-request-subtitles";
  const POLL_INTERVAL_MS = 500;
  const POLL_ATTEMPTS = 30;
  const MAX_CAPTURED = 5;

  let languages = ["en", "zh-Hans", "zh-Hant", "zh"];
  // videoId -> { detail, rank, direct }
  const captured = new Map<string, { detail: BrowserSubtitles; rank: number; direct: boolean }>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollVideoId = "";

  const originalFetch = window.fetch;

  const currentVideoId = () => {
    try { return new URL(location.href).searchParams.get("v") || ""; } catch { return ""; }
  };

  const langRank = (code: string | undefined) => {
    const value = String(code || "").toLowerCase();
    if (!value || value === "auto") return languages.length + 1;
    const exact = languages.findIndex(l => l.toLowerCase() === value);
    if (exact >= 0) return exact;
    const prefix = value.split("-")[0];
    const related = languages.findIndex(l => l.toLowerCase().split("-")[0] === prefix);
    return related >= 0 ? related : languages.length;
  };

  const emit = (detail: BrowserSubtitles) => {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(detail) }));
  };

  /** Keep the best-ranked capture per video; announce it if it is current. */
  const store = (videoId: string, language: string, payload: SubtitlePayload, direct = false) => {
    if (!videoId) return;
    const hasEvents = payload.events?.length;
    const hasCues = payload.cues?.length;
    if (!hasEvents && !hasCues) return;

    const rank = langRank(language);
    const previous = captured.get(videoId);
    if (previous && previous.rank <= rank) {
      if (direct) previous.direct = true;
      return;
    }
    const detail = {
      videoId,
      title: videoId === currentVideoId() ? document.title.replace(/ - YouTube$/, "") : "",
      language: language || "auto",
      ...payload,
    };
    captured.delete(videoId);
    captured.set(videoId, { detail, rank, direct: direct || previous?.direct || false });
    while (captured.size > MAX_CAPTURED) captured.delete(captured.keys().next().value!);
    if (videoId === currentVideoId()) emit(detail);
  };

  // ── parsing ─────────────────────────────────────────────

  /** Keep json3 events intact so the backend can use word-level timings. */
  const json3Events = normalizeJson3;

  const xmlCues = (value: string) => {
    const doc = new DOMParser().parseFromString(value, "text/xml");
    return [...doc.querySelectorAll("text")].map(node => {
      const start = Number(node.getAttribute("start"));
      const dur = Number(node.getAttribute("dur") || 0);
      return {
        start: start * 1000,
        end: (start + dur) * 1000,
        text: (node.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }).filter(c => Number.isFinite(c.start) && c.end > c.start && c.text);
  };

  const parseRaw = (raw: string): SubtitlePayload | null => {
    const text = String(raw || "").trim();
    if (text.startsWith("{")) {
      try {
        const events = json3Events(JSON.parse(text));
        if (events.length) return { events };
      } catch { /* fall through */ }
    }
    if (text.startsWith("<")) {
      const cues = xmlCues(text);
      if (cues.length) return { cues };
    }
    return null;
  };

  /** Only original-language timedtext responses; skip YouTube auto-translations. */
  const captionInfo = (url: string) => {
    try {
      const parsed = new URL(url, location.href);
      if (!/\/api\/timedtext/i.test(parsed.pathname)) return null;
      if (parsed.searchParams.get("tlang")) return null;
      return {
        videoId: parsed.searchParams.get("v") || "",
        language: parsed.searchParams.get("lang") || "auto",
      };
    } catch {
      return null;
    }
  };

  const handleRaw = (raw: string, url: string, direct = false) => {
    const info = captionInfo(url);
    if (!info?.videoId) return false;
    const payload = parseRaw(raw);
    if (!payload) return false;
    store(info.videoId, info.language, payload, direct);
    return true;
  };

  // ── passive interception ────────────────────────────────

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0] || "");
      if (captionInfo(url)) {
        response.clone().text().then(raw => { handleRaw(raw, url); }).catch(() => {});
      }
    } catch { /* never break the page's fetch */ }
    return response;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    this.__ytsCaptionUrl = String(url || "");
    return open.call(this, method, url, async, username, password);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (captionInfo(this.__ytsCaptionUrl || "")) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType && this.responseType !== "text") return;
          handleRaw(this.responseText, this.__ytsCaptionUrl || "");
        } catch { /* ignore */ }
      });
    }
    return send.apply(this, args);
  };

  // ── active fetch from the current player response ───────

  /** ytInitialPlayerResponse is stale after SPA navigation; prefer the player. */
  const playerResponse = (videoId: string) => {
    const candidates: (PlayerResponse | undefined)[] = [];
    try { candidates.push(document.getElementById("movie_player")?.getPlayerResponse?.()); } catch {}
    candidates.push(window.ytInitialPlayerResponse);
    return candidates.find(r => r?.videoDetails?.videoId === videoId) || null;
  };

  const pickTrack = (tracks: CaptionTrack[]) => {
    const usable = tracks.filter(t => t?.baseUrl);
    if (!usable.length) return null;
    // Manual tracks before ASR; then user language priority.
    return [...usable].sort((a, b) => (
      Number(a.kind === "asr") - Number(b.kind === "asr")
      || langRank(a.languageCode) - langRank(b.languageCode)
    ))[0];
  };

  const fetchPlayerTrack = async (videoId: string) => {
    const response = playerResponse(videoId);
    if (!response) return false;
    const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = pickTrack(tracks);
    if (!track) return true; // player loaded, video simply has no captions
    try {
      const url = new URL(track.baseUrl, location.href);
      url.searchParams.set("fmt", "json3");
      const r = await originalFetch(url.toString(), { credentials: "include" });
      if (!r.ok) return false;
      const raw = await r.text();
      // baseUrl may lack v=; attribute the result to the requested video.
      if (!url.searchParams.get("v")) url.searchParams.set("v", videoId);
      if (!url.searchParams.get("lang")) url.searchParams.set("lang", track.languageCode || "auto");
      return handleRaw(raw, url.toString(), true);
    } catch {
      // YouTube may require a PO token for direct requests; the player's
      // own request can still be captured by the interception above.
      return false;
    }
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pollVideoId = "";
  };

  const startPolling = (videoId: string) => {
    const existing = captured.get(videoId);
    if (existing) emit(existing.detail);
    if (existing?.direct) return;
    if (pollTimer && pollVideoId === videoId) return;
    stopPolling();
    pollVideoId = videoId;
    let attempts = 0;
    let inFlight = false;
    pollTimer = setInterval(async () => {
      if (currentVideoId() !== videoId || ++attempts > POLL_ATTEMPTS) {
        stopPolling();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        if (await fetchPlayerTrack(videoId)) stopPolling();
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);
  };

  window.addEventListener(REQUEST, (event) => {
    let detail = event.detail;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch { return; }
    }
    if (!record(detail)) return;
    if (Array.isArray(detail.languages) && detail.languages.length) {
      languages = detail.languages.map(String);
    }
    const videoId = String(detail?.videoId || "");
    if (videoId && videoId === currentVideoId()) startPolling(videoId);
  });

  window.addEventListener("yt-navigate-start", stopPolling);
})();
