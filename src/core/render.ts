import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { activeCue, buildCues, CAPTION_FONTS, drawCaptions, getCaptionStyle, type CaptionCue } from "../shared/captions";
import { computeLayout, type LayoutLayer } from "../shared/layout";
import { OUTPUT_SIZE, type ClipSettings, type Rect, type Word } from "../shared/types";
import { BIN, FONTS_DIR } from "./config";
import { ExecError } from "./exec";

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
}

const { width: OUT_W, height: OUT_H } = OUTPUT_SIZE;
/** Height of the caption overlay strip; fits two lines of the biggest style plus outline, glow and tilt. */
const STRIP_H = 480;
const MAX_FPS = 60;
const BLUR_DOWNSCALE = 8;
const BLUR_SIGMA = 6;
const STDERR_TAIL = 8 * 1024;

let fontsRegistered = false;
function registerFonts(): void {
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

function buildFilterGraph(layers: LayoutLayer[], fps: string, duration: number, captions: { y: number } | null): string {
  const chains: string[] = [];
  const n = layers.length;
  chains.push(
    n === 1
      ? `[0:v]fps=${fps}:start_time=0[s0]`
      : `[0:v]fps=${fps}:start_time=0,split=${n}${layers.map((_, i) => `[s${i}]`).join("")}`,
  );
  layers.forEach(({ src, dst, blur }, i) => {
    const crop = `crop=${src.w}:${src.h}:${src.x}:${src.y}`;
    // Blur at low resolution: same look as a huge-radius blur at a fraction of the cost.
    const scaling = blur
      ? `scale=${evenAtLeast2(dst.w / BLUR_DOWNSCALE)}:${evenAtLeast2(dst.h / BLUR_DOWNSCALE)},gblur=sigma=${BLUR_SIGMA},scale=${dst.w}:${dst.h}`
      : `scale=${dst.w}:${dst.h}:flags=lanczos`;
    chains.push(`[s${i}]${crop},${scaling}[l${i}]`);
  });

  const first = layers[0]!;
  const coversFrame = first.dst.x === 0 && first.dst.y === 0 && first.dst.w === OUT_W && first.dst.h === OUT_H;
  let acc = "[l0]";
  if (!coversFrame) {
    chains.push(`color=c=black:s=${OUT_W}x${OUT_H}:r=${fps}:d=${duration.toFixed(3)}[base]`);
    chains.push(`[base][l0]overlay=${first.dst.x}:${first.dst.y}[o0]`);
    acc = "[o0]";
  }
  for (let i = 1; i < n; i++) {
    const { dst } = layers[i]!;
    chains.push(`${acc}[l${i}]overlay=${dst.x}:${dst.y}[o${i}]`);
    acc = `[o${i}]`;
  }
  if (captions) {
    chains.push(`[1:v]scale=out_color_matrix=bt709,format=yuva420p[cap]`);
    chains.push(`${acc}[cap]overlay=0:${captions.y}[oc]`);
    acc = "[oc]";
  }
  chains.push(`${acc}setsar=1,format=yuv420p[vout]`);
  return chains.join(";");
}

async function tailOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let kept = "";
  for await (const chunk of stream) {
    kept += decoder.decode(chunk, { stream: true });
    if (kept.length > STDERR_TAIL * 2) kept = kept.slice(-STDERR_TAIL);
  }
  return kept.slice(-STDERR_TAIL);
}

async function watchProgress(stream: ReadableStream<Uint8Array>, duration: number, onProgress: (p: number) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("out_time_us=")) continue;
      const us = Number(line.slice("out_time_us=".length));
      if (Number.isFinite(us) && us >= 0) onProgress(Math.min(0.99, us / 1e6 / duration));
    }
  }
}

async function encode(
  job: RenderJob,
  tmpPath: string,
  cues: CaptionCue[],
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const duration = job.end - job.start;
  const fps = frameRate(job.source.fps);
  const layout = computeLayout({ width: job.source.width, height: job.source.height }, job.webcam, job.settings, OUTPUT_SIZE);

  const captionY = Math.min(1, Math.max(0, job.settings.captionY)) * OUT_H;
  const strip =
    cues.length > 0
      ? { y: Math.min(OUT_H - STRIP_H, Math.max(0, Math.round((captionY - STRIP_H / 2) / 2) * 2)) }
      : null;

  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", job.start.toFixed(3), "-t", duration.toFixed(3), "-i", job.sourcePath,
  ];
  if (strip) {
    args.push("-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${OUT_W}x${STRIP_H}`, "-framerate", fps.arg, "-i", "pipe:0");
  }
  args.push(
    "-filter_complex", buildFilterGraph(layout.layers, fps.arg, duration, strip),
    "-map", "[vout]", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "-t", duration.toFixed(3),
    "-progress", "pipe:1", "-nostats",
    tmpPath,
  );

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
        sink.write(rgba);
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
 * Render one clip to `job.outPath`: reframe to 1080x1920 per computeLayout, burn captions (drawn with
 * @napi-rs/canvas and piped to ffmpeg as raw RGBA, since this ffmpeg build has no subtitle/drawtext filters).
 */
export async function renderClip(job: RenderJob, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
  validate(job);
  signal?.throwIfAborted();
  const cues = job.settings.subtitles ? buildCues(job.words, job.start, job.end, job.settings.captionStyle) : [];

  await mkdir(dirname(job.outPath), { recursive: true });
  const ext = extname(job.outPath) || ".mp4";
  const tmpPath = join(dirname(job.outPath), `.${basename(job.outPath, ext)}.${crypto.randomUUID().slice(0, 8)}.partial${ext}`);
  try {
    await encode(job, tmpPath, cues, onProgress, signal);
    await rename(tmpPath, job.outPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  onProgress(1);
}
