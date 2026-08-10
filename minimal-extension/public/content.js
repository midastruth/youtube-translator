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
  translateWhole: false, autoTranslate: true,
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

chrome.storage.local.get(["ytsSettings"], d => {
  settings = { ...DEF, ...(d.ytsSettings||{}) };
  syncStyle(); findV();

  observer = new MutationObserver(() => findV());
  observer.observe(document.body, { childList:true, subtree:true });

  window.addEventListener("yt-navigate-finish", () => {
    subtitles = []; ci = -1; refresh();
    setTimeout(findV, 1000);
  });
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.ytsSettings) {
    settings = { ...DEF, ...(changes.ytsSettings.newValue||{}) };
    syncStyle(); subtitles = []; ci = -1; refresh(); findV();
  }
});
