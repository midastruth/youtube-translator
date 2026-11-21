import type { ExtensionSettings } from "./types.js";

export type SettingsPatch = {
  action: "updateSettings";
  patch: Partial<ExtensionSettings>;
  remove: (keyof ExtensionSettings)[];
};
export type SettingsResult = { ok: true } | { ok: false; code: string };

// The background owns read/modify/write, including writes from other tabs.
export function updateSettings(patch: Partial<ExtensionSettings>, remove: (keyof ExtensionSettings)[] = [], saved?: () => void) {
  chrome.runtime.sendMessage({ action: "updateSettings", patch, remove } satisfies SettingsPatch, (result: SettingsResult | undefined) => {
    if (chrome.runtime.lastError) throw new Error("settings_message_failed");
    if (!result) throw new Error("settings_response_missing");
    if (!result.ok) throw new Error(result.code);
    saved?.();
  });
}
