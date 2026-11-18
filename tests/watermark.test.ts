import { describe, expect, test } from "bun:test";

import { createCanvas } from "@napi-rs/canvas";

import { parseSettingsPatch } from "../src/core/pipeline";
import { registerFonts } from "../src/core/render";
import { ValidationError } from "../src/core/store";
import type { ImageWatermark, TextWatermark, Watermark } from "../src/shared/types";
import { drawWatermarks, MAX_WATERMARKS, measureWatermark, type WatermarkImages } from "../src/shared/watermark";

const frame = { width: 1080, height: 1920 };

const text: TextWatermark = {
  id: "txt1",
  kind: "text",
  x: 540,
  y: 960,
  rotation: 0,
  opacity: 1,
  onThumbnail: false,
  text: "@iyansr",
  font: "Anton",
  size: 64,
  color: "#ffffff",
  stroke: 6,
  strokeColor: "#000000",
};

const image: ImageWatermark = {
  id: "img1",
  kind: "image",
  x: 300,
  y: 400,
  rotation: 0,
  opacity: 1,
  onThumbnail: false,
  file: "0123456789abcdef.png",
  width: 200,
};

const parse = (watermarks: unknown) => parseSettingsPatch({ watermarks }).watermarks;
const rejects = (watermarks: unknown, message: string) => {
  expect(() => parse(watermarks)).toThrow(ValidationError);
  expect(() => parse(watermarks)).toThrow(message);
};

describe("parseSettingsPatch watermarks", () => {
  test("accepts a valid list and lowercases colours", () => {
    const parsed = parse([{ ...text, color: "#FFAA00" }, image]);
    expect(parsed).toHaveLength(2);
    expect((parsed![0] as TextWatermark).color).toBe("#ffaa00");
    expect(parse([])).toEqual([]);
  });

  test("rejects a bad list, count, ids and unknown keys", () => {
    rejects("nope", "watermarks must be an array");
    rejects(
      Array.from({ length: MAX_WATERMARKS + 1 }, (_, i) => ({ ...text, id: `wm${i}abc` })),
      `At most ${MAX_WATERMARKS}`,
    );
    rejects([{ ...text, id: "AB" }], "id must be");
    rejects([text, { ...image, id: "txt1" }], "used twice");
    rejects([{ ...text, extra: 1 }], 'Unknown watermarks[0] field "extra"');
    rejects([{ ...text, file: "x.png" }], 'Unknown watermarks[0] field "file"');
    rejects([{ ...text, kind: "video" }], "kind must be");
  });

  test("rejects out-of-range numbers", () => {
    rejects([{ ...text, x: -1081 }], "x must be");
    rejects([{ ...text, x: 2161 }], "x must be");
    rejects([{ ...text, y: -1921 }], "y must be");
    rejects([{ ...text, y: 3841 }], "y must be");
    rejects([{ ...text, x: Number.NaN }], "x must be");
    rejects([{ ...text, rotation: 181 }], "rotation must be");
    rejects([{ ...text, opacity: 1.1 }], "opacity must be");
    rejects([{ ...text, size: 7 }], "size must be");
    rejects([{ ...text, size: 401 }], "size must be");
    rejects([{ ...text, stroke: 41 }], "stroke must be");
    rejects([{ ...image, width: 15 }], "width must be");
    rejects([{ ...image, width: 2161 }], "width must be");
  });

  test("rejects bad text, font, colours, file names and flags", () => {
    rejects([{ ...text, text: "" }], "text must be");
    rejects([{ ...text, text: "x".repeat(121) }], "text must be");
    rejects([{ ...text, text: "two\nlines" }], "single line");
    rejects([{ ...text, font: "Comic Sans" }], "font must be one of");
    rejects([{ ...text, color: "red" }], "color must be a colour");
    rejects([{ ...text, strokeColor: "#fff" }], "strokeColor must be a colour");
    rejects([{ ...image, file: "../secret.png" }], "file must be the file name");
    rejects([{ ...text, onThumbnail: "yes" }], "onThumbnail must be");
  });
});

const scratch = (width: number, height: number) => createCanvas(width, height).getContext("2d");

const alphaAt = (data: { data: Uint8ClampedArray; width: number }, x: number, y: number) =>
  data.data[(Math.round(y) * data.width + Math.round(x)) * 4 + 3]!;

describe("drawWatermarks", () => {
  registerFonts();
  const bitmap = createCanvas(100, 50);
  const bitmapContext = bitmap.getContext("2d");
  bitmapContext.fillStyle = "#ff0000";
  bitmapContext.fillRect(0, 0, 100, 50);
  const images: WatermarkImages = new Map([[image.file, { image: bitmap, width: 100, height: 50 }]]);
  function paint(watermarks: Watermark[], size = frame) {
    const ctx = createCanvas(size.width, size.height).getContext("2d");
    drawWatermarks(ctx, watermarks, images, size, scratch);
    return ctx.getImageData(0, 0, size.width, size.height);
  }

  test("an image is centred on x/y, keeps its aspect and takes the opacity", () => {
    const data = paint([{ ...image, opacity: 0.5 }]);
    // 200 x 100 box centred on (300, 400)
    expect(alphaAt(data, 300, 400)).toBeCloseTo(128, -1);
    expect(alphaAt(data, 205, 355)).toBeGreaterThan(0);
    expect(alphaAt(data, 395, 445)).toBeGreaterThan(0);
    expect(alphaAt(data, 195, 400)).toBe(0);
    expect(alphaAt(data, 300, 340)).toBe(0);
    expect(measureWatermark(scratch(1, 1), image, images)).toEqual({ w: 200, h: 100 });
  });

  test("rotation turns the box around its centre", () => {
    const data = paint([{ ...image, rotation: 90 }]);
    expect(alphaAt(data, 300, 400)).toBe(255);
    expect(alphaAt(data, 300, 340)).toBe(255); // 200 tall now
    expect(alphaAt(data, 235, 400)).toBe(0); // only 100 wide now
  });

  test("an image missing from the map is skipped; measureWatermark returns null", () => {
    const data = paint([{ ...image, file: "ffffffffffffffff.png" }]);
    expect(data.data.every((value) => value === 0)).toBe(true);
    expect(measureWatermark(scratch(1, 1), { ...image, file: "ffffffffffffffff.png" }, images)).toBeNull();
  });

  test("a watermark partly outside the frame is clipped, not an error", () => {
    const data = paint([{ ...image, x: 0, y: 0 }]);
    expect(alphaAt(data, 50, 25)).toBe(255);
    expect(alphaAt(data, 150, 25)).toBe(0);
  });

  test("scales with the frame width", () => {
    const half = { width: 540, height: 960 };
    const data = paint([image], half);
    expect(alphaAt(data, 150, 200)).toBe(255);
    expect(alphaAt(data, 100 - 6, 200)).toBe(0);
    expect(alphaAt(data, 200 + 6, 200)).toBe(0);
  });

  test("text is centred on x/y: its ink straddles the point", () => {
    const data = paint([{ ...text, stroke: 0 }]);
    let left = data.width;
    let right = 0;
    let top = data.height;
    let bottom = 0;
    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        if (data.data[(y * data.width + x) * 4 + 3]! < 128) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    expect((left + right) / 2).toBeCloseTo(540, -1);
    expect(top).toBeLessThan(960);
    expect(bottom).toBeGreaterThan(960);
    const box = measureWatermark(scratch(1, 1), { ...text, stroke: 0 }, images)!;
    expect(box.h).toBeCloseTo(64 * 1.2, 5);
    expect(right - left).toBeLessThanOrEqual(box.w);
  });

  test("translucent outlined text needs a scratch canvas and is one uniform opacity", () => {
    const translucent = { ...text, opacity: 0.5 };
    const ctx = createCanvas(frame.width, frame.height).getContext("2d");
    expect(() => drawWatermarks(ctx, [translucent], images, frame)).toThrow("createCanvas");
    const data = paint([translucent]);
    const alphas = new Set<number>();
    for (let i = 3; i < data.data.length; i += 4) if (data.data[i]! > 0) alphas.add(data.data[i]!);
    // Outline and fill never stack: nothing is more opaque than the opacity (rounding aside).
    expect(Math.max(...alphas)).toBeLessThanOrEqual(129);
  });

  test("leaves the context as found", () => {
    const ctx = createCanvas(frame.width, frame.height).getContext("2d");
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#123456";
    drawWatermarks(ctx, [text, { ...image, rotation: 33 }], images, frame, scratch);
    expect(ctx.globalAlpha).toBeCloseTo(0.3, 5);
    expect(ctx.fillStyle).toBe("#123456");
    expect(ctx.getTransform().a).toBe(1);
    expect(ctx.getTransform().e).toBe(0);
  });
});
