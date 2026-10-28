import { translationSchema, type Message, type Translation } from "../types";
import { cacheKey, clearCache, getCached, putCached } from "../lib/cache";
import { getSettings } from "../lib/settings";

const inFlight = new Map<string, Promise<Translation>>();
let modelState: { endpoint: string; version: string; checked: number } | undefined;
let active = 0;
const waiting: Array<() => void> = [];
class ImageAccessError extends Error {}
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
async function modelVersion(endpoint: string): Promise<string> {
  if (modelState?.endpoint === endpoint && Date.now() - modelState.checked < 5 * 60_000)
    return modelState.version;
  let version = "gemini-3.5-flash-lite";
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const data = (await response.json()) as { model?: unknown };
      if (typeof data.model === "string" && data.model.length < 100)
        version = data.model;
      await chrome.storage.local.set({ modelVersion: { endpoint, version } });
    }
  } catch {
    const stored = await chrome.storage.local.get("modelVersion");
    const previous = stored.modelVersion as { endpoint?: unknown; version?: unknown } | undefined;
    if (previous?.endpoint === endpoint && typeof previous.version === "string")
      version = previous.version;
  }
  modelState = { endpoint, version, checked: Date.now() };
  return version;
}
async function download(url: string, imageData?: string): Promise<Blob> {
  if (imageData) {
    if (
      !imageData.startsWith("data:image/jpeg;base64,") ||
      imageData.length > 17_000_000
    )
      throw new ImageAccessError(
        "Dữ liệu ảnh gửi từ trang không hợp lệ hoặc quá lớn.",
      );
    let blob: Blob;
    try {
      blob = await fetch(imageData).then((response) => response.blob());
    } catch {
      throw new ImageAccessError("Không đọc được dữ liệu ảnh gửi từ trang.");
    }
    if (blob.size > 12 * 1024 * 1024)
      throw new ImageAccessError("Ảnh lớn hơn giới hạn 12 MB.");
    return blob;
  }
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new ImageAccessError("Không thể tải trực tiếp ảnh này.");
  if (!(await chrome.permissions.contains({ origins: [`${parsed.origin}/*`] })))
    throw new ImageAccessError(
      `Chưa cấp quyền tải ảnh từ ${parsed.origin}. Mở popup và cấp quyền ảnh.`,
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        credentials: "include",
      });
    } catch {
      throw new ImageAccessError("Không tải được ảnh từ trang web.");
    }
    if (!response.ok)
      throw new ImageAccessError(
        `Không tải được ảnh (HTTP ${response.status}).`,
      );
    const type = response.headers.get("content-type")?.split(";")[0];
    if (
      !type ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)
    )
      throw new ImageAccessError("Định dạng ảnh không được hỗ trợ.");
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      throw new ImageAccessError("Không đọc được dữ liệu ảnh từ trang web.");
    }
    if (blob.size > 15 * 1024 * 1024)
      throw new ImageAccessError("Ảnh lớn hơn giới hạn 15 MB.");
    return blob;
  } finally {
    clearTimeout(timer);
  }
}
async function translate(
  message: Extract<Message, { type: "TRANSLATE" }>,
): Promise<Translation> {
  const settings = await getSettings();
  const endpoint = settings.apiBaseUrl.replace(/\/+$/, "");
  const key = cacheKey(
    `${endpoint}:${message.contentId || message.url}`,
    message.sourceLanguage,
    message.targetLanguage,
    await modelVersion(endpoint),
  );
  const cached = await getCached(key);
  if (cached) return cached;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const job = slot(async () => {
    const image = await download(message.url, message.imageData);
    const form = new FormData();
    form.append("image", image, "comic-image");
    form.append("source_language", message.sourceLanguage);
    form.append("target_language", message.targetLanguage);
    form.append("image_identifier", message.imageId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200000);
    try {
      const response = await fetch(`${endpoint}/api/v1/translate/image`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          (data as { error?: { message?: string } }).error?.message ||
            `API HTTP ${response.status}`,
        );
      const validated = translationSchema.parse(data);
      await putCached(key, validated);
      return validated;
    } catch (error) {
      if (error instanceof TypeError)
        throw new Error(
          `Không kết nối được backend tại ${endpoint}. Kiểm tra URL và quyền truy cập.`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse) => {
      if (message.type === "TRANSLATE") {
        translate(message).then(
          (value) => sendResponse({ ok: true, value }),
          (error) =>
            sendResponse({
              ok: false,
              error: String(error instanceof Error ? error.message : error),
              stage: error instanceof ImageAccessError ? "image" : "api",
            }),
        );
        return true;
      }
      if (message.type === "CLEAR_CACHE") {
        clearCache().then(
          () => sendResponse({ ok: true }),
          (error) => sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      }
      if (message.type === "STATUS") {
        sendResponse({ ok: true, active, queued: waiting.length });
        return false;
      }
      return false;
    },
  );
});
