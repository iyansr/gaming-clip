import { defaultCustomLayout } from "../../shared/layout";
import { OUTPUT_SIZE, type CamElement, type CustomLayout, type LayoutElement, type Rect, type Size } from "../../shared/types";
import type { Edge } from "../components/RectEditor";
import { clamp } from "./format";

export type ElementRole = "game" | "cam";

/** Selection and aspect lock of the free-form layout editor; shared by the preview overlay and the settings panel. */
export interface CustomUi {
  selected: ElementRole;
  /** Resizing keeps the crop's aspect ratio (Shift frees it for one drag). */
  lockAspect: boolean;
}

/** Smallest box edge (output px). */
export const MIN_DST = 24;
/** A box can leave the frame but this much of it must stay inside. */
const MIN_VISIBLE = 40;
/** Snap distance (output px). */
export const SNAP_PX = 12;
export const MAX_FEATHER = 150;
export const MAX_BORDER = 20;

export const CAM_STYLE: Pick<CamElement, "feather" | "radius" | "border" | "borderColor"> = { feather: 0, radius: 0, border: 0, borderColor: "#ffffff" };

export const resolveCustom = (source: Size, webcam: Rect | null, custom: CustomLayout | null): CustomLayout => custom ?? defaultCustomLayout(source, webcam, OUTPUT_SIZE);

/** Largest rect of aspect `aspect` (w/h) inside `box`, centred. */
export function fitAspect(box: Rect, aspect: number): Rect {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  w = Math.max(MIN_DST, Math.round(w));
  h = Math.max(MIN_DST, Math.round(h));
  return { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h };
}

/** What "Reset" / "Show" gives back: the element of the default arrangement, or a sensible one when that arrangement lacks it. */
export function defaultElement(role: "game", source: Size, webcam: Rect | null): LayoutElement;
export function defaultElement(role: "cam", source: Size, webcam: Rect | null): CamElement;
export function defaultElement(role: ElementRole, source: Size, webcam: Rect | null): LayoutElement | CamElement {
  const base = defaultCustomLayout(source, webcam, OUTPUT_SIZE);
  if (role === "game") {
    if (base.game) return base.game;
    const w = Math.min(source.width, Math.floor((source.height * OUTPUT_SIZE.width) / OUTPUT_SIZE.height / 2) * 2);
    return { src: { x: Math.floor((source.width - w) / 4) * 2, y: 0, w, h: source.height }, dst: { x: 0, y: 0, w: OUTPUT_SIZE.width, h: OUTPUT_SIZE.height } };
  }
  if (base.cam) return base.cam;
  const src: Rect = webcam ?? { x: 0, y: 0, w: Math.round(source.width * 0.25), h: Math.round(source.width * 0.25 * (source.height / source.width)) };
  const w = Math.round(OUTPUT_SIZE.width * 0.5);
  return { src, dst: { x: Math.round((OUTPUT_SIZE.width - w) / 2), y: 40, w, h: Math.round((w * src.h) / src.w) }, ...CAM_STYLE };
}

export function withElement(custom: CustomLayout, role: ElementRole, element: LayoutElement | CamElement | null): CustomLayout {
  return { ...custom, [role]: element };
}

/** Keeps a box inside what the server accepts (x >= -width, size <= 4x the frame) and partly visible. */
export function clampDst(r: Rect, frame: Size = OUTPUT_SIZE): Rect {
  const w = clamp(r.w, MIN_DST, 4 * frame.width);
  const h = clamp(r.h, MIN_DST, 4 * frame.height);
  return {
    x: Math.round(clamp(r.x, Math.max(MIN_VISIBLE - w, -frame.width), frame.width - MIN_VISIBLE)),
    y: Math.round(clamp(r.y, Math.max(MIN_VISIBLE - h, -frame.height), frame.height - MIN_VISIBLE)),
    w: Math.round(w),
    h: Math.round(h),
  };
}

export interface Guides {
  x: number[];
  y: number[];
}

export interface SnapTargets {
  x: number[];
  y: number[];
}

/** Frame edges, frame centre lines and the edges of the other visible boxes. */
export function snapTargets(frame: Size, others: Rect[]): SnapTargets {
  return {
    x: [0, frame.width / 2, frame.width, ...others.flatMap((o) => [o.x, o.x + o.w])],
    y: [0, frame.height / 2, frame.height, ...others.flatMap((o) => [o.y, o.y + o.h])],
  };
}

/** Smallest correction that puts one of `values` on one of `targets`, if within `threshold`. */
function nearest(values: number[], targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/** Targets the box currently sits on (within half a pixel): the lines to draw while dragging. */
function guidesFor(r: Rect, targets: SnapTargets): Guides {
  const hit = (values: number[], list: number[]) => [...new Set(list.filter((t) => values.some((v) => Math.abs(v - t) < 0.5)))];
  return { x: hit([r.x, r.x + r.w / 2, r.x + r.w], targets.x), y: hit([r.y, r.y + r.h / 2, r.y + r.h], targets.y) };
}

interface SnapOptions {
  targets: SnapTargets;
  /** false = no snapping (Alt held). */
  snap: boolean;
}

export function moveRect(start: Rect, dx: number, dy: number, o: SnapOptions): { rect: Rect; guides: Guides } {
  let x = start.x + dx;
  let y = start.y + dy;
  if (o.snap) {
    x += nearest([x, x + start.w / 2, x + start.w], o.targets.x, SNAP_PX) ?? 0;
    y += nearest([y, y + start.h / 2, y + start.h], o.targets.y, SNAP_PX) ?? 0;
  }
  const rect = clampDst({ ...start, x, y });
  return { rect, guides: o.snap ? guidesFor(rect, o.targets) : { x: [], y: [] } };
}

/**
 * Resizes `start` by dragging `edges` by (dx, dy). With `aspect` (w/h) the box keeps that ratio:
 * corners anchor the opposite corner, edge handles anchor the opposite edge and grow around the centre of the other axis.
 */
export function resizeRect(start: Rect, edges: Edge[], dx: number, dy: number, aspect: number | null, o: SnapOptions): { rect: Rect; guides: Guides } {
  const sx = edges.includes("e") ? 1 : edges.includes("w") ? -1 : 0;
  const sy = edges.includes("s") ? 1 : edges.includes("n") ? -1 : 0;
  let rect: Rect;

  if (aspect === null) {
    let x1 = start.x;
    let y1 = start.y;
    let x2 = start.x + start.w;
    let y2 = start.y + start.h;
    if (sx < 0) x1 += dx;
    if (sx > 0) x2 += dx;
    if (sy < 0) y1 += dy;
    if (sy > 0) y2 += dy;
    if (o.snap) {
      if (sx !== 0) {
        const d = nearest([sx < 0 ? x1 : x2], o.targets.x, SNAP_PX) ?? 0;
        if (sx < 0) x1 += d;
        else x2 += d;
      }
      if (sy !== 0) {
        const d = nearest([sy < 0 ? y1 : y2], o.targets.y, SNAP_PX) ?? 0;
        if (sy < 0) y1 += d;
        else y2 += d;
      }
    }
    if (sx < 0) x1 = Math.min(x1, x2 - MIN_DST);
    if (sx > 0) x2 = Math.max(x2, x1 + MIN_DST);
    if (sy < 0) y1 = Math.min(y1, y2 - MIN_DST);
    if (sy > 0) y2 = Math.max(y2, y1 + MIN_DST);
    rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  } else {
    // Width the box would have; height follows from the aspect.
    let w = start.w;
    if (sx !== 0 && sy !== 0) w = Math.max(start.w + sx * dx, (start.h + sy * dy) * aspect);
    else if (sx !== 0) w = start.w + sx * dx;
    else w = (start.h + sy * dy) * aspect;
    w = Math.max(w, MIN_DST, MIN_DST * aspect);

    const anchorX = (width: number) => (sx > 0 ? start.x : sx < 0 ? start.x + start.w - width : start.x + (start.w - width) / 2);
    const anchorY = (height: number) => (sy > 0 ? start.y : sy < 0 ? start.y + start.h - height : start.y + (start.h - height) / 2);

    if (o.snap) {
      // Correction in width terms, from whichever moving edge is closest to a target.
      const fixes: number[] = [];
      if (sx !== 0) {
        const edge = sx > 0 ? anchorX(w) + w : anchorX(w);
        const d = nearest([edge], o.targets.x, SNAP_PX);
        if (d !== null) fixes.push(sx * d);
      }
      if (sy !== 0) {
        const h = w / aspect;
        const edge = sy > 0 ? anchorY(h) + h : anchorY(h);
        const d = nearest([edge], o.targets.y, SNAP_PX);
        if (d !== null) fixes.push(sy * d * aspect);
      }
      if (fixes.length > 0) w += fixes.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
      w = Math.max(w, MIN_DST, MIN_DST * aspect);
    }
    const h = w / aspect;
    rect = { x: anchorX(w), y: anchorY(h), w, h };
  }

  rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  return { rect, guides: o.snap ? guidesFor(rect, o.targets) : { x: [], y: [] } };
}

export type DstField = keyof Rect;

/** Applies a typed value to one field of a box; with `aspect` the other side of w/h follows. */
export function setDstField(r: Rect, field: DstField, value: number, aspect: number | null): Rect {
  const v = Math.round(value);
  if (field === "x") return clampDst({ ...r, x: v });
  if (field === "y") return clampDst({ ...r, y: v });
  if (field === "w") return clampDst({ ...r, w: v, h: aspect === null ? r.h : v / aspect });
  return clampDst({ ...r, h: v, w: aspect === null ? r.w : v * aspect });
}
