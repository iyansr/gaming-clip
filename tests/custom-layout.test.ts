import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { parseCustomLayout } from "../src/core/pipeline";
import { ValidationError } from "../src/core/store";
import { drawCamBorder, drawCamMask, type ComposeContext } from "../src/shared/compose";
import { computeLayout, defaultCustomLayout } from "../src/shared/layout";
import { OUTPUT_SIZE, type CustomLayout } from "../src/shared/types";

const source = { width: 1280, height: 720 };
const webcam = { x: 0, y: 0, w: 327, h: 209 };

function alphaOf(draw: (ctx: ComposeContext) => void, w: number, h: number): Uint8ClampedArray {
  const ctx = createCanvas(w, h).getContext("2d");
  draw(ctx as unknown as ComposeContext);
  const { data } = ctx.getImageData(0, 0, w, h);
  return data.filter((_, i) => i % 4 === 3);
}

describe("defaultCustomLayout", () => {
  test("is the split layout as free elements", () => {
    const split = computeLayout(source, webcam, { layout: "split", focusX: 0.5, custom: null }, OUTPUT_SIZE);
    const custom = defaultCustomLayout(source, webcam, OUTPUT_SIZE);
    expect(custom.background).toEqual({ kind: "blur" });
    expect(custom.game).toEqual({ src: split.layers[0]!.src, dst: split.layers[0]!.dst });
    expect(custom.cam).toMatchObject({ src: split.layers[1]!.src, dst: split.layers[1]!.dst, feather: 0, radius: 0, border: 0, borderColor: "#ffffff" });
  });

  test("without a webcam it is one full-frame game element", () => {
    const custom = defaultCustomLayout(source, null, OUTPUT_SIZE);
    expect(custom.cam).toBeNull();
    expect(custom.game?.dst).toEqual({ x: 0, y: 0, w: OUTPUT_SIZE.width, h: OUTPUT_SIZE.height });
  });
});

describe("computeLayout", () => {
  test("custom with a null layout uses the default; other modes keep a black plain base", () => {
    const custom = computeLayout(source, webcam, { layout: "custom", focusX: 0.5, custom: null }, OUTPUT_SIZE);
    expect(custom.mode).toBe("custom");
    expect(custom.layers.map((layer) => layer.role)).toEqual(["background", "game", "cam"]);
    for (const layout of ["split", "fill", "fit"] as const) {
      const plain = computeLayout(source, webcam, { layout, focusX: 0.5, custom: null }, OUTPUT_SIZE);
      expect([plain.fill, plain.image]).toEqual(["#000", null]);
      expect(plain.layers.every((layer) => layer.cam === undefined)).toBe(true);
    }
  });

  test("backgrounds map to fill, image and the blur layer", () => {
    const base: CustomLayout = { background: { kind: "color", color: "#1e1b4b" }, game: null, cam: null };
    const at = (custom: CustomLayout) => computeLayout(source, null, { layout: "custom", focusX: 0.5, custom }, OUTPUT_SIZE);
    expect(at(base)).toMatchObject({ fill: "#1e1b4b", image: null, layers: [] });
    expect(at({ ...base, background: { kind: "image", file: "a.png" } })).toMatchObject({ fill: "#000", image: "a.png", layers: [] });
    expect(at({ ...base, background: { kind: "blur" } }).layers).toHaveLength(1);
  });
});

describe("drawCamMask / drawCamBorder", () => {
  test("opaque core, fades to transparent at the edge, monotone", () => {
    const [w, h] = [400, 300];
    const alpha = alphaOf((ctx) => drawCamMask(ctx, w, h, { feather: 40, radius: 60 }), w, h);
    const row = Array.from({ length: 60 }, (_, x) => alpha[150 * w + x]!);
    expect(row[0]!).toBeLessThan(3);
    expect(row[59]).toBe(255);
    for (let x = 1; x < row.length; x++) expect(row[x]!).toBeGreaterThanOrEqual(row[x - 1]!);
    // smooth: no step bigger than a few levels per pixel
    for (let x = 1; x < row.length; x++) expect(row[x]! - row[x - 1]!).toBeLessThan(40);
    expect(alpha[0]).toBe(0);
  });

  test("radius is clamped to half the shorter side: a circle", () => {
    const size = 200;
    const alpha = alphaOf((ctx) => drawCamMask(ctx, size, size, { feather: 0, radius: 5000 }), size, size);
    expect(alpha[0]).toBe(0);
    expect(alpha[100 * size + 100]).toBe(255);
    expect(alpha[100 * size + 1]).toBe(255);
    expect(alpha[20 * size + 20]).toBe(0);
  });

  test("border paints a ring only", () => {
    const [w, h] = [200, 100];
    const alpha = alphaOf((ctx) => drawCamBorder(ctx, w, h, { feather: 0, radius: 20, border: 8, borderColor: "#ffffff" }), w, h);
    expect(alpha[50 * w + 3]).toBe(255);
    expect(alpha[50 * w + 100]).toBe(0);
    expect(alphaOf((ctx) => drawCamBorder(ctx, w, h, { feather: 0, radius: 20, border: 0, borderColor: "#ffffff" }), w, h).every((a) => a === 0)).toBe(true);
  });
});

describe("parseCustomLayout", () => {
  const valid = () => ({
    background: { kind: "color", color: "#1E1B4B" },
    game: { src: { x: 0, y: 0, w: 640, h: 360 }, dst: { x: -100, y: 0, w: 1080, h: 1920 } },
    cam: {
      src: { x: 0, y: 0, w: 327, h: 209 },
      dst: { x: 600, y: 1500, w: 432, h: 276 },
      feather: 40,
      radius: 60,
      border: 6,
      borderColor: "#ffffff",
    },
  });

  test("accepts a valid layout and lower-cases colours", () => {
    expect(parseCustomLayout(valid()).background).toEqual({ kind: "color", color: "#1e1b4b" });
  });

  test.each([
    ["unknown key", { ...valid(), extra: 1 }],
    ["feather too big", { ...valid(), cam: { ...valid().cam, feather: 500 } }],
    ["bad border colour", { ...valid(), cam: { ...valid().cam, borderColor: "red" } }],
    ["dst too small", { ...valid(), game: { ...valid().game, dst: { x: 0, y: 0, w: 8, h: 100 } } }],
    ["dst too far", { ...valid(), game: { ...valid().game, dst: { x: 9000, y: 0, w: 100, h: 100 } } }],
    ["non-numeric rect", { ...valid(), game: { ...valid().game, src: { x: "0", y: 0, w: 640, h: 360 } } }],
    ["image name that is not an upload", { ...valid(), background: { kind: "image", file: "../x.png" } }],
    ["unknown background kind", { ...valid(), background: { kind: "video" } }],
  ])("rejects %s", (_, layout) => {
    expect(() => parseCustomLayout(layout)).toThrow(ValidationError);
  });
});
