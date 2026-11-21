import type { ExtensionSettings, StoredSettings } from "./types.js";
import { updateSettings } from "./settings.js";

const RANGE_KEYS = ["fontSizeOrig", "fontSizeTran", "bgOpacity", "fontScale"];
const LIVE_KEYS = [...RANGE_KEYS, "autoScale", "isBilingual", "origColor", "tranColor"];
const pendingDisplayEdits = new Map<string, symbol>();

function displayValues() {
  return {
    fontSizeOrig: Number(getVal("fontSizeOrig")), fontSizeTran: Number(getVal("fontSizeTran")),
    fontScale: Number(getVal("fontScale")) / 100, autoScale: getVal("autoScale") === "true",
    isBilingual: getVal("isBilingual") === "true", origColor: getVal("origColor"),
    tranColor: getVal("tranColor"), bgOpacity: Number(getVal("bgOpacity")) / 100,
  };
}

function previewDisplay() {
  const s = displayValues();
  const orig = document.getElementById("previewOrig")!;
  const tran = document.getElementById("previewTran")!;
  orig.style.cssText = `font-size:${s.fontSizeOrig * s.fontScale}px;color:${s.origColor};font-weight:500;display:${s.isBilingual ? "block" : "none"}`;
  tran.style.cssText = `font-size:${s.fontSizeTran * s.fontScale}px;color:${s.tranColor};font-weight:400`;
  document.getElementById("subtitlePreview")!.style.background = `rgba(0,0,0,${s.bgOpacity})`;
}


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
  span.textContent = `${getVal(id)}${id === "bgOpacity" || id === "fontScale" ? "%" : "px"}`;
}

function loadSettings() {
  chrome.storage.local.get(["ytsSettings"], (data: StoredSettings) => {
    const settings = data.ytsSettings || {};
    setVal("backendUrl", settings.backendUrl || "http://localhost:8787");
    setVal("languages", settings.languages || "en,zh-Hans,zh-Hant,zh");
    setVal("toLang", settings.toLang || "zh-CN");
    setVal("segmentation", settings.segmentation || "rule");
    setVal("translateEngine", settings.translateEngine === "legacy" ? "legacy" : "document");
    setVal("translateApiKey", settings.translateApiKey || "");
    setVal("translateBaseUrl", settings.translateBaseUrl || "");
    setVal("translateModel", settings.translateModel || "");
    setVal("translateRequestBudget", settings.translateRequestBudget ?? "");
    setVal("translateWhole", settings.translateWhole ? "true" : "false");
    setVal("whisperEnabled", settings.whisperEnabled ? "true" : "false");
    setVal("whisperApiKey", settings.whisperApiKey || "");
    setVal("whisperBaseUrl", settings.whisperBaseUrl || "");
    setVal("whisperModel", settings.whisperModel || "");
    setVal("whisperLanguage", settings.whisperLanguage || "");
    setVal("isBilingual", settings.isBilingual !== false ? "true" : "false");
    setVal("fontSizeOrig", settings.fontSizeOrig || 18);
    setVal("fontSizeTran", settings.fontSizeTran || 24);
    setVal("fontScale", Math.round((settings.fontScale ?? 1) * 100));
    setVal("autoScale", settings.autoScale !== false ? "true" : "false");
    setVal("origColor", settings.origColor || "#ffffff");
    setVal("tranColor", settings.tranColor || "#ffff00");
    setVal("bgOpacity", Math.round((settings.bgOpacity ?? 0.6) * 100));
    RANGE_KEYS.forEach(updateRangeLabel);
    previewDisplay();
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
  const budgetInput = document.getElementById("translateRequestBudget") as HTMLInputElement;
  const rawBudget = budgetInput.value.trim();
  const budget = rawBudget ? Number(rawBudget) : undefined;
  budgetInput.setCustomValidity(budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0 || budget > 1000)
    ? "请输入 0～1000 的整数（0 关闭限制），或留空使用服务端配置" : "");
  if (!budgetInput.reportValidity()) return;
  // Capture the edited fields now, not after an asynchronous storage read.
  // Live display controls and dragged position are saved independently.
  const settings: Partial<ExtensionSettings> = {};
  for (const id of [
    "backendUrl", "languages", "toLang", "segmentation", "translateEngine",
    "translateApiKey", "translateBaseUrl", "translateModel",
    "whisperApiKey", "whisperBaseUrl", "whisperModel", "whisperLanguage",
  ] as const) {
    settings[id] = getVal(id).trim();
  }

  settings.backendUrl = (settings.backendUrl || "").replace(/\/+$/, "") || "http://localhost:8787";
  if (budget !== undefined) settings.translateRequestBudget = budget;
  settings.translateWhole = getVal("translateWhole") === "true";
  settings.whisperEnabled = getVal("whisperEnabled") === "true";
  settings.autoTranslate = true;

  updateSettings(settings, budget === undefined ? ["enabled", "translateRequestBudget"] : ["enabled"], () => {
    const message = document.getElementById("savedMsg");
    if (!message) return;
    message.classList.remove("show");
    void message.offsetWidth;
    message.classList.add("show");
  });
}

for (const key of LIVE_KEYS) {
  document.getElementById(key)?.addEventListener("input", () => {
    if (RANGE_KEYS.includes(key)) updateRangeLabel(key);
    previewDisplay();
    const value = displayValues()[key as keyof ReturnType<typeof displayValues>];
    const edit = Symbol();
    pendingDisplayEdits.set(key, edit);
    updateSettings({ [key]: value }, [], () => {
      if (pendingDisplayEdits.get(key) === edit) pendingDisplayEdits.delete(key);
    });
  });
}
chrome.storage.onChanged.addListener(changes => {
  if (!changes.ytsSettings) return;
  const before = (changes.ytsSettings.oldValue || {}) as Record<string, unknown>;
  const after = (changes.ytsSettings.newValue || {}) as Record<string, unknown>;
  for (const key of LIVE_KEYS) {
    // Queued writes may announce an older value while this control has newer input.
    if (pendingDisplayEdits.has(key) || before[key] === after[key] || after[key] === undefined) continue;
    const value = after[key];
    setVal(key, key === "fontScale" || key === "bgOpacity" ? Math.round(Number(value) * 100) : String(value));
    if (RANGE_KEYS.includes(key)) updateRangeLabel(key);
  }
  previewDisplay();
});
document.getElementById("downloadVttButton")?.addEventListener("click", downloadVtt);
document.getElementById("saveButton")?.addEventListener("click", saveSettings);

loadSettings();
