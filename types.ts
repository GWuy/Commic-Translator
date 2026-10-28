import { z } from "zod";

export const translationSchema = z.object({
  imageId: z.string(),
  sourceLanguage: z.string(),
  targetLanguage: z.string(),
  regions: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["speech", "thought", "caption", "sound", "other"]),
        bbox: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().gt(0).max(1),
            height: z.number().gt(0).max(1),
          })
          .refine((b) => b.x + b.width <= 1.001 && b.y + b.height <= 1.001),
        originalText: z.string(),
        translatedText: z.string(),
        confidence: z.number().min(0).max(1),
        readingOrder: z.number().int().min(0),
        uncertain: z.boolean().default(false),
      }),
    )
    .max(100),
});
export type Translation = z.infer<typeof translationSchema>;

export interface Settings {
  enabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  debounceMs: number;
  displayMode: "cover" | "label";
  showOriginal: boolean;
  opacity: number;
  fontScale: number;
  disabledSites: string[];
}
export type TranslateMessage = {
  type: "TRANSLATE";
  url: string;
  imageId: string;
  imageData?: string;
  contentId?: string;
  sourceLanguage: string;
  targetLanguage: string;
};
export type Message =
  TranslateMessage | { type: "STATUS" } | { type: "CLEAR_CACHE" };
