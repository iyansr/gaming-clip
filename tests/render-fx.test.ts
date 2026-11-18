import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { BIN } from "../src/core/config";
import { videoEncoderArgs } from "../src/core/encoder";
import { run } from "../src/core/exec";
import { buildEncodeArgs, buildFilterGraph, planGraph, renderClip, type RenderJob } from "../src/core/render";
import {
  DEFAULT_CLIP_SETTINGS,
  EMPTY_TIMELINE,
  type ClipSettings,
  type ClipTimeline,
  type OverlayItem,
  type TimelineItem,
} from "../src/shared/types";

let dir = "";
let library = "";

const SRC = { width: 320, height: 180, fps: 30, duration: 4 };
/** Clip 0.5..3.5 of the source: item times below are source times, `at(rel)` converts from clip time. */
const START = 0.5;
const END = 3.5;
const at = (rel: number) => START + rel;
const settings: ClipSettings = { ...DEFAULT_CLIP_SETTINGS, layout: "fill", subtitles: false };

async function ff(args: string[]): Promise<void> {
  await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

async function probe(path: string) {
  const { stdout } = await run(BIN.ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height,sample_rate,channels:format=duration",
    "-of",
    "json",
    path,
  ]);
  const info = JSON.parse(stdout) as {
    streams: { codec_type: string; width?: number; height?: number; sample_rate?: string; channels?: number }[];
    format: { duration: string };
  };
  return {
    video: info.streams.find((s) => s.codec_type === "video"),
    audio: info.streams.find((s) => s.codec_type === "audio"),
    duration: Number(info.format.duration),
  };
}

/** Gray 54x96 thumbnail of the frame at `t`. */
async function frame(path: string, t: number): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      BIN.ffmpeg,
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(t),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      "scale=54:96,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  expect(bytes.length).toBe(54 * 96);
  return bytes;
}

const ignore = () => {};
const mean = (bytes: Uint8Array) => bytes.reduce((sum, v) => sum + v, 0) / bytes.length;
const meanAbsDiff = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;

/** Mean volume (dB) of the audio over the whole file, from volumedetect. */
async function meanVolume(path: string): Promise<number> {
  const proc = Bun.spawn([BIN.ffmpeg, "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const match = /mean_volume: (-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`no volumedetect output:\n${stderr.slice(-500)}`);
  return Number(match[1]);
}

function job(out: string, timeline: ClipTimeline, over: Partial<RenderJob> = {}): RenderJob {
  return {
    sourcePath: join(dir, "src.mp4"),
    source: SRC,
    start: START,
    end: END,
    settings,
    webcam: null,
    words: [],
    outPath: join(dir, out),
    timeline,
    libraryDir: library,
    ...over,
  };
}

const zoom: TimelineItem = {
  id: "z",
  kind: "zoom",
  start: at(0.2),
  end: at(1.2),
  scale: 2,
  x: 0.3,
  y: 0.4,
  ease: "punch",
};
const shake: TimelineItem = { id: "s", kind: "shake", start: at(1.5), end: at(2), intensity: 0.8 };
const flash: TimelineItem = { id: "f", kind: "flash", start: at(2.2), end: at(2.7), color: "#ffffff" };
const look: TimelineItem = { id: "l", kind: "look", start: at(0.1), end: at(0.9), look: "deepfry" };
const text: OverlayItem = {
  id: "t",
  kind: "overlay",
  start: at(0.1),
  end: at(2.5),
  overTeaser: false,
  animation: "pop",
  element: {
    id: "w1",
    kind: "text",
    x: 540,
    y: 400,
    rotation: -8,
    opacity: 1,
    onThumbnail: false,
    text: "HELLO",
    font: "Anton",
    size: 120,
    color: "#ffee00",
    stroke: 6,
    strokeColor: "#000000",
  },
};
const sticker: OverlayItem = {
  id: "st",
  kind: "overlay",
  start: at(0.5),
  end: at(2.5),
  overTeaser: false,
  animation: "slide",
  element: {
    id: "w2",
    kind: "image",
    x: 540,
    y: 1300,
    rotation: 15,
    opacity: 0.9,
    onThumbnail: false,
    file: "boom.png",
    width: 300,
  },
};
const sound: TimelineItem = { id: "so", kind: "sound", start: at(0.4), end: at(1.4), file: "beep.wav", volume: 1.5 };
const voice: TimelineItem = { id: "v", kind: "voice", start: at(1), end: at(2), preset: "earrape" };

const everything: TimelineItem[] = [zoom, shake, flash, look, text, sticker, sound, voice];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gclip-fx-"));
  library = join(dir, "library");
  await Bun.$`mkdir -p ${library}`;
  const encoder = await videoEncoderArgs();
  await ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x180:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=4",
    "-filter:a",
    "volume=0.15",
    ...encoder,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    join(dir, "src.mp4"),
  ]);
  await ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x180:rate=30:duration=4",
    ...encoder,
    "-pix_fmt",
    "yuv420p",
    join(dir, "silent.mp4"),
  ]);
  // A mono 1 s intro without audio and a portrait outro with audio: both must be fitted to 1080x1920.
  await ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=24:duration=1",
    ...encoder,
    "-pix_fmt",
    "yuv420p",
    join(library, "intro.mp4"),
  ]);
  await ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=90x160:rate=25:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=1",
    ...encoder,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    join(library, "outro.mp4"),
  ]);
  await ff(["-f", "lavfi", "-i", "sine=frequency=1200:duration=1", join(library, "beep.wav")]);
  const canvas = createCanvas(64, 48);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff3300";
  ctx.beginPath();
  ctx.arc(32, 24, 22, 0, Math.PI * 2);
  ctx.fill();
  await Bun.write(join(library, "boom.png"), await canvas.encode("png"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("empty timeline", () => {
  const baseJob: RenderJob = {
    sourcePath: "s.mp4",
    source: { width: 1920, height: 1080, fps: 30, duration: 10 },
    start: 1,
    end: 5,
    settings: { ...DEFAULT_CLIP_SETTINGS, layout: "split" },
    webcam: { x: 0, y: 0, w: 400, h: 225 },
    words: [],
    outPath: "o.mp4",
    timeline: EMPTY_TIMELINE,
    libraryDir: "lib",
  };

  // Captured from the renderer before the editor existed: an empty timeline must not add a single filter.
  const graphs = {
    split:
      "[0:v]fps=30:start_time=0,split=2[s0][s1];[s0]crop=890:1080:514:0,scale=1080:1312:flags=lanczos[l0];[s1]crop=400:225:0:0,scale=1080:608:flags=lanczos[l1];color=c=0x000000:s=1080x1920:r=30:d=4.000,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[base];[base][l0]overlay=0:608[o0];[o0][l1]overlay=0:0[o1];[1:v]scale=out_color_matrix=bt709,format=yuva420p[cap];[o1][cap]overlay=0:700[oc];[oc]setsar=1,format=yuv420p[vout]",
    fill: "[0:v]fps=30:start_time=0[s0];[s0]crop=608:1080:656:0,scale=1080:1920:flags=lanczos[l0];[l0]setsar=1,format=yuv420p[vout]",
    fit: "[0:v]fps=30:start_time=0,split=2[s0][s1];[s0]crop=608:1080:656:0,scale=136:240,gblur=sigma=6,scale=1080:1920[l0];[s1]crop=1920:1080:0:0,scale=1080:608:flags=lanczos[l1];[l0][l1]overlay=0:656[o1];[1:v]scale=out_color_matrix=bt709,format=yuva420p[cap];[o1][cap]overlay=0:700[oc];[oc]setsar=1,format=yuv420p[vout]",
  };

  const graphOf = async (layout: ClipSettings["layout"], captions: { y: number } | null) => {
    const j = { ...baseJob, settings: { ...baseJob.settings, layout } };
    return buildFilterGraph(await planGraph(j, "/tmp/x.partial.mp4", []), "30", 4, captions);
  };

  test("the filter graph is byte-identical to the pre-editor graph", async () => {
    expect(await graphOf("split", { y: 700 })).toBe(graphs.split);
    expect(await graphOf("fill", null)).toBe(graphs.fill);
    expect(await graphOf("fit", { y: 700 })).toBe(graphs.fit);
  });

  test("the ffmpeg argument list is what it was before the editor", async () => {
    const j = { ...baseJob, settings: { ...baseJob.settings, layout: "fill" as const } };
    const plan = await planGraph(j, "/tmp/x.partial.mp4", []);
    expect(plan.audio).toBeNull();
    expect(buildEncodeArgs(j, plan, null, "30", ["-c:v", "libx264"], "o.partial.mp4")).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1.000",
      "-t",
      "4.000",
      "-i",
      "s.mp4",
      "-filter_complex",
      graphs.fill,
      "-map",
      "[vout]",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      "-t",
      "4.000",
      "-progress",
      "pipe:1",
      "-nostats",
      "o.partial.mp4",
    ]);
  });
});

describe("renderClip with a timeline", () => {
  const length = END - START;
  const progress: number[] = [];
  const outputs: Record<string, string> = {};

  beforeAll(async () => {
    const variants: Record<string, [TimelineItem[], Partial<RenderJob>]> = {
      plain: [[], {}],
      main: [everything, {}],
      noFlash: [everything.filter((i) => i.kind !== "flash"), {}],
      noZoom: [everything.filter((i) => i.kind !== "zoom"), {}],
    };
    for (const [name, [items, over]] of Object.entries(variants)) {
      const out = join(dir, `${name}.mp4`);
      await renderClip(job(`${name}.mp4`, { items, teaser: null }, over), ignore);
      outputs[name] = out;
    }
    outputs.full = join(dir, "full.mp4");
    await renderClip(
      job(
        "full.mp4",
        { items: everything, teaser: { start: at(1), end: at(2) } },
        { settings: { ...settings, intro: "intro.mp4" } },
      ),
      (p) => progress.push(p),
    );
  }, 240_000);

  test("main render is 1080x1920 with 48 kHz stereo audio and the clip's length", async () => {
    const info = await probe(outputs.main!);
    expect(info.video).toMatchObject({ width: 1080, height: 1920 });
    expect(info.audio).toMatchObject({ sample_rate: "48000", channels: 2 });
    expect(Math.abs(info.duration - length)).toBeLessThan(0.15);
  });

  test("intro + teaser + clip has the summed length and keeps audio", async () => {
    const info = await probe(outputs.full!);
    expect(info.video).toMatchObject({ width: 1080, height: 1920 });
    expect(info.audio).toBeDefined();
    expect(Math.abs(info.duration - (1 + 1 + length))).toBeLessThan(0.15);
  });

  test("progress is monotonic, below 1 until the end, and ends at 1", () => {
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(1);
    expect(progress.slice(0, -1).every((p) => p >= 0 && p <= 0.99)).toBe(true);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]! - 1e-9)).toBe(true);
    expect(progress.some((p) => p > 0.85 && p < 1)).toBe(true);
  });

  test("a flash makes the frame much brighter", async () => {
    const t = 2.3;
    const flashed = mean(await frame(outputs.main!, t));
    const plain = mean(await frame(outputs.noFlash!, t));
    expect(flashed).toBeGreaterThan(plain + 40);
  });

  test("a zoom changes the frame; the same instant without a zoom is untouched by it", async () => {
    const t = 0.7;
    const zoomed = await frame(outputs.main!, t);
    const unzoomed = await frame(outputs.noZoom!, t);
    expect(meanAbsDiff(zoomed, unzoomed)).toBeGreaterThan(8);
    // Outside every item the effects change nothing: frame at 2.9 s is identical with and without the zoom.
    expect(meanAbsDiff(await frame(outputs.main!, 2.9), await frame(outputs.noZoom!, 2.9))).toBeLessThan(1);
  });

  test("overlays, looks and the plain render differ from each other where they should", async () => {
    const t = 0.3;
    const withFx = await frame(outputs.noFlash!, t);
    const plain = await frame(outputs.plain!, t);
    expect(meanAbsDiff(withFx, plain)).toBeGreaterThan(5);
  });

  test("an earrape voice item and a sound make the audio louder", async () => {
    expect(await meanVolume(outputs.main!)).toBeGreaterThan((await meanVolume(outputs.plain!)) + 6);
  });

  test("a source without audio still plays a library sound", async () => {
    const out = join(dir, "silent-out.mp4");
    await renderClip(
      job(
        "silent-out.mp4",
        { items: [sound, { ...voice, id: "v2" }], teaser: null },
        { sourcePath: join(dir, "silent.mp4") },
      ),
      ignore,
    );
    const info = await probe(out);
    expect(info.audio).toMatchObject({ sample_rate: "48000", channels: 2 });
    expect(await meanVolume(out)).toBeGreaterThan(-60);
  });

  test("every voice preset and look renders and keeps the clip's length and sync", async () => {
    const presets = ["earrape", "bass", "chipmunk", "deep", "echo", "robot"] as const;
    const items: TimelineItem[] = [
      ...presets.map((preset, i): TimelineItem => ({
        id: `p${i}`,
        kind: "voice",
        start: at(i * 0.45),
        end: at(i * 0.45 + 0.4),
        preset,
      })),
      { id: "bw", kind: "look", start: at(0), end: at(1), look: "bw" },
      { id: "bl", kind: "look", start: at(1), end: at(2), look: "blur" },
      { ...text, id: "t2", animation: "shake" },
      { ...sticker, id: "st2", animation: "none" },
    ];
    const out = join(dir, "presets.mp4");
    await renderClip(job("presets.mp4", { items, teaser: null }), ignore);
    const info = await probe(out);
    expect(Math.abs(info.duration - length)).toBeLessThan(0.15);
    expect(info.audio).toBeDefined();
  });

  test("an overTeaser overlay is on screen from the first frame of the teaser, and only then", async () => {
    // The text lies in the clip's first 0.6 s, the teaser is a later range: the clip copy never reaches the teaser.
    const headline: OverlayItem = {
      ...text,
      id: "hook",
      start: at(0),
      end: at(0.6),
      animation: "pop",
      overTeaser: true,
    };
    const teaser = { start: at(1), end: at(2) };
    const renders = {
      hook: [headline],
      quiet: [{ ...headline, overTeaser: false }],
      none: [],
    };
    const frames: Record<string, { teaser: Uint8Array; clip: Uint8Array }> = {};
    const durations: Record<string, number> = {};
    for (const [name, items] of Object.entries(renders)) {
      const out = join(dir, `teaser-${name}.mp4`);
      await renderClip(job(`teaser-${name}.mp4`, { items, teaser }), ignore);
      // 0.3 s is inside the teaser (0..1 s); 1.3 s is inside the clip's own headline (starts at 1.0 s).
      frames[name] = { teaser: await frame(out, 0.3), clip: await frame(out, 1.3) };
      durations[name] = (await probe(out)).duration;
    }
    // Only the band of the frame that holds the text (y 400 of 1920 -> thumbnail rows ~15..28) is compared.
    const band = (bytes: Uint8Array) => bytes.slice(15 * 54, 28 * 54);
    const hook = band(frames.hook!.teaser);
    expect(meanAbsDiff(hook, band(frames.quiet!.teaser))).toBeGreaterThan(8);
    expect(meanAbsDiff(band(frames.quiet!.teaser), band(frames.none!.teaser))).toBeLessThan(1);
    // The clip part is the same with and without the flag, and the output is not longer for it.
    expect(meanAbsDiff(frames.hook!.clip, frames.quiet!.clip)).toBeLessThan(1);
    expect(Math.abs(durations.hook! - (1 + length))).toBeLessThan(0.15);
    expect(Math.abs(durations.hook! - durations.quiet!)).toBeLessThan(0.1);
  }, 120_000);

  test("an outro alone appends its length, with audio", async () => {
    const out = join(dir, "outro-out.mp4");
    await renderClip(job("outro-out.mp4", EMPTY_TIMELINE, { settings: { ...settings, outro: "outro.mp4" } }), ignore);
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 1080, height: 1920 });
    expect(Math.abs(info.duration - (length + 1))).toBeLessThan(0.15);
  });

  test("a missing library file is a readable error and leaves no output behind", async () => {
    const gone: TimelineItem = { ...sound, id: "gone", file: "nope.wav" };
    expect(renderClip(job("missing.mp4", { items: [gone], teaser: null }), ignore)).rejects.toThrow(
      'Sound "gone" uses library file "nope.wav"',
    );
    expect(
      renderClip(job("missing2.mp4", EMPTY_TIMELINE, { settings: { ...settings, intro: "nope.mp4" } }), ignore),
    ).rejects.toThrow('The intro uses library file "nope.mp4"');
    expect(await Bun.file(join(dir, "missing.mp4")).exists()).toBe(false);
  });

  test("scratch files and partial outputs are cleaned up", async () => {
    const names = await Array.fromAsync(new Bun.Glob(".*").scan({ cwd: dir, onlyFiles: true, dot: true }));
    expect(names.filter((n) => n.endsWith(".png") || n.includes(".partial") || n.includes(".main"))).toEqual([]);
    expect((await stat(outputs.full!)).size).toBeGreaterThan(0);
  });
});
