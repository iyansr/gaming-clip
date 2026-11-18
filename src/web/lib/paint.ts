import { drawCamBorder, drawCamMask } from "../../shared/compose";
import type { FrameLayout, LayoutLayer } from "../../shared/layout";
import type { Rect, Size } from "../../shared/types";

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
