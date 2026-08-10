/* YouTube Subtitle Translator — Content Script */

const CID = "yts-overlay";

let videoEl = null, subtitles = [], ci = -1;
let observer = null, settings = {};

const DEF = {
  backendUrl: "http://localhost:8787",
  languages: "en,zh-Hans,zh-Hant,zh",
  toLang: "zh-CN",
  segmentation: "rule",
  translateApiKey: "", translateBaseUrl: "", translateModel: "",
  translateWhole: false, autoTranslate: true, enabled: true,
  // Whisper fallback (no subtitle track → transcribe audio)
  whisperEnabled: false, whisperApiKey: "", whisperBaseUrl: "", whisperModel: "", whisperLanguage: "",
  // display
  isBilingual: true,
  fontSizeOrig: 22, fontSizeTran: 18,
  positionY: 12, origColor: "#ffffff", tranColor: "#ffff00",
  bgOpacity: 0.6,
};

// ── style ──────────────────────────────────────────────────

const styleEl = document.createElement("style");
styleEl.id = "yts-style";
document.head.appendChild(styleEl);

function syncStyle() {
  const bg = `rgba(0,0,0,${settings.bgOpacity ?? 0.6})`;
  styleEl.textContent = `
    #${CID} { position:absolute; bottom:${settings.positionY||12}%; left:50%; transform:translateX(-50%); text-align:center; z-index:99; pointer-events:auto; max-width:85%; cursor:grab; user-select:none; }
    #${CID}.drag { cursor:grabbing; }
    #${CID} .bg { display:none; padding:6px 14px; border-radius:8px; background:${bg}; }
    #${CID} .orig { display:none; color:${settings.origColor||"#fff"}; font-size:${settings.fontSizeOrig||22}px; font-weight:600; line-height:1.4; text-shadow:1px 1px 2px #000; pointer-events:none; }
    #${CID} .tran { display:none; color:${settings.tranColor||"#ff0"}; font-size:${settings.fontSizeTran||18}px; font-weight:500; line-height:1.4; text-shadow:1px 1px 2px #000; pointer-events:none; }
  `;
}

// ── API ────────────────────────────────────────────────────

async function apiPost(path, body) {
  const url = `${settings.backendUrl || DEF.backendUrl}${path}`;
  const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`Backend ${r.status}`);
  return r.json();
}

// ── overlay ────────────────────────────────────────────────

function overlay() {
  let el = document.getElementById(CID);
  if (!el) {
    el = document.createElement("div"); el.id = CID;
    const bg = document.createElement("div"); bg.className = "bg";
    const orig = document.createElement("div"); orig.className = "orig";
    const tran = document.createElement("div"); tran.className = "tran";
    bg.appendChild(orig); bg.appendChild(tran);
    el.appendChild(bg);
    const m = document.querySelector("#movie_player .html5-video-container");
    if (m) m.appendChild(el);
    drag(el);
  }
  return el;
}

function refresh() {
  const bg = document.querySelector(`#${CID} .bg`);
  const orig = document.querySelector(`#${CID} .orig`);
  const tran = document.querySelector(`#${CID} .tran`);
  if (!orig || !tran || !bg) return;

  if (ci >= 0 && subtitles[ci]) {
    const s = subtitles[ci];
    orig.textContent = s.text;
    orig.style.display = "block";
    const hasTr = s.translation && settings.isBilingual !== false;
    tran.textContent = hasTr ? s.translation : "";
    tran.style.display = hasTr ? "block" : "none";
    bg.style.display = "block";
  } else {
    bg.style.display = "none";
  }
}

// ── drag ───────────────────────────────────────────────────

function drag(el) {
  let down = false, sy = 0, ib = 0;
  const ct = () => el.parentElement;

  el.addEventListener("mousedown", e => {
    if (e.button !== 0) return; e.preventDefault();
    down = true; el.classList.add("drag");
    sy = e.clientY;
    ib = ct().getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  });
  document.addEventListener("mousemove", e => {
    if (!down) return;
    let nb = ib + (sy - e.clientY);
    const ph = ct().clientHeight;
    nb = Math.max(0, Math.min(ph - el.offsetHeight, nb));
    settings.positionY = Math.round((nb / ph) * 100);
    el.style.bottom = settings.positionY + "%";
  });
  document.addEventListener("mouseup", () => {
    if (!down) return; down = false; el.classList.remove("drag");
    chrome.storage.local.get(["ytsSettings"], d => {
      const s = d.ytsSettings || {};
      s.positionY = settings.positionY;
      chrome.storage.local.set({ ytsSettings: s });
    });
  });
}

// ── subtitle index ─────────────────────────────────────────

function idxOf(ms) {
  let lo = 0, hi = subtitles.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >>> 1, s = subtitles[m];
    if (ms >= s.start && ms <= s.end) return m;
    if (ms < s.start) hi = m - 1; else lo = m + 1;
  }
  return -1;
}

// ── load ───────────────────────────────────────────────────

async function load(pageUrl) {
  overlay();
  try {
    const tr = await fetch(
      `${settings.backendUrl||DEF.backendUrl}/api/subtitle/tracks?url=${encodeURIComponent(pageUrl)}`
    ).then(r => r.json());
    if (!tr.tracks?.length) return;

    let track = null;
    const langs = (settings.languages||DEF.languages).split(",").map(s=>s.trim());
    for (const src of ["manual","automatic"]) {
      for (const l of langs) {
        const p = l.split("-")[0].toLowerCase();
        track = tr.tracks.find(t => t.source===src && t.language.toLowerCase().startsWith(p));
        if (track) break;
      }
      if (track) break;
    }
    if (!track) track = tr.tracks[0];
    if (!track) return;

    const body = {
      url: pageUrl, language: track.language,
      languages: [track.language], allow_automatic: true,
      segmentation: settings.segmentation||"rule",
    };
    if (settings.autoTranslate !== false && settings.toLang) {
      body.translate_to = settings.toLang;
      body.translate_provider = "openai";
      if (settings.translateApiKey) body.translate_api_key = settings.translateApiKey;
      if (settings.translateBaseUrl) body.translate_base_url = settings.translateBaseUrl;
      if (settings.translateModel) body.translate_model = settings.translateModel;
      if (settings.translateWhole) body.translate_whole = true;
    }

    if (settings.whisperEnabled) {
      body.whisper_enabled = true;
      if (settings.whisperApiKey) body.whisper_api_key = settings.whisperApiKey;
      if (settings.whisperBaseUrl) body.whisper_base_url = settings.whisperBaseUrl;
      if (settings.whisperModel) body.whisper_model = settings.whisperModel;
      if (settings.whisperLanguage) body.whisper_language = settings.whisperLanguage;
    }

    const resp = await apiPost("/api/subtitle/process", body);
    subtitles = (resp.cues||[]).map(c => ({ start:c.start, end:c.end, text:c.text, translation:c.translation||"" }));
  } catch (e) { console.error("[YTS]", e); }
}

// ── events ─────────────────────────────────────────────────

function bindVideo() {
  videoEl?.removeEventListener("timeupdate", tick);
  videoEl?.addEventListener("timeupdate", tick);
}
function tick() {
  if (!videoEl) return;
  const i = idxOf(videoEl.currentTime * 1000);
  if (i !== ci) { ci = i; refresh(); }
}
function findV() {
  if (settings.enabled === false) return;
  const v = document.querySelector("video");
  if (v && v !== videoEl) { videoEl = v; bindVideo(); const vid = videoId(); if (vid) load(`https://www.youtube.com/watch?v=${vid}`); }
}
function videoId() { try { return new URL(location.href).searchParams.get("v")||""; } catch { return ""; } }

// ── download VTT ───────────────────────────────────────────

function downloadVtt() {
  if (!subtitles.length) return;
  const lines = ["WEBVTT",""];
  subtitles.forEach((s,i) => {
    const st = msVtt(s.start), en = msVtt(s.end);
    lines.push(`${i+1}`, `${st} --> ${en}`, s.text);
    if (s.translation) lines.push(s.translation);
    lines.push("");
  });
  const b = new Blob([lines.join("\n")], { type:"text/vtt;charset=utf-8" });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a"); a.href = u; a.download = `subtitles_${Date.now()}.vtt`; a.click();
  URL.revokeObjectURL(u);
}
function msVtt(ms) {
  const s = ms/1000;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = (s%60).toFixed(3).padStart(6,"0");
  return h>0 ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${sec}` : `${String(m).padStart(2,"0")}:${sec}`;
}

// ── messages ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _, send) => {
  if (msg.action === "downloadVtt") { downloadVtt(); send({ok:true}); }
  else if (msg.action === "toggleBilingual") { settings.isBilingual = !settings.isBilingual; refresh(); send({isBilingual:settings.isBilingual}); }
});

// ── boot ───────────────────────────────────────────────────

// Google Translate SVG icons
const ICON_ON = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.401 4.818h-9.927L10.927 0H1.599C.72 0 .002.719.002 1.599v16.275c0 .878.72 1.597 1.597 1.597h10L13.072 24H22.4c.878 0 1.597-.707 1.597-1.572V6.39c0-.865-.72-1.572-1.597-1.572zm-15.66 8.68c-2.07 0-3.75-1.68-3.75-3.75 0-2.07 1.68-3.75 3.75-3.75 1.012 0 1.86.375 2.512.976l-.99.952a2.194 2.194 0 0 0-1.522-.584c-1.305 0-2.363 1.08-2.363 2.409S5.436 12.16 6.74 12.16c1.507 0 2.13-1.08 2.19-1.808l-2.188-.002V9.066h3.51c.05.23.09.457.09.764 0 2.147-1.434 3.669-3.602 3.669zm16.757 8.93c0 .59-.492 1.072-1.097 1.072h-8.875l3.649-4.03h.005l-.74-2.302.006-.005s.568-.488 1.277-1.24c.712.771 1.63 1.699 2.818 2.805l.771-.772c-1.272-1.154-2.204-2.07-2.89-2.805.919-1.087 1.852-2.455 2.049-3.707h2.034v.002h.002v-.94h-4.532v-1.52h-1.471v1.52H14.3l-1.672-5.21.006.022h9.767c.605 0 1.097.48 1.097 1.072v16.038zm-6.484-7.311c-.536.548-.943.873-.943.873l-.008.004-1.46-4.548h4.764c-.307 1.084-.988 2.108-1.651 2.904-1.176-1.392-1.18-1.844-1.18-1.844h-1.222s.05.678 1.7 2.61z" fill="#fff"/></svg>`;
const ICON_OFF = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.401 4.818h-9.927L10.927 0H1.599C.72 0 .002.719.002 1.599v16.275c0 .878.72 1.597 1.597 1.597h10L13.072 24H22.4c.878 0 1.597-.707 1.597-1.572V6.39c0-.865-.72-1.572-1.597-1.572zm-15.66 8.68c-2.07 0-3.75-1.68-3.75-3.75 0-2.07 1.68-3.75 3.75-3.75 1.012 0 1.86.375 2.512.976l-.99.952a2.194 2.194 0 0 0-1.522-.584c-1.305 0-2.363 1.08-2.363 2.409S5.436 12.16 6.74 12.16c1.507 0 2.13-1.08 2.19-1.808l-2.188-.002V9.066h3.51c.05.23.09.457.09.764 0 2.147-1.434 3.669-3.602 3.669zm16.757 8.93c0 .59-.492 1.072-1.097 1.072h-8.875l3.649-4.03h.005l-.74-2.302.006-.005s.568-.488 1.277-1.24c.712.771 1.63 1.699 2.818 2.805l.771-.772c-1.272-1.154-2.204-2.07-2.89-2.805.919-1.087 1.852-2.455 2.049-3.707h2.034v.002h.002v-.94h-4.532v-1.52h-1.471v1.52H14.3l-1.672-5.21.006.022h9.767c.605 0 1.097.48 1.097 1.072v16.038zm-6.484-7.311c-.536.548-.943.873-.943.873l-.008.004-1.46-4.548h4.764c-.307 1.084-.988 2.108-1.651 2.904-1.176-1.392-1.18-1.844-1.18-1.844h-1.222s.05.678 1.7 2.61z" fill="#717171"/></svg>`;

function injectToggle() {
  if (document.getElementById("yts-toggle")) return;
  const target = document.querySelector(".ytp-right-controls");
  if (!target) return;

  // wrap in div like kiss-translator does
  const wrapper = document.createElement("span");
  wrapper.className = "yts-toggle-wrap";
  wrapper.style.cssText = "height:100%;display:inline-block;position:relative";

  const btn = document.createElement("button");
  btn.id = "yts-toggle";
  btn.className = "ytp-button";
  btn.title = "双语字幕翻译";
  btn.setAttribute("aria-label", "双语字幕翻译");
  btn.innerHTML = settings.enabled !== false ? ICON_ON : ICON_OFF;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    settings.enabled = settings.enabled === false ? true : false;
    btn.innerHTML = settings.enabled !== false ? ICON_ON : ICON_OFF;
    btn.title = settings.enabled !== false ? "关闭字幕翻译" : "开启字幕翻译";
    if (settings.enabled === false) {
      subtitles = []; ci = -1; refresh();
      const el = document.getElementById(CID);
      if (el) el.style.display = "none";
    } else {
      const el = document.getElementById(CID);
      if (el) el.style.display = "";
      const vid = videoId();
      if (vid) load(`https://www.youtube.com/watch?v=${vid}`);
    }
    chrome.storage.local.get(["ytsSettings"], d => {
      const s = d.ytsSettings || {};
      s.enabled = settings.enabled;
      chrome.storage.local.set({ ytsSettings: s });
    });
  });

  wrapper.appendChild(btn);
  target.insertBefore(wrapper, target.firstChild);

  // re-inject on toolbar rebuild
  const bar = document.querySelector(".ytp-chrome-bottom");
  if (bar) {
    const mo = new MutationObserver(() => {
      if (!document.getElementById("yts-toggle")) {
        const t = document.querySelector(".ytp-right-controls");
        if (t && !t.querySelector(".yts-toggle-wrap")) {
          t.insertBefore(wrapper, t.firstChild);
        }
      }
    });
    mo.observe(bar, { childList: true, subtree: true });
  }
}

function updateToggleIcon(btn) {
  const on = settings.enabled !== false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="${on ? '#3ea6ff' : '#aaa'}"><path d="M2 3h4l2 4H5l-1 7h2l1 7h13l2-7h-2l-1-7h-3l2-4h4l-2 18H4L2 3z"/><circle cx="12" cy="14" r="4"/></svg>`;
  btn.title = on ? "关闭字幕翻译" : "开启字幕翻译";
}

chrome.storage.local.get(["ytsSettings"], d => {
  settings = { ...DEF, ...(d.ytsSettings||{}) };
  syncStyle(); findV();
  injectToggle();

  observer = new MutationObserver(() => findV());
  observer.observe(document.body, { childList:true, subtree:true });

  window.addEventListener("yt-navigate-finish", () => {
    subtitles = []; ci = -1; refresh();
    setTimeout(() => { injectToggle(); findV(); }, 1000);
  });
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.ytsSettings) {
    settings = { ...DEF, ...(changes.ytsSettings.newValue||{}) };
    syncStyle();
    if (settings.enabled === false) {
      subtitles = []; ci = -1; refresh();
      const el = document.getElementById(CID); if (el) el.style.display = "none";
    } else {
      const el = document.getElementById(CID); if (el) el.style.display = "";
      subtitles = []; ci = -1; refresh(); findV();
    }
  }
});
