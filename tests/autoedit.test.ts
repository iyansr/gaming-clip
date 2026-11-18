import { describe, expect, test } from "bun:test";

import { heuristicTimeline, mergeTimeline, timelineFromAnswer, type EditInput } from "../src/core/autoedit";
import type { ClipTimeline, LibraryItem, LoudnessEnvelope, Transcript } from "../src/shared/types";

const libraryItem = (file: string, kind: LibraryItem["kind"], name: string, duration: number | null): LibraryItem => ({
  file,
  kind,
  name,
  duration,
  width: kind === "sticker" ? 512 : null,
  height: kind === "sticker" ? 512 : null,
  addedAt: "2026-01-01T00:00:00.000Z",
});

const BOOM = libraryItem("a1b2c3d4e5f60718293a4b5c6d7e8f90.mp3", "sound", "vine boom", 1.4);
const WHOOSH = libraryItem("b1b2c3d4e5f60718293a4b5c6d7e8f90.mp3", "sound", "soft whoosh", 2);
const STICKER = libraryItem("c1b2c3d4e5f60718293a4b5c6d7e8f90.png", "sticker", "explosion", null);

const transcript: Transcript = {
  language: "en",
  model: "test",
  segments: [
    { start: 0.4, end: 1.2, text: "before the clip", words: [] },
    { start: 10.2, end: 11, text: "what was that", words: [] },
    { start: 16.7, end: 17.3, text: "AHHH", words: [] },
    { start: 21, end: 23, text: "after the clip", words: [] },
  ],
};

/** Loudness envelope of a 24 s video: a flat baseline with short spikes at the given absolute times. */
function envelope(base: number, spikes: [time: number, db: number][]): LoudnessEnvelope {
  const step = 0.1;
  const rms = new Array<number>(240).fill(base);
  for (const [time, db] of spikes) {
    const index = Math.round(time / step);
    for (const offset of [-1, 0]) {
      const i = index + offset;
      if (i >= 0 && i < rms.length) rms[i] = Math.max(rms[i]!, db);
    }
  }
  return { step, rms };
}

const input: EditInput = {
  start: 10,
  end: 22,
  title: "was that a clutch",
  reason: "A clutch play with a scream at the end.",
  transcript,
  // A small peak at 12.6 s (+8 dB) and the loud one at 17 s (+18 dB).
  loudness: envelope(-30, [
    [12.6, -22],
    [17, -12],
  ]),
  library: [BOOM, WHOOSH, STICKER],
  focus: {
    face: { x: 0.5, y: 0.18 },
    action: { x: 0.5, y: 0.62 },
    centre: { x: 0.5, y: 0.5 },
  },
};

const kinds = (timeline: ClipTimeline, kind: string) => timeline.items.filter((item) => item.kind === kind);

describe("heuristic edit", () => {
  test("hook covers the start of the clip with the uppercased title", () => {
    const timeline = heuristicTimeline(input);
    const hook = timeline.items.find((item) => item.kind === "overlay" && item.element.kind === "text");
    expect(hook).toBeDefined();
    if (!hook || hook.kind !== "overlay" || hook.element.kind !== "text") throw new Error("no hook");
    expect(hook.start).toBe(10);
    expect(hook.end).toBeCloseTo(12.2, 5);
    expect(hook.element.text).toBe("WAS THAT A CLUTCH");
    expect(hook.element.font).toBe("Anton");
    expect(hook.element.size).toBeGreaterThan(100);
    expect(hook.element.y).toBeLessThan(1920 / 2);
    expect(hook.animation).toBe("pop");
  });

  test("punch-ins stay inside the clip and never overlap", () => {
    const timeline = heuristicTimeline(input);
    const zooms = kinds(timeline, "zoom");
    expect(zooms.length).toBe(2);
    for (const zoom of zooms) {
      expect(zoom.start).toBeGreaterThanOrEqual(10);
      expect(zoom.end).toBeLessThanOrEqual(22);
      if (zoom.kind !== "zoom") throw new Error("not a zoom");
      expect(zoom.scale).toBe(1.4);
      expect(zoom.x).toBe(input.focus.face.x);
      expect(zoom.y).toBe(input.focus.face.y);
    }
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i]!.start).toBeGreaterThanOrEqual(zooms[i - 1]!.end);
    }
  });

  test("earrape only on the loud peak, never on the softer one", () => {
    const timeline = heuristicTimeline(input);
    const voices = kinds(timeline, "voice");
    expect(voices.length).toBe(1);
    const voice = voices[0]!;
    expect(voice.kind).toBe("voice");
    if (voice.kind !== "voice") throw new Error("not a voice item");
    expect(voice.preset).toBe("earrape");
    expect(voice.start).toBeGreaterThan(16.5);
    expect(voice.end).toBeLessThan(18.5);

    // The same clip with only the +8 dB peak is not a scream.
    const calm = heuristicTimeline({ ...input, loudness: envelope(-30, [[12.6, -22]]) });
    expect(kinds(calm, "voice").length).toBe(0);
  });

  test("uses a matching library sound and ignores the others", () => {
    const timeline = heuristicTimeline(input);
    const sounds = kinds(timeline, "sound");
    expect(sounds.length).toBe(1);
    const sound = sounds[0]!;
    if (sound.kind !== "sound") throw new Error("not a sound");
    expect(sound.file).toBe(BOOM.file);
    expect(sound.start).toBeGreaterThan(16.5);
    expect(sound.end - sound.start).toBeLessThanOrEqual(BOOM.duration! + 0.05);

    const noMatch = heuristicTimeline({ ...input, library: [WHOOSH, STICKER] });
    expect(kinds(noMatch, "sound").length).toBe(0);
  });

  test("teaser replays the payoff only when it is late in the clip", () => {
    const timeline = heuristicTimeline(input);
    expect(timeline.teaser).not.toBeNull();
    expect(timeline.teaser!.start).toBeCloseTo(15.9, 5);
    expect(timeline.teaser!.end).toBeCloseTo(18.4, 5);

    const early = heuristicTimeline({ ...input, loudness: envelope(-30, [[12.6, -12]]) });
    expect(early.teaser).toBeNull();
  });

  test("the hook replays over the teaser only when the clip has one", () => {
    const withTeaser = heuristicTimeline(input);
    const hook = withTeaser.items.find((item) => item.kind === "overlay");
    if (!hook || hook.kind !== "overlay") throw new Error("no hook");
    expect(withTeaser.teaser).not.toBeNull();
    expect(hook.overTeaser).toBe(true);

    const early = heuristicTimeline({ ...input, loudness: envelope(-30, [[12.6, -12]]) });
    const earlyHook = early.items.find((item) => item.kind === "overlay");
    if (!earlyHook || earlyHook.kind !== "overlay") throw new Error("no hook");
    expect(early.teaser).toBeNull();
    expect(earlyHook.overTeaser).toBe(false);
  });
});

describe("model answer", () => {
  const answer = {
    hook: { text: "he's dead", end: 2 },
    teaser: { start: 5, end: 7 },
    items: [
      { kind: "zoom", start: 3, end: 4, scale: 1.5, focus: "face", ease: "punch" },
      // Out of ZOOM_LIMITS: dropped.
      { kind: "zoom", start: 4.2, end: 5, scale: 9, focus: "face" },
      { kind: "text", start: 2.4, end: 3.4, text: "*LISTENING*", animation: "pop" },
      { kind: "sticker", start: 6.8, end: 7.8, name: "explosion", animation: "pop" },
      // Unknown sticker file / name: dropped.
      { kind: "sticker", start: 7.5, end: 8, file: "deadbeefdeadbeefdeadbeefdeadbeef.png" },
      { kind: "sticker", start: 7.5, end: 8, name: "missing sticker" },
      { kind: "sound", start: 6.9, end: 8.2, name: "vine boom", volume: 1.5 },
      // Unknown sound: dropped.
      { kind: "sound", start: 7, end: 8, name: "nope" },
      { kind: "voice", start: 6.9, end: 8.1, preset: "earrape" },
    ],
  };

  test("keeps valid items, drops bad files and out-of-range values", () => {
    const timeline = timelineFromAnswer(answer, input);
    expect(kinds(timeline, "zoom").length).toBe(1);
    const overlays = kinds(timeline, "overlay");
    if (overlays[0]?.kind !== "overlay") throw new Error("no hook");
    const stickers = overlays.filter((item) => item.kind === "overlay" && item.element.kind === "image");
    expect(stickers.length).toBe(1);
    expect(overlays.length).toBe(3);
    expect(kinds(timeline, "sound").length).toBe(1);
    expect(kinds(timeline, "voice").length).toBe(1);

    const sticker = stickers[0]!;
    if (sticker.kind !== "overlay" || sticker.element.kind !== "image") throw new Error("not a sticker");
    expect(sticker.element.file).toBe(STICKER.file);
    expect(sticker.start).toBeCloseTo(16.8, 5);

    const sound = kinds(timeline, "sound")[0]!;
    if (sound.kind !== "sound") throw new Error("not a sound");
    expect(sound.file).toBe(BOOM.file);
    expect(sound.volume).toBe(1.5);
  });

  test("converts clip-relative times to source times", () => {
    const timeline = timelineFromAnswer(answer, input);
    const zoom = kinds(timeline, "zoom")[0]!;
    expect(zoom.start).toBe(13);
    expect(zoom.end).toBe(14);
    expect(timeline.teaser).toEqual({ start: 15, end: 17 });

    const hook = timeline.items[0]!;
    if (hook.kind !== "overlay" || hook.element.kind !== "text") throw new Error("no hook");
    expect(hook.element.text).toBe("HE'S DEAD");
    expect(hook.start).toBe(10);
    expect(hook.end).toBe(12);
  });

  test("marks only the hook to replay over the teaser", () => {
    const timeline = timelineFromAnswer(answer, input);
    expect(timeline.teaser).not.toBeNull();
    const overlays = timeline.items.filter((item) => item.kind === "overlay");
    if (overlays[0]?.kind !== "overlay") throw new Error("no hook");
    expect(overlays[0].overTeaser).toBe(true);
    expect(overlays.slice(1).every((item) => item.kind === "overlay" && !item.overTeaser)).toBe(true);

    const noTeaser = timelineFromAnswer({ ...answer, teaser: null }, input);
    const hook = noTeaser.items.find((item) => item.kind === "overlay");
    if (!hook || hook.kind !== "overlay") throw new Error("no hook");
    expect(noTeaser.teaser).toBeNull();
    expect(hook.overTeaser).toBe(false);
  });

  test("drops everything when the answer has nothing usable", () => {
    expect(() =>
      timelineFromAnswer({ hook: null, teaser: null, items: [{ kind: "zoom", start: 1, end: 2 }] }, input),
    ).toThrow();
  });
});

describe("append mode", () => {
  const existing: ClipTimeline = {
    items: [
      { id: "oldzoom", kind: "zoom", start: 10.5, end: 11.5, scale: 1.2, x: 0.5, y: 0.5, ease: "smooth" },
      { id: "oldflash", kind: "flash", start: 18, end: 18.2, color: "#ffffff" },
    ],
    teaser: { start: 16, end: 18 },
  };

  test("drops new zooms that overlap an existing zoom but keeps the rest", () => {
    const planned: ClipTimeline = {
      items: [
        { id: "newzoom", kind: "zoom", start: 11, end: 12, scale: 1.4, x: 0.5, y: 0.2, ease: "punch" },
        { id: "newshake", kind: "shake", start: 19, end: 19.4, intensity: 0.8 },
      ],
      teaser: { start: 14, end: 16 },
    };
    const merged = mergeTimeline(existing, planned, false);
    expect(merged.items.map((item) => item.id)).toEqual(["oldzoom", "oldflash", "newshake"]);
    expect(merged.teaser).toEqual(existing.teaser);
  });

  test("a kept teaser flips the appended hook to replay over it", () => {
    // A clip whose own peaks are too early for a teaser: the planned hook starts with overTeaser false.
    const planned = heuristicTimeline({ ...input, loudness: envelope(-30, [[12.6, -12]]) });
    expect(planned.teaser).toBeNull();
    const merged = mergeTimeline(existing, planned, false);
    expect(merged.teaser).toEqual(existing.teaser);
    const hook = merged.items.find((item) => item.kind === "overlay");
    if (!hook || hook.kind !== "overlay") throw new Error("no hook");
    expect(hook.overTeaser).toBe(true);
  });

  test("replace discards the old timeline", () => {
    const planned: ClipTimeline = {
      items: [{ id: "newshake", kind: "shake", start: 19, end: 19.4, intensity: 0.8 }],
      teaser: null,
    };
    const merged = mergeTimeline(existing, planned, true);
    expect(merged.items.map((item) => item.id)).toEqual(["newshake"]);
    expect(merged.teaser).toBeNull();
  });
});
