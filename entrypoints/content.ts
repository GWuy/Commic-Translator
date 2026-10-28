import { getSettings } from "../lib/settings";
import { Overlay } from "../lib/overlay";
import { captureImage } from "../lib/image-capture";
import type { Settings, TranslateMessage, Translation } from "../types";

type TranslationReply = {
  ok: boolean;
  value?: Translation;
  error?: string;
  stage?: "image" | "api";
};

export default defineContentScript({
  matches: ["*://*/*"],
  runAt: "document_idle",
  async main() {
    let settings = await getSettings();
    let generation = 0;
    let pageUrl = location.href;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = new Set<HTMLImageElement>();
    const tracked = new Set<HTMLImageElement>();
    const overlays = new Map<HTMLImageElement, Overlay>();
    const pending = new Set<HTMLImageElement>();
    const errors = new Map<HTMLImageElement, string>();
    const lastUrls = new WeakMap<HTMLImageElement, string>();
    const badges = new Map<HTMLImageElement, HTMLDivElement>();
    function badge(image: HTMLImageElement, message: string | null): void {
      let element = badges.get(image);
      if (!message) {
        element?.remove();
        badges.delete(image);
        return;
      }
      if (!element) {
        element = document.createElement("div");
        element.style.cssText =
          "position:absolute;z-index:2147483641;pointer-events:none;background:#1e3f76e8;color:white;padding:5px 8px;border-radius:5px;font:12px Arial,sans-serif;max-width:280px;";
        badges.set(image, element);
        document.body.append(element);
      }
      element.textContent = `Comic Translator: ${message}`;
      const rect = image.getBoundingClientRect();
      element.style.left = `${rect.left + scrollX + 4}px`;
      element.style.top = `${rect.top + scrollY + 4}px`;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const image = entry.target as HTMLImageElement;
        if (entry.isIntersecting) visible.add(image);
        else visible.delete(image);
      }
      schedule();
    });
    function eligible(image: HTMLImageElement): boolean {
      if (
        !image.complete ||
        image.naturalWidth < 300 ||
        image.naturalHeight < 300
      )
        return false;
      const rect = image.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 180) return false;
      const text = `${image.alt} ${image.className} ${image.id}`.toLowerCase();
      return !/avatar|logo|icon|banner|advert|profile|emoji/.test(text);
    }
    function addImages(root: ParentNode): void {
      const images =
        root instanceof HTMLImageElement
          ? [root]
          : [...root.querySelectorAll<HTMLImageElement>("img")];
      for (const image of images)
        if (!tracked.has(image)) {
          tracked.add(image);
          lastUrls.set(image, image.currentSrc || image.src);
          observer.observe(image);
          image.addEventListener("load", () => {
            refreshImage(image);
            schedule();
          });
        }
    }
    function refreshImage(image: HTMLImageElement): void {
      const url = image.currentSrc || image.src;
      if (lastUrls.get(image) === url) return;
      lastUrls.set(image, url);
      overlays.get(image)?.destroy();
      overlays.delete(image);
      errors.delete(image);
      badge(image, null);
    }
    function allowed(): boolean {
      return (
        settings.enabled && !settings.disabledSites.includes(location.hostname)
      );
    }
    function schedule(): void {
      clearTimeout(timer);
      if (allowed()) timer = setTimeout(process, settings.debounceMs);
    }
    function sendTranslation(
      message: TranslateMessage,
    ): Promise<TranslationReply> {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response: TranslationReply) => {
          if (chrome.runtime.lastError)
            reject(
              new Error(chrome.runtime.lastError.message || "Lỗi kết nối"),
            );
          else if (!response)
            reject(new Error("Service worker không trả kết quả."));
          else resolve(response);
        });
      });
    }
    async function translateImage(
      image: HTMLImageElement,
      url: string,
      current: number,
    ): Promise<void> {
      try {
        const request: TranslateMessage = {
          type: "TRANSLATE",
          url,
          imageId: url,
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
        };
        if (!/^https?:/i.test(url)) {
          const capture = await captureImage(image);
          Object.assign(request, capture, { imageId: capture.contentId });
        }
        let response = await sendTranslation(request);
        if (!response.ok && response.stage === "image" && !request.imageData) {
          const capture = await captureImage(image);
          response = await sendTranslation({
            ...request,
            ...capture,
            imageId: capture.contentId,
          });
        }
        if (
          (image.currentSrc || image.src) !== url ||
          current !== generation ||
          !image.isConnected ||
          !allowed()
        ) {
          badge(image, null);
          return;
        }
        if (!response.ok || !response.value)
          throw new Error(response.error || "Không dịch được ảnh");
        badge(image, null);
        overlays.set(image, new Overlay(image, response.value, settings));
      } catch (error) {
        if (current === generation && image.isConnected && allowed()) {
          const message =
            error instanceof Error ? error.message : "Không dịch được ảnh";
          errors.set(image, message);
          badge(image, message);
          console.warn("[Comic Translator]", message);
        } else badge(image, null);
      } finally {
        pending.delete(image);
        schedule();
      }
    }
    async function process(): Promise<void> {
      if (!allowed()) return;
      const current = generation;
      const images = [...visible].filter(
        (image) =>
          eligible(image) &&
          !pending.has(image) &&
          !overlays.has(image) &&
          !errors.has(image),
      );
      images.sort(
        (a, b) =>
          Math.abs(
            a.getBoundingClientRect().top +
              a.getBoundingClientRect().height / 2 -
              innerHeight / 2,
          ) -
          Math.abs(
            b.getBoundingClientRect().top +
              b.getBoundingClientRect().height / 2 -
              innerHeight / 2,
          ),
      );
      for (const image of images) {
        const url = image.currentSrc || image.src;
        if (!url) continue;
        pending.add(image);
        badge(image, "Đang dịch…");
        void translateImage(image, url, current);
      }
    }
    addImages(document);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === "attributes" &&
          record.target instanceof HTMLImageElement
        ) {
          const image = record.target;
          refreshImage(image);
          observer.observe(image);
        }
        for (const node of record.addedNodes)
          if (node instanceof Element) addImages(node);
        for (const node of record.removedNodes)
          if (node instanceof Element) {
            const images =
              node instanceof HTMLImageElement
                ? [node]
                : [...node.querySelectorAll<HTMLImageElement>("img")];
            for (const image of images) {
              observer.unobserve(image);
              tracked.delete(image);
              visible.delete(image);
              overlays.get(image)?.destroy();
              overlays.delete(image);
              badge(image, null);
            }
          }
      }
      schedule();
    });
    mutations.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes", "data-src"],
    });
    addEventListener(
      "scroll",
      () => {
        for (const overlay of overlays.values()) overlay.position();
        for (const [image, element] of badges) {
          const rect = image.getBoundingClientRect();
          element.style.left = `${rect.left + scrollX + 4}px`;
          element.style.top = `${rect.top + scrollY + 4}px`;
        }
        schedule();
      },
      { passive: true },
    );
    addEventListener("resize", () => {
      for (const image of tracked) refreshImage(image);
      for (const overlay of overlays.values()) overlay.position();
      for (const [image, element] of badges) {
        const rect = image.getBoundingClientRect();
        element.style.left = `${rect.left + scrollX + 4}px`;
        element.style.top = `${rect.top + scrollY + 4}px`;
      }
      schedule();
    });
    setInterval(() => {
      if (location.href === pageUrl) return;
      pageUrl = location.href;
      generation++;
      for (const overlay of overlays.values()) overlay.destroy();
      overlays.clear();
      errors.clear();
      for (const image of badges.keys()) badge(image, null);
      schedule();
    }, 1000);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      const previous = settings;
      settings = {
        ...settings,
        ...(changes.settings.newValue as Partial<Settings>),
      };
      if (
        previous.sourceLanguage !== settings.sourceLanguage ||
        previous.targetLanguage !== settings.targetLanguage ||
        !allowed()
      ) {
        generation++;
        for (const overlay of overlays.values()) overlay.destroy();
        overlays.clear();
        errors.clear();
        for (const image of badges.keys()) badge(image, null);
      } else for (const overlay of overlays.values()) overlay.update(settings);
      schedule();
    });
    schedule();
  },
});
