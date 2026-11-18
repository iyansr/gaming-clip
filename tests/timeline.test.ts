import { beforeAll, describe, expect, test } from "bun:test";

import { addLibraryItem } from "../src/core/library";
import { addClip, parseTimeline, patchClip } from "../src/core/pipeline";
import { createProject, getProject, updateProject, ValidationError } from "../src/core/store";
import { MAX_TIMELINE_ITEMS } from "../src/shared/effects";
import type { SourceMeta } from "../src/shared/types";

const source: SourceMeta = {
  input: "test.mp4",
  videoId: null,
  title: "Test",
  channel: "Test",
  duration: 600,
  width: 1280,
  height: 720,
  fps: 30,
};

const zoom = { id: "z1", kind: "zoom", start: 10, end: 12, scale: 1.6, x: 0.5, y: 0.4, ease: "punch" };
const timeline = (items: unknown[], teaser: unknown = null) => ({ items, teaser });

/** One second of 8 kHz mono 16-bit PCM: enough for ffprobe to report a duration. */
function wav(seconds = 1): Uint8Array {
  const rate = 8000;
  const samples = seconds * rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
  }
  return bytes;
}

/** Rejects with the thrown error, so an assertion can inspect it without an unawaited matcher. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject");
}

let projectId: string;
let clipId: string;

beforeAll(async () => {
  const created = await createProject("https://example.com/watch?v=test");
  projectId = created.id;
  await updateProject(projectId, (project) => {
    project.source = source;
    project.stages.download = { status: "done", progress: 1 };
  });
  const project = await addClip(projectId, 10, 40, "Test clip");
  clipId = project.clips[0]!.id;
});

describe("parseTimeline", () => {
  test("accepts valid items and defaults a missing teaser to null", () => {
    const parsed = parseTimeline(timeline([zoom, { id: "s1", kind: "shake", start: 12, end: 13, intensity: 0.6 }]));
    expect(parsed.items).toHaveLength(2);
    expect(parsed.teaser).toBeNull();
    expect(parsed.items[0]).toMatchObject({ id: "z1", kind: "zoom", scale: 1.6, ease: "punch" });
  });

  test("rejects an unknown kind with a path to the item", () => {
    expect(() => parseTimeline(timeline([{ ...zoom, kind: "boom" }]))).toThrow(ValidationError);
    expect(() => parseTimeline(timeline([{ ...zoom, kind: "boom" }]))).toThrow("timeline.items[0].kind must be one of");
  });

  test("rejects end <= start and out-of-range numbers", () => {
    expect(() => parseTimeline(timeline([{ ...zoom, end: 10 }]))).toThrow(
      "timeline.items[0].end must be after timeline.items[0].start",
    );
    expect(() => parseTimeline(timeline([{ ...zoom, start: 12, end: 10 }]))).toThrow("must be after");
    expect(() => parseTimeline(timeline([{ ...zoom, scale: 4 }]))).toThrow(
      "timeline.items[0].scale must be a number between 1.05 and 3",
    );
    expect(() => parseTimeline(timeline([{ ...zoom, scale: Number.NaN }]))).toThrow("timeline.items[0].scale");
    expect(() => parseTimeline(timeline([{ ...zoom, x: 1.2 }]))).toThrow("timeline.items[0].x");
    expect(() => parseTimeline(timeline([{ ...zoom, ease: "bounce" }]))).toThrow("timeline.items[0].ease");
    expect(() => parseTimeline(timeline([{ ...zoom, end: 10.05 }]))).toThrow("items must be 0.1-60s");
  });

  test("rejects unknown fields, bad lists and duplicate ids", () => {
    expect(() => parseTimeline(timeline([{ ...zoom, wobble: 3 }]))).toThrow('Unknown timeline.items[0] field "wobble"');
    expect(() => parseTimeline({ items: "nope" })).toThrow("timeline.items must be an array");
    expect(() =>
      parseTimeline(timeline(Array.from({ length: MAX_TIMELINE_ITEMS + 1 }, (_, i) => ({ ...zoom, id: `z${i}` })))),
    ).toThrow(`At most ${MAX_TIMELINE_ITEMS}`);
    expect(() => parseTimeline(timeline([zoom, { ...zoom, start: 13, end: 14 }]))).toThrow(
      'timeline.items[1].id "z1" is used twice',
    );
  });

  test("defaults a missing overTeaser to false and rejects a non-boolean", () => {
    const overlay = {
      id: "o1",
      kind: "overlay",
      start: 10,
      end: 12,
      animation: "pop",
      element: {
        id: "h0001",
        kind: "text",
        x: 540,
        y: 560,
        rotation: 0,
        opacity: 1,
        onThumbnail: false,
        text: "WAS THAT",
        font: "Anton",
        size: 110,
        color: "#ffffff",
        stroke: 12,
        strokeColor: "#000000",
      },
    };
    const item = parseTimeline(timeline([overlay])).items[0]!;
    expect(item).toMatchObject({ kind: "overlay", overTeaser: false });
    expect(parseTimeline(timeline([{ ...overlay, overTeaser: true }])).items[0]).toMatchObject({ overTeaser: true });
    expect(() => parseTimeline(timeline([{ ...overlay, overTeaser: "yes" }]))).toThrow(
      "timeline.items[0].overTeaser must be true or false",
    );
  });

  test("rejects a teaser without a positive length", () => {
    expect(() => parseTimeline(timeline([], { start: 5, end: 5 }))).toThrow(
      "timeline.teaser.end must be after timeline.teaser.start",
    );
    expect(() => parseTimeline(timeline([], { start: 5, end: 7, extra: 1 }))).toThrow(
      'Unknown timeline.teaser field "extra"',
    );
  });
});

describe("patchClip timeline", () => {
  test("rejects overlapping zooms and leaves the clip untouched", async () => {
    const overlapping = timeline([zoom, { ...zoom, id: "z2", start: 11, end: 13 }]);
    expect((await rejection(patchClip(projectId, clipId, { timeline: parseTimeline(overlapping) }))).message).toContain(
      "overlap",
    );
    const clip = (await getProject(projectId)).clips.find((candidate) => candidate.id === clipId)!;
    expect(clip.timeline.items).toEqual([]);
  });

  test("rejects a sound longer than its library file", async () => {
    const sound = await addLibraryItem(wav(), "audio/wav", "vine boom");
    const long = timeline([{ id: "s1", kind: "sound", start: 12, end: 14, file: sound.file, volume: 1 }]);
    expect((await rejection(patchClip(projectId, clipId, { timeline: parseTimeline(long) }))).message).toContain(
      "only 1.00s",
    );

    const short = timeline([{ id: "s1", kind: "sound", start: 12, end: 12.5, file: sound.file, volume: 1 }]);
    const patched = await patchClip(projectId, clipId, { timeline: parseTimeline(short) });
    expect(patched.clips[0]!.timeline.items).toHaveLength(1);
  });

  test("rejects a teaser outside the clip, and an intro that is not a video", async () => {
    expect(
      (await rejection(patchClip(projectId, clipId, { timeline: parseTimeline(timeline([], { start: 5, end: 7 })) })))
        .message,
    ).toContain("must lie inside the clip");
    const sound = await addLibraryItem(wav(), "audio/wav", "not a video");
    expect((await rejection(patchClip(projectId, clipId, { settings: { intro: sound.file } }))).message).toContain(
      "settings.intro",
    );
  });

  test("a timeline patch invalidates a done render but keeps the thumbnail", async () => {
    await updateProject(projectId, (project) => {
      const clip = project.clips.find((candidate) => candidate.id === clipId)!;
      clip.render = { status: "done", progress: 1, file: `${clipId}-test.mp4`, renderedAt: new Date().toISOString() };
      clip.thumbnail.file = `${clipId}-test.jpg`;
    });
    const project = await patchClip(projectId, clipId, {
      timeline: parseTimeline(timeline([{ ...zoom, start: 20, end: 21 }])),
    });
    const clip = project.clips.find((candidate) => candidate.id === clipId)!;
    expect(clip.render).toEqual({ status: "idle", progress: 0 });
    expect(clip.timeline.items).toHaveLength(1);
    expect(clip.thumbnail.file).toBe(`${clipId}-test.jpg`);
  });

  test("trimming drops a teaser that no longer fits instead of refusing the trim", async () => {
    const project = await patchClip(projectId, clipId, {
      timeline: parseTimeline(timeline([], { start: 12, end: 14 })),
    });
    expect(project.clips[0]!.timeline.teaser).toEqual({ start: 12, end: 14 });

    const trimmed = await patchClip(projectId, clipId, { start: 15 });
    const clip = trimmed.clips.find((candidate) => candidate.id === clipId)!;
    expect(clip.start).toBe(15);
    expect(clip.timeline.teaser).toBeNull();
  });
});
