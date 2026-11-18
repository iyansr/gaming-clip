import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

import {
  activeCue,
  buildCues,
  CAPTION_FONTS,
  drawCaptions,
  getCaptionStyle,
  type CaptionCue,
} from "../shared/captions";
import { drawCamBorder, drawCamMask, type ComposeContext } from "../shared/compose";
import { computeLayout, type LayoutLayer } from "../shared/layout";
import {
  OUTPUT_SIZE,
  type ClipSettings,
  type ClipTimeline,
  type Rect,
  type Watermark,
  type Word,
} from "../shared/types";
import { drawWatermarks, type WatermarkImages } from "../shared/watermark";
import { BIN, FONTS_DIR } from "./config";
import { videoEncoderArgs } from "./encoder";
import { ExecError } from "./exec";
import {
  assembleBookends,
  audioFxChains,
  ffColor,
  layoutFxChains,
  overlayFxChains,
  planAudioFx,
  planVideoFx,
  probeMedia,
  requireLibraryFile,
  tailOf,
  teaserRange,
  watchProgress,
  type AudioFx,
  type Bookends,
  type VideoFx,
} from "./fx";

export interface RenderJob {
  sourcePath: string;
  source: { width: number; height: number; fps: number; duration: number };
  start: number;
  end: number;
  settings: ClipSettings;
  webcam: Rect | null;
  /** Transcript words on the source timeline (any range; renderer filters). Ignored when settings.subtitles is false. */
  words: Word[];
  outPath: string;
  /** Directory of the project's uploaded background images; needed when the layout uses one. */
  assetsDir?: string;
  /** Editor timeline (SOURCE times, as stored on the clip); effects, overlays, sounds, voices and the teaser. */
  timeline: ClipTimeline;
  /** Media library directory; sounds, stickers, intro and outro are looked up here. */
  libraryDir: string;
}

const { width: OUT_W, height: OUT_H } = OUTPUT_SIZE;
/** Height of the caption overlay strip; fits two lines of the biggest style plus outline, glow and tilt. */
const STRIP_H = 480;
const MAX_FPS = 60;
const BLUR_DOWNSCALE = 8;
const BLUR_SIGMA = 6;
/** Share of the progress bar the clip pass takes when a second pass (teaser, intro, outro) follows. */
const MAIN_PASS_SHARE = 0.85;

let fontsRegistered = false;
/** Makes the bundled caption fonts available to every @napi-rs/canvas context in this process. */
export function registerFonts(): void {
  if (fontsRegistered) return;
  for (const font of CAPTION_FONTS) {
    const path = join(FONTS_DIR, font.file);
    if (!GlobalFonts.registerFromPath(path, font.family)) throw new Error(`Cannot register caption font ${path}`);
  }
  fontsRegistered = true;
}

function validate(job: RenderJob): void {
  const { start, end, source } = job;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Invalid clip range ${start}..${end}`);
  if (start < 0 || start >= end) throw new Error(`Invalid clip range: start ${start}s must be >= 0 and < end ${end}s`);
  if (end > source.duration + 0.001) {
    throw new Error(`Clip end ${end}s is beyond the source duration ${source.duration}s`);
  }
  if (!(source.fps > 0) || !(source.width > 0) || !(source.height > 0)) {
    throw new Error(`Invalid source metadata: ${source.width}x${source.height} @ ${source.fps} fps`);
  }
  if (job.settings.subtitles) getCaptionStyle(job.settings.captionStyle);
}

/** Frame rate as an ffmpeg rational: NTSC rates stay exact so the caption pipe and the video share one timebase. */
function frameRate(fps: number): { arg: string; value: number } {
  const capped = Math.min(fps, MAX_FPS);
  const nominal = Math.round(capped * 1.001);
  if (nominal !== capped && Math.abs(capped - (nominal * 1000) / 1001) < 0.01) {
    return { arg: `${nominal * 1000}/1001`, value: (nominal * 1000) / 1001 };
  }
  const rounded = Math.round(capped * 1000) / 1000;
  return { arg: String(rounded), value: rounded };
}

const evenAtLeast2 = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** A layout layer snapped to what ffmpeg can do exactly (even sizes and positions) and clipped to the frame. */
interface PlacedLayer {
  layer: LayoutLayer;
  /** Crop in source pixels. */
  src: Rect;
  /** Scaled size and position; may reach past the frame edges. */
  dst: Rect;
  /** Part of `dst` inside the frame; always non-empty. */
  visible: Rect;
  /** Webcam alpha mask / border ring PNGs, sized `visible` (set up by planGraph). */
  maskFile?: string;
  borderFile?: string;
}

interface GraphPlan {
  layers: PlacedLayer[];
  /** Base colour (#rgb / #rrggbb). */
  fill: string;
  /** Background image file, cover-fitted over the base colour. */
  imageFile: string | null;
  /** Transparent 1080x1920 PNG with every watermark, overlaid after the layout layers and under the captions. */
  watermarkFile: string | null;
  /** Timeline looks, zoom/shake, overlays and flashes (see fx.ts). */
  fx: VideoFx;
  /** Voice distortion and library sounds; null when the clip audio passes through untouched. */
  audio: AudioFx | null;
}

function placeLayers(layers: LayoutLayer[], source: { width: number; height: number }): PlacedLayer[] {
  const placed: PlacedLayer[] = [];
  for (const layer of layers) {
    const dst = {
      x: Math.round(layer.dst.x / 2) * 2,
      y: Math.round(layer.dst.y / 2) * 2,
      w: evenAtLeast2(layer.dst.w),
      h: evenAtLeast2(layer.dst.h),
    };
    const x = Math.max(0, dst.x);
    const y = Math.max(0, dst.y);
    const w = Math.min(OUT_W, dst.x + dst.w) - x;
    const h = Math.min(OUT_H, dst.y + dst.h) - y;
    if (w <= 0 || h <= 0) continue;
    // ffmpeg's crop rounds x/y down to even for 4:2:0 anyway.
    const sx = Math.min(Math.max(0, Math.floor(layer.src.x / 2) * 2), source.width - 2);
    const sy = Math.min(Math.max(0, Math.floor(layer.src.y / 2) * 2), source.height - 2);
    const src = {
      x: sx,
      y: sy,
      w: Math.min(Math.max(1, Math.round(layer.src.w)), source.width - sx),
      h: Math.min(Math.max(1, Math.round(layer.src.h)), source.height - sy),
    };
    placed.push({ layer, src, dst, visible: { x, y, w, h } });
  }
  return placed;
}

/** Draws a webcam PNG (mask or border) for the visible part of a layer's `dst`. */
async function writeCamImage(
  path: string,
  placed: PlacedLayer,
  draw: (ctx: ComposeContext, w: number, h: number) => void,
): Promise<void> {
  const { dst, visible } = placed;
  const canvas = createCanvas(visible.w, visible.h);
  const ctx = canvas.getContext("2d");
  // Shadow offsets ignore the transform, so the mask's soft edge still lands where the full element would put it.
  ctx.translate(dst.x - visible.x, dst.y - visible.y);
  draw(ctx, dst.w, dst.h);
  await Bun.write(path, await canvas.encode("png"));
}

/** Decodes the bitmaps of the image watermarks from the project's assets directory. */
export async function loadWatermarkImages(
  watermarks: Watermark[],
  assetsDir: string | undefined,
): Promise<WatermarkImages> {
  const images: WatermarkImages = new Map();
  for (const wm of watermarks) {
    if (wm.kind !== "image" || images.has(wm.file)) continue;
    if (!assetsDir) throw new Error("A watermark uses an image but the job has no assets directory");
    const path = join(assetsDir, basename(wm.file));
    if (!(await Bun.file(path).exists()))
      throw new Error(`Watermark image ${wm.file} is missing from the project assets`);
    const image = await loadImage(path);
    images.set(wm.file, { image, width: image.width, height: image.height });
  }
  return images;
}

/** Placement of the layout's layers plus the temporary images they need; every file written is listed in `scratch`. */
export async function planGraph(job: RenderJob, tmpPath: string, scratch: string[]): Promise<GraphPlan> {
  const layout = computeLayout(
    { width: job.source.width, height: job.source.height },
    job.webcam,
    job.settings,
    OUTPUT_SIZE,
  );
  const layers = placeLayers(layout.layers, job.source);
  const stem = tmpPath.slice(0, tmpPath.length - extname(tmpPath).length);
  let imageFile: string | null = null;
  if (layout.image) {
    if (!job.assetsDir) throw new Error("The layout has a background image but the render job has no assets directory");
    imageFile = join(job.assetsDir, basename(layout.image));
    if (!(await Bun.file(imageFile).exists()))
      throw new Error(`Background image ${layout.image} is missing from the project assets`);
  }
  for (const [i, placed] of layers.entries()) {
    const style = placed.layer.cam;
    if (!style) continue;
    if (style.feather > 0 || style.radius > 0) {
      placed.maskFile = `${stem}.mask${i}.png`;
      scratch.push(placed.maskFile);
      await writeCamImage(placed.maskFile, placed, (ctx, w, h) => drawCamMask(ctx, w, h, style));
    }
    if (style.border > 0) {
      placed.borderFile = `${stem}.border${i}.png`;
      scratch.push(placed.borderFile);
      await writeCamImage(placed.borderFile, placed, (ctx, w, h) => drawCamBorder(ctx, w, h, style));
    }
  }
  let watermarkFile: string | null = null;
  if (job.settings.watermarks.length > 0) {
    registerFonts();
    const images = await loadWatermarkImages(job.settings.watermarks, job.assetsDir);
    const canvas = createCanvas(OUT_W, OUT_H);
    drawWatermarks(canvas.getContext("2d"), job.settings.watermarks, images, OUTPUT_SIZE, (width, height) =>
      createCanvas(width, height).getContext("2d"),
    );
    watermarkFile = `${stem}.watermarks.png`;
    scratch.push(watermarkFile);
    await Bun.write(watermarkFile, await canvas.encode("png"));
  }
  const clip = { start: job.start, end: job.end };
  if (job.timeline.items.some((item) => item.kind === "overlay")) registerFonts();
  const fx = await planVideoFx(job.timeline, clip, job.libraryDir, stem, scratch);
  const audio = await planAudioFx(job.timeline, clip, job.sourcePath, job.libraryDir);
  return { layers, fill: layout.fill, imageFile, watermarkFile, fx, audio };
}

/** Still-image inputs after the video (and caption pipe), in the order the graph refers to them. */
function extraFiles(plan: GraphPlan): string[] {
  return [
    plan.imageFile,
    ...plan.layers.flatMap((placed) => [placed.maskFile, placed.borderFile]),
    plan.watermarkFile,
    ...plan.fx.overlays.map((overlay) => overlay.file),
  ].filter((file): file is string => file !== undefined && file !== null);
}

/** The video filter graph; with an empty timeline it contains nothing but the layout, watermarks and captions. */
export function buildFilterGraph(
  plan: GraphPlan,
  fps: string,
  duration: number,
  captions: { y: number } | null,
): string {
  const chains: string[] = [];
  const { layers } = plan;
  const n = layers.length;
  const files = extraFiles(plan);
  const inputOf = (file: string) => (captions ? 2 : 1) + files.indexOf(file);

  if (n > 0) {
    chains.push(
      n === 1
        ? `[0:v]fps=${fps}:start_time=0[s0]`
        : `[0:v]fps=${fps}:start_time=0,split=${n}${layers.map((_, i) => `[s${i}]`).join("")}`,
    );
  }
  layers.forEach(({ layer, src, dst, visible, maskFile }, i) => {
    const crop = `crop=${src.w}:${src.h}:${src.x}:${src.y}`;
    // Blur at low resolution: same look as a huge-radius blur at a fraction of the cost.
    const scaling = layer.blur
      ? `scale=${evenAtLeast2(dst.w / BLUR_DOWNSCALE)}:${evenAtLeast2(dst.h / BLUR_DOWNSCALE)},gblur=sigma=${BLUR_SIGMA},scale=${dst.w}:${dst.h}`
      : `scale=${dst.w}:${dst.h}:flags=lanczos`;
    const inside =
      visible.w === dst.w && visible.h === dst.h
        ? ""
        : `,crop=${visible.w}:${visible.h}:${visible.x - dst.x}:${visible.y - dst.y}`;
    chains.push(`[s${i}]${crop},${scaling}${inside}[${maskFile ? `u${i}` : `l${i}`}]`);
    if (maskFile) {
      chains.push(`[${inputOf(maskFile)}:v]format=rgba,alphaextract[m${i}]`);
      chains.push(`[u${i}][m${i}]alphamerge[l${i}]`);
    }
  });

  const first = layers[0];
  const coversFrame =
    first !== undefined &&
    plan.imageFile === null &&
    !first.maskFile &&
    first.visible.w === OUT_W &&
    first.visible.h === OUT_H;
  let acc = "[l0]";
  if (!coversFrame) {
    // The color source is BT.601; go through RGB so the base matches the BT.709 of the rest of the frame.
    chains.push(
      `color=c=${ffColor(plan.fill)}:s=${OUT_W}x${OUT_H}:r=${fps}:d=${duration.toFixed(3)},` +
        `format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[base]`,
    );
    acc = "[base]";
    if (plan.imageFile) {
      chains.push(
        `[${inputOf(plan.imageFile)}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUT_W}:${OUT_H},` +
          `scale=out_color_matrix=bt709,format=yuva420p[image]`,
      );
      chains.push(`[base][image]overlay=0:0[bg]`);
      acc = "[bg]";
    }
  }
  layers.forEach(({ visible, borderFile }, i) => {
    if (i === 0 && coversFrame) return;
    chains.push(`${acc}[l${i}]overlay=${visible.x}:${visible.y}[o${i}]`);
    acc = `[o${i}]`;
    if (borderFile) {
      chains.push(`[${inputOf(borderFile)}:v]scale=out_color_matrix=bt709,format=yuva420p[b${i}]`);
      chains.push(`${acc}[b${i}]overlay=${visible.x}:${visible.y}[ob${i}]`);
      acc = `[ob${i}]`;
    }
  });
  const layoutFx = layoutFxChains(plan.fx, acc);
  chains.push(...layoutFx.chains);
  acc = layoutFx.acc;
  if (plan.watermarkFile) {
    chains.push(`[${inputOf(plan.watermarkFile)}:v]scale=out_color_matrix=bt709,format=yuva420p[wm]`);
    chains.push(`${acc}[wm]overlay=0:0[ow]`);
    acc = "[ow]";
  }
  const overlays = overlayFxChains(plan.fx, acc, fps, inputOf);
  chains.push(...overlays.chains);
  acc = overlays.acc;
  if (captions) {
    chains.push(`[1:v]scale=out_color_matrix=bt709,format=yuva420p[cap]`);
    chains.push(`${acc}[cap]overlay=0:${captions.y}[oc]`);
    acc = "[oc]";
  }
  chains.push(`${acc}setsar=1,format=yuv420p[vout]`);
  return chains.join(";");
}

/**
 * ffmpeg arguments of the clip pass: source (seeked to the clip), caption pipe, stills, library sounds, the graph.
 * Without a timeline audio plan the clip audio is mapped straight through, as before the editor existed.
 */
export function buildEncodeArgs(
  job: RenderJob,
  plan: GraphPlan,
  strip: { y: number } | null,
  fps: string,
  videoArgs: string[],
  outPath: string,
): string[] {
  const duration = job.end - job.start;
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    job.start.toFixed(3),
    "-t",
    duration.toFixed(3),
    "-i",
    job.sourcePath,
  ];
  if (strip) {
    args.push(
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-video_size",
      `${OUT_W}x${STRIP_H}`,
      "-framerate",
      fps,
      "-i",
      "pipe:0",
    );
  }
  // Stills (background image, webcam masks and borders) loop for the whole clip; an overlay's only for its item.
  const stillLength = new Map(plan.fx.overlays.map(({ item, file }) => [file, item.end - item.start]));
  const files = extraFiles(plan);
  for (const file of files)
    args.push("-loop", "1", "-framerate", fps, "-t", (stillLength.get(file) ?? duration).toFixed(3), "-i", file);
  const { audio } = plan;
  for (const sound of audio?.sounds ?? []) args.push("-i", sound.file);
  const graph = buildFilterGraph(plan, fps, duration, strip);
  const firstSoundInput = (strip ? 2 : 1) + files.length;
  args.push(
    "-filter_complex",
    audio ? [graph, ...audioFxChains(audio, duration, firstSoundInput)].join(";") : graph,
    "-map",
    "[vout]",
    "-map",
    audio ? "[aout]" : "0:a:0?",
    ...videoArgs,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    ...(audio ? ["-ar", "48000", "-ac", "2"] : []),
    "-movflags",
    "+faststart",
    "-t",
    duration.toFixed(3),
    "-progress",
    "pipe:1",
    "-nostats",
    outPath,
  );
  return args;
}

async function encode(
  job: RenderJob,
  plan: GraphPlan,
  outPath: string,
  cues: CaptionCue[],
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const duration = job.end - job.start;
  const fps = frameRate(job.source.fps);

  const captionY = Math.min(1, Math.max(0, job.settings.captionY)) * OUT_H;
  const strip =
    cues.length > 0
      ? { y: Math.min(OUT_H - STRIP_H, Math.max(0, Math.round((captionY - STRIP_H / 2) / 2) * 2)) }
      : null;
  const args = buildEncodeArgs(job, plan, strip, fps.arg, await videoEncoderArgs(), outPath);

  const proc = Bun.spawn([BIN.ffmpeg, ...args], {
    stdin: strip ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => proc.kill(9);
  signal?.addEventListener("abort", onAbort, { once: true });
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });

  /** Resolves to an error only when feeding failed while ffmpeg was still healthy. */
  const feedCaptions = async (): Promise<Error | null> => {
    const sink = proc.stdin;
    if (!strip || !sink || typeof sink === "number") return null;
    try {
      registerFonts();
      const canvas = createCanvas(OUT_W, STRIP_H);
      const ctx = canvas.getContext("2d");
      ctx.translate(0, -strip.y);
      const blank = Buffer.alloc(OUT_W * STRIP_H * 4);
      const frame = { width: OUT_W, height: OUT_H, centerY: captionY };
      const frames = Math.ceil(duration * fps.value);
      for (let i = 0; i < frames && !exited && !signal?.aborted; i++) {
        const t = i / fps.value;
        let rgba: Buffer = blank;
        if (activeCue(cues, t)) {
          ctx.clearRect(0, strip.y, OUT_W, STRIP_H);
          drawCaptions(ctx, cues, t, job.settings.captionStyle, frame);
          const { data } = ctx.getImageData(0, 0, OUT_W, STRIP_H);
          rgba = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        }
        // Buffered write; the flush below applies the backpressure and surfaces a broken pipe.
        void sink.write(rgba);
        await Promise.race([sink.flush(), proc.exited]);
      }
      await Promise.race([sink.end(), proc.exited]);
      return null;
    } catch (err) {
      // A dead ffmpeg breaks the pipe; its exit code and stderr are the real story then.
      const diedByItself = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
      if (diedByItself) return null;
      proc.kill(9);
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  try {
    const stderrP = tailOf(proc.stderr);
    const progressP = watchProgress(proc.stdout, duration, onProgress);
    const feedP = feedCaptions();
    const exitCode = await proc.exited;
    const [stderr, , feedError] = await Promise.all([stderrP, progressP, feedP]);
    signal?.throwIfAborted();
    if (feedError) throw new Error(`Caption rendering failed: ${feedError.message}`);
    if (exitCode !== 0) throw new ExecError(BIN.ffmpeg, exitCode, stderr);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    proc.kill(9);
  }
}

/**
 * Render one clip to `job.outPath`: reframe to 1080x1920 per computeLayout, apply the timeline (looks, zoom/shake,
 * overlays, flashes, voice and sounds), burn captions (drawn with @napi-rs/canvas and piped to ffmpeg as raw RGBA,
 * since this ffmpeg build has no subtitle/drawtext filters). A teaser, intro or outro makes a second pass that
 * concatenates intro + teaser + clip + outro.
 */
export async function renderClip(
  job: RenderJob,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  validate(job);
  signal?.throwIfAborted();
  const cues = job.settings.subtitles ? buildCues(job.words, job.start, job.end, job.settings.captionStyle) : [];
  const { intro, outro } = job.settings;
  const introPath = intro ? await requireLibraryFile(job.libraryDir, intro, "The intro") : null;
  const outroPath = outro ? await requireLibraryFile(job.libraryDir, outro, "The outro") : null;
  // The teaser is a range of the finished clip, so it is cut from the main pass.
  const teaser = teaserRange(job.timeline, { start: job.start, end: job.end });
  const assemble = teaser !== null || introPath !== null || outroPath !== null;
  const share = assemble ? MAIN_PASS_SHARE : 1;

  await mkdir(dirname(job.outPath), { recursive: true });
  const ext = extname(job.outPath) || ".mp4";
  const tmpPath = join(
    dirname(job.outPath),
    `.${basename(job.outPath, ext)}.${crypto.randomUUID().slice(0, 8)}.partial${ext}`,
  );
  const scratch: string[] = [];
  try {
    const plan = await planGraph(job, tmpPath, scratch);
    signal?.throwIfAborted();
    let mainPath = tmpPath;
    if (assemble) {
      mainPath = `${tmpPath.slice(0, tmpPath.length - ext.length)}.main${ext}`;
      scratch.push(mainPath);
    }
    await encode(job, plan, mainPath, cues, (p) => onProgress(p * share), signal);
    if (assemble) {
      const bookends: Bookends = {
        mainPath,
        main: await probeMedia(mainPath),
        teaser,
        teaserOverlays: plan.fx.teaserOverlays,
        intro: introPath ? { path: introPath, info: await probeMedia(introPath) } : null,
        outro: outroPath ? { path: outroPath, info: await probeMedia(outroPath) } : null,
      };
      await assembleBookends(
        bookends,
        frameRate(job.source.fps).arg,
        tmpPath,
        (p) => onProgress(Math.min(0.99, share + (1 - share) * p)),
        signal,
      );
    }
    await rename(tmpPath, job.outPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  } finally {
    await Promise.all(scratch.map((file) => rm(file, { force: true })));
  }
  onProgress(1);
}
