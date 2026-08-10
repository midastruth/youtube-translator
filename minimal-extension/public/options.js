const RANGE_KEYS = ["fontSizeOrig", "fontSizeTran", "bgOpacity"];

function setVal(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  element.value = value;
}

function getVal(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing options field: ${id}`);
  return element.value;
}

function updateRangeLabel(id) {
  const span = document.getElementById(`${id}Val`);
  if (!span) return;
  span.textContent = `${getVal(id)}${id === "bgOpacity" ? "%" : "px"}`;
}

function loadSettings() {
  chrome.storage.local.get(["ytsSettings"], (data) => {
    const settings = data.ytsSettings || {};
    setVal("backendUrl", settings.backendUrl || "http://localhost:8787");
    setVal("languages", settings.languages || "en,zh-Hans,zh-Hant,zh");
    setVal("toLang", settings.toLang || "zh-CN");
    setVal("segmentation", settings.segmentation || "rule");
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
  chrome.storage.local.get(["ytsSettings"], (data) => {
    // Keep state controlled from the player, notably enabled and positionY.
    const settings = { ...(data.ytsSettings || {}) };
    for (const id of [
      "backendUrl", "languages", "toLang", "segmentation",
      "translateApiKey", "translateBaseUrl", "translateModel",
      "whisperApiKey", "whisperBaseUrl", "whisperModel", "whisperLanguage",
      "origColor", "tranColor",
    ]) {
      settings[id] = getVal(id).trim();
    }

    settings.backendUrl = settings.backendUrl.replace(/\/+$/, "") || "http://localhost:8787";
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
      message.classList.remove("show");
      void message.offsetWidth;
      message.classList.add("show");
    });
  });
}

for (const key of RANGE_KEYS) {
  document.getElementById(key).addEventListener("input", () => updateRangeLabel(key));
}
document.getElementById("downloadVttButton").addEventListener("click", downloadVtt);
document.getElementById("saveButton").addEventListener("click", saveSettings);

loadSettings();
