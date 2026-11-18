import { drawCamBorder, drawCamMask } from "../../shared/compose";
import { flashAlphaAt, frameTransformAt, overlayStateAt } from "../../shared/effects";
import type { FrameLayout, LayoutLayer } from "../../shared/layout";
import type { LookId, LookItem, Rect, Size, TimelineItem } from "../../shared/types";
import { drawWatermarks, type WatermarkImages } from "../../shared/watermark";
import { sharedOffscreen } from "./watermarks";

/** Same low-resolution blur the renderer uses (render.ts BLUR_DOWNSCALE / BLUR_SIGMA). */
const BLUR_DOWNSCALE = 8;
const BLUR_SIGMA = 6;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available in this browser");
  return ctx;
}

/**
 * Paints a FrameLayout onto the preview canvas the way the renderer composes the short: base colour,
 * background image (cover-fit), layers in order, the webcam through its feathered/rounded mask, then its border.
 * Owns its scratch canvases, so a frame allocates nothing once sizes are stable.
 */
export class LayoutPainter {
  private readonly blur = document.createElement("canvas");
  private readonly blurCtx = context2d(this.blur);
  private readonly cam = document.createElement("canvas");
  private readonly camCtx = context2d(this.cam);
  private readonly mask = document.createElement("canvas");
  private readonly maskCtx = context2d(this.mask);
  private maskKey = "";

  paint(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    layout: FrameLayout,
    image: HTMLImageElement | null,
    output: Size,
  ): void {
    ctx.fillStyle = layout.fill;
    ctx.fillRect(0, 0, output.width, output.height);
    if (image) {
      const scale = Math.max(output.width / image.naturalWidth, output.height / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      ctx.drawImage(image, (output.width - w) / 2, (output.height - h) / 2, w, h);
    }

    for (const { src, dst, blur, cam } of layout.layers) {
      if (blur) {
        const w = Math.max(2, Math.round(dst.w / BLUR_DOWNSCALE));
        const h = Math.max(2, Math.round(dst.h / BLUR_DOWNSCALE));
        if (this.blur.width !== w || this.blur.height !== h) {
          this.blur.width = w;
          this.blur.height = h;
        }
        this.blurCtx.filter = `blur(${BLUR_SIGMA}px)`;
        this.blurCtx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, w, h);
        ctx.drawImage(this.blur, 0, 0, w, h, dst.x, dst.y, dst.w, dst.h);
      } else if (cam) {
        this.paintCam(ctx, video, src, dst, cam);
      } else {
        ctx.drawImage(video, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
      }
    }
  }

  private paintCam(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    src: Rect,
    dst: Rect,
    style: NonNullable<LayoutLayer["cam"]>,
  ): void {
    const w = Math.round(dst.w);
    const h = Math.round(dst.h);
    if (w < 1 || h < 1) return;
    if (this.cam.width !== w || this.cam.height !== h) {
      this.cam.width = w;
      this.cam.height = h;
    }
    const key = `${w}x${h}/${style.feather}/${style.radius}`;
    if (key !== this.maskKey) {
      this.maskKey = key;
      this.mask.width = w;
      this.mask.height = h;
      drawCamMask(this.maskCtx, w, h, style);
    }
    const cam = this.camCtx;
    cam.globalCompositeOperation = "source-over";
    cam.clearRect(0, 0, w, h);
    cam.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, w, h);
    cam.globalCompositeOperation = "destination-in";
    cam.drawImage(this.mask, 0, 0);
    ctx.drawImage(this.cam, dst.x, dst.y, dst.w, dst.h);

    if (style.border > 0) {
      ctx.save();
      ctx.translate(dst.x, dst.y);
      drawCamBorder(ctx, w, h, style);
      ctx.restore();
    }
  }
}

/** Canvas twins of the renderer's looks (src/core/render.ts), on a 1080-wide frame. */
const LOOK_FILTER: Record<LookId, string> = {
  deepfry: "contrast(1.8) saturate(3) brightness(1.06)",
  bw: "grayscale(1)",
  blur: "blur(16px)",
};

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Everything FramePainter needs for one frame; `items` and `t` are clip-relative (relativeItems). */
export interface FrameInput {
  video: HTMLVideoElement;
  layout: FrameLayout;
  image: HTMLImageElement | null;
  output: Size;
  items: TimelineItem[];
  t: number;
}

/**
 * The layout stage of the paint order: layout -> look -> zoom/shake. The layout is composed once into an offscreen
 * frame (only when a look or a zoom/shake is active), the look is applied to it as a canvas filter, and the result
 * is blitted with frameTransformAt's translate/scale, so it matches the renderer's scale-then-crop exactly.
 */
export class FramePainter {
  private readonly layout = new LayoutPainter();
  private readonly surfaces: (Surface | null)[] = [null, null];

  private surface(slot: 0 | 1, size: Size): Surface {
    let s = this.surfaces[slot];
    if (!s) {
      const canvas = document.createElement("canvas");
      s = { canvas, ctx: context2d(canvas) };
      this.surfaces[slot] = s;
    }
    if (s.canvas.width !== size.width || s.canvas.height !== size.height) {
      s.canvas.width = size.width;
      s.canvas.height = size.height;
    }
    return s;
  }

  paint(ctx: CanvasRenderingContext2D, { video, layout, image, output, items, t }: FrameInput): void {
    const looks = items
      .filter((i): i is LookItem => i.kind === "look" && t >= i.start && t < i.end)
      .map((i) => LOOK_FILTER[i.look])
      .join(" ");
    const { scale, ox, oy } = frameTransformAt(items, t, output);
    const moved = scale !== 1 || ox !== 0 || oy !== 0;
    if (looks === "" && !moved) {
      this.layout.paint(ctx, video, layout, image, output);
      return;
    }

    const flat = this.surface(0, output);
    this.layout.paint(flat.ctx, video, layout, image, output);
    let source = flat.canvas;
    if (looks !== "") {
      const looked = this.surface(1, output);
      looked.ctx.clearRect(0, 0, output.width, output.height);
      looked.ctx.filter = looks;
      looked.ctx.drawImage(flat.canvas, 0, 0);
      looked.ctx.filter = "none";
      source = looked.canvas;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.scale(scale, scale);
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }
}

/**
 * Timed text and stickers over the frame: each element is scaled about its centre and offset by overlayStateAt and
 * drawn through drawWatermarks with its opacity times the fade. Text waits for the caption fonts.
 */
export function drawOverlayItems(
  ctx: CanvasRenderingContext2D,
  items: TimelineItem[],
  t: number,
  images: WatermarkImages,
  output: Size,
  fontsReady: boolean,
): void {
  for (const item of items) {
    if (item.kind !== "overlay") continue;
    const state = overlayStateAt(item, t);
    const el = item.element;
    if (!state || (el.kind === "text" && !fontsReady)) continue;
    ctx.save();
    ctx.translate(el.x + state.dx, el.y + state.dy);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-el.x, -el.y);
    drawWatermarks(ctx, [{ ...el, opacity: el.opacity * state.alpha }], images, output, sharedOffscreen);
    ctx.restore();
  }
}

/** Solid flashes over the frame, fading out over each item. */
export function drawFlashes(ctx: CanvasRenderingContext2D, items: TimelineItem[], t: number, output: Size): void {
  for (const item of items) {
    if (item.kind !== "flash") continue;
    const alpha = flashAlphaAt(item, t);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = item.color;
    ctx.fillRect(0, 0, output.width, output.height);
  }
  ctx.globalAlpha = 1;
}

/** Paints an intro/outro video cover-fit over the whole frame, like the renderer scales it; black until it has a frame. */
export function drawCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, output: Size): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, output.width, output.height);
  if (video.readyState < 2 || video.videoWidth === 0) return;
  const scale = Math.max(output.width / video.videoWidth, output.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  ctx.drawImage(video, (output.width - w) / 2, (output.height - h) / 2, w, h);
}
