import { useMemo } from "react";

import { CAPTION_FONTS } from "../../shared/captions";
import type { ImageWatermark, TextWatermark, Watermark } from "../../shared/types";
import { measureWatermark, type WatermarkContext, type WatermarkImages } from "../../shared/watermark";
import { useAssetImages } from "./images";

/** Size limits the server enforces (parseSettingsPatch). */
export const WM_SIZE = { min: 8, max: 400 } as const;
export const WM_WIDTH = { min: 16, max: 2160 } as const;
export const WM_STROKE_MAX = 40;
export const WM_TEXT_MAX = 120;

export interface WatermarkUi {
  /** Id of the selected overlay (box on the canvas, row in the panel), or null. */
  selected: string | null;
}

/** Transparent scratch canvas as a 2D context, for drawWatermarks / drawThumbnail. */
export function createOffscreen(width: number, height: number): WatermarkContext {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available in this browser");
  return ctx;
}

let measuring: CanvasRenderingContext2D | null = null;

function measureContext(): CanvasRenderingContext2D {
  if (!measuring) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available in this browser");
    measuring = ctx;
  }
  return measuring;
}

/** Decoded bitmaps of the image overlays, in the shape drawWatermarks wants. Loaded once per file and cached. */
export function useWatermarkImages(projectId: string, watermarks: Watermark[]): WatermarkImages {
  const files = useMemo(
    () => [...new Set(watermarks.flatMap((w) => (w.kind === "image" ? [w.file] : [])))],
    [watermarks],
  );
  const images = useAssetImages(projectId, files);
  return useMemo(
    () =>
      new Map(
        [...images].map(([file, image]) => [file, { image, width: image.naturalWidth, height: image.naturalHeight }]),
      ),
    [images],
  );
}

/** What to paint now: text overlays wait until the caption fonts are loaded, so no frame shows a fallback font. */
export function drawableWatermarks(watermarks: Watermark[], fontsReady: boolean): Watermark[] {
  return fontsReady ? watermarks : watermarks.filter((w) => w.kind === "image");
}

export interface WatermarkBox {
  w: number;
  h: number;
}

/** Unrotated box (output px) of every overlay that can be drawn right now, keyed by id. */
export function useWatermarkBoxes(
  watermarks: Watermark[],
  images: WatermarkImages,
  fontsReady: boolean,
): Map<string, WatermarkBox> {
  return useMemo(() => {
    const boxes = new Map<string, WatermarkBox>();
    for (const wm of drawableWatermarks(watermarks, fontsReady)) {
      const box = measureWatermark(measureContext(), wm, images);
      if (box) boxes.set(wm.id, box);
    }
    return boxes;
  }, [watermarks, images, fontsReady]);
}

export function newWatermarkId(taken: Watermark[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = [...bytes].map((b) => (b % 36).toString(36)).join("");
    if (!taken.some((w) => w.id === id)) return id;
  }
}

export function newTextWatermark(taken: Watermark[]): TextWatermark {
  return {
    id: newWatermarkId(taken),
    kind: "text",
    x: 540,
    y: 1700,
    rotation: 0,
    opacity: 0.85,
    onThumbnail: false,
    text: "@yourname",
    font: CAPTION_FONTS[0]!.family,
    size: 64,
    color: "#ffffff",
    stroke: 4,
    strokeColor: "#000000",
  };
}

/** A logo-sized image in the top-right corner, kept at most 240 px wide. */
export function newImageWatermark(taken: Watermark[], file: string, natural: { width: number; height: number }) {
  const width = Math.max(WM_WIDTH.min, Math.min(240, natural.width));
  const height = (width * natural.height) / natural.width;
  const wm: ImageWatermark = {
    id: newWatermarkId(taken),
    kind: "image",
    x: Math.round(1080 - 40 - width / 2),
    y: Math.round(40 + height / 2),
    rotation: 0,
    opacity: 1,
    onThumbnail: false,
    file,
    width,
  };
  return wm;
}
