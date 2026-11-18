/**
 * Timeline effects for the renderer: ffmpeg graph pieces for looks, zoom/shake, overlays and flashes, the voice and
 * sound mix, and the final intro + teaser + clip + outro pass. The math lives in src/shared/effects.ts (the browser
 * preview evaluates the same functions); this file only turns it into filters. Times in `VideoFx` / `AudioFx` are
 * clip-relative.
 */
import { join, basename } from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import {
  FLASH_ALPHA,
  frameTransformExpr,
  OVERLAY_FADE_IN,
  OVERLAY_FADE_OUT,
  overlayAnimExpr,
  relativeItems,
} from "../shared/effects";
import {
  OUTPUT_SIZE,
  type ClipTimeline,
  type FlashItem,
  type LookId,
  type LookItem,
  type OverlayItem,
  type TimelineItem,
  type VoiceFx,
  type VoiceItem,
  type Watermark,
} from "../shared/types";
import { drawWatermarks, measureWatermark, type WatermarkImages } from "../shared/watermark";
import { BIN } from "./config";
import { videoEncoderArgs } from "./encoder";
import { ExecError, run } from "./exec";

const { width: OUT_W, height: OUT_H } = OUTPUT_SIZE;
const STDERR_TAIL = 8 * 1024;
const SAMPLE_RATE = 48_000;
/** Largest peak the final mix may reach; keeps summed sounds and distorted voices out of hard digital clipping. */
const LIMITER = "alimiter=limit=0.97:level=0";
const even = (n: number) => Math.ceil(n / 2) * 2;
/** Transparent margin around a rotated element's bitmap, px: antialiasing and the outline's soft edge. */
const BITMAP_PAD = 4;

/** `#rgb` / `#rrggbb` as an ffmpeg colour. */
export function ffColor(color: string): string {
  const hex = color.slice(1);
  return `0x${
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex
  }`;
}

/** Seconds as an ffmpeg expression literal (millisecond precision is plenty for gates). */
const sec = (v: number) => Number(v.toFixed(4)).toString();
const gate = (item: { start: number; end: number }) => `between(t,${sec(item.start)},${sec(item.end)})`;

/** Path of a library file used by a timeline item or bookend; throws a readable error when it is gone. */
export async function requireLibraryFile(libraryDir: string, file: string, what: string): Promise<string> {
  const path = join(libraryDir, basename(file));
  if (!(await Bun.file(path).exists())) throw new Error(`${what} uses library file "${file}", which no longer exists`);
  return path;
}

// ---------------------------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------------------------

export interface PlannedOverlay {
  /** Clip-relative item. */
  item: OverlayItem;
  /** PNG of the element, centred, large enough for its rotated box. */
  file: string;
}

/** Everything the video graph needs for the timeline, clip-relative; the lists are in paint order. */
export interface VideoFx {
  looks: LookItem[];
  /** Zoom + shake of the composed layout; null when the timeline has neither. */
  transform: { scale: string; x: string; y: string } | null;
  overlays: PlannedOverlay[];
  /** `overTeaser` overlays, re-timed to the teaser segment (start 0); empty without a teaser. Drawn by the final pass. */
  teaserOverlays: PlannedOverlay[];
  flashes: FlashItem[];
}

/**
 * The teaser as a range of the rendered clip (seconds from the clip start), or null when the timeline has none or
 * it falls outside the clip.
 */
export function teaserRange(
  timeline: ClipTimeline,
  clip: { start: number; end: number },
): { start: number; length: number } | null {
  const { teaser } = timeline;
  if (!teaser) return null;
  const duration = clip.end - clip.start;
  const start = Math.min(duration, Math.max(0, teaser.start - clip.start));
  const end = Math.min(duration, Math.max(0, teaser.end - clip.start));
  return end - start > 1e-3 ? { start, length: end - start } : null;
}

/** Decodes the library stickers an overlay timeline refers to. */
async function loadStickers(overlays: OverlayItem[], libraryDir: string): Promise<WatermarkImages> {
  const images: WatermarkImages = new Map();
  for (const item of overlays) {
    const el = item.element;
    if (el.kind !== "image" || images.has(el.file)) continue;
    const path = await requireLibraryFile(libraryDir, el.file, `Overlay "${item.id}"`);
    const image = await loadImage(path);
    images.set(el.file, { image, width: image.width, height: image.height });
  }
  return images;
}

/**
 * Draws one overlay element on its own transparent canvas, centred and sized for its rotated box. Fonts must be
 * registered by the caller (text is measured here).
 */
async function writeElementBitmap(
  path: string,
  element: Watermark,
  images: WatermarkImages,
  item: OverlayItem,
): Promise<void> {
  const measure = createCanvas(1, 1).getContext("2d");
  const box = measureWatermark(measure, element, images);
  if (!box) throw new Error(`Overlay "${item.id}": the image of the sticker is missing`);
  const rad = (element.rotation * Math.PI) / 180;
  const width = even(box.w * Math.abs(Math.cos(rad)) + box.h * Math.abs(Math.sin(rad)) + 2 * BITMAP_PAD);
  const height = even(box.w * Math.abs(Math.sin(rad)) + box.h * Math.abs(Math.cos(rad)) + 2 * BITMAP_PAD);
  const canvas = createCanvas(width, height);
  drawWatermarks(
    canvas.getContext("2d"),
    [{ ...element, x: width / 2, y: height / 2 }],
    images,
    // Only the width matters (scale factor 1); a frame-sized scratch for translucent outlined text is this canvas's size.
    { width: OUT_W, height },
    (w, h) => createCanvas(w, h).getContext("2d"),
  );
  await Bun.write(path, await canvas.encode("png"));
}

/**
 * Plans the video side of a timeline: clip-relative items and one PNG per overlay (listed in `scratch`).
 * `registerFonts()` must have run when an overlay holds text.
 */
export async function planVideoFx(
  timeline: ClipTimeline,
  clip: { start: number; end: number },
  libraryDir: string,
  stem: string,
  scratch: string[],
): Promise<VideoFx> {
  const items = relativeItems(timeline.items, clip.start, clip.end);
  const of = <K extends TimelineItem["kind"]>(kind: K) =>
    items.filter((item): item is Extract<TimelineItem, { kind: K }> => item.kind === kind);
  const overlayItems = of("overlay");
  const teaser = teaserRange(timeline, clip);
  // Teaser copies come from the source-time items: the hook headline may start before the clip and still be wanted.
  const teaserItems = teaser
    ? timeline.items.filter((item): item is OverlayItem => item.kind === "overlay" && item.overTeaser === true)
    : [];
  const images = await loadStickers([...overlayItems, ...teaserItems], libraryDir);
  const overlays: PlannedOverlay[] = [];
  for (const [i, item] of overlayItems.entries()) {
    const file = `${stem}.fx${i}.png`;
    scratch.push(file);
    await writeElementBitmap(file, item.element, images, item);
    overlays.push({ item, file });
  }
  const teaserOverlays: PlannedOverlay[] = [];
  for (const [i, source] of teaserItems.entries()) {
    // Same bitmap as the clip copy when there is one; the animation restarts at the teaser's first frame.
    let file = overlays.find(({ item }) => item.id === source.id)?.file;
    if (!file) {
      file = `${stem}.fxt${i}.png`;
      scratch.push(file);
      await writeElementBitmap(file, source.element, images, source);
    }
    const item = { ...source, start: 0, end: Math.min(source.end - source.start, teaser?.length ?? 0) };
    teaserOverlays.push({ item, file });
  }
  return {
    looks: of("look"),
    transform: frameTransformExpr(items, OUTPUT_SIZE),
    overlays,
    teaserOverlays,
    flashes: of("flash"),
  };
}

/** Look filters on a 1080-wide frame; the browser preview uses the canvas twins listed in src/shared. */
const LOOK_FILTERS: Record<LookId, string> = {
  deepfry: "eq=contrast=1.8:saturation=3:brightness=0.03",
  bw: "hue=s=0",
  blur: "gblur=sigma=16",
};

/** Looks, then zoom/shake, on the composed layout `acc`. Returns the chains and the new tail label. */
export function layoutFxChains(fx: VideoFx, acc: string): { chains: string[]; acc: string } {
  const chains: string[] = [];
  fx.looks.forEach((look, i) => {
    chains.push(`${acc}${LOOK_FILTERS[look.look]}:enable='${gate(look)}'[lk${i}]`);
    acc = `[lk${i}]`;
  });
  if (fx.transform) {
    const { scale, x, y } = fx.transform;
    chains.push(
      `${acc}scale=w='trunc(${OUT_W}*${scale}/2)*2':h='trunc(${OUT_H}*${scale}/2)*2':eval=frame:flags=bicubic,` +
        `crop=${OUT_W}:${OUT_H}:x='${x}':y='${y}'[zm]`,
    );
    acc = "[zm]";
  }
  return { chains, acc };
}

/**
 * Timed overlays on `acc`. Each source runs only for its own item and is shifted to its start with setpts, so the
 * stream costs nothing outside it; `inputOf` gives the ffmpeg input index of an overlay PNG. Labels are
 * `ov<i>` / `oo<i>`, so one graph can hold only one call.
 */
export function overlayChains(
  overlays: PlannedOverlay[],
  acc: string,
  inputOf: (file: string) => number,
): { chains: string[]; acc: string } {
  const chains: string[] = [];
  overlays.forEach(({ item, file }, i) => {
    const length = item.end - item.start;
    const { scale, dx, dy } = overlayAnimExpr(item);
    const sizing =
      scale === "1" ? "" : `,scale=w='trunc(iw*(${scale})/2)*2':h='trunc(ih*(${scale})/2)*2':eval=frame:flags=bicubic`;
    // Fade on the item's own time (its stream starts at 0), then shift to clip time for the animation expressions.
    chains.push(
      `[${inputOf(file)}:v]scale=out_color_matrix=bt709,format=yuva420p,` +
        `fade=t=in:st=0:d=${OVERLAY_FADE_IN}:alpha=1,` +
        `fade=t=out:st=${sec(length - OVERLAY_FADE_OUT)}:d=${OVERLAY_FADE_OUT}:alpha=1,` +
        `setpts=PTS+${sec(item.start)}/TB${sizing}[ov${i}]`,
    );
    const { x, y } = item.element;
    chains.push(
      `${acc}[ov${i}]overlay=x='${sec(x)}-overlay_w/2+(${dx})':y='${sec(y)}-overlay_h/2+(${dy})':` +
        `enable='${gate(item)}':eval=frame[oo${i}]`,
    );
    acc = `[oo${i}]`;
  });
  return { chains, acc };
}

/**
 * Timed overlays, then flashes, on `acc` (after the watermarks, under the captions). `inputOf` gives the ffmpeg
 * input index of an overlay PNG.
 */
export function overlayFxChains(
  fx: VideoFx,
  acc: string,
  fps: string,
  inputOf: (file: string) => number,
): { chains: string[]; acc: string } {
  const { chains, acc: afterOverlays } = overlayChains(fx.overlays, acc, inputOf);
  acc = afterOverlays;
  fx.flashes.forEach((flash, i) => {
    const length = flash.end - flash.start;
    chains.push(
      `color=c=${ffColor(flash.color)}:s=${OUT_W}x${OUT_H}:r=${fps}:d=${sec(length)},format=rgba,` +
        `colorchannelmixer=aa=${FLASH_ALPHA},scale=out_color_matrix=bt709,format=yuva420p,` +
        `fade=t=out:st=0:d=${sec(length)}:alpha=1,setpts=PTS+${sec(flash.start)}/TB[fl${i}]`,
    );
    chains.push(`${acc}[fl${i}]overlay=0:0:enable='${gate(flash)}'[of${i}]`);
    acc = `[of${i}]`;
  });
  return { chains, acc };
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

/** One library sound cut to the clip: play `length` s starting `skip` s into the file, `delay` s into the clip. */
export interface PlannedSound {
  file: string;
  skip: number;
  delay: number;
  length: number;
  volume: number;
}

export interface AudioFx {
  /** Whether the source has an audio stream; without it the mix starts from silence. */
  sourceAudio: boolean;
  /** Clip-relative; empty when the source has no audio. */
  voices: VoiceItem[];
  sounds: PlannedSound[];
}

/** `ffprobe` facts about a media file: does it carry audio, and how long are its streams. */
export interface MediaInfo {
  hasAudio: boolean;
  /** Video stream duration (format duration when the stream has none), seconds. */
  duration: number;
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await run(BIN.ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,duration:format=duration",
    "-of",
    "json",
    path,
  ]);
  const info = JSON.parse(stdout) as {
    streams?: { codec_type: string; duration?: string }[];
    format?: { duration?: string };
  };
  const streams = info.streams ?? [];
  const video = Number(streams.find((s) => s.codec_type === "video")?.duration);
  const format = Number(info.format?.duration);
  const duration = Number.isFinite(video) && video > 0 ? video : format;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Cannot read the duration of ${path}`);
  return { hasAudio: streams.some((s) => s.codec_type === "audio"), duration };
}

/**
 * Voice presets, applied to a copy of the clip audio (48 kHz stereo float). Pitch presets resample the rate and
 * stretch the tempo back, so the length never changes.
 */
const VOICE_CHAINS: Record<VoiceFx, string> = {
  // Boosted bass, then far more gain than fits: hard clipping and bit crushing give the blown-out meme sound.
  earrape: "equalizer=f=90:t=q:w=0.8:g=14,volume=30dB,asoftclip=type=hard,acrusher=bits=6:mode=lin:aa=0,volume=-4dB",
  bass: "bass=g=16:f=90:w=0.7,equalizer=f=55:t=q:w=1:g=8,volume=-3dB",
  chipmunk: `asetrate=${SAMPLE_RATE * 1.6},aresample=${SAMPLE_RATE},atempo=${1 / 1.6}`,
  deep: `asetrate=${Math.round(SAMPLE_RATE * 0.7)},aresample=${SAMPLE_RATE},atempo=${(1 / 0.7).toFixed(6)}`,
  echo: "aecho=0.8:0.88:60|120:0.5|0.3",
  robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
};

/**
 * Plans the audio side of a timeline. Returns null when it changes nothing (no sound, and no voice on a source
 * that has audio); `sounds` come from the library, a missing file is an error naming the item.
 */
export async function planAudioFx(
  timeline: ClipTimeline,
  clip: { start: number; end: number },
  sourcePath: string,
  libraryDir: string,
): Promise<AudioFx | null> {
  const voiceCandidates = relativeItems(
    timeline.items.filter((item): item is VoiceItem => item.kind === "voice"),
    clip.start,
    clip.end,
  );
  const sounds: PlannedSound[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "sound") continue;
    const from = Math.max(item.start, clip.start);
    const to = Math.min(item.end, clip.end);
    if (to - from <= 1e-3) continue;
    sounds.push({
      file: await requireLibraryFile(libraryDir, item.file, `Sound "${item.id}"`),
      skip: from - item.start,
      delay: from - clip.start,
      length: to - from,
      volume: item.volume,
    });
  }
  if (voiceCandidates.length === 0 && sounds.length === 0) return null;
  const { hasAudio } = await probeMedia(sourcePath);
  const voices = hasAudio ? voiceCandidates : [];
  if (voices.length === 0 && sounds.length === 0) return null;
  return { sourceAudio: hasAudio, voices, sounds };
}

/**
 * Audio chains ending in `[aout]`: the clip audio (or silence) with voice distortion gated over its items, the
 * library sounds mixed on top, then a limiter. Sounds are inputs `firstSoundInput`, `firstSoundInput + 1`, ...
 * Every gate keeps the dry and wet branches the same length, so sync never moves.
 */
export function audioFxChains(audio: AudioFx, duration: number, firstSoundInput: number): string[] {
  const chains: string[] = [];
  const format = `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo:sample_fmts=fltp`;
  chains.push(
    audio.sourceAudio
      ? `[0:a:0]${format}[a0]`
      : `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${sec(duration)},${format}[a0]`,
  );
  let mix = "[a0]";
  const { voices } = audio;
  if (voices.length > 0) {
    chains.push(`[a0]asplit=${voices.length + 1}[dry]${voices.map((_, i) => `[wet${i}]`).join("")}`);
    // Overlapping voice items would sum past 1; the dry branch only needs to be silent wherever any wet one plays.
    chains.push(`[dry]volume='max(0,1-(${voices.map(gate).join("+")}))':eval=frame[dryg]`);
    voices.forEach((voice, i) => {
      chains.push(
        `[wet${i}]${VOICE_CHAINS[voice.preset]},volume='${sec(voice.volume)}*${gate(voice)}':eval=frame[wetg${i}]`,
      );
    });
    chains.push(
      `[dryg]${voices.map((_, i) => `[wetg${i}]`).join("")}amix=inputs=${voices.length + 1}:normalize=0:duration=first[voiced]`,
    );
    mix = "[voiced]";
  }
  audio.sounds.forEach((sound, i) => {
    const delay = Math.round(sound.delay * 1000);
    chains.push(
      `[${firstSoundInput + i}:a:0]${format},atrim=start=${sec(sound.skip)}:duration=${sec(sound.length)},` +
        `asetpts=PTS-STARTPTS,volume=${sec(sound.volume)}${delay > 0 ? `,adelay=${delay}:all=1` : ""}[snd${i}]`,
    );
  });
  const inputs = audio.sounds.length + 1;
  const sounds = audio.sounds.map((_, i) => `[snd${i}]`).join("");
  chains.push(
    inputs > 1
      ? `${mix}${sounds}amix=inputs=${inputs}:normalize=0:duration=first:dropout_transition=0,${LIMITER}[aout]`
      : `${mix}${LIMITER}[aout]`,
  );
  return chains;
}

// ---------------------------------------------------------------------------------------------
// Running ffmpeg, and the final pass (intro + teaser + clip + outro)
// ---------------------------------------------------------------------------------------------

/** Last few KB of a stream (ffmpeg's stderr), for error messages. */
export async function tailOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let kept = "";
  for await (const chunk of stream) {
    kept += decoder.decode(chunk, { stream: true });
    if (kept.length > STDERR_TAIL * 2) kept = kept.slice(-STDERR_TAIL);
  }
  return kept.slice(-STDERR_TAIL);
}

/** Reads `-progress pipe:1` output and reports `out_time` as a 0..0.99 fraction of `duration`. */
export async function watchProgress(
  stream: ReadableStream<Uint8Array>,
  duration: number,
  onProgress: (p: number) => void,
) {
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

/** Where the finished clip gets cut and what is glued around it. All files exist; the lengths are probed. */
export interface Bookends {
  /** The rendered clip (effects and captions included). */
  mainPath: string;
  main: MediaInfo;
  /** Teaser range, seconds into the rendered clip; null = none. */
  teaser: { start: number; length: number } | null;
  /** Overlays drawn over the teaser segment, in the teaser's own time (see `VideoFx.teaserOverlays`). */
  teaserOverlays: PlannedOverlay[];
  intro: { path: string; info: MediaInfo } | null;
  outro: { path: string; info: MediaInfo } | null;
}

interface Segment {
  /** Input options in front of `-i`. */
  seek?: { start: number; length: number };
  path: string;
  hasAudio: boolean;
  length: number;
  /** Library videos are fitted to the frame; the clip and its teaser already are. */
  cover: boolean;
  /** Drawn over this segment in its own time; their PNGs are inputs after the segments. */
  overlays?: PlannedOverlay[];
}

/** Segments in play order. */
function segmentsOf(b: Bookends): Segment[] {
  const list: Segment[] = [];
  if (b.intro)
    list.push({ path: b.intro.path, hasAudio: b.intro.info.hasAudio, length: b.intro.info.duration, cover: true });
  if (b.teaser) {
    list.push({
      seek: b.teaser,
      path: b.mainPath,
      hasAudio: b.main.hasAudio,
      length: b.teaser.length,
      cover: false,
      overlays: b.teaserOverlays,
    });
  }
  list.push({ path: b.mainPath, hasAudio: b.main.hasAudio, length: b.main.duration, cover: false });
  if (b.outro)
    list.push({ path: b.outro.path, hasAudio: b.outro.info.hasAudio, length: b.outro.info.duration, cover: true });
  return list;
}

/** Overlay PNG inputs of the final pass, in input order (they follow the segment inputs). */
const overlayInputs = (segments: Segment[]) => segments.flatMap((segment) => segment.overlays ?? []);

/**
 * One concat filter over every segment, each normalised to 1080x1920, `fps`, 48 kHz stereo and its exact length.
 * Segment overlays are composited before the concat. The overlay PNGs are inputs `segments.length` and up.
 */
export function buildBookendGraph(segments: Segment[], fps: string): string {
  const chains: string[] = [];
  const audioFormat = `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo:sample_fmts=fltp`;
  const pngs = overlayInputs(segments);
  segments.forEach((segment, i) => {
    const fit = segment.cover
      ? `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUT_W}:${OUT_H},`
      : "";
    const base = `[${i}:v]${fit}setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS`;
    if (segment.overlays?.length) {
      chains.push(`${base}[b${i}]`);
      const { chains: drawn, acc } = overlayChains(
        segment.overlays,
        `[b${i}]`,
        (file) => segments.length + pngs.findIndex((png) => png.file === file),
      );
      chains.push(...drawn, `${acc}null[v${i}]`);
    } else {
      chains.push(`${base}[v${i}]`);
    }
    chains.push(
      segment.hasAudio
        ? `[${i}:a:0]${audioFormat},apad,atrim=duration=${sec(segment.length)},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${sec(segment.length)},${audioFormat},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });
  const pads = segments.map((_, i) => `[v${i}][a${i}]`).join("");
  chains.push(`${pads}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  return chains.join(";");
}

/** Total length of the assembled file, seconds. */
export const bookendDuration = (b: Bookends) => segmentsOf(b).reduce((sum, s) => sum + s.length, 0);

/** Encodes intro + teaser + clip + outro into `outPath` in one ffmpeg pass. */
export async function assembleBookends(
  b: Bookends,
  fps: string,
  outPath: string,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const segments = segmentsOf(b);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const segment of segments) {
    if (segment.seek) args.push("-ss", segment.seek.start.toFixed(3), "-t", segment.seek.length.toFixed(3));
    args.push("-i", segment.path);
  }
  // Stills loop for their overlay's length only, like in the clip pass.
  for (const { item, file } of overlayInputs(segments))
    args.push("-loop", "1", "-framerate", fps, "-t", (item.end - item.start).toFixed(3), "-i", file);
  args.push(
    "-filter_complex",
    buildBookendGraph(segments, fps),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...(await videoEncoderArgs()),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    outPath,
  );
  const proc = Bun.spawn([BIN.ffmpeg, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill(9);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const stderrP = tailOf(proc.stderr);
    const progressP = watchProgress(proc.stdout, bookendDuration(b), onProgress);
    const exitCode = await proc.exited;
    const [stderr] = await Promise.all([stderrP, progressP]);
    signal?.throwIfAborted();
    if (exitCode !== 0) throw new ExecError(BIN.ffmpeg, exitCode, stderr);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    proc.kill(9);
  }
}
