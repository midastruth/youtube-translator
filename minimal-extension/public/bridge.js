/* Capture YouTube's own timed-text response before yt-dlp needs to access it.
 * This runs in the page's MAIN world. It is a fallback for servers whose IP is
 * challenged by YouTube; no cookies or credentials leave the browser.
 */
(() => {
  const EVENT = "yts-browser-subtitles";
  const videoId = () => {
    try { return new URL(location.href).searchParams.get("v") || ""; } catch { return ""; }
  };

  const emit = (cues, language = "auto") => {
    const clean = cues.filter(c => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.text);
    if (!clean.length || !videoId()) return;
    const detail = {
      videoId: videoId(),
      title: document.title.replace(/ - YouTube$/, ""),
      language,
      cues: clean,
    };
    window.__YTS_BROWSER_SUBTITLES = detail;
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
  };

  const json3 = (data) => {
    const cues = [];
    for (const event of data?.events || []) {
      const text = (event.segs || []).map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      const start = Number(event.tStartMs);
      const duration = Number(event.dDurationMs || 0);
      if (text && Number.isFinite(start) && duration > 0) cues.push({ start, end: start + duration, text });
    }
    return cues;
  };

  const xml = (value) => {
    const doc = new DOMParser().parseFromString(value, "text/xml");
    return [...doc.querySelectorAll("text")].map(node => ({
      start: Number(node.getAttribute("start")) * 1000,
      end: (Number(node.getAttribute("start")) + Number(node.getAttribute("dur") || 0)) * 1000,
      text: node.textContent.replace(/\s+/g, " ").trim(),
    })).filter(c => c.end > c.start);
  };

  const parse = async (response, url) => {
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.clone().text();
    let cues = [];
    if (type.includes("json") || raw.trim().startsWith("{")) {
      try { cues = json3(JSON.parse(raw)); } catch { /* try XML below */ }
    }
    if (!cues.length && raw.trim().startsWith("<")) cues = xml(raw);
    if (!cues.length) return;
    const lang = new URL(url, location.href).searchParams.get("lang") || "auto";
    emit(cues, lang);
  };

  const preferredLanguages = () => ["en", "zh-Hans", "zh-Hant", "zh"];
  const fetchPlayerTrack = async () => {
    const tracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length || !videoId()) return;
    const preferred = preferredLanguages();
    const track = preferred.map(language => tracks.find(item => (
      item.languageCode?.toLowerCase() === language.toLowerCase()
      || item.languageCode?.toLowerCase().split("-")[0] === language.toLowerCase().split("-")[0]
    ))).find(Boolean) || tracks[0];
    if (!track?.baseUrl) return;
    try {
      const response = await originalFetch(track.baseUrl, { credentials: "include" });
      const raw = await response.text();
      const cues = raw.trim().startsWith("{") ? json3(JSON.parse(raw)) : xml(raw);
      if (cues.length) emit(cues, track.languageCode || "auto");
    } catch { /* YouTube may reject this track; network interception can still work. */ }
  };

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    if (/timedtext|caption/i.test(url)) parse(response, url).catch(() => {});
    return response;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__ytsCaptionUrl = String(url || "");
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (/timedtext|caption/i.test(this.__ytsCaptionUrl || "")) {
      this.addEventListener("load", () => {
        const raw = String(this.responseText || "");
        const url = this.__ytsCaptionUrl;
        let cues = [];
        if (raw.trim().startsWith("{")) { try { cues = json3(JSON.parse(raw)); } catch {} }
        if (!cues.length && raw.trim().startsWith("<")) cues = xml(raw);
        if (cues.length) emit(cues, new URL(url, location.href).searchParams.get("lang") || "auto");
      });
    }
    return send.apply(this, args);
  };

  let attempts = 0;
  const poll = setInterval(() => {
    fetchPlayerTrack();
    if (++attempts >= 30) clearInterval(poll);
  }, 500);
})();
