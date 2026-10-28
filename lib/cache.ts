import { openDB } from "idb";
import type { Translation } from "../types";

const TTL = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 300;
const memory = new Map<string, Translation>();
const db = openDB("comic-translator", 1, {
  upgrade(database) {
    database.createObjectStore("translations", { keyPath: "key" });
  },
});
type Entry = {
  key: string;
  value: Translation;
  expires: number;
  lastUsed: number;
};
export function cacheKey(
  url: string,
  source: string,
  target: string,
  modelVersion: string,
): string {
  return JSON.stringify([modelVersion, "pipeline-1", url, source, target]);
}
export async function getCached(key: string): Promise<Translation | undefined> {
  const found = memory.get(key);
  if (found) return found;
  const database = await db;
  const entry = (await database.get("translations", key)) as Entry | undefined;
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    await database.delete("translations", key);
    return undefined;
  }
  memory.set(key, entry.value);
  await database.put("translations", { ...entry, lastUsed: Date.now() });
  return entry.value;
}
export async function putCached(
  key: string,
  value: Translation,
): Promise<void> {
  memory.set(key, value);
  const database = await db;
  await database.put("translations", {
    key,
    value,
    expires: Date.now() + TTL,
    lastUsed: Date.now(),
  });
  const entries = (await database.getAll("translations")) as Entry[];
  const expired = entries.filter((e) => e.expires < Date.now());
  const live = entries
    .filter((e) => e.expires >= Date.now())
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of [
    ...expired,
    ...live.slice(0, Math.max(0, live.length - LIMIT)),
  ])
    await database.delete("translations", entry.key);
}
export async function clearCache(): Promise<void> {
  memory.clear();
  await (await db).clear("translations");
}
