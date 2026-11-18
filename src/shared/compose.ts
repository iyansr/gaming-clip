/**
 * Webcam styling shared by the renderer (@napi-rs/canvas -> PNGs for ffmpeg), the thumbnail generator and the
 * browser preview (CanvasRenderingContext2D). Isomorphic: no runtime imports, no `ctx.filter`, so every
 * environment gets the same pixels. The soft edge is a Gaussian-blurred shadow of the shape drawn far outside
 * the canvas (shadow offsets ignore the transform and are not clipped away with the shape).
 */

/** Structural 2D context satisfied by CanvasRenderingContext2D and @napi-rs/canvas. */
export interface ComposeContext {
  fillStyle: string | object;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  closePath(): void;
  fill(fillRule?: "nonzero" | "evenodd"): void;
}

/** Gaussian sigma as a share of the feather width: the edge goes 0 -> 1 across `feather` px (within 0.6%). */
const SIGMA_PER_FEATHER = 0.2;

interface Shape {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** Effective feather width. */
  soft: number;
}

/**
 * The 50% contour of the cam: the element box inset by half the feather, so the soft edge stays
 * inside the box. Radius is the box radius shrunk by the same inset, never beyond half the shorter side.
 */
function camShape(w: number, h: number, feather: number, radius: number): Shape {
  const short = Math.min(w, h);
  // At most half the shorter side, so a core always remains.
  const soft = Math.min(Math.max(0, feather), short / 2);
  const inset = soft / 2;
  const sw = w - 2 * inset;
  const sh = h - 2 * inset;
  const boxRadius = Math.min(Math.max(0, radius), short / 2);
  return { x: inset, y: inset, w: sw, h: sh, r: Math.min(Math.max(0, boxRadius - inset), Math.min(sw, sh) / 2), soft };
}

function roundedRect(ctx: ComposeContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Paints the webcam alpha mask into a w x h canvas: opaque (black) inside a rounded rect of `radius`,
 * fading to transparent over `feather` px at the edges. `radius` is clamped to half the shorter side,
 * `feather` too. Expects a transparent canvas and an untransformed or translate-only context.
 */
export function drawCamMask(
  ctx: ComposeContext,
  w: number,
  h: number,
  style: { feather: number; radius: number },
): void {
  const shape = camShape(w, h, style.feather, style.radius);
  const { soft } = shape;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  if (soft === 0) {
    roundedRect(ctx, shape.x, shape.y, shape.w, shape.h, shape.r);
  } else {
    // Canvas shadow blur: sigma = shadowBlur / 2. The shape sits one canvas width to the left; its shadow comes back.
    const away = w + 4 * soft + 16;
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2 * SIGMA_PER_FEATHER * soft;
    ctx.shadowOffsetX = away;
    ctx.shadowOffsetY = 0;
    roundedRect(ctx, shape.x - away, shape.y, shape.w, shape.h, shape.r);
  }
  ctx.fill();
  ctx.restore();
}

/**
 * Paints only the border ring (if border > 0) for a w x h cam element: it hugs the 50% contour of the
 * feathered mask and grows inwards, with the same corner radius.
 */
export function drawCamBorder(
  ctx: ComposeContext,
  w: number,
  h: number,
  style: { feather: number; radius: number; border: number; borderColor: string },
): void {
  if (!(style.border > 0)) return;
  const outer = camShape(w, h, style.feather, style.radius);
  const width = Math.min(style.border, Math.min(outer.w, outer.h) / 2);
  ctx.save();
  ctx.fillStyle = style.borderColor;
  ctx.beginPath();
  roundedRect(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
  roundedRect(
    ctx,
    outer.x + width,
    outer.y + width,
    outer.w - 2 * width,
    outer.h - 2 * width,
    Math.min(Math.max(0, outer.r - width), Math.min(outer.w, outer.h) / 2 - width),
  );
  ctx.fill("evenodd");
  ctx.restore();
}
