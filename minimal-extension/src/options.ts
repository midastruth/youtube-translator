import type { StoredSettings } from "./types.js";

const RANGE_KEYS = ["fontSizeOrig", "fontSizeTran", "bgOpacity"];

function setVal(id: string, value: string | number) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return;
  element.value = String(value);
}

function getVal(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) throw new Error(`Missing options field: ${id}`);
  return element.value;
}

function updateRangeLabel(id: string) {
  const span = document.getElementById(`${id}Val`);
  if (!span) return;
  span.textContent = `${getVal(id)}${id === "bgOpacity" ? "%" : "px"}`;
}

function loadSettings() {
  chrome.storage.local.get(["ytsSettings"], (data: StoredSettings) => {
    const settings = data.ytsSettings || {};
    setVal("backendUrl", settings.backendUrl || "http://localhost:8787");
    setVal("languages", settings.languages || "en,zh-Hans,zh-Hant,zh");
    setVal("toLang", settings.toLang || "zh-CN");
    setVal("segmentation", settings.segmentation || "rule");
    setVal("translateEngine", settings.translateEngine || "legacy");
    setVal("translateApiKey", settings.translateApiKey || "");
    setVal("translateBaseUrl", settings.translateBaseUrl || "");
    setVal("translateModel", settings.translateModel || "");
    setVal("translateWhole", settings.translateWhole ? "true" : "false");
    setVal("whisperEnabled", settings.whisperEnabled ? "true" : "false");
    setVal("whisperApiKey", settings.whisperApiKey || "");
    setVal("whisperBaseUrl", settings.whisperBaseUrl || "");
    setVal("whisperModel", settings.whisperModel || "");
    setVal("whisperLanguage", settings.whisperLanguage || "");
    setVal("isBilingual", settings.isBilingual !== false ? "true" : "false");
    setVal("fontSizeOrig", settings.fontSizeOrig || 22);
    setVal("fontSizeTran", settings.fontSizeTran || 18);
    setVal("origColor", settings.origColor || "#ffffff");
    setVal("tranColor", settings.tranColor || "#ffff00");
    setVal("bgOpacity", Math.round((settings.bgOpacity ?? 0.6) * 100));
    RANGE_KEYS.forEach(updateRangeLabel);
  });
}

function downloadVtt() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id !== undefined) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "downloadVtt" });
    }
  });
}

function saveSettings() {
  chrome.storage.local.get(["ytsSettings"], (data: StoredSettings) => {
    // Keep page-controlled display state such as positionY.
    const settings = { ...(data.ytsSettings || {}) };
    delete settings.enabled;
    for (const id of [
      "backendUrl", "languages", "toLang", "segmentation", "translateEngine",
      "translateApiKey", "translateBaseUrl", "translateModel",
      "whisperApiKey", "whisperBaseUrl", "whisperModel", "whisperLanguage",
      "origColor", "tranColor",
    ] as const) {
      settings[id] = getVal(id).trim();
    }

    settings.backendUrl = (settings.backendUrl || "").replace(/\/+$/, "") || "http://localhost:8787";
    settings.translateWhole = getVal("translateWhole") === "true";
    settings.whisperEnabled = getVal("whisperEnabled") === "true";
    settings.isBilingual = getVal("isBilingual") === "true";
    settings.bgOpacity = Number.parseInt(getVal("bgOpacity"), 10) / 100;
    settings.fontSizeOrig = Number.parseInt(getVal("fontSizeOrig"), 10) || 22;
    settings.fontSizeTran = Number.parseInt(getVal("fontSizeTran"), 10) || 18;
    settings.positionY ??= 12;
    settings.autoTranslate = true;

    chrome.storage.local.set({ ytsSettings: settings }, () => {
      const message = document.getElementById("savedMsg");
      if (!message) return;
      message.classList.remove("show");
      void message.offsetWidth;
      message.classList.add("show");
    });
  });
}

for (const key of RANGE_KEYS) {
  document.getElementById(key)?.addEventListener("input", () => updateRangeLabel(key));
}
document.getElementById("downloadVttButton")?.addEventListener("click", downloadVtt);
document.getElementById("saveButton")?.addEventListener("click", saveSettings);

loadSettings();
