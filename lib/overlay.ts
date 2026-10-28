import type { Settings, Translation } from "../types";

export class Overlay {
  private host = document.createElement("div");
  private shadow = this.host.attachShadow({ mode: "closed" });
  private resize = new ResizeObserver(() => this.position());
  constructor(
    private image: HTMLImageElement,
    private result: Translation,
    private settings: Settings,
  ) {
    this.host.style.cssText =
      "position:absolute;z-index:2147483640;pointer-events:none;";
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}.region{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;overflow-wrap:anywhere;border-radius:6px;padding:2px 4px;pointer-events:auto;cursor:text;font-family:Arial,sans-serif;line-height:1.12;box-shadow:0 1px 5px #0004}.region:hover .translated,.region:focus .translated{display:none}.region:hover .original,.region:focus .original{display:block}.original{display:none}.region.label{background:#181c27ee;color:white;height:auto!important;min-height:20px}.region.hidden{display:none}`;
    this.shadow.append(style);
    for (const region of result.regions) {
      const box = document.createElement("div");
      box.className = `region ${settings.displayMode === "label" ? "label" : ""} ${settings.showOriginal ? "hidden" : ""}`;
      box.title = "Di chuột hoặc nhấp để xem bản gốc";
      box.tabIndex = 0;
      box.style.left = `${region.bbox.x * 100}%`;
      box.style.top = `${region.bbox.y * 100}%`;
      box.style.width = `${region.bbox.width * 100}%`;
      box.style.height = `${region.bbox.height * 100}%`;
      box.style.background =
        settings.displayMode === "cover"
          ? `rgba(255,255,255,${settings.opacity})`
          : "";
      box.style.color = settings.displayMode === "cover" ? "#17243b" : "";
      const translated = document.createElement("span");
      translated.className = "translated";
      translated.textContent = region.translatedText;
      const original = document.createElement("span");
      original.className = "original";
      original.textContent = region.originalText;
      box.append(translated, original);
      this.shadow.append(box);
    }
    document.body.append(this.host);
    this.resize.observe(image);
    this.position();
  }
  update(settings: Settings): void {
    this.settings = settings;
    this.shadow.querySelectorAll<HTMLElement>(".region").forEach((el) => {
      el.classList.toggle("hidden", settings.showOriginal);
      el.classList.toggle("label", settings.displayMode === "label");
      el.style.background =
        settings.displayMode === "cover"
          ? `rgba(255,255,255,${settings.opacity})`
          : "";
      el.style.color = settings.displayMode === "cover" ? "#17243b" : "";
    });
    this.position();
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
    if (fit === "contain" || fit === "scale-down") {
      const scale = Math.min(
        rect.width / this.image.naturalWidth,
        rect.height / this.image.naturalHeight,
      );
      width = this.image.naturalWidth * scale;
      height = this.image.naturalHeight * scale;
      left += (rect.width - width) / 2;
      top += (rect.height - height) / 2;
    } else if (fit === "cover") {
      const scale = Math.max(
        rect.width / this.image.naturalWidth,
        rect.height / this.image.naturalHeight,
      );
      width = this.image.naturalWidth * scale;
      height = this.image.naturalHeight * scale;
      left += (rect.width - width) / 2;
      top += (rect.height - height) / 2;
      this.host.style.clipPath = `inset(${Math.max(0, rect.top - top)}px ${Math.max(0, left + width - rect.right)}px ${Math.max(0, top + height - rect.bottom)}px ${Math.max(0, rect.left - left)}px)`;
    } else this.host.style.clipPath = "";
    this.host.style.left = `${left + scrollX}px`;
    this.host.style.top = `${top + scrollY}px`;
    this.host.style.width = `${width}px`;
    this.host.style.height = `${height}px`;
    this.shadow
      .querySelectorAll<HTMLElement>(".region")
      .forEach((el, index) => {
        const region = this.result.regions[index];
        if (!region) return;
        el.style.fontSize = `${Math.max(9, Math.min(28, Math.sqrt(width * region.bbox.width * height * region.bbox.height) / 5)) * this.settings.fontScale}px`;
      });
  }
  destroy(): void {
    this.resize.disconnect();
    this.host.remove();
  }
}
