/* YouTube Subtitle Translator — Content Script
 * 
 * Watches for YouTube video, fetches bilingual subtitles from backend,
 * renders them as an overlay on the player.
 */

// ── config ────────────────────────────────────────────────

const DEFAULT_BACKEND = "http://localhost:8787";
const SUBTITLE_CONTAINER_ID = "yt-backend-subtitle-overlay";

let videoEl = null;
let subtitles = [];
let currentIndex = -1;
let fromLang = "";
let observer = null;
let settings = {};

// ── CSS ────────────────────────────────────────────────────

const style = document.createElement("style");
style.textContent = `
  #${SUBTITLE_CONTAINER_ID} {
    position: absolute;
    bottom: 12%;
    left: 50%;
    transform: translateX(-50%);
    text-align: center;
    z-index: 99;
    pointer-events: none;
    max-width: 80%;
  }
  #${SUBTITLE_CONTAINER_ID} .cue {
    display: none;
    margin-bottom: 4px;
    line-height: 1.4;
    text-shadow: 1px 1px 2px #000;
  }
  #${SUBTITLE_CONTAINER_ID} .orig {
    color: #fff;
    font-size: clamp(0.8rem, 2.2cqw, 1.6rem);
  }
  #${SUBTITLE_CONTAINER_ID} .tran {
    color: #ff0;
    font-size: clamp(0.7rem, 1.9cqw, 1.4rem);
  }
`;
document.head.appendChild(style);

// ── API ────────────────────────────────────────────────────

async function apiPost(path, body) {
  const url = `${settings.backendUrl || DEFAULT_BACKEND}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Backend ${resp.status}`);
  return resp.json();
}

// ── DOM ────────────────────────────────────────────────────

function createOverlay() {
  let el = document.getElementById(SUBTITLE_CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = SUBTITLE_CONTAINER_ID;

    const orig = document.createElement("div");
    orig.className = "cue orig";
    const tran = document.createElement("div");
    tran.className = "cue tran";
    el.appendChild(orig);
    el.appendChild(tran);

    // Attach to player container
    const mount = document.querySelector("#movie_player .html5-video-container");
    if (mount) mount.appendChild(el);
  }
  return el;
}

function updateOverlay() {
  const el = document.getElementById(SUBTITLE_CONTAINER_ID);
  if (!el) return;

  const origEl = el.querySelector(".orig");
  const tranEl = el.querySelector(".tran");

  if (currentIndex >= 0 && subtitles[currentIndex]) {
    const sub = subtitles[currentIndex];
    origEl.textContent = sub.text;
    origEl.style.display = "block";
    if (sub.translation) {
      tranEl.textContent = sub.translation;
      tranEl.style.display = "block";
    } else {
      tranEl.style.display = "none";
    }
  } else {
    origEl.style.display = "none";
    tranEl.style.display = "none";
  }
}

function findSubtitleIndex(timeMs) {
  let lo = 0, hi = subtitles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sub = subtitles[mid];
    if (timeMs >= sub.start && timeMs <= sub.end) return mid;
    if (timeMs < sub.start) hi = mid - 1;
    else lo = mid + 1;
  }
  return -1;
}

// ── main logic ─────────────────────────────────────────────

async function processVideo(pageUrl) {
  createOverlay();

  try {
    // 1. get tracks
    const tracksResp = await fetch(
      `${settings.backendUrl || DEFAULT_BACKEND}/api/subtitle/tracks?url=${encodeURIComponent(pageUrl)}`
    ).then(r => r.json());

    if (!tracksResp.tracks?.length) {
      console.log("[YTS] No subtitle tracks");
      return;
    }

    // 2. pick best track
    const langs = settings.languages || ["en", "zh-Hans", "zh-Hant", "zh"];
    let track = null;
    for (const src of ["manual", "automatic"]) {
      for (const lang of langs) {
        const prefix = lang.split("-")[0].toLowerCase();
        track = tracksResp.tracks.find(
          t => t.source === src && t.language.toLowerCase().startsWith(prefix)
        );
        if (track) break;
      }
      if (track) break;
    }
    if (!track) track = tracksResp.tracks[0];
    if (!track) return;

    console.log(`[YTS] Using track: ${track.language} (${track.source})`);

    // 3. process
    const body = {
      url: pageUrl,
      language: track.language,
      languages: [track.language],
      allow_automatic: true,
      segmentation: settings.segmentation || "rule",
    };

    if (settings.autoTranslate !== false && settings.toLang) {
      body.translate_to = settings.toLang;
      body.translate_provider = "openai";
      if (settings.translateApiKey) body.translate_api_key = settings.translateApiKey;
      if (settings.translateBaseUrl) body.translate_base_url = settings.translateBaseUrl;
      if (settings.translateModel) body.translate_model = settings.translateModel;
      if (settings.translateWhole) body.translate_whole = true;
    }

    const resp = await apiPost("/api/subtitle/process", body);
    subtitles = (resp.cues || []).map(c => ({
      start: c.start,
      end: c.end,
      text: c.text,
      translation: c.translation || "",
    }));
    fromLang = resp.from_lang;

    console.log(`[YTS] Loaded ${subtitles.length} cues from ${fromLang} → ${resp.to_lang || "none"}`);
  } catch (err) {
    console.error("[YTS] Failed:", err);
  }
}

function attachTimeUpdate() {
  videoEl.removeEventListener("timeupdate", onTimeUpdate);
  videoEl.addEventListener("timeupdate", onTimeUpdate);
}

function onTimeUpdate() {
  const timeMs = videoEl.currentTime * 1000;
  const idx = findSubtitleIndex(timeMs);
  if (idx !== currentIndex) {
    currentIndex = idx;
    updateOverlay();
  }
}

function findVideo() {
  const v = document.querySelector("video");
  if (v && v !== videoEl) {
    videoEl = v;
    attachTimeUpdate();
    const pageUrl = `https://www.youtube.com/watch?v${getVideoId()}`;
    processVideo(pageUrl);
  }
}

function getVideoId() {
  try {
    return new URL(location.href).searchParams.get("v") || "";
  } catch { return ""; }
}

// ── init ───────────────────────────────────────────────────

chrome.storage.local.get(["ytsSettings"], (data) => {
  settings = data.ytsSettings || {};
  findVideo();

  // watch for video element
  observer = new MutationObserver(() => {
    findVideo();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // YouTube SPA navigation
  window.addEventListener("yt-navigate-finish", () => {
    subtitles = [];
    currentIndex = -1;
    updateOverlay();
    setTimeout(findVideo, 1000);
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.ytsSettings) {
    settings = changes.ytsSettings.newValue || {};
    subtitles = [];
    currentIndex = -1;
    findVideo();
  }
});
