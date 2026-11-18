/**
 * Timeline effect math shared by the browser preview and the ffmpeg renderer. Every function exists twice: a JS
 * evaluation (`*At`) used by the preview canvas and an ffmpeg expression builder (`*Expr`) used in the filter graph.
 * Both are built from the same constants in this file; change them together. Isomorphic: only type imports.
 *
 * Times here are CLIP-RELATIVE seconds (0 = clip start). Convert source-time items with `relativeItems` first.
 */
import type { OverlayItem, ShakeItem, TimelineItem, ZoomItem } from "./types";

export const ZOOM_LIMITS = { min: 1.05, max: 3 } as const;
/** Ramp lengths in seconds, per ease: in, out. Clamped to half the item when the item is short. */
export const ZOOM_RAMPS = { punch: { in: 0.08, out: 0.12 }, smooth: { in: 0.4, out: 0.4 } } as const;
/** Shake amplitude at intensity 1, px on a 1080-wide frame. */
export const SHAKE_PX = 40;
const SHAKE_RAMP = 0.05;
/** Flash opacity at its start; it fades linearly to 0 at its end. */
export const FLASH_ALPHA = 0.85;
/** Overlay fade in / fade out, seconds (every animation). */
export const OVERLAY_FADE_IN = 0.06;
export const OVERLAY_FADE_OUT = 0.1;
const POP = { grow: 0.12, settle: 0.1, from: 0.4, peak: 1.15 } as const;
const OVERLAY_SHAKE = { px: 12, hz: 9 } as const;
const SLIDE = { dur: 0.25, px: 1200 } as const;
/** Shortest and longest timeline item, seconds. */
export const ITEM_LIMITS = { min: 0.1, max: 60 } as const;
export const MAX_TIMELINE_ITEMS = 80;
export const TEASER_LIMITS = { min: 0.5, max: 4 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => u * u * (3 - 2 * u);
/** Number literal for an ffmpeg expression (no exponent notation). */
const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(6)).toString());

/** Items shifted to clip-relative time and cut to the clip; items that do not overlap the clip are dropped. */
export function relativeItems<T extends TimelineItem>(items: T[], clipStart: number, clipEnd: number): T[] {
  const length = clipEnd - clipStart;
  return items
    .map((item) => ({
      ...item,
      start: Math.max(0, item.start - clipStart),
      end: Math.min(length, item.end - clipStart),
    }))
    .filter((item) => item.end - item.start > 1e-3);
}

// ---------------------------------------------------------------------------------------------
// Envelopes: 0 outside the item, ramps to 1 inside.
// ---------------------------------------------------------------------------------------------

function ramps(start: number, end: number, rin: number, rout: number): { rin: number; rout: number } {
  const half = (end - start) / 2;
  return { rin: Math.max(1e-3, Math.min(rin, half)), rout: Math.max(1e-3, Math.min(rout, half)) };
}

function envelopeAt(t: number, start: number, end: number, rin: number, rout: number, eased: boolean): number {
  if (t < start || t >= end) return 0;
  const r = ramps(start, end, rin, rout);
  const a = clamp((t - start) / r.rin, 0, 1);
  const b = clamp((end - t) / r.rout, 0, 1);
  return eased ? smooth(a) * smooth(b) : a * b;
}

function envelopeExpr(start: number, end: number, rin: number, rout: number, eased: boolean): string {
  const r = ramps(start, end, rin, rout);
  const a = `clip((t-${n(start)})/${n(r.rin)},0,1)`;
  const b = `clip((${n(end)}-t)/${n(r.rout)},0,1)`;
  const gate = `between(t,${n(start)},${n(end)})`;
  return eased ? `(${gate}*(${a})*(${a})*(3-2*${a})*(${b})*(${b})*(3-2*${b}))` : `(${gate}*${a}*${b})`;
}

// ---------------------------------------------------------------------------------------------
// Frame transform: zoom + shake. Zoom items never overlap (validation rejects it).
// ---------------------------------------------------------------------------------------------

/** Where to crop the frame scaled by `scale`: offset in output px. Draw as translate(-ox,-oy) then scale(scale). */
export interface FrameTransform {
  scale: number;
  ox: number;
  oy: number;
}

const zoomEnvAt = (z: ZoomItem, t: number) =>
  envelopeAt(t, z.start, z.end, ZOOM_RAMPS[z.ease].in, ZOOM_RAMPS[z.ease].out, z.ease === "smooth");
const zoomEnvExpr = (z: ZoomItem) =>
  envelopeExpr(z.start, z.end, ZOOM_RAMPS[z.ease].in, ZOOM_RAMPS[z.ease].out, z.ease === "smooth");
const shakeAmpAt = (s: ShakeItem, t: number, width: number) =>
  s.intensity * SHAKE_PX * (width / 1080) * envelopeAt(t, s.start, s.end, SHAKE_RAMP, SHAKE_RAMP, false);
const shakeAmpExpr = (s: ShakeItem, width: number) =>
  `(${n(s.intensity * SHAKE_PX * (width / 1080))}*${envelopeExpr(s.start, s.end, SHAKE_RAMP, SHAKE_RAMP, false)})`;

/** Shake wobble, -1..1 per axis; incommensurate frequencies so it never looks periodic. */
const wobbleX = (t: number) => (Math.sin(2 * Math.PI * 11 * t) + 0.5 * Math.sin(2 * Math.PI * 23 * t + 1)) / 1.5;
const wobbleY = (t: number) => (Math.cos(2 * Math.PI * 13 * t) + 0.5 * Math.sin(2 * Math.PI * 29 * t + 2)) / 1.5;
const wobbleXExpr = "((sin(2*PI*11*t)+0.5*sin(2*PI*23*t+1))/1.5)";
const wobbleYExpr = "((cos(2*PI*13*t)+0.5*sin(2*PI*29*t+2))/1.5)";

/** Zoom and shake items only (others are ignored). */
export function frameTransformAt(
  items: TimelineItem[],
  t: number,
  size: { width: number; height: number },
): FrameTransform {
  const { width: W, height: H } = size;
  let zoom = 1;
  let fx = 0.5;
  let fy = 0.5;
  let amp = 0;
  for (const item of items) {
    if (item.kind === "zoom") {
      const k = zoomEnvAt(item, t);
      if (t >= item.start && t < item.end) {
        fx = item.x;
        fy = item.y;
      }
      zoom += (item.scale - 1) * k;
    } else if (item.kind === "shake") {
      amp += shakeAmpAt(item, t, W);
    }
  }
  // Enough extra scale that the shake never shows the frame edge: 2*amp of slack on the short axis.
  const scale = zoom + (2 * amp) / W;
  const slackX = W * (scale - 1);
  const slackY = H * (scale - 1);
  const ox = clamp(fx * slackX - amp * wobbleX(t), 0, slackX);
  const oy = clamp(fy * slackY - amp * wobbleY(t), 0, slackY);
  return { scale, ox, oy };
}

/**
 * ffmpeg expressions of the same transform, in terms of `t`: `scale` for `scale=w=W*scale:h=H*scale:eval=frame`,
 * `x`/`y` for the `crop=W:H:x:y` that follows. Null when there is no zoom or shake item.
 */
export function frameTransformExpr(
  items: TimelineItem[],
  size: { width: number; height: number },
): { scale: string; x: string; y: string } | null {
  const { width: W, height: H } = size;
  const zooms = items.filter((i): i is ZoomItem => i.kind === "zoom");
  const shakes = items.filter((i): i is ShakeItem => i.kind === "shake");
  if (zooms.length === 0 && shakes.length === 0) return null;
  const zoom = ["1", ...zooms.map((z) => `${n(z.scale - 1)}*${zoomEnvExpr(z)}`)].join("+");
  const amp = shakes.length > 0 ? `(${shakes.map((s) => shakeAmpExpr(s, W)).join("+")})` : "0";
  // Focus of the zoom active at t (0.5 when none): items do not overlap, so at most one gate is 1.
  const focus = (axis: "x" | "y") =>
    zooms.reduceRight((rest, z) => `if(between(t,${n(z.start)},${n(z.end)}),${n(z[axis])},${rest})`, "0.5");
  const scale = `(${zoom}+2*${amp}/${n(W)})`;
  const slack = (dim: number) => `(${n(dim)}*(${scale}-1))`;
  const x = `clip(${focus("x")}*${slack(W)}-${amp}*${wobbleXExpr},0,${slack(W)})`;
  const y = `clip(${focus("y")}*${slack(H)}-${amp}*${wobbleYExpr},0,${slack(H)})`;
  return { scale, x, y };
}

// ---------------------------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------------------------

export function flashAlphaAt(item: { start: number; end: number }, t: number): number {
  if (t < item.start || t >= item.end) return 0;
  return FLASH_ALPHA * (1 - (t - item.start) / (item.end - item.start));
}

// ---------------------------------------------------------------------------------------------
// Overlay animation (text / sticker). Rotation is part of the element and baked into its bitmap.
// ---------------------------------------------------------------------------------------------

/** Scale about the element's centre, opacity multiplier and offset in output px (1080-wide frame). */
export interface OverlayState {
  scale: number;
  alpha: number;
  dx: number;
  dy: number;
}

export function overlayStateAt(item: OverlayItem, t: number): OverlayState | null {
  if (t < item.start || t >= item.end) return null;
  const tau = t - item.start;
  const alpha = Math.min(1, tau / OVERLAY_FADE_IN, (item.end - t) / OVERLAY_FADE_OUT);
  let scale = 1;
  let dx = 0;
  if (item.animation === "pop") {
    if (tau < POP.grow) scale = POP.from + (POP.peak - POP.from) * (tau / POP.grow);
    else if (tau < POP.grow + POP.settle) scale = POP.peak - (POP.peak - 1) * ((tau - POP.grow) / POP.settle);
  } else if (item.animation === "shake") {
    dx = OVERLAY_SHAKE.px * Math.sin(2 * Math.PI * OVERLAY_SHAKE.hz * tau);
  } else if (item.animation === "slide") {
    const u = Math.min(1, tau / SLIDE.dur);
    dx = -(1 - (1 - (1 - u) ** 3)) * SLIDE.px;
  }
  return { scale, alpha: Math.max(0, alpha), dx, dy: 0 };
}

/**
 * ffmpeg expressions of the overlay animation, in terms of `t` (clip time). `scale` is for the `scale` filter with
 * eval=frame on the element bitmap; `dx`/`dy` are added to the overlay position. Opacity is done with `fade`
 * filters (`fadeIn`, `fadeOut` durations, linear like overlayStateAt).
 */
export function overlayAnimExpr(item: OverlayItem): { scale: string; dx: string; dy: string } {
  const a = n(item.start);
  const tau = `(t-${a})`;
  if (item.animation === "pop") {
    const grow = `(${n(POP.from)}+${n(POP.peak - POP.from)}*${tau}/${n(POP.grow)})`;
    const settle = `(${n(POP.peak)}-${n(POP.peak - 1)}*(${tau}-${n(POP.grow)})/${n(POP.settle)})`;
    return {
      scale: `if(lt(${tau},${n(POP.grow)}),${grow},if(lt(${tau},${n(POP.grow + POP.settle)}),${settle},1))`,
      dx: "0",
      dy: "0",
    };
  }
  if (item.animation === "shake") {
    return { scale: "1", dx: `${n(OVERLAY_SHAKE.px)}*sin(2*PI*${n(OVERLAY_SHAKE.hz)}*${tau})`, dy: "0" };
  }
  if (item.animation === "slide") {
    const u = `clip(${tau}/${n(SLIDE.dur)},0,1)`;
    return { scale: "1", dx: `-pow(1-${u},3)*${n(SLIDE.px)}`, dy: "0" };
  }
  return { scale: "1", dx: "0", dy: "0" };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers shared by server and editor
// ---------------------------------------------------------------------------------------------

/** First pair of zoom items that overlap in time, or null. */
export function overlappingZooms(items: TimelineItem[]): [ZoomItem, ZoomItem] | null {
  const zooms = items.filter((i): i is ZoomItem => i.kind === "zoom").sort((p, q) => p.start - q.start);
  for (let i = 1; i < zooms.length; i++) if (zooms[i]!.start < zooms[i - 1]!.end) return [zooms[i - 1]!, zooms[i]!];
  return null;
}
