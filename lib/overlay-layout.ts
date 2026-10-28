import type { BBox, Translation } from "../types";

export type PlannedRegion = {
  id: string;
  type: Translation["regions"][number]["type"];
  textBBox: BBox;
  bubbleBBox?: BBox;
  renderBBox: BBox;
  originalText: string;
  translatedText: string;
  fallbackOnly: boolean;
};

function intersection(a: BBox, b: BBox): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
function sameBubble(a: BBox, b: BBox): boolean {
  return (
    intersection(a, b) / Math.min(a.width * a.height, b.width * b.height) > 0.72
  );
}
function union(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
function inset(box: BBox, fraction: number): BBox {
  const dx = box.width * fraction,
    dy = box.height * fraction;
  return {
    x: box.x + dx,
    y: box.y + dy,
    width: box.width - 2 * dx,
    height: box.height - 2 * dy,
  };
}
function tightTextBox(box: BBox): BBox {
  const dx = Math.min(0.015, Math.max(0.004, box.width * 0.08));
  const dy = Math.min(0.012, Math.max(0.004, box.height * 0.08));
  const x = Math.max(0, box.x - dx),
    y = Math.max(0, box.y - dy);
  return {
    x,
    y,
    width: Math.min(1 - x, box.width + 2 * dx),
    height: Math.min(1 - y, box.height + 2 * dy),
  };
}

export function planRegions(result: Translation): PlannedRegion[] {
  const planned: PlannedRegion[] = [];
  for (const region of [...result.regions].sort(
    (a, b) => a.readingOrder - b.readingOrder,
  )) {
    const textBBox = region.textBBox ?? region.bbox;
    if (!region.translatedText.trim()) continue;
    if (
      region.originalText.trim().length < 2 &&
      region.translatedText.trim().length < 2 &&
      textBBox.width * textBBox.height < 0.004
    )
      continue;
    const bubble = region.bubbleBBox ?? undefined;
    const match =
      bubble && region.type === "speech"
        ? planned.find(
            (p) =>
              p.type === "speech" &&
              p.bubbleBBox &&
              sameBubble(p.bubbleBBox, bubble),
          )
        : undefined;
    if (match) {
      match.textBBox = union(match.textBBox, textBBox);
      match.bubbleBBox = union(match.bubbleBBox!, bubble!);
      match.renderBBox = inset(match.bubbleBBox, 0.09);
      match.originalText += ` ${region.originalText.trim()}`;
      match.translatedText += ` ${region.translatedText.trim()}`;
      continue;
    }
    const renderBBox =
      bubble && region.type === "speech"
        ? inset(bubble, 0.09)
        : tightTextBox(textBBox);
    planned.push({
      id: region.id,
      type: region.type,
      textBBox,
      bubbleBBox: bubble,
      renderBBox,
      originalText: region.originalText.trim(),
      translatedText: region.translatedText.trim(),
      fallbackOnly: region.type === "sound" && !bubble,
    });
  }
  for (let i = 0; i < planned.length; i++) {
    const current = planned[i]!;
    if (current.fallbackOnly) continue;
    for (let j = 0; j < i; j++) {
      const earlier = planned[j]!;
      if (earlier.fallbackOnly) continue;
      const overlap = intersection(current.renderBBox, earlier.renderBBox);
      if (
        overlap /
          Math.min(
            current.renderBBox.width * current.renderBBox.height,
            earlier.renderBBox.width * earlier.renderBBox.height,
          ) >
        0.1
      ) {
        current.fallbackOnly = true;
        break;
      }
    }
  }
  return planned;
}
