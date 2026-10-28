import type { Settings } from "../types";

export const defaults: Settings = {
  enabled: false,
  apiBaseUrl: "http://127.0.0.1:8000",
  sourceLanguage: "auto",
  targetLanguage: "vi",
  debounceMs: 1200,
  displayMode: "clean",
  showOriginal: false,
  opacity: 0.94,
  fontScale: 1,
  disabledSites: [],
};
export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  const saved = result.settings as Partial<Settings> | undefined;
  const merged = { ...defaults, ...saved };
  if (!["clean", "subtle", "hover"].includes(merged.displayMode))
    merged.displayMode = "clean";
  return merged;
}
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
