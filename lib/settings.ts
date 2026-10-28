import type { Settings } from "../types";

export const defaults: Settings = {
  enabled: false,
  sourceLanguage: "auto",
  targetLanguage: "vi",
  debounceMs: 1200,
  displayMode: "cover",
  showOriginal: false,
  opacity: 0.94,
  fontScale: 1,
  disabledSites: [],
};
export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  return { ...defaults, ...(result.settings as Partial<Settings> | undefined) };
}
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
