/**
 * Watermark drawing shared by the renderer (@napi-rs/canvas -> one transparent PNG for ffmpeg), the thumbnail
 * generator and the browser preview/editor (CanvasRenderingContext2D). Isomorphic: only type imports.
 */
import { CAPTION_FONTS } from "./captions";
import type { ImageWatermark, Size, TextWatermark, Watermark } from "./types";

export const MAX_WATERMARKS = 5;

const CAP_MEASURE_SIZE = 1000;

/** Line box of a text watermark as a multiple of its font size. */
const TEXT_LINE_HEIGHT = 1.2;

/** Structural 2D context satisfied by CanvasRenderingContext2D and @napi-rs/canvas (and by ThumbnailContext). */
export interface WatermarkContext {
  /** The canvas being drawn on; only handed back to `drawImage` when a translucent outlined text is composited. */
  canvas: unknown;
  font: string;
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  miterLimit: number;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number; actualBoundingBoxAscent: number };
  drawImage(
    image: never,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Decoded bitmap of an image watermark; width/height are its natural pixel size. */
export interface WatermarkImage {
  image: unknown;
  width: number;
  height: number;
}

/** Bitmaps of the image watermarks, keyed by `ImageWatermark.file`. */
export type WatermarkImages = Map<string, WatermarkImage>;

/** New transparent offscreen canvas of the given size, returned as its 2D context. */
export type WatermarkCanvasFactory = (width: number, height: number) => WatermarkContext;

function fontOf(wm: TextWatermark, size: number): string {
  const font = CAPTION_FONTS.find((candidate) => candidate.family === wm.font);
  if (!font) throw new Error(`Unknown watermark font "${wm.font}"`);
  return `${font.weight} ${size}px "${font.family}"`;
}

/**
 * Box of one watermark in output pixels (1080-wide frame) before rotation, centred on the watermark's x/y.
 * Text: measured width + the outline on both sides, by `size * 1.2` + the outline (the line box is centred on the
 * middle of the capitals). Image: `width` by the bitmap's aspect. Null for an image that is not in `images`.
 */
export function measureWatermark(
  ctx: WatermarkContext,
  wm: Watermark,
  images: WatermarkImages,
): { w: number; h: number } | null {
  if (wm.kind === "image") {
    const bitmap = images.get(wm.file);
    return bitmap ? { w: wm.width, h: (wm.width * bitmap.height) / bitmap.width } : null;
  }
  ctx.save();
  ctx.font = fontOf(wm, wm.size);
  const { width } = ctx.measureText(wm.text);
  ctx.restore();
  return { w: width + 2 * wm.stroke, h: wm.size * TEXT_LINE_HEIGHT + 2 * wm.stroke };
}

/** Moves the origin to the watermark's centre and rotates; `k` scales output pixels to canvas pixels. */
function place(ctx: WatermarkContext, wm: Watermark, k: number): void {
  ctx.translate(wm.x * k, wm.y * k);
  ctx.rotate((wm.rotation * Math.PI) / 180);
}

function paintText(ctx: WatermarkContext, wm: TextWatermark, k: number): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  // The line box is centred on the middle of the capitals, whatever the font's ascent and descent. The cap height is
  // measured at a large size: engines round glyph bounds to whole pixels (differently) at small ones.
  ctx.font = fontOf(wm, CAP_MEASURE_SIZE);
  const baseline = ((ctx.measureText("H").actualBoundingBoxAscent / CAP_MEASURE_SIZE) * wm.size * k) / 2;
  ctx.font = fontOf(wm, wm.size * k);
  if (wm.stroke > 0) {
    // Half of the stroke lies under the fill, so the visible outline is `stroke` px wide.
    ctx.strokeStyle = wm.strokeColor;
    ctx.lineWidth = 2 * wm.stroke * k;
    ctx.strokeText(wm.text, 0, baseline);
  }
  ctx.fillStyle = wm.color;
  ctx.fillText(wm.text, 0, baseline);
}

function paintImage(ctx: WatermarkContext, wm: ImageWatermark, bitmap: WatermarkImage, k: number): void {
  const w = wm.width * k;
  const h = (w * bitmap.height) / bitmap.width;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap.image as never, 0, 0, bitmap.width, bitmap.height, -w / 2, -h / 2, w, h);
}

/**
 * Paints the watermarks in order, in output coordinates scaled by `frame.width / 1080` (watermarks reaching past
 * the frame are clipped by the canvas). Images missing from `images` are skipped. Expects an untransformed
 * context and leaves it as found.
 *
 * Text with an outline and opacity below 1 is first drawn opaque on a scratch canvas (`createCanvas`, frame-sized)
 * and composited once at the opacity; drawn directly, the fill would blend over the half of the outline beneath it.
 * `createCanvas` is required for exactly that case.
 */
export function drawWatermarks(
  ctx: WatermarkContext,
  watermarks: Watermark[],
  images: WatermarkImages,
  frame: Size,
  createCanvas?: WatermarkCanvasFactory,
): void {
  const k = frame.width / 1080;
  let scratch: WatermarkContext | null = null;
  for (const wm of watermarks) {
    if (wm.kind === "image") {
      const bitmap = images.get(wm.file);
      if (!bitmap) continue;
      ctx.save();
      ctx.globalAlpha = wm.opacity;
      place(ctx, wm, k);
      paintImage(ctx, wm, bitmap, k);
      ctx.restore();
    } else if (wm.opacity >= 1 || wm.stroke <= 0) {
      ctx.save();
      ctx.globalAlpha = wm.opacity;
      place(ctx, wm, k);
      paintText(ctx, wm, k);
      ctx.restore();
    } else {
      if (!createCanvas) throw new Error("drawWatermarks needs createCanvas to draw translucent text with an outline");
      scratch ??= createCanvas(frame.width, frame.height);
      scratch.clearRect(0, 0, frame.width, frame.height);
      scratch.save();
      place(scratch, wm, k);
      paintText(scratch, wm, k);
      scratch.restore();
      ctx.save();
      ctx.globalAlpha = wm.opacity;
      ctx.drawImage(scratch.canvas as never, 0, 0, frame.width, frame.height, 0, 0, frame.width, frame.height);
      ctx.restore();
    }
  }
}
