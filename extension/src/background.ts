import type { StoredSettings } from "./types.js";
import type { SettingsPatch, SettingsResult } from "./settings.js";

const settingsWrites: { message: SettingsPatch; send: (result: SettingsResult) => void }[] = [];

function writeNextSettings() {
  const job = settingsWrites[0];
  if (!job) return;
  const finish = (result: SettingsResult) => {
    job.send(result);
    settingsWrites.shift();
    writeNextSettings();
  };
  chrome.storage.local.get(["ytsSettings"], (data: StoredSettings) => {
    // Storage failures are translated only at the message boundary, never retried.
    if (chrome.runtime.lastError) { finish({ ok: false, code: "settings_read_failed" }); return; }
    const settings = { ...data.ytsSettings, ...job.message.patch };
    for (const key of job.message.remove) delete settings[key];
    chrome.storage.local.set({ ytsSettings: settings }, () => {
      if (chrome.runtime.lastError) { finish({ ok: false, code: "settings_write_failed" }); return; }
      finish({ ok: true });
    });
  });
}

chrome.runtime.onMessage.addListener((message: SettingsPatch, _sender, send) => {
  if (message.action !== "updateSettings") return;
  settingsWrites.push({ message, send });
  if (settingsWrites.length === 1) writeNextSettings();
  return true; // Keep the response channel open through the queued storage write.
});

function showBadge(tabId: number, text: string, color: string) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text:"" }), 2500);
}

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;

  const tabId = tab.id;
  chrome.tabs.sendMessage(tabId, { action:"downloadVtt" }, (response: { ok?: boolean } | undefined) => {
    if (chrome.runtime.lastError) {
      showBadge(tabId, "!", "#d93025");
      return;
    }
    if (response?.ok) {
      showBadge(tabId, "✓", "#188038");
    } else {
      showBadge(tabId, "!", "#d93025");
    }
  });
});
