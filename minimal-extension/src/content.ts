/* YouTube Subtitle Translator — Content Script */
import { parseBrowserSubtitles, displayError } from "./types.js";
import type { ExtensionSettings, StoredSettings, Subtitle, BrowserSubtitles, DisplayError } from "./types.js";
import { exportableSubtitles, formatVtt, subtitleIndexAt, videoIdFromUrl } from "./subtitles.js";
import type { PendingSubtitle } from "./subtitles.js";
import { buildStreamRequest, hasBrowserSubtitles, selectBackendTrack } from "./stream-request.js";
import { apiStream } from "./subtitle-stream.js";

const CID = "yts-overlay";

let videoEl: HTMLVideoElement | null = null, subtitles: PendingSubtitle[] = [], ci = -1;
let observer: MutationObserver | null = null;
let settings: ExtensionSettings;
let loadedVideoId = "", loadGeneration = 0;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let loadAbortController: AbortController | null = null;
let renderFrame: number | null = null;
let browserSubtitleCache: BrowserSubtitles | null = null;

const DEF: ExtensionSettings = {
  backendUrl: "http://localhost:8787",
  languages: "en,zh-Hans,zh-Hant,zh",
  toLang: "zh-CN",
  segmentation: "rule",
  translateEngine: "legacy", translateProvider: "openai",
  translateApiKey: "", translateBaseUrl: "", translateModel: "",
  translateWhole: false, autoTranslate: true, enabled: false,
  // Whisper fallback (no subtitle track → transcribe audio)
  whisperEnabled: false, whisperApiKey: "", whisperBaseUrl: "", whisperModel: "", whisperLanguage: "",
  // display
  isBilingual: true,
  fontSizeOrig: 22, fontSizeTran: 18,
  positionY: 12, origColor: "#ffffff", tranColor: "#ffff00",
  bgOpacity: 0.6,
};

// A stream already retries each failed translation chunk twice on the backend.
// Reconnect a limited number of times so cached successes are kept and only the
// remaining cues are submitted again, without risking an endless retry loop.
const AUTO_RETRY_DELAYS = [3000, 6000];
settings = { ...DEF };

// ── style ──────────────────────────────────────────────────

const styleEl = document.createElement("style");
styleEl.id = "yts-style";
document.head.appendChild(styleEl);

function syncStyle() {
  const bg = `rgba(0,0,0,${settings.bgOpacity ?? 0.6})`;
  styleEl.textContent = `
    #${CID} { --yts-bottom:${settings.positionY ?? 12}%; position:absolute; bottom:var(--yts-bottom); left:50%; transform:translateX(-50%); text-align:center; z-index:59; pointer-events:auto; max-width:85%; cursor:grab; user-select:none; visibility:visible; opacity:1; }
    .html5-video-player:not(.ytp-autohide) > #${CID} { bottom:max(var(--yts-bottom), 64px); }
    .html5-video-player.ytp-fullscreen:not(.ytp-autohide) > #${CID} { bottom:max(var(--yts-bottom), 76px); }
    #${CID}.drag { cursor:grabbing; }
    #${CID} .bg { display:none; padding:6px 14px; border-radius:8px; background:${bg}; }
    #${CID} .orig { display:none; color:${settings.origColor||"#fff"}; font-size:${settings.fontSizeOrig||22}px; font-weight:600; line-height:1.4; text-shadow:1px 1px 2px #000; pointer-events:none; }
    #${CID} .tran { display:none; color:${settings.tranColor||"#ff0"}; font-size:${settings.fontSizeTran||18}px; font-weight:500; line-height:1.4; text-shadow:1px 1px 2px #000; pointer-events:none; }
    #${CID} .status { display:none; margin:0 auto 8px; width:max-content; max-width:80vw; padding:7px 12px; border-radius:6px; background:rgba(0,0,0,.82); color:#fff; font-size:14px; line-height:1.35; text-shadow:none; pointer-events:none; }
    #${CID} .status.success { color:#7ee787; }
    #${CID} .status.error { color:#ff8b8b; }
  `;
  const currentOverlay = document.getElementById(CID);
  if (currentOverlay) {
    currentOverlay.style.setProperty("--yts-bottom", `${settings.positionY ?? 12}%`);
  }
}

// ── API ────────────────────────────────────────────────────

function waitForRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("翻译已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once:true });
  });
}

function cancelActiveLoad() {
  loadGeneration += 1;
  loadAbortController?.abort();
  loadAbortController = null;
}

function hideTranslation() {
  cancelActiveLoad();
  clearStatus();
  subtitles = []; ci = -1; refresh();
  const el = document.getElementById(CID);
  if (el) el.style.display = "none";
}

// bridge.js runs in the page's MAIN world; event details cross worlds as JSON
// strings because object details are not reliably readable across worlds.
const parseBridgeDetail = parseBrowserSubtitles;

function acceptBrowserSubtitles(event: CustomEvent<unknown>) {
  const detail = parseBridgeDetail(event.detail);
  if (!detail?.videoId || detail.videoId !== videoId() || !hasBrowserSubtitles(detail)) return;
  browserSubtitleCache = detail;
}

function requestBrowserSubtitles(id: string, languages: string[]) {
  window.dispatchEvent(new CustomEvent("yts-request-subtitles", {
    detail: JSON.stringify({ videoId: id, languages }),
  }));
}

function waitForBrowserSubtitles(id: string, signal: AbortSignal, timeout = 8000): Promise<BrowserSubtitles | null> {
  if (browserSubtitleCache?.videoId === id) return Promise.resolve(browserSubtitleCache);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: BrowserSubtitles | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      window.removeEventListener("yts-browser-subtitles", onEvent);
      resolve(value || null);
    };
    const onAbort = () => finish(null);
    const onEvent = (event: CustomEvent<unknown>) => {
      const detail = parseBridgeDetail(event.detail);
      if (detail?.videoId === id && hasBrowserSubtitles(detail)) finish(detail);
    };
    timer = setTimeout(() => finish(browserSubtitleCache?.videoId === id ? browserSubtitleCache : null), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("yts-browser-subtitles", onEvent);
  });
}

window.addEventListener("yts-browser-subtitles", acceptBrowserSubtitles);

// ── overlay ────────────────────────────────────────────────

function overlay() {
  let el = document.getElementById(CID);
  if (!el) {
    el = document.createElement("div"); el.id = CID;
    const bg = document.createElement("div"); bg.className = "bg";
    const orig = document.createElement("div"); orig.className = "orig";
    const tran = document.createElement("div"); tran.className = "tran";
    const status = document.createElement("div"); status.className = "status";
    bg.appendChild(orig); bg.appendChild(tran);
    el.appendChild(status);
    el.appendChild(bg);
    drag(el);
  }
  // The player root survives video-container rebuilds and is the same stable
  // positioning context used by YouTube's controls and caption windows.
  const mount = document.querySelector("#movie_player")
    || videoEl?.closest?.(".html5-video-player")
    || videoEl?.closest?.(".html5-video-container");
  if (mount && el.parentElement !== mount) mount.appendChild(el);
  return el;
}

function scheduleRefresh() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    refresh();
  });
}

function setText(element: Element, value: unknown) {
  const text = String(value ?? "");
  if (element.textContent !== text) element.textContent = text;
}

function showStatus(message: string, type = "info", hideAfter = 0) {
  const el = overlay();
  const status = el?.querySelector<HTMLElement>(".status");
  if (!status) return;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  setText(status, message);
  status.className = `status ${type}`;
  status.style.display = "block";
  if (hideAfter > 0) {
    statusTimer = setTimeout(() => {
      status.style.display = "none";
      statusTimer = null;
    }, hideAfter);
  }
}

function clearStatus() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  const status = document.querySelector<HTMLElement>(`#${CID} .status`);
  if (status) status.style.display = "none";
}

function refresh() {
  const root = overlay();
  const bg = root?.querySelector<HTMLElement>(".bg");
  const orig = root?.querySelector<HTMLElement>(".orig");
  const tran = root?.querySelector<HTMLElement>(".tran");
  if (!orig || !tran || !bg) return;

  if (ci >= 0 && subtitles[ci]) {
    const s = subtitles[ci];
    const hasTranslation = Boolean(s.translation);
    const bilingual = settings.isBilingual !== false;
    setText(orig, s.text);
    orig.style.display = bilingual || !hasTranslation ? "block" : "none";
    setText(tran, hasTranslation ? s.translation : "");
    tran.style.display = hasTranslation ? "block" : "none";
    bg.style.display = "block";
  } else {
    bg.style.display = "none";
  }
}

// ── drag ───────────────────────────────────────────────────

function drag(el: HTMLElement) {
  let down = false, sy = 0, ib = 0;
  const ct = () => el.parentElement!;

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
    el.style.setProperty("--yts-bottom", settings.positionY + "%");
  });
  document.addEventListener("mouseup", () => {
    if (!down) return; down = false; el.classList.remove("drag");
    chrome.storage.local.get(["ytsSettings"], (d: StoredSettings) => {
      const s = d.ytsSettings || {};
      s.positionY = settings.positionY;
      chrome.storage.local.set({ ytsSettings: s });
    });
  });
}

// ── subtitle index ─────────────────────────────────────────

function idxOf(ms: number) {
  return subtitleIndexAt(subtitles, ms);
}

// ── load ───────────────────────────────────────────────────

async function load(pageUrl: string) {
  loadAbortController?.abort();
  const controller = new AbortController();
  loadAbortController = controller;
  const generation = ++loadGeneration;
  subtitles = [];
  ci = -1;
  refresh();
  overlay();
  showStatus("正在连接字幕后端…");
  try {
    const baseUrl = (settings.backendUrl || DEF.backendUrl).replace(/\/+$/, "");
    const langs = (settings.languages || DEF.languages)
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const pageVideoId = videoIdFromUrl(pageUrl);
    // Let bridge.js start capturing YouTube's own captions in parallel; they
    // are only used if the backend (yt-dlp) cannot provide a track.
    requestBrowserSubtitles(pageVideoId, langs);
    const params = new URLSearchParams({ url: pageUrl, languages: langs.join(",") });
    const tracksResponse = await fetch(`${baseUrl}/api/subtitle/tracks?${params}`, {
      signal: controller.signal,
    });
    let tr: { tracks: { source: string; language: string }[] } = { tracks: [] };
    let tracksError: Error | null = null;
    if (tracksResponse.ok) {
      tr = await tracksResponse.json();
    } else {
      const error = await tracksResponse.json().catch(() => ({}));
      tracksError = new Error(error.detail || `Backend ${tracksResponse.status}`);
    }

    const track = selectBackendTrack(tr.tracks, langs);

    // Fallback: yt-dlp is blocked (e.g. HTTP 400 bot check) or found no
    // track. Give YouTube's own player a moment to provide its captions.
    let browserSubs: BrowserSubtitles | null = null;
    if (!track) {
      showStatus("后端无法获取字幕，正在尝试读取播放器字幕…");
      browserSubs = await waitForBrowserSubtitles(pageVideoId, controller.signal);
      if (generation !== loadGeneration) return;
      if (browserSubs?.videoId !== pageVideoId || !hasBrowserSubtitles(browserSubs)) browserSubs = null;
    }
    if (!track && !browserSubs) {
      if (tracksError && !settings.whisperEnabled) throw tracksError;
      if (!settings.whisperEnabled) {
        showStatus("没有找到匹配字幕，可在设置中启用 Whisper", "error");
        return;
      }
    }

    const body = buildStreamRequest({
      pageUrl, languages: langs, track, browserSubtitles: browserSubs, title: document.title, settings,
    });

    showStatus(
      track || browserSubs ? "正在处理并流式翻译字幕…" : "没有字幕，正在使用 Whisper 转写…",
    );
    let totalCues = 0;
    let restoredCues = 0;
    let streamDone = false;
    let failedCues = 0;
    const translated = new Set();

    for (let attempt = 0; attempt <= AUTO_RETRY_DELAYS.length; attempt += 1) {
      streamDone = false;
      failedCues = 0;
      translated.clear();

      const streamBaseUrl = (settings.backendUrl || DEF.backendUrl).replace(/\/+$/, "");
      await apiStream(streamBaseUrl, "/api/subtitle/stream", body, controller.signal, event => {
        if (generation !== loadGeneration || settings.enabled === false) return;

        if (event.type === "meta") {
          totalCues = Number(event.total_cues) || 0;
          restoredCues = Math.min(
            totalCues,
            Math.max(0, Number(event.completed_cues) || 0),
          );
          if (restoredCues > 0) {
            const action = restoredCues >= totalCues ? "" : "，正在补译剩余字幕…";
            showStatus(`已恢复缓存 ${restoredCues}/${totalCues}${action}`);
          } else {
            showStatus(totalCues ? `字幕已获取，正在翻译 0/${totalCues}…` : "正在翻译字幕…");
          }
          return;
        }

        if (["source_cue", "cue_chunk", "cue"].includes(event.type)) {
          const index = Number(event.index);
          if (!Number.isInteger(index) || index < 0) return;
          const previous: Partial<Subtitle> = subtitles[index] || {};
          subtitles[index] = {
            start: event.start ?? previous.start,
            end: event.end ?? previous.end,
            text: event.text ?? previous.text ?? "",
            translation: event.translation ?? previous.translation ?? "",
          };
          if (event.type === "cue") translated.add(index);
          if (videoEl && subtitles.every(Boolean)) {
            ci = idxOf(videoEl.currentTime * 1000);
            refresh();
          }
          const completed = Math.max(restoredCues, translated.size);
          if (event.type === "cue" && !event.cached && (
            completed === restoredCues + 1
            || completed % 10 === 0
            || completed === totalCues
          )) {
            showStatus(`字幕翻译中 ${completed}/${totalCues || subtitles.length}…`);
          }
          return;
        }

        if (event.type === "error") {
          const streamError: DisplayError = new Error(event.detail || "字幕流处理失败");
          streamError.code = event.code || "stream_error";
          streamError.hideAfterMs = Math.max(0, Number(event.hide_after_ms) || 0);
          throw streamError;
        }
        if (event.type === "done") {
          streamDone = true;
          failedCues = Math.max(0, Number(event.failed_cues) || 0);
        }
      });

      if (generation !== loadGeneration || settings.enabled === false) return;
      if (!streamDone) throw new Error("字幕流提前结束");
      if (failedCues === 0) {
        showStatus(`字幕翻译完成（${totalCues || subtitles.length} 条）`, "success", 3000);
        break;
      }

      if (attempt === AUTO_RETRY_DELAYS.length) {
        showStatus(`已完成，${failedCues} 条翻译失败；自动重试已结束`, "error", 30000);
        break;
      }

      const delay = AUTO_RETRY_DELAYS[attempt];
      showStatus(
        `${failedCues} 条翻译失败，${delay / 1000} 秒后自动重试（${attempt + 1}/${AUTO_RETRY_DELAYS.length}）…`,
        "error",
      );
      await waitForRetry(delay, controller.signal);
      if (generation !== loadGeneration || !settings.enabled) return;
      showStatus(`正在自动重试 ${failedCues} 条字幕…`);
    }

    if (generation !== loadGeneration || !settings.enabled) return;
    if (!subtitles.length) showStatus("后端没有返回可显示的字幕", "error");
  } catch (value) {
    const e = displayError(value);
    if (generation !== loadGeneration) return;
    if (e?.name === "AbortError") return;
    const baseUrl = (settings.backendUrl || DEF.backendUrl).replace(/\/+$/, "");
    const detail = String(e?.message || e || "");
    const botBlocked = /sign in to confirm|not a bot|confirm you.?re not a bot/i.test(detail);
    const message = e instanceof TypeError
      ? `无法连接后端 ${baseUrl}，请先启动服务`
      : botBlocked
        ? "字幕加载失败（Backend 400）：YouTube 拦截了后端请求，请配置 yt-dlp cookies.txt 后重启后端"
        : e?.code === "translation_already_running"
          ? e.message
          : `字幕加载失败：${detail}`;
    showStatus(message, "error", Math.max(0, Number(e?.hideAfterMs) || 0));
    console.error("[YTS]", e);
  } finally {
    if (loadAbortController === controller) loadAbortController = null;
  }
}

// ── events ─────────────────────────────────────────────────

function bindVideo(nextVideo: HTMLVideoElement) {
  videoEl?.removeEventListener("timeupdate", tick);
  videoEl = nextVideo;
  videoEl.addEventListener("timeupdate", tick);
}
function tick() {
  if (!videoEl) return;
  const i = idxOf(videoEl.currentTime * 1000);
  ci = i;
  // Refresh even when the cue index did not change: the player may have
  // replaced the overlay container since the previous timeupdate event.
  scheduleRefresh();
}
function findV() {
  if (settings.enabled === false) return;
  const v = document.querySelector("video");
  const vid = videoId();
  if (!v || !vid) return;

  const videoChanged = v !== videoEl;
  const idChanged = vid !== loadedVideoId;
  if (videoChanged) bindVideo(v);
  if (videoChanged || idChanged) {
    loadedVideoId = vid;
    browserSubtitleCache = null;
    load(`https://www.youtube.com/watch?v=${vid}`);
  }
}
function videoId() { return videoIdFromUrl(location.href); }

// ── download VTT ───────────────────────────────────────────

function downloadVtt() {
  const exportable = exportableSubtitles(subtitles);
  if (!exportable.length) {
    const error = "还没有可导出的字幕，请先开启翻译并等待字幕加载";
    showStatus(error, "error", 4000);
    return { ok:false, error };
  }
  const b = new Blob([formatVtt(exportable)], { type:"text/vtt;charset=utf-8" });
  const u = URL.createObjectURL(b);
  const filename = `youtube_${videoId() || "subtitles"}_${Date.now()}.vtt`;
  const a = document.createElement("a"); a.href = u; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
  showStatus(`已导出 ${exportable.length} 条字幕`, "success", 2500);
  return { ok:true, count:exportable.length, filename };
}

// ── messages ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: { action?: string }, _, send) => {
  if (msg.action === "downloadVtt") send(downloadVtt());
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
  btn.title = settings.enabled !== false ? "关闭字幕翻译" : "开启字幕翻译";
  btn.setAttribute("aria-label", "双语字幕翻译");
  btn.innerHTML = settings.enabled !== false ? ICON_ON : ICON_OFF;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    settings.enabled = settings.enabled === false ? true : false;
    updateToggleIcon(btn);
    if (settings.enabled === false) {
      hideTranslation();
    } else {
      const el = document.getElementById(CID);
      if (el) el.style.display = "";
      loadedVideoId = "";
      findV();
    }
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

function updateToggleIcon(btn: HTMLElement) {
  const on = settings.enabled !== false;
  btn.innerHTML = on ? ICON_ON : ICON_OFF;
  btn.title = on ? "关闭字幕翻译" : "开启字幕翻译";
}

chrome.storage.local.get(["ytsSettings"], (d: StoredSettings) => {
  // Enabling translation is intentionally page-local. Every fresh page load
  // starts off, preventing an automatic API request before the user opts in.
  const storedSettings = { ...(d.ytsSettings || {}) };
  settings = { ...DEF, ...storedSettings, enabled:false };
  syncStyle(); findV();
  injectToggle();

  observer = new MutationObserver(records => {
    const root = document.getElementById(CID);
    // Rendering text inside our own overlay creates child-list mutations.
    // Ignore those records so refresh() cannot recursively trigger itself.
    const hasExternalMutation = records.some(record => (
      !root || (record.target !== root && !root.contains(record.target))
    ));
    if (!hasExternalMutation) return;
    findV();
    if (settings.enabled !== false && (subtitles.length || statusTimer)) scheduleRefresh();
  });
  observer.observe(document.body, { childList:true, subtree:true });

  window.addEventListener("yt-navigate-finish", () => {
    // A YouTube SPA navigation keeps this content script alive. Reset the
    // page-local toggle explicitly so every newly opened video starts off.
    settings.enabled = false;
    const toggle = document.getElementById("yts-toggle");
    if (toggle) updateToggleIcon(toggle);
    loadedVideoId = "";
    browserSubtitleCache = null;
    hideTranslation();
    setTimeout(() => { injectToggle(); findV(); }, 1000);
  });
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.ytsSettings) {
    const oldStored: Partial<ExtensionSettings> = changes.ytsSettings.oldValue || {};
    const newStored: Partial<ExtensionSettings> = changes.ytsSettings.newValue || {};
    const changedKeys = new Set([
      ...Object.keys(oldStored),
      ...Object.keys(newStored),
    ]);
    const positionOnly = [...changedKeys].every(key => (
      key === "positionY" || oldStored[key as keyof ExtensionSettings] === newStored[key as keyof ExtensionSettings]
    ));
    const enabled = settings.enabled;
    settings = { ...DEF, ...newStored, enabled };
    syncStyle();
    // Dragging persists only positionY. Applying that storage update must not
    // clear and fetch the already loaded subtitles, which causes a visible
    // flash as soon as the mouse button is released.
    if (positionOnly) {
      refresh();
      return;
    }
    if (settings.enabled === false) {
      hideTranslation();
    } else {
      const el = document.getElementById(CID); if (el) el.style.display = "";
      loadedVideoId = "";
      subtitles = []; ci = -1; refresh(); findV();
    }
  }
});
