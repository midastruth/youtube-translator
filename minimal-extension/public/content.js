/* YouTube Subtitle Translator — Content Script */

const SUBTITLE_CONTAINER_ID = "yt-backend-subtitle-overlay";
const DEFAULT_BACKEND = "http://localhost:8787";

let videoEl = null, subtitles = [], currentIndex = -1;
let observer = null, settings = {};

// ── defaults ──────────────────────────────────────────────

const DEFAULTS = {
  backendUrl: DEFAULT_BACKEND,
  languages: "en,zh-Hans,zh-Hant,zh",
  toLang: "zh-CN",
  segmentation: "rule",
  translateApiKey: "",
  translateBaseUrl: "",
  translateModel: "",
  translateWhole: false,
  autoTranslate: true,
  // display
  isBilingual: true,
  fontSizeOrig: 22,
  fontSizeTran: 18,
  positionY: 12,  // % from bottom
  origColor: "#ffffff",
  tranColor: "#ffff00",
};

// ── CSS injection ──────────────────────────────────────────

const styleEl = document.createElement("style");
styleEl.id = "yts-dynamic-style";
document.head.appendChild(styleEl);

function updateStyle() {
  const s = settings;
  styleEl.textContent = `
    #${SUBTITLE_CONTAINER_ID} {
      position: absolute;
      bottom: ${s.positionY || 12}%;
      left: 50%;
      transform: translateX(-50%);
      text-align: center;
      z-index: 99;
      pointer-events: auto;
      max-width: 85%;
      cursor: grab;
      user-select: none;
    }
    #${SUBTITLE_CONTAINER_ID}.dragging { cursor: grabbing; }
    #${SUBTITLE_CONTAINER_ID} .cue {
      display: none;
      margin-bottom: 2px;
      line-height: 1.4;
      text-shadow: 1px 1px 2px #000;
      pointer-events: none;
    }
    #${SUBTITLE_CONTAINER_ID} .orig {
      color: ${s.origColor || "#fff"};
      font-size: ${s.fontSizeOrig || 22}px;
      font-weight: 600;
    }
    #${SUBTITLE_CONTAINER_ID} .tran {
      color: ${s.tranColor || "#ff0"};
      font-size: ${s.fontSizeTran || 18}px;
      font-weight: 500;
    }
  `;
}

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

// ── DOM / Overlay ──────────────────────────────────────────

function createOverlay() {
  let el = document.getElementById(SUBTITLE_CONTAINER_ID);
  if (el) return el;

  el = document.createElement("div");
  el.id = SUBTITLE_CONTAINER_ID;

  const orig = document.createElement("div");
  orig.className = "cue orig";
  const tran = document.createElement("div");
  tran.className = "cue tran";
  el.appendChild(orig);
  el.appendChild(tran);

  const mount = document.querySelector("#movie_player .html5-video-container");
  if (mount) mount.appendChild(el);

  enableDrag(el);
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
    if (settings.isBilingual !== false && sub.translation) {
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

function findSubtitleIndex(ms) {
  let lo = 0, hi = subtitles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const s = subtitles[mid];
    if (ms >= s.start && ms <= s.end) return mid;
    if (ms < s.start) hi = mid - 1;
    else lo = mid + 1;
  }
  return -1;
}

// ── Drag to reposition ─────────────────────────────────────

function enableDrag(el) {
  let isDragging = false, startY = 0, initialBottom = 0;
  const container = () => el.parentElement;

  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging = true;
    el.classList.add("dragging");
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const parentRect = container().getBoundingClientRect();
    initialBottom = parentRect.bottom - rect.bottom;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const deltaY = startY - e.clientY;
    let newBottom = initialBottom + deltaY;
    const parentH = container().clientHeight;
    const elH = el.offsetHeight;
    newBottom = Math.max(0, Math.min(parentH - elH, newBottom));
    const pct = ((newBottom / parentH) * 100);
    settings.positionY = Math.round(pct);
    el.style.bottom = settings.positionY + "%";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove("dragging");
    // persist position
    chrome.storage.local.get(["ytsSettings"], (data) => {
      const s = data.ytsSettings || {};
      s.positionY = settings.positionY;
      chrome.storage.local.set({ ytsSettings: s });
    });
  });
}

// ── main logic ─────────────────────────────────────────────

async function processVideo(pageUrl) {
  createOverlay();

  try {
    const tracksResp = await fetch(
      `${settings.backendUrl || DEFAULT_BACKEND}/api/subtitle/tracks?url=${encodeURIComponent(pageUrl)}`
    ).then(r => r.json());

    if (!tracksResp.tracks?.length) {
      console.log("[YTS] No subtitle tracks");
      return;
    }

    const langs = (settings.languages || "en,zh-Hans,zh-Hant,zh").split(",").map(s => s.trim());
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

    console.log(`[YTS] Loaded ${subtitles.length} cues → ${resp.to_lang || "none"}`);
  } catch (err) {
    console.error("[YTS] Failed:", err);
  }
}

// ── VTT download ───────────────────────────────────────────

function downloadVtt() {
  if (!subtitles.length) return;
  const lines = ["WEBVTT", ""];
  subtitles.forEach((sub, i) => {
    const start = msToVtt(sub.start);
    const end = msToVtt(sub.end);
    lines.push(`${i + 1}`, `${start} --> ${end}`, sub.text);
    if (sub.translation) lines.push(sub.translation);
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/vtt;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `subtitles_${Date.now()}.vtt`;
  a.click();
  URL.revokeObjectURL(url);
}

function msToVtt(ms) {
  const s = ms / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`
    : `${String(m).padStart(2, "0")}:${sec}`;
}

// ── video events ───────────────────────────────────────────

function attachTimeUpdate() {
  videoEl?.removeEventListener("timeupdate", onTimeUpdate);
  videoEl?.addEventListener("timeupdate", onTimeUpdate);
}

function onTimeUpdate() {
  if (!videoEl) return;
  const idx = findSubtitleIndex(videoEl.currentTime * 1000);
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
    const vid = getVideoId();
    if (vid) processVideo(`https://www.youtube.com/watch?v=${vid}`);
  }
}

function getVideoId() {
  try { return new URL(location.href).searchParams.get("v") || ""; }
  catch { return ""; }
}

// ── message listener (VTT from popup, toggle bilingual) ─────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "downloadVtt") {
    downloadVtt();
    sendResponse({ ok: true });
  } else if (msg.action === "toggleBilingual") {
    settings.isBilingual = !settings.isBilingual;
    updateOverlay();
    sendResponse({ isBilingual: settings.isBilingual });
  } else if (msg.action === "getSubtitles") {
    sendResponse({ count: subtitles.length });
  }
});

// ── init ───────────────────────────────────────────────────

chrome.storage.local.get(["ytsSettings"], (data) => {
  settings = { ...DEFAULTS, ...(data.ytsSettings || {}) };
  updateStyle();
  findVideo();

  observer = new MutationObserver(() => findVideo());
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("yt-navigate-finish", () => {
    subtitles = [];
    currentIndex = -1;
    updateOverlay();
    setTimeout(findVideo, 1000);
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.ytsSettings) {
    settings = { ...DEFAULTS, ...(changes.ytsSettings.newValue || {}) };
    updateStyle();
    subtitles = [];
    currentIndex = -1;
    updateOverlay();
    findVideo();
  }
});
