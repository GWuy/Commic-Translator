import type { BBox, Settings, Translation } from "../types";
import { planRegions, type PlannedRegion } from "./overlay-layout";

type Item = {
  region: PlannedRegion;
  element: HTMLButtonElement | HTMLDivElement;
  text: string;
};

function sentenceCase(text: string, language: string): string {
  if (
    language !== "vi" ||
    text !== text.toLocaleUpperCase("vi") ||
    text === text.toLocaleLowerCase("vi")
  )
    return text;
  return text
    .toLocaleLowerCase("vi")
    .replace(
      /(^|[.!?]\s+)(\p{L})/gu,
      (_all, start: string, letter: string) =>
        start + letter.toLocaleUpperCase("vi"),
    );
}

export class Overlay {
  private host = document.createElement("div");
  private shadow = this.host.attachShadow({ mode: "closed" });
  private surface = document.createElement("div");
  private measure = document.createElement("div");
  private popover = document.createElement("div");
  private items: Item[] = [];
  private resize = new ResizeObserver(() => this.position());
  private lastSize = "";
  private pinned = false;
  private hideTimer?: number;

  constructor(
    private image: HTMLImageElement,
    private result: Translation,
    private settings: Settings,
  ) {
    this.host.style.cssText =
      "position:absolute;z-index:2147483640;pointer-events:none;overflow:visible;";
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}.surface{position:absolute;inset:0;pointer-events:none}.region{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;padding:2px 3px;overflow:hidden;white-space:pre-line;overflow-wrap:break-word;line-height:1.16;letter-spacing:0;font-family:Arial,Helvetica,sans-serif;font-weight:500;color:#171717;background:white;border:0;box-shadow:none;pointer-events:auto;user-select:text;cursor:text}.region.speech{border-radius:38% 42% 40% 36% / 24% 29% 28% 25%}.region.caption,.region.thought{border-radius:3px;background:#f7f7f5}.region.thought{font-style:italic}.region.sound{border-radius:2px;font-style:italic}.region.subtle{background:rgba(255,255,255,var(--opacity));border-radius:4px}.region:focus-visible,.marker:focus-visible{outline:2px solid #376dc6;outline-offset:2px}.marker{position:absolute;display:grid;place-items:center;width:18px;height:18px;padding:0;border:1px solid #767676;border-radius:50%;background:rgba(255,255,255,.94);color:#222;font:700 13px Arial,sans-serif;line-height:1;pointer-events:auto;cursor:pointer}.measure{position:absolute;top:-10000px;left:0;visibility:hidden;white-space:pre-line;overflow-wrap:break-word;line-height:1.16;font-family:Arial,Helvetica,sans-serif;font-weight:500;padding:0}.popover{position:absolute;display:none;box-sizing:border-box;padding:10px 12px;border:1px solid #a9a9a9;border-radius:7px;background:#fff;color:#171717;font:14px/1.4 Arial,Helvetica,sans-serif;overflow:auto;max-height:45vh;white-space:pre-line;overflow-wrap:break-word;user-select:text;pointer-events:auto}.popover.open{display:block}`;
    this.surface.className = "surface";
    this.measure.className = "measure";
    this.popover.className = "popover";
    this.popover.addEventListener("pointerenter", () =>
      clearTimeout(this.hideTimer),
    );
    this.popover.addEventListener("pointerleave", () => this.hideSoon());
    this.shadow.append(style, this.surface, this.measure, this.popover);
    document.body.append(this.host);
    this.rebuild();
    this.resize.observe(image);
    this.position();
  }

  private rebuild(): void {
    this.surface.replaceChildren();
    this.items = [];
    this.close();
    if (this.settings.showOriginal) return;
    for (const region of planRegions(this.result)) {
      const text = sentenceCase(
        region.translatedText,
        this.result.targetLanguage,
      );
      const element = document.createElement("div");
      element.className = "region";
      element.tabIndex = 0;
      element.textContent = text;
      element.setAttribute(
        "aria-label",
        `${text}. Xem bản gốc bằng cách di chuột hoặc nhấn Enter.`,
      );
      const item: Item = { region, element, text };
      element.addEventListener("pointerenter", () => this.open(item, true));
      element.addEventListener("pointerleave", () => this.hideSoon());
      element.addEventListener("focus", () => this.open(item, true));
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.toggle(item, true);
        }
      });
      element.addEventListener("click", () => {
        if (!getSelection()?.toString()) this.toggle(item, true);
      });
      this.surface.append(element);
      this.items.push(item);
    }
    this.lastSize = "";
  }

  update(settings: Settings): void {
    this.settings = settings;
    this.rebuild();
    this.position();
  }

  private place(
    element: HTMLElement,
    box: BBox,
    width: number,
    height: number,
  ): void {
    element.style.left = `${box.x * width}px`;
    element.style.top = `${box.y * height}px`;
    element.style.width = `${box.width * width}px`;
    element.style.height = `${box.height * height}px`;
  }

  private fit(
    text: string,
    width: number,
    height: number,
    imageWidth: number,
  ): number | null {
    if (width < 46 || height < 27) return null;
    const min = 12;
    const max = Math.max(
      min,
      Math.min(22, imageWidth * 0.032) * this.settings.fontScale,
    );
    this.measure.textContent = text;
    this.measure.style.width = `${Math.max(1, width - 8)}px`;
    let low = min,
      high = max,
      chosen = 0;
    for (let i = 0; i < 7; i++) {
      const size = i === 0 ? min : (low + high) / 2;
      this.measure.style.fontSize = `${size}px`;
      if (
        this.measure.getBoundingClientRect().height <= height - 5 &&
        this.measure.scrollWidth <= width - 5
      ) {
        chosen = size;
        low = size;
      } else high = size;
    }
    return chosen >= min ? chosen : null;
  }

  private layout(width: number, height: number): void {
    const markers: Array<{ x: number; y: number }> = [];
    for (const item of this.items) {
      const { region, element, text } = item;
      const box = region.renderBBox;
      const fontSize =
        region.fallbackOnly || this.settings.displayMode === "hover"
          ? null
          : this.fit(text, box.width * width, box.height * height, width);
      const marker = !fontSize;
      element.className = marker
        ? "marker"
        : `region ${region.type} ${this.settings.displayMode === "subtle" ? "subtle" : ""}`;
      if (marker) {
        element.textContent = "⋯";
        element.style.fontSize = "";
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", `Xem bản dịch: ${text}`);
        const x = Math.min(
          width - 20,
          Math.max(0, (region.textBBox.x + region.textBBox.width) * width - 18),
        );
        let y = Math.min(height - 20, Math.max(0, region.textBBox.y * height));
        for (
          let step = 0;
          step < 8 &&
          markers.some(
            (other) => Math.abs(other.x - x) < 18 && Math.abs(other.y - y) < 18,
          );
          step++
        )
          y = Math.min(
            height - 20,
            Math.max(0, y + (step % 2 ? -1 : 1) * (step + 1) * 20),
          );
        markers.push({ x, y });
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.width = "18px";
        element.style.height = "18px";
      } else {
        element.removeAttribute("role");
        element.textContent = text;
        element.style.fontSize = `${fontSize}px`;
        element.style.setProperty("--opacity", String(this.settings.opacity));
        this.place(element, box, width, height);
      }
    }
  }

  private open(item: Item, original: boolean): void {
    clearTimeout(this.hideTimer);
    if (this.settings.showOriginal) return;
    const showOriginal =
      original &&
      this.settings.displayMode !== "hover" &&
      !item.element.classList.contains("marker");
    this.popover.textContent = showOriginal
      ? item.region.originalText
      : `${item.text}\n\nNguyên bản: ${item.region.originalText}`;
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    const popWidth = Math.min(300, Math.max(140, width - 12));
    this.popover.style.width = `${popWidth}px`;
    this.popover.style.left = `${Math.max(4, Math.min(width - popWidth - 4, item.region.textBBox.x * width))}px`;
    this.popover.style.top = `${Math.max(4, Math.min(height - 32, (item.region.textBBox.y + item.region.textBBox.height) * height + 5))}px`;
    this.popover.classList.add("open");
  }
  private toggle(item: Item, original: boolean): void {
    if (this.pinned && this.popover.classList.contains("open")) {
      this.close();
      return;
    }
    this.open(item, original);
    this.pinned = true;
  }
  private hideSoon(): void {
    clearTimeout(this.hideTimer);
    if (!this.pinned)
      this.hideTimer = window.setTimeout(
        () => this.popover.classList.remove("open"),
        120,
      );
  }
  private close(): void {
    this.pinned = false;
    this.popover.classList.remove("open");
  }

  position(): void {
    if (!this.image.isConnected) {
      this.destroy();
      return;
    }
    const rect = this.image.getBoundingClientRect();
    const fit = getComputedStyle(this.image).objectFit;
    let width = rect.width,
      height = rect.height,
      left = rect.left,
      top = rect.top;
    if (fit === "contain" || fit === "scale-down" || fit === "cover") {
      const ratio =
        fit === "cover"
          ? Math.max(
              rect.width / this.image.naturalWidth,
              rect.height / this.image.naturalHeight,
            )
          : Math.min(
              rect.width / this.image.naturalWidth,
              rect.height / this.image.naturalHeight,
            );
      width = this.image.naturalWidth * ratio;
      height = this.image.naturalHeight * ratio;
      left += (rect.width - width) / 2;
      top += (rect.height - height) / 2;
    }
    this.surface.style.clipPath =
      fit === "cover"
        ? `inset(${Math.max(0, rect.top - top)}px ${Math.max(0, left + width - rect.right)}px ${Math.max(0, top + height - rect.bottom)}px ${Math.max(0, rect.left - left)}px)`
        : "";
    this.host.style.left = `${left + scrollX}px`;
    this.host.style.top = `${top + scrollY}px`;
    this.host.style.width = `${width}px`;
    this.host.style.height = `${height}px`;
    const size = `${Math.round(width)}x${Math.round(height)}:${this.settings.displayMode}:${this.settings.fontScale}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.layout(width, height);
    }
  }
  destroy(): void {
    clearTimeout(this.hideTimer);
    this.resize.disconnect();
    this.host.remove();
  }
}
