import { describe, expect, test } from "bun:test";

import {
  frameTransformAt,
  frameTransformExpr,
  overlayAnimExpr,
  overlayStateAt,
  overlappingZooms,
  relativeItems,
} from "../src/shared/effects";
import type { OverlayItem, TimelineItem } from "../src/shared/types";

/** Evaluates the subset of the ffmpeg expression language the builders emit, so preview and render can be compared. */
function ffEval(expr: string, t: number): number {
  const fns = {
    clip: (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
    between: (x: number, lo: number, hi: number) => Number(x >= lo && x <= hi),
    iff: (c: number, a: number, b: number) => (c ? a : b),
    lt: (a: number, b: number) => Number(a < b),
    sin: Math.sin,
    cos: Math.cos,
    pow: Math.pow,
    PI: Math.PI,
  };
  const body = `return ${expr.replace(/\bif\(/g, "iff(")};`;
  // oxlint-disable-next-line typescript/no-implied-eval -- test-only evaluator for generated arithmetic.
  return new Function(...Object.keys(fns), "t", body)(...Object.values(fns), t) as number;
}

const size = { width: 1080, height: 1920 };
const items: TimelineItem[] = [
  { id: "z1", kind: "zoom", start: 1, end: 2.5, scale: 1.6, x: 0.3, y: 0.2, ease: "punch" },
  { id: "z2", kind: "zoom", start: 3, end: 4, scale: 2, x: 0.7, y: 0.6, ease: "smooth" },
  { id: "s1", kind: "shake", start: 1.2, end: 3.5, intensity: 0.7 },
];

describe("preview and render compute the same effects", () => {
  test("zoom + shake frame transform", () => {
    const expr = frameTransformExpr(items, size)!;
    for (let t = 0; t < 5; t += 0.0137) {
      const js = frameTransformAt(items, t, size);
      expect(ffEval(expr.scale, t)).toBeCloseTo(js.scale, 6);
      expect(ffEval(expr.x, t)).toBeCloseTo(js.ox, 3);
      expect(ffEval(expr.y, t)).toBeCloseTo(js.oy, 3);
    }
  });

  test("overlay animations", () => {
    for (const animation of ["pop", "shake", "slide", "none"] as const) {
      const item = { id: "o", kind: "overlay", start: 0.5, end: 2, animation } as OverlayItem;
      const expr = overlayAnimExpr(item);
      for (let t = 0.5; t < 2; t += 0.01) {
        const js = overlayStateAt(item, t)!;
        expect(ffEval(expr.scale, t)).toBeCloseTo(js.scale, 6);
        expect(ffEval(expr.dx, t)).toBeCloseTo(js.dx, 3);
      }
    }
  });
});

describe("frame transform", () => {
  test("is the identity without zoom or shake, and never shows the frame edge", () => {
    expect(frameTransformExpr([], size)).toBeNull();
    expect(frameTransformAt([], 1, size)).toEqual({ scale: 1, ox: 0, oy: 0 });
    for (let t = 0; t < 5; t += 0.01) {
      const { scale, ox, oy } = frameTransformAt(items, t, size);
      expect(ox).toBeGreaterThanOrEqual(0);
      expect(oy).toBeGreaterThanOrEqual(0);
      expect(ox + size.width).toBeLessThanOrEqual(size.width * scale + 1e-6);
      expect(oy + size.height).toBeLessThanOrEqual(size.height * scale + 1e-6);
    }
  });

  test("the focus point stays put on screen at full zoom", () => {
    const zoom: TimelineItem = { id: "z", kind: "zoom", start: 0, end: 2, scale: 2, x: 0.25, y: 0.75, ease: "punch" };
    const { scale, ox, oy } = frameTransformAt([zoom], 1, size);
    expect(scale).toBeCloseTo(2, 6);
    expect(0.25 * size.width * scale - ox).toBeCloseTo(0.25 * size.width, 6);
    expect(0.75 * size.height * scale - oy).toBeCloseTo(0.75 * size.height, 6);
  });
});

test("relativeItems shifts to clip time and drops what lies outside", () => {
  const rel = relativeItems(items, 2, 3.2);
  expect(rel.map((i) => [i.id, i.start, i.end])).toEqual([
    ["z1", 0, 0.5],
    ["z2", 1, 1.2000000000000002],
    ["s1", 0, 1.2000000000000002],
  ]);
  expect(relativeItems(items, 10, 20)).toEqual([]);
});

test("overlappingZooms finds touching-inside pairs only", () => {
  expect(overlappingZooms(items)).toBeNull();
  const clash = [...items, { ...items[0]!, id: "z3", start: 2, end: 3.1 } as TimelineItem];
  expect(overlappingZooms(clash)?.map((z) => z.id)).toEqual(["z1", "z3"]);
});
