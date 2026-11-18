import * as ort from "onnxruntime-node";

import type { Rect, Webcam } from "../shared/types";
import { MODELS } from "./config";
import { grabFrame } from "./frames";

const SAMPLES = 24;
const CONCURRENCY = 4;
/** Analysis frames are decoded at most this wide; rects are scaled back to source pixels. */
const MAX_ANALYSIS_WIDTH = 1920;
const NET = 640;
const FACE_SCORE_MIN = 0.55;
/**
 * Mean signed gradient (0..255 luma, between neighbouring pixels, averaged over the sampled frames) that marks a
 * static overlay edge. Averaging signed values cancels gameplay noise and keeps edges that never move, which
 * also recovers low-contrast borders (dark clothes against a dark game) that a per-frame threshold would miss.
 */
const EDGE_MEAN_STEP = 3;
const MIN_FACE_PERSISTENCE = 0.4;
/** Score credited to a rect side lying on the frame border (facecams usually touch a corner). */
const FRAME_SIDE_SCORE = 0.8;
const MIN_SIDE_SCORE = 0.3;

interface Face {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

type Session = ort.InferenceSession;

let sessionPromise: Promise<Session> | undefined;

function getSession(): Promise<Session> {
  sessionPromise ??= (async () => {
    if (!(await Bun.file(MODELS.face.path).exists())) {
      throw new Error(`Face model not found at ${MODELS.face.path}. Run \`bun run setup\` to download it.`);
    }
    return ort.InferenceSession.create(MODELS.face.path);
  })();
  sessionPromise.catch(() => {
    sessionPromise = undefined;
  });
  return sessionPromise;
}

function iou(a: Face, b: Face): number {
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(faces: Face[], threshold: number): Face[] {
  const sorted = faces.toSorted((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of sorted) if (kept.every((k) => iou(k, f) < threshold)) kept.push(f);
  return kept;
}

/** Letterboxes `region` of an RGB frame into a 640x640 BGR float NCHW tensor (bilinear). */
function toTensor(rgb: Uint8Array, width: number, height: number, region: Rect, scale: number): Float32Array {
  const plane = NET * NET;
  const out = new Float32Array(3 * plane);
  const ow = Math.min(NET, Math.round(region.w * scale));
  const oh = Math.min(NET, Math.round(region.h * scale));
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(height - 1, Math.max(0, region.y + (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(width - 1, Math.max(0, region.x + (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * width + x0) * 3;
      const i01 = (y0 * width + x1) * 3;
      const i10 = (y1 * width + x0) * 3;
      const i11 = (y1 * width + x1) * 3;
      const o = y * NET + x;
      for (let c = 0; c < 3; c++) {
        const top = rgb[i00 + c]! * (1 - fx) + rgb[i01 + c]! * fx;
        const bottom = rgb[i10 + c]! * (1 - fx) + rgb[i11 + c]! * fx;
        out[(2 - c) * plane + o] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

async function detectInRegion(
  session: Session,
  rgb: Uint8Array,
  width: number,
  height: number,
  region: Rect,
): Promise<Face[]> {
  const scale = NET / Math.max(region.w, region.h);
  const input = new ort.Tensor("float32", toTensor(rgb, width, height, region, scale), [1, 3, NET, NET]);
  const out = await session.run({ input });
  const faces: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`]!.data as Float32Array;
    const obj = out[`obj_${stride}`]!.data as Float32Array;
    const box = out[`bbox_${stride}`]!.data as Float32Array;
    const cols = NET / stride;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
      if (score < FACE_SCORE_MIN) continue;
      const cx = ((i % cols) + box[i * 4]!) * stride;
      const cy = (Math.floor(i / cols) + box[i * 4 + 1]!) * stride;
      const w = Math.exp(box[i * 4 + 2]!) * stride;
      const h = Math.exp(box[i * 4 + 3]!) * stride;
      faces.push({
        x: region.x + (cx - w / 2) / scale,
        y: region.y + (cy - h / 2) / scale,
        w: w / scale,
        h: h / scale,
        score,
      });
    }
  }
  return nms(faces, 0.3);
}

/** Whole frame plus a 3x2 grid of overlapping tiles, so small facecam faces are seen at higher resolution. */
function faceRegions(width: number, height: number): Rect[] {
  const regions: Rect[] = [{ x: 0, y: 0, w: width, h: height }];
  const tw = Math.round(width * 0.4);
  const th = Math.round(height * 0.6);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      regions.push({ x: Math.round(col * 0.3 * width), y: Math.round(row * 0.4 * height), w: tw, h: th });
    }
  }
  return regions;
}

/** Sums, per pixel boundary, the signed luma step over all frames. */
class EdgeSums {
  /** vertical[y*w+x]: step from pixel x-1 to x on row y. */
  readonly vertical: Int32Array;
  /** horizontal[y*w+x]: step from pixel y-1 to y on column x. */
  readonly horizontal: Int32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.vertical = new Int32Array(width * height);
    this.horizontal = new Int32Array(width * height);
  }

  add(rgb: Uint8Array): void {
    const { width, height, vertical, horizontal } = this;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++)
      gray[i] = (77 * rgb[i * 3]! + 150 * rgb[i * 3 + 1]! + 29 * rgb[i * 3 + 2]!) >> 8;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const g = gray[i]!;
        if (x > 0) vertical[i]! += g - gray[i - 1]!;
        if (y > 0) horizontal[i]! += g - gray[i - width]!;
      }
    }
  }
}

interface FaceCluster {
  frames: number;
  /** Median face box. */
  box: Rect;
  /** Union-ish extent of the face over time (10th/90th percentile edges). */
  extent: { x0: number; y0: number; x1: number; y1: number };
}

function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function percentile(values: number[], p: number): number {
  const s = values.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
}

/** The face that sits at a stable place in the most sampled frames. */
function clusterFaces(perFrame: Face[][]): FaceCluster | null {
  const near = (seed: { cx: number; cy: number; size: number }, f: Face) =>
    Math.hypot(f.x + f.w / 2 - seed.cx, f.y + f.h / 2 - seed.cy) <= seed.size * 0.6 &&
    Math.max(f.w, f.h) / seed.size > 0.6 &&
    Math.max(f.w, f.h) / seed.size < 1.6;
  const bestPerFrame = (seed: { cx: number; cy: number; size: number }) => {
    const members: Face[] = [];
    for (const faces of perFrame) {
      const hits = faces.filter((f) => near(seed, f));
      if (hits.length > 0) members.push(hits.reduce((a, b) => (b.score > a.score ? b : a)));
    }
    return members;
  };

  let best: Face[] = [];
  for (const faces of perFrame) {
    for (const f of faces) {
      const members = bestPerFrame({ cx: f.x + f.w / 2, cy: f.y + f.h / 2, size: Math.max(f.w, f.h) });
      if (members.length > best.length) best = members;
    }
  }
  if (best.length === 0) return null;
  // Re-centre on the member medians and collect again, so the seed's own jitter does not decide membership.
  const refined = bestPerFrame({
    cx: median(best.map((f) => f.x + f.w / 2)),
    cy: median(best.map((f) => f.y + f.h / 2)),
    size: median(best.map((f) => Math.max(f.w, f.h))),
  });
  const members = refined.length >= best.length ? refined : best;
  return {
    frames: members.length,
    box: {
      x: median(members.map((f) => f.x)),
      y: median(members.map((f) => f.y)),
      w: median(members.map((f) => f.w)),
      h: median(members.map((f) => f.h)),
    },
    extent: {
      x0: percentile(
        members.map((f) => f.x),
        0.1,
      ),
      y0: percentile(
        members.map((f) => f.y),
        0.1,
      ),
      x1: percentile(
        members.map((f) => f.x + f.w),
        0.9,
      ),
      y1: percentile(
        members.map((f) => f.y + f.h),
        0.9,
      ),
    },
  };
}

/**
 * Static-edge lookup: how much of a straight segment lies on an edge that stays put through the video.
 * Both orientations are tolerant of +-1 px so that blurred or rescaled borders still count.
 */
class PersistentEdges {
  /** colPrefix[y*w+x] = number of rows < y where a (dilated) vertical step is static at column x. */
  private readonly colPrefix: Uint16Array;
  /** rowPrefix[y*(w+1)+x] = number of columns < x where a (dilated) horizontal step is static on row y. */
  private readonly rowPrefix: Uint16Array;

  constructor(sums: EdgeSums, frames: number) {
    const { width, height } = sums;
    const need = frames * EDGE_MEAN_STEP;
    this.colPrefix = new Uint16Array((height + 1) * width);
    this.rowPrefix = new Uint16Array(height * (width + 1));
    const v = sums.vertical;
    const h = sums.horizontal;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const hit =
          Math.abs(v[i]!) >= need ||
          (x > 0 && Math.abs(v[i - 1]!) >= need) ||
          (x + 1 < width && Math.abs(v[i + 1]!) >= need);
        this.colPrefix[(y + 1) * width + x] = this.colPrefix[i]! + (hit ? 1 : 0);
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const hit =
          Math.abs(h[i]!) >= need ||
          (y > 0 && Math.abs(h[i - width]!) >= need) ||
          (y + 1 < height && Math.abs(h[i + width]!) >= need);
        this.rowPrefix[y * (width + 1) + x + 1] = this.rowPrefix[y * (width + 1) + x]! + (hit ? 1 : 0);
      }
    }
    this.width = width;
    this.height = height;
  }

  readonly width: number;
  readonly height: number;

  /** Fraction of rows y0..y1 (exclusive end) with a persistent vertical step at boundary x. */
  vertical(x: number, y0: number, y1: number): number {
    return (this.colPrefix[y1 * this.width + x]! - this.colPrefix[y0 * this.width + x]!) / (y1 - y0);
  }

  /** Fraction of columns x0..x1 (exclusive end) with a persistent horizontal step at boundary y. */
  horizontal(y: number, x0: number, x1: number): number {
    return (this.rowPrefix[y * (this.width + 1) + x1]! - this.rowPrefix[y * (this.width + 1) + x0]!) / (x1 - x0);
  }
}

/**
 * Strongest boundary positions in [from, to) by `coverage`, at least `gap` px apart. Dilated edges give
 * 3 px plateaus; the neighbour bonus makes the plateau centre win.
 */
function peaks(
  from: number,
  to: number,
  coverage: (p: number) => number,
  min: number,
  gap: number,
  max: number,
): number[] {
  const scored: { p: number; rank: number }[] = [];
  for (let p = from; p < to; p++) {
    const c = coverage(p);
    if (c >= min) scored.push({ p, rank: c + 1e-3 * (coverage(p - 1) + coverage(p + 1)) });
  }
  scored.sort((a, b) => b.rank - a.rank);
  const kept: number[] = [];
  for (const { p } of scored) {
    if (kept.length >= max) break;
    if (kept.every((k) => Math.abs(k - p) > gap)) kept.push(p);
  }
  return kept;
}

interface RectFit {
  rect: Rect;
  /** Mean side score 0..1 (frame-border sides count FRAME_SIDE_SCORE). */
  score: number;
}

/** Finds the overlay rect around the face whose four sides lie on persistent edges or on the frame border. */
function fitRect(edges: PersistentEdges, face: FaceCluster): RectFit | null {
  const { width, height } = edges;
  const { x0: fx0, y0: fy0, x1: fx1, y1: fy1 } = face.extent;
  const faceX0 = Math.floor(fx0);
  const faceY0 = Math.floor(fy0);
  const faceX1 = Math.ceil(fx1);
  const faceY1 = Math.ceil(fy1);
  // A side can be invisible where the face is (dark clothes on a dark game), so candidates are also
  // judged over a band three face widths/heights around the face centre.
  const cx = face.box.x + face.box.w / 2;
  const cy = face.box.y + face.box.h / 2;
  const span = (a: number, b: number, limit: number): [number, number] => [
    Math.max(0, Math.floor(a)),
    Math.min(limit, Math.ceil(b)),
  ];
  const [bandY0, bandY1] = span(face.box.y, face.box.y + face.box.h, height);
  const [bandX0, bandX1] = span(face.box.x, face.box.x + face.box.w, width);
  const [wideY0, wideY1] = span(cy - face.box.h * 3, cy + face.box.h * 3, height);
  const [wideX0, wideX1] = span(cx - face.box.w * 3, cx + face.box.w * 3, width);
  const gap = 6;
  const maxPer = 8;
  const minCoverage = 0.3;
  const vertical = (x: number) => Math.max(edges.vertical(x, bandY0, bandY1), edges.vertical(x, wideY0, wideY1));
  const horizontal = (y: number) => Math.max(edges.horizontal(y, bandX0, bandX1), edges.horizontal(y, wideX0, wideX1));

  const lefts = [0, ...peaks(1, faceX0, vertical, minCoverage, gap, maxPer)];
  const rights = [width, ...peaks(faceX1 + 1, width - 1, vertical, minCoverage, gap, maxPer)];
  const tops = [0, ...peaks(1, faceY0, horizontal, minCoverage, gap, maxPer)];
  const bottoms = [height, ...peaks(faceY1 + 1, height - 1, horizontal, minCoverage, gap, maxPer)];

  let best: RectFit | null = null;
  for (const x0 of lefts) {
    for (const x1 of rights) {
      const w = x1 - x0;
      for (const y0 of tops) {
        for (const y1 of bottoms) {
          const h = y1 - y0;
          const aspect = w / h;
          const area = (w * h) / (width * height);
          if (aspect < 0.9 || aspect > 2.2 || area < 0.015 || area > 0.35) continue;
          const sides = [
            x0 === 0 ? FRAME_SIDE_SCORE : edges.vertical(x0, y0, y1),
            x1 === width ? FRAME_SIDE_SCORE : edges.vertical(x1, y0, y1),
            y0 === 0 ? FRAME_SIDE_SCORE : edges.horizontal(y0, x0, x1),
            y1 === height ? FRAME_SIDE_SCORE : edges.horizontal(y1, x0, x1),
          ];
          if (Math.min(...sides) < MIN_SIDE_SCORE) continue;
          const score = sides.reduce((a, b) => a + b, 0) / 4;
          if (
            !best ||
            score > best.score + 1e-9 ||
            (Math.abs(score - best.score) <= 0.02 && w * h < best.rect.w * best.rect.h)
          ) {
            best = { rect: { x: x0, y: y0, w, h }, score };
          }
        }
      }
    }
  }
  return best;
}

/** Rect guessed from the face alone: ~3.2 face widths, 16:9, face centred horizontally and upper-middle vertically. */
function fallbackRect(face: Rect, width: number, height: number): Rect {
  let w = face.w * 3.2;
  let h = (w * 9) / 16;
  const fit = Math.min(1, width / w, height / h);
  w *= fit;
  h *= fit;
  const x = Math.min(width - w, Math.max(0, face.x + face.w / 2 - w / 2));
  const y = Math.min(height - h, Math.max(0, face.y + face.h / 2 - h * 0.42));
  return { x, y, w, h };
}

export async function detectWebcam(
  videoPath: string,
  meta: { duration: number; width: number; height: number },
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Webcam> {
  const session = await getSession();
  const shrink = Math.min(1, MAX_ANALYSIS_WIDTH / meta.width);
  const width = Math.max(2, Math.round((meta.width * shrink) / 2) * 2);
  const height = Math.max(2, Math.round((meta.height * shrink) / 2) * 2);
  const regions = faceRegions(width, height);
  const edges = new EdgeSums(width, height);
  const perFrame: Face[][] = Array.from({ length: SAMPLES }, () => []);
  const times = Array.from({ length: SAMPLES }, (_, k) => meta.duration * (0.05 + (0.9 * (k + 0.5)) / SAMPLES));

  let next = 0;
  let done = 0;
  let decoded = 0;
  const worker = async () => {
    for (let k = next++; k < SAMPLES; k = next++) {
      let rgb: Uint8Array;
      try {
        rgb = await grabFrame(videoPath, times[k]!, { width, height, format: "rgb24" }, signal);
      } catch (err) {
        signal?.throwIfAborted();
        // Sampling lands past the last decodable frame on some files; the remaining samples still carry the evidence.
        if (err instanceof Error && err.message.startsWith("No frame at")) {
          done++;
          continue;
        }
        throw err;
      }
      decoded++;
      edges.add(rgb);
      const found: Face[] = [];
      for (const region of regions) {
        signal?.throwIfAborted();
        found.push(...(await detectInRegion(session, rgb, width, height, region)));
      }
      perFrame[k] = nms(found, 0.4);
      onProgress?.(Math.min(0.95, ++done / SAMPLES));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (decoded < SAMPLES / 2) {
    throw new Error(`Could only decode ${decoded} of ${SAMPLES} sample frames from ${videoPath}`);
  }

  const none: Webcam = { rect: null, confidence: 0, source: "auto" };
  const cluster = clusterFaces(perFrame);
  const persistence = cluster ? cluster.frames / decoded : 0;
  if (!cluster || persistence < MIN_FACE_PERSISTENCE) {
    onProgress?.(1);
    return none;
  }

  const fit = fitRect(new PersistentEdges(edges, decoded), cluster);
  const faceStrength = Math.min(1, persistence / 0.8);
  let rect: Rect;
  let confidence: number;
  if (fit) {
    rect = fit.rect;
    confidence = 0.4 * faceStrength + 0.6 * fit.score;
  } else {
    rect = fallbackRect(cluster.box, width, height);
    confidence = 0.35 * faceStrength;
  }
  onProgress?.(1);

  const x = Math.max(0, Math.floor(rect.x / shrink));
  const y = Math.max(0, Math.floor(rect.y / shrink));
  const x1 = Math.min(meta.width, Math.ceil((rect.x + rect.w) / shrink));
  const y1 = Math.min(meta.height, Math.ceil((rect.y + rect.h) / shrink));
  return { rect: { x, y, w: x1 - x, h: y1 - y }, confidence: Math.round(confidence * 100) / 100, source: "auto" };
}
