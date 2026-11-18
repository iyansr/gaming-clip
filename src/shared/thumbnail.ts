/**
 * Cover-image styles and drawing. Isomorphic like captions.ts: the Bun generator (@napi-rs/canvas)
 * and the browser preview (CanvasRenderingContext2D) call the same code, so the preview is the output.
 */
import type { CaptionContext } from "./captions";
import { drawCamBorder, drawCamMask, type ComposeContext } from "./compose";
import type { FrameLayout, LayoutLayer } from "./layout";
import { OUTPUT_SIZE, type Size, type Watermark } from "./types";
import { drawWatermarks, type WatermarkImages } from "./watermark";

export interface ThumbnailStyle {
  id: string;
  name: string;
  /** Must be a family listed in CAPTION_FONTS (the fonts both environments load). */
  fontFamily: string;
  fontWeight: number;
  /** Font size in px at a 1080-wide frame; shrunk down to `minSize` to fit `maxLines`. */
  size: number;
  minSize: number;
  uppercase: boolean;
  maxLines: number;
  /** Line box height as a multiple of the font size. */
  lineHeight: number;
  fill: string;
  /** Colour of `*accent*` words. */
  accent: string;
  stroke: { color: string; width: number } | null;
  shadow: { color: string; blur: number; offsetY: number } | null;
  /** Solid bar behind each line (px padding at 1080). */
  bar: { fill: string; padX: number; padY: number; radius: number } | null;
  /** Rotation of the whole headline in radians. */
  tilt: number;
  /** 0..1 darkness of the gradient laid behind the headline so it reads on any frame. */
  scrim: number;
}

export const THUMBNAIL_STYLES: ThumbnailStyle[] = [
  {
    id: "impact",
    name: "Impact",
    fontFamily: "Anton",
    fontWeight: 400,
    size: 150,
    minSize: 84,
    uppercase: true,
    maxLines: 3,
    lineHeight: 1.16,
    fill: "#FFFFFF",
    accent: "#FFE600",
    stroke: { color: "#000000", width: 20 },
    shadow: { color: "rgba(0,0,0,0.9)", blur: 0, offsetY: 10 },
    bar: null,
    tilt: 0,
    scrim: 0.55,
  },
  {
    id: "banner",
    name: "Banner",
    fontFamily: "Poppins ExtraBold",
    fontWeight: 800,
    size: 100,
    minSize: 60,
    uppercase: true,
    maxLines: 3,
    lineHeight: 1.5,
    fill: "#111111",
    accent: "#E0002B",
    stroke: null,
    shadow: null,
    bar: { fill: "#FFE600", padX: 30, padY: 4, radius: 10 },
    tilt: -0.045,
    scrim: 0.3,
  },
  {
    id: "neon",
    name: "Neon",
    fontFamily: "Anton",
    fontWeight: 400,
    size: 142,
    minSize: 80,
    uppercase: true,
    maxLines: 3,
    lineHeight: 1.18,
    fill: "#FFFFFF",
    accent: "#39FF88",
    stroke: { color: "#06121A", width: 12 },
    shadow: { color: "#00E5FF", blur: 44, offsetY: 0 },
    bar: null,
    tilt: 0,
    scrim: 0.65,
  },
  {
    id: "comic",
    name: "Comic",
    fontFamily: "Bangers",
    fontWeight: 400,
    size: 164,
    minSize: 90,
    uppercase: true,
    maxLines: 3,
    lineHeight: 1.12,
    fill: "#FFF200",
    accent: "#FF3B6B",
    stroke: { color: "#000000", width: 18 },
    shadow: { color: "rgba(0,0,0,0.9)", blur: 0, offsetY: 12 },
    bar: null,
    tilt: -0.07,
    scrim: 0.4,
  },
  {
    id: "minimal",
    name: "Minimal",
    fontFamily: "Poppins SemiBold",
    fontWeight: 600,
    size: 76,
    minSize: 52,
    uppercase: false,
    maxLines: 3,
    lineHeight: 1.3,
    fill: "#FFFFFF",
    accent: "#FFD54A",
    stroke: null,
    shadow: { color: "rgba(0,0,0,0.9)", blur: 26, offsetY: 4 },
    bar: null,
    tilt: 0,
    scrim: 0.5,
  },
];

export function getThumbnailStyle(id: string): ThumbnailStyle {
  const style = THUMBNAIL_STYLES.find((candidate) => candidate.id === id);
  if (!style) {
    throw new Error(
      `Unknown thumbnail style "${id}" (known: ${THUMBNAIL_STYLES.map((candidate) => candidate.id).join(", ")})`,
    );
  }
  return style;
}

/** Structural 2D context satisfied by CanvasRenderingContext2D and @napi-rs/canvas. */
export interface ThumbnailContext extends CaptionContext, ComposeContext {
  /** The canvas being drawn on; used as a scratch source for the blur and for offscreen webcam masks. */
  canvas: unknown;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  globalCompositeOperation: string;
  fill(fillRule?: "nonzero" | "evenodd"): void;
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
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(offset: number, color: string): void };
}

/** Extra inputs of `drawThumbnail` beyond the headline. */
export interface ThumbnailOptions {
  text: string;
  styleId: string;
  textY: number;
  /** Size the layout was computed for (the source video); layer `src` rects scale by `imageSize / sourceSize`. */
  sourceSize: Size;
  /** Decoded picture for layouts with an image background (`layout.image`), and its pixel size. Without it only `layout.fill` shows. */
  backgroundImage?: { image: unknown; size: Size };
  /** Watermarks of the clip (all of them; those with `onThumbnail` are painted, under the headline) and their bitmaps. */
  watermarks?: { list: Watermark[]; images: WatermarkImages };
  /** New transparent offscreen canvas (returned as its context); needed for a webcam with a soft edge or rounded corners, and for translucent outlined watermark text. */
  createCanvas?: (width: number, height: number) => ThumbnailContext;
}

/** Split a headline into runs; `*word or phrase*` marks an accent run, an unbalanced `*` is literal. */
export function parseHeadline(text: string): { text: string; accent: boolean }[] {
  const runs: { text: string; accent: boolean }[] = [];
  const collapsed = text.replace(/\s+/g, " ").trim();
  const accentRe = /\*([^*]+)\*/g;
  let last = 0;
  for (let match = accentRe.exec(collapsed); match; match = accentRe.exec(collapsed)) {
    if (match.index > last) runs.push({ text: collapsed.slice(last, match.index), accent: false });
    runs.push({ text: match[1]!, accent: true });
    last = match.index + match[0].length;
  }
  if (last < collapsed.length) runs.push({ text: collapsed.slice(last), accent: false });
  return runs;
}

/** A word is a list of same-line parts: `RE*ALLY*` is one word with two differently coloured parts. */
interface HeadlineWord {
  parts: { text: string; accent: boolean }[];
}

function headlineWords(text: string, uppercase: boolean): HeadlineWord[] {
  const words: HeadlineWord[] = [];
  let glue = false;
  for (const run of parseHeadline(uppercase ? text.toUpperCase() : text)) {
    const pieces = run.text.split(" ");
    pieces.forEach((piece, i) => {
      if (piece === "") {
        glue = false;
        return;
      }
      // Only the first piece of a run can continue the previous run's word (no space between them).
      if (i === 0 && glue && words.length > 0) words[words.length - 1]!.parts.push({ text: piece, accent: run.accent });
      else words.push({ parts: [{ text: piece, accent: run.accent }] });
      glue = true;
    });
    glue = !run.text.endsWith(" ");
  }
  return words;
}

interface MeasuredWord extends HeadlineWord {
  width: number;
  partWidths: number[];
}

interface HeadlineLayout {
  size: number;
  space: number;
  lines: { words: MeasuredWord[]; width: number }[];
}

function wrap(words: MeasuredWord[], space: number, maxWidth: number): { words: MeasuredWord[]; width: number }[] {
  const lines: { words: MeasuredWord[]; width: number }[] = [];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && line.width + space + word.width <= maxWidth) {
      line.words.push(word);
      line.width += space + word.width;
    } else {
      lines.push({ words: [word], width: word.width });
    }
  }
  return lines;
}

const ELLIPSIS = "…";
const SHRINK_STEP = 0.94;

/** Largest font size (down to the style's floor) at which the headline fits; past the floor the text is cut with an ellipsis. */
function layoutHeadline(
  ctx: ThumbnailContext,
  words: HeadlineWord[],
  style: ThumbnailStyle,
  scale: number,
  maxWidth: number,
): HeadlineLayout {
  const measureAt = (size: number) => {
    ctx.font = `${style.fontWeight} ${size}px "${style.fontFamily}"`;
    const measured: MeasuredWord[] = words.map((word) => {
      const partWidths = word.parts.map((part) => ctx.measureText(part.text).width);
      return { ...word, partWidths, width: partWidths.reduce((sum, width) => sum + width, 0) };
    });
    return { measured, space: ctx.measureText(" ").width };
  };

  let size = style.size * scale;
  const floor = style.minSize * scale;
  for (;;) {
    const { measured, space } = measureAt(size);
    const widest = Math.max(...measured.map((word) => word.width));
    let lines = wrap(measured, space, maxWidth);
    const fits = widest <= maxWidth && lines.length <= style.maxLines;
    if (fits || size <= floor) {
      if (!fits) {
        // Still too long at the smallest size: keep what fits and mark the cut.
        lines = lines.slice(0, style.maxLines);
        const last = lines[lines.length - 1]!;
        const tail = last.words[last.words.length - 1]!;
        const cut = tail.parts[tail.parts.length - 1]!;
        cut.text = `${cut.text.replace(/[.,!?;:]+$/, "")}${ELLIPSIS}`;
        const { measured: again } = measureAt(size);
        const byWord = new Map(measured.map((word, i) => [word, again[i]!]));
        lines = lines.map((line) => {
          const remeasured = line.words.map((word) => byWord.get(word)!);
          return {
            words: remeasured,
            width: remeasured.reduce((sum, word) => sum + word.width, 0) + space * (remeasured.length - 1),
          };
        });
      } else {
        // Balance: the narrowest wrap width that keeps the same number of lines.
        let lo = widest;
        let hi = maxWidth;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (wrap(measured, space, mid).length <= lines.length) hi = mid;
          else lo = mid;
        }
        lines = wrap(measured, space, hi);
      }
      return { size, space, lines };
    }
    size = Math.max(floor, size * SHRINK_STEP);
  }
}

/** Passes of the low-resolution blur: the crop is shrunk by this factor per pass, then scaled back up. */
const BLUR_SHRINK = [6, 4];

/** `k` scales the layout's output pixels to canvas pixels; `sx`/`sy` scale source pixels to image pixels. */
function drawLayer(
  ctx: ThumbnailContext,
  image: unknown,
  layer: LayoutLayer,
  k: number,
  sx: number,
  sy: number,
  createCanvas: ThumbnailOptions["createCanvas"],
): void {
  const { src } = layer;
  const source = image as never;
  const dst = { x: layer.dst.x * k, y: layer.dst.y * k, w: layer.dst.w * k, h: layer.dst.h * k };
  if (!layer.blur) {
    const style = layer.cam;
    if (!style) {
      ctx.drawImage(source, src.x * sx, src.y * sy, src.w * sx, src.h * sy, dst.x, dst.y, dst.w, dst.h);
      return;
    }
    const scaled = {
      feather: style.feather * k,
      radius: style.radius * k,
      border: style.border * k,
      borderColor: style.borderColor,
    };
    if (style.feather > 0 || style.radius > 0) {
      if (!createCanvas)
        throw new Error("drawThumbnail needs opts.createCanvas to draw a webcam with a soft edge or rounded corners");
      // Mask first, then the picture only where the mask is opaque (source-in), then the result onto the cover.
      const w = Math.max(1, Math.round(dst.w));
      const h = Math.max(1, Math.round(dst.h));
      const cam = createCanvas(w, h);
      cam.imageSmoothingEnabled = true;
      cam.imageSmoothingQuality = "high";
      drawCamMask(cam, w, h, scaled);
      cam.globalCompositeOperation = "source-in";
      cam.drawImage(source, src.x * sx, src.y * sy, src.w * sx, src.h * sy, 0, 0, w, h);
      ctx.drawImage(cam.canvas as never, 0, 0, w, h, dst.x, dst.y, dst.w, dst.h);
    } else {
      ctx.drawImage(source, src.x * sx, src.y * sy, src.w * sx, src.h * sy, dst.x, dst.y, dst.w, dst.h);
    }
    ctx.save();
    ctx.translate(dst.x, dst.y);
    drawCamBorder(ctx, dst.w, dst.h, scaled);
    ctx.restore();
    return;
  }
  // Blur without ctx.filter (support differs between browsers and node canvas): shrink the crop
  // into the corner of its own destination in steps, then stretch that tiny copy back over it.
  // Reading the canvas back needs canvas pixels == these coordinates, hence the identity-transform rule.
  const self = ctx.canvas as never;
  let w = dst.w;
  let h = dst.h;
  BLUR_SHRINK.forEach((factor, pass) => {
    const nw = Math.max(2, Math.round(w / factor));
    const nh = Math.max(2, Math.round(h / factor));
    if (pass === 0) ctx.drawImage(source, src.x * sx, src.y * sy, src.w * sx, src.h * sy, dst.x, dst.y, nw, nh);
    else ctx.drawImage(self, dst.x, dst.y, w, h, dst.x, dst.y, nw, nh);
    w = nw;
    h = nh;
  });
  for (const factor of BLUR_SHRINK.slice(1).reverse()) {
    const nw = w * factor;
    const nh = h * factor;
    ctx.drawImage(self, dst.x, dst.y, w, h, dst.x, dst.y, nw, nh);
    w = nw;
    h = nh;
  }
  ctx.drawImage(self, dst.x, dst.y, w, h, dst.x, dst.y, dst.w, dst.h);
}

function roundedRect(ctx: ThumbnailContext, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const TEXT_WIDTH = 0.88;
const EDGE_MARGIN = 0.03;

/**
 * Paint the whole cover in output pixels (`frame`, everything scales with frame.width / 1080):
 * the layout's layers cut from `image`, then the style's scrim and the headline centred at textY.
 *
 * `layout` is in source-video pixels (`opts.sourceSize`); `image` is that frame at any uniform
 * scale, `imageSize` its actual size. An empty headline draws the frame only.
 * The canvas must be exactly `frame` pixels with an identity transform (the blur reads it back).
 */
export function drawThumbnail(
  ctx: ThumbnailContext,
  image: unknown,
  imageSize: Size,
  layout: FrameLayout,
  opts: ThumbnailOptions,
  frame: Size,
): void {
  const style = getThumbnailStyle(opts.styleId);
  const scale = frame.width / 1080;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = layout.fill;
  ctx.fillRect(0, 0, frame.width, frame.height);
  const { backgroundImage } = opts;
  if (layout.image && backgroundImage) {
    // Cover-fit: scale to fill the frame, crop the overflow evenly.
    const fit = Math.max(frame.width / backgroundImage.size.width, frame.height / backgroundImage.size.height);
    const cropW = frame.width / fit;
    const cropH = frame.height / fit;
    ctx.drawImage(
      backgroundImage.image as never,
      (backgroundImage.size.width - cropW) / 2,
      (backgroundImage.size.height - cropH) / 2,
      cropW,
      cropH,
      0,
      0,
      frame.width,
      frame.height,
    );
  }
  // The layout targets the full-size output; `frame` may be a scaled preview of it.
  const k = frame.width / OUTPUT_SIZE.width;
  for (const layer of layout.layers) {
    drawLayer(
      ctx,
      image,
      layer,
      k,
      imageSize.width / opts.sourceSize.width,
      imageSize.height / opts.sourceSize.height,
      opts.createCanvas,
    );
  }
  ctx.restore();
  if (opts.watermarks) {
    const list = opts.watermarks.list.filter((wm) => wm.onThumbnail);
    drawWatermarks(ctx, list, opts.watermarks.images, frame, opts.createCanvas);
  }

  const words = headlineWords(opts.text, style.uppercase);
  if (words.length === 0) return;

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  const { size, space, lines } = layoutHeadline(ctx, words, style, scale, frame.width * TEXT_WIDTH);
  ctx.font = `${style.fontWeight} ${size}px "${style.fontFamily}"`;
  const lineH = size * style.lineHeight;
  const blockH = lineH * lines.length;
  const margin = frame.height * EDGE_MARGIN;
  const centerY = Math.min(
    Math.max(opts.textY * frame.height, blockH / 2 + margin),
    frame.height - blockH / 2 - margin,
  );

  if (style.scrim > 0) {
    const reach = blockH / 2 + size * 1.6;
    const top = Math.max(0, centerY - reach);
    const bottom = Math.min(frame.height, centerY + reach);
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(0.35, `rgba(0,0,0,${style.scrim})`);
    gradient.addColorStop(0.65, `rgba(0,0,0,${style.scrim})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, top, frame.width, bottom - top);
  }

  ctx.translate(frame.width / 2, centerY);
  ctx.rotate(style.tilt);
  // A single word wider than the frame even at the smallest size: squeeze the block to fit.
  const squeeze = Math.min(1, (frame.width * TEXT_WIDTH) / Math.max(...lines.map((line) => line.width)));
  ctx.scale(squeeze, squeeze);
  const capHeight = ctx.measureText("H").actualBoundingBoxAscent;
  const placed = lines.flatMap((line, row) => {
    const baseline = -blockH / 2 + row * lineH + (lineH + capHeight) / 2;
    let x = -line.width / 2;
    return line.words.flatMap((word) => {
      const parts = word.parts.map((part, i) => {
        const at = { text: part.text, accent: part.accent, x, y: baseline };
        x += word.partWidths[i]!;
        return at;
      });
      x += space;
      return parts;
    });
  });

  if (style.bar) {
    const { fill, padX, padY, radius } = style.bar;
    ctx.fillStyle = fill;
    lines.forEach((line, row) => {
      const top = -blockH / 2 + row * lineH + padY * scale;
      roundedRect(
        ctx,
        -line.width / 2 - padX * scale,
        top,
        line.width + 2 * padX * scale,
        lineH - 2 * padY * scale,
        radius * scale,
      );
      ctx.fill();
    });
  }

  const applyShadow = () => {
    if (!style.shadow) return;
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
  };
  // All strokes before any fill, so a neighbour's outline never covers a letter.
  if (style.stroke) {
    ctx.save();
    applyShadow();
    ctx.strokeStyle = style.stroke.color;
    ctx.lineWidth = (style.stroke.width * size) / style.size;
    for (const part of placed) ctx.strokeText(part.text, part.x, part.y);
    ctx.restore();
  } else {
    applyShadow();
  }
  for (const part of placed) {
    ctx.fillStyle = part.accent ? style.accent : style.fill;
    ctx.fillText(part.text, part.x, part.y);
  }
  ctx.restore();
}
