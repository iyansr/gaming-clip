import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createCanvas, ImageData, loadImage, type Image } from "@napi-rs/canvas";
import { computeLayout } from "../shared/layout";
import { drawThumbnail, getThumbnailStyle, type ThumbnailContext } from "../shared/thumbnail";
import { OUTPUT_SIZE, type ClipSettings, type LoudnessEnvelope, type Rect } from "../shared/types";
import { grabFrame } from "./frames";
import { registerFonts } from "./render";

export interface ThumbnailCandidate {
  time: number;
  /** 0..1, best candidate = 1. */
  score: number;
}

export interface ThumbnailSearch {
  sourcePath: string;
  source: { width: number; height: number; duration: number };
  start: number;
  end: number;
  webcam: Rect | null;
  loudness: LoudnessEnvelope | null;
}

export interface ThumbnailJob {
  sourcePath: string;
  source: { width: number; height: number };
  time: number;
  settings: Pick<ClipSettings, "layout" | "focusX" | "custom">;
  webcam: Rect | null;
  text: string;
  style: string;
  textY: number;
  outPath: string;
  /** Directory of the project's uploaded background images; needed when the layout uses one. */
  assetsDir?: string;
}

const JPEG_QUALITY = 90;

/** Analysis frame width; sharpness is compared between frames of one clip, so absolute size is irrelevant. */
const PROBE_WIDTH = 320;
const PROBE_CONCURRENCY = 4;
/** Keep away from the clip edges: cuts and fades live there. */
const EDGE_GUARD = 0.4;
const MIN_SPACING = 0.7;
const LOUD_PEAKS = 4;
const PEAK_SPACING = 1.5;
/** A face reacts a moment after the sound that caused it. */
const REACTION_DELAYS = [0.3, 0.7];
const SPREAD_SAMPLES = 6;
/** Below this mean luma (0..255) a frame is a fade or a loading screen. */
const DARK_LUMA = 14;
const WEBCAM_WEIGHT = 0.6;
const LOUD_BONUS = 0.15;

/** Times worth probing: just after the loudest moments, plus an even spread as a fallback. */
function probeTimes(start: number, end: number, loudness: LoudnessEnvelope | null): { time: number; loud: number }[] {
  const from = start + Math.min(EDGE_GUARD, (end - start) / 4);
  const to = end - Math.min(EDGE_GUARD, (end - start) / 4);
  const picks: { time: number; loud: number }[] = [];
  if (loudness && loudness.step > 0) {
    const steps: { time: number; db: number }[] = [];
    for (let i = Math.max(0, Math.floor(from / loudness.step)); i < loudness.rms.length && i * loudness.step < to; i++) {
      steps.push({ time: i * loudness.step, db: loudness.rms[i]! });
    }
    const peaks: { time: number; db: number }[] = [];
    for (const step of [...steps].sort((a, b) => b.db - a.db)) {
      if (peaks.length === LOUD_PEAKS) break;
      if (peaks.every((peak) => Math.abs(peak.time - step.time) >= PEAK_SPACING)) peaks.push(step);
    }
    peaks.forEach((peak, rank) => {
      for (const delay of REACTION_DELAYS) picks.push({ time: peak.time + delay, loud: 1 - rank / LOUD_PEAKS });
    });
  }
  for (let i = 0; i < SPREAD_SAMPLES; i++) picks.push({ time: from + ((to - from) * (i + 0.5)) / SPREAD_SAMPLES, loud: 0 });

  const kept: { time: number; loud: number }[] = [];
  for (const pick of picks) {
    const time = Math.round(Math.min(to, Math.max(from, pick.time)) * 100) / 100;
    if (kept.every((other) => Math.abs(other.time - time) >= 0.2)) kept.push({ time, loud: pick.loud });
  }
  return kept;
}

/** Mean absolute Laplacian (edge energy) and mean luma of a region of a gray frame. Blurred frames score low. */
function regionStats(gray: Uint8Array, width: number, region: Rect): { sharpness: number; luma: number } {
  const x0 = Math.max(1, Math.floor(region.x));
  const y0 = Math.max(1, Math.floor(region.y));
  const x1 = Math.min(width - 1, Math.ceil(region.x + region.w));
  const y1 = Math.min(gray.length / width - 1, Math.ceil(region.y + region.h));
  let edges = 0;
  let luma = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const center = gray[i]!;
      edges += Math.abs(4 * center - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!);
      luma += center;
      count++;
    }
  }
  return count === 0 ? { sharpness: 0, luma: 0 } : { sharpness: edges / count, luma: luma / count };
}

/** Good cover frames inside [start, end], best first, at least 0.7 s apart. */
export async function suggestThumbnailTimes(input: ThumbnailSearch, count = 6, signal?: AbortSignal): Promise<ThumbnailCandidate[]> {
  const { source, webcam } = input;
  const width = PROBE_WIDTH;
  const height = Math.max(2, Math.round((PROBE_WIDTH * source.height) / source.width / 2) * 2);
  const k = width / source.width;
  const whole: Rect = { x: 0, y: 0, w: width, h: height };
  const cam: Rect | null = webcam && { x: webcam.x * k, y: webcam.y * k, w: webcam.w * k, h: webcam.h * k };

  const times = probeTimes(input.start, Math.min(input.end, source.duration), input.loudness);
  const probes: { time: number; loud: number; frame: number; cam: number; luma: number }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: PROBE_CONCURRENCY }, async () => {
      while (next < times.length) {
        const probe = times[next++]!;
        const gray = await grabFrame(input.sourcePath, probe.time, { width, height, format: "gray" }, signal);
        const frame = regionStats(gray, width, whole);
        const face = cam ? regionStats(gray, width, cam) : null;
        probes.push({ ...probe, frame: frame.sharpness, cam: face?.sharpness ?? 0, luma: (face ?? frame).luma });
      }
    }),
  );

  const maxFrame = Math.max(...probes.map((probe) => probe.frame), 1e-6);
  const maxCam = Math.max(...probes.map((probe) => probe.cam), 1e-6);
  const scored = probes
    .map((probe) => {
      const sharp = cam
        ? WEBCAM_WEIGHT * (probe.cam / maxCam) + (1 - WEBCAM_WEIGHT) * (probe.frame / maxFrame)
        : probe.frame / maxFrame;
      return { time: probe.time, score: (sharp + LOUD_BONUS * probe.loud) * Math.min(1, probe.luma / DARK_LUMA) };
    })
    .sort((a, b) => b.score - a.score);

  const best = Math.max(scored[0]?.score ?? 0, 1e-6);
  const kept: ThumbnailCandidate[] = [];
  for (const candidate of scored) {
    if (kept.length === count) break;
    if (kept.every((other) => Math.abs(other.time - candidate.time) >= MIN_SPACING)) {
      kept.push({ time: candidate.time, score: Math.round((candidate.score / best) * 100) / 100 });
    }
  }
  return kept;
}

/** Writes the cover as a 1080x1920 JPEG (temp file + rename). */
export async function renderThumbnail(job: ThumbnailJob, signal?: AbortSignal): Promise<void> {
  getThumbnailStyle(job.style);
  if (!Number.isFinite(job.time) || job.time < 0) throw new Error(`Invalid thumbnail time ${job.time}`);
  const { width, height } = job.source;

  const rgb = await grabFrame(job.sourcePath, job.time, { width, height, format: "rgb24" }, signal);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    rgba[o] = rgb[i]!;
    rgba[o + 1] = rgb[i + 1]!;
    rgba[o + 2] = rgb[i + 2]!;
    rgba[o + 3] = 255;
  }
  const frame = createCanvas(width, height);
  frame.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);

  registerFonts();
  const canvas = createCanvas(OUTPUT_SIZE.width, OUTPUT_SIZE.height);
  const layout = computeLayout(job.source, job.webcam, job.settings, OUTPUT_SIZE);
  let backgroundImage: { image: Image; size: { width: number; height: number } } | undefined;
  if (layout.image) {
    if (!job.assetsDir) throw new Error("The layout has a background image but the thumbnail job has no assets directory");
    const image = await loadImage(join(job.assetsDir, basename(layout.image)));
    backgroundImage = { image, size: { width: image.width, height: image.height } };
  }
  drawThumbnail(
    canvas.getContext("2d") as unknown as ThumbnailContext,
    frame,
    job.source,
    layout,
    {
      text: job.text,
      styleId: job.style,
      textY: job.textY,
      sourceSize: job.source,
      backgroundImage,
      createCanvas: (width, height) => createCanvas(width, height).getContext("2d") as unknown as ThumbnailContext,
    },
    OUTPUT_SIZE,
  );
  const jpeg = await canvas.encode("jpeg", JPEG_QUALITY);
  signal?.throwIfAborted();

  await mkdir(dirname(job.outPath), { recursive: true });
  const temp = `${job.outPath}.partial`;
  try {
    await Bun.write(temp, jpeg);
    await rename(temp, job.outPath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
