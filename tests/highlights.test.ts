import { describe, expect, test } from "bun:test";
import { findHighlights, formatTranscript, parseLlmClips, type HighlightCandidate } from "../src/core/highlights";
import type { LoudnessEnvelope, ProjectOptions, Segment, Transcript } from "../src/shared/types";

interface Burst {
  at: number;
  seconds: number;
  db: number;
}

function envelope(duration: number, bursts: Burst[], level = -30, step = 0.5): LoudnessEnvelope {
  const rms = new Array<number>(Math.ceil(duration / step)).fill(level);
  for (const burst of bursts) {
    const from = Math.floor(burst.at / step);
    const to = Math.ceil((burst.at + burst.seconds) / step);
    for (let i = from; i < to && i < rms.length; i++) rms[i] = burst.db;
  }
  return { step, rms };
}

function transcript(segments: { start: number; end: number; text: string }[], language = "en"): Transcript {
  const built: Segment[] = segments.map((segment) => ({ ...segment, words: [] }));
  return { language, model: "test", segments: built };
}

function options(overrides: Partial<ProjectOptions> = {}): ProjectOptions {
  return { language: "en", clipCount: 3, minDuration: 15, maxDuration: 60, ...overrides };
}

async function run(
  segments: { start: number; end: number; text: string }[],
  loudness: LoudnessEnvelope,
  duration: number,
  opts: ProjectOptions,
): Promise<{ engine: string; candidates: HighlightCandidate[]; warnings: string[] }> {
  return findHighlights({ transcript: transcript(segments), loudness, duration, title: "Test video", options: opts });
}

describe("heuristic highlights", () => {
  test("finds three hype bursts, non-overlapping, bounded and score-ordered", async () => {
    const bursts = [
      { at: 100, seconds: 3, db: -10 },
      { at: 250, seconds: 3, db: -10 },
      { at: 400, seconds: 3, db: -10 },
    ];
    const segments = bursts.map((burst) => ({ start: burst.at - 1, end: burst.at + 3, text: "oh my god no way" }));
    const result = await run(segments, envelope(600, bursts), 600, options());

    expect(result.engine).toBe("heuristic");
    expect(result.candidates).toHaveLength(3);
    expect(result.warnings).toEqual([]);
    for (const burst of bursts) {
      expect(result.candidates.filter((clip) => clip.start <= burst.at && clip.end >= burst.at)).toHaveLength(1);
    }
    for (let i = 0; i < result.candidates.length; i++) {
      const clip = result.candidates[i]!;
      expect(clip.start).toBeGreaterThanOrEqual(0);
      expect(clip.end).toBeLessThanOrEqual(600);
      expect(clip.end - clip.start).toBeGreaterThanOrEqual(15);
      expect(clip.end - clip.start).toBeLessThanOrEqual(60);
      if (i > 0) expect(result.candidates[i - 1]!.score).toBeGreaterThanOrEqual(clip.score);
    }
    for (let i = 0; i < result.candidates.length; i++) {
      for (let j = i + 1; j < result.candidates.length; j++) {
        const a = result.candidates[i]!;
        const b = result.candidates[j]!;
        expect(Math.min(a.end, b.end) - Math.max(a.start, b.start)).toBeLessThanOrEqual(0);
      }
    }
  });

  test("loudness-only input still finds the bursts", async () => {
    const bursts = [
      { at: 80, seconds: 3, db: -12 },
      { at: 200, seconds: 3, db: -12 },
      { at: 320, seconds: 3, db: -12 },
    ];
    const result = await run([], envelope(420, bursts), 420, options());
    expect(result.candidates).toHaveLength(3);
    for (const burst of bursts) {
      expect(result.candidates.some((clip) => clip.start <= burst.at && clip.end >= burst.at)).toBe(true);
    }
  });

  test("keeps windows inside the video near both edges", async () => {
    const result = await run([], envelope(120, [
      { at: 1, seconds: 2, db: -10 },
      { at: 118, seconds: 2, db: -10 },
    ]), 120, options({ clipCount: 5 }));
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    for (const clip of result.candidates) {
      expect(clip.start).toBeGreaterThanOrEqual(0);
      expect(clip.end).toBeLessThanOrEqual(120);
      expect(clip.start).toBeLessThan(clip.end);
      expect(clip.end - clip.start).toBeGreaterThanOrEqual(15);
      expect(clip.end - clip.start).toBeLessThanOrEqual(60);
    }
    expect(result.candidates.some((clip) => clip.start <= 1 && clip.end >= 1)).toBe(true);
    expect(result.candidates.some((clip) => clip.start <= 118 && clip.end >= 118)).toBe(true);
  });

  test("snaps starts and ends to nearby segment boundaries", async () => {
    const result = await run(
      [
        { start: 57, end: 60.5, text: "get ready" },
        { start: 60.5, end: 64, text: "oh my god" },
      ],
      envelope(100, [{ at: 59, seconds: 3, db: -10 }]),
      100,
      options({ clipCount: 1, minDuration: 3, maxDuration: 20 }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.start).toBe(57);
    expect(result.candidates[0]!.end).toBe(64);
  });

  test("honours clipCount", async () => {
    const bursts = [
      { at: 40, seconds: 3, db: -10 },
      { at: 120, seconds: 3, db: -10 },
      { at: 200, seconds: 3, db: -10 },
      { at: 280, seconds: 3, db: -10 },
      { at: 360, seconds: 3, db: -10 },
    ];
    const result = await run([], envelope(400, bursts), 400, options({ clipCount: 2 }));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.score).toBe(95);
  });

  test("silent video with an empty transcript yields no candidates and a warning", async () => {
    const result = await run([], envelope(60, [], -90), 60, options());
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("No highlight");
  });

  test("matches keywords as whole words only", async () => {
    const brunch = await run(
      [{ start: 20, end: 22, text: "running shoes brunch" }],
      envelope(60, [], -90),
      60,
      options(),
    );
    expect(brunch.candidates).toHaveLength(0);

    const runOnly = await run([{ start: 20, end: 22, text: "run" }], envelope(60, [], -90), 60, options());
    expect(runOnly.candidates.length).toBeGreaterThan(0);
  });
});

describe("parseLlmClips", () => {
  test("drops garbage, clamps durations and scores, trims strings", () => {
    const clips = parseLlmClips(
      {
        clips: [
          { start: 10, end: 12, title: "  short  ", reason: " r ", score: 150 },
          { start: 100, end: 105, title: "tail", reason: "", score: 42 },
          { start: 110, end: 118, title: "end", reason: "", score: 59 },
          { start: "x", end: 20, title: "bad" },
          { start: 20, end: 500, title: "outside" },
          { start: 30, end: 30, title: "empty" },
          { start: 60, end: 70, title: "x".repeat(100), reason: "long", score: 51 },
          null,
        ],
      },
      { duration: 120, options: options(), transcript: transcript([]) },
    );

    expect(clips).toHaveLength(4);
    expect(clips[0]).toMatchObject({ start: 10, end: 25, title: "short", reason: "r", score: 100 });
    expect(clips[1]).toMatchObject({ start: 100, end: 115, score: 42 });
    expect(clips[2]).toMatchObject({ start: 105, end: 120, score: 59 });
    for (const clip of clips) {
      expect(clip.end - clip.start).toBeGreaterThanOrEqual(15);
      expect(clip.end - clip.start).toBeLessThanOrEqual(60);
      expect(clip.end).toBeLessThanOrEqual(120);
      expect(Number.isInteger(clip.score)).toBe(true);
      expect(clip.score).toBeGreaterThanOrEqual(0);
      expect(clip.score).toBeLessThanOrEqual(100);
      expect(clip.title.length).toBeLessThanOrEqual(80);
    }
  });

  test("accepts numeric strings and MM:SS / H:MM:SS timestamps", () => {
    const ctx = { duration: 4000, options: options(), transcript: transcript([]) };
    const clips = parseLlmClips(
      {
        clips: [
          { start: "01:23.4", end: "01:40", title: "stamp", reason: "", score: 70 },
          { start: "1:01:00", end: "1:01:20", title: "hour", reason: "", score: 60 },
          { start: "100", end: "115", title: "numeric", reason: "", score: 50 },
          { start: 200, end: "03:40", title: "mixed", reason: "", score: 40 },
        ],
      },
      ctx,
    );
    expect(clips).toHaveLength(4);
    expect(clips[0]!.start).toBeCloseTo(83.4, 5);
    expect(clips[0]!.end).toBeCloseTo(100, 5);
    expect(clips[1]).toMatchObject({ start: 3660, end: 3680 });
    expect(clips[2]).toMatchObject({ start: 100, end: 115 });
    expect(clips[3]).toMatchObject({ start: 200, end: 220 });
  });

  test("drops malformed time strings", () => {
    const ctx = { duration: 4000, options: options(), transcript: transcript([]) };
    const clips = parseLlmClips(
      {
        clips: [
          { start: "01:xx.4", end: "01:40", title: "a" },
          { start: "soon", end: 100, title: "b" },
          { start: "01:99", end: "02:30", title: "c" },
          { start: "01:23:99", end: "01:24:30", title: "d" },
          { start: "1:2:3:4", end: "01:40", title: "e" },
          { start: "", end: "", title: "f" },
        ],
      },
      ctx,
    );
    expect(clips).toHaveLength(0);
  });

  test("accepts a bare array and rejects non-clip shapes", () => {
    const ctx = { duration: 60, options: options(), transcript: transcript([]) };
    expect(parseLlmClips([{ start: 5, end: 25, title: "a", reason: "b", score: 10 }], ctx)).toHaveLength(1);
    expect(parseLlmClips("nope", ctx)).toHaveLength(0);
    expect(parseLlmClips({ clips: "nope" }, ctx)).toHaveLength(0);
  });
});

describe("formatTranscript", () => {
  test("formats lines, loudness markers and hour timestamps", () => {
    const segments = [
      { start: 5, end: 7.5, text: "oh my god" },
      { start: 65, end: 68, text: "wait" },
    ];
    const text = formatTranscript(transcript(segments), envelope(80, [{ at: 5.5, seconds: 1, db: -16 }]));
    expect(text.split("\n")).toEqual([
      "[00:05.0 -> 00:07.5] oh my god (LOUD +14dB)",
      "[01:05.0 -> 01:08.0] wait",
    ]);

    const hours = formatTranscript(
      transcript([{ start: 3661, end: 3663, text: "later" }]),
      envelope(3663, []),
    );
    expect(hours.startsWith("[01:01:01.0 -> 01:01:03.0] later")).toBe(true);
  });

  test("inserts no-speech lines for long gaps with a loud peak", () => {
    const text = formatTranscript(
      transcript([
        { start: 5, end: 7, text: "okay" },
        { start: 30, end: 32, text: "hi" },
      ]),
      envelope(40, [{ at: 15, seconds: 1, db: -12 }]),
    );
    expect(text).toContain("[00:07.0 -> 00:30.0] (no speech, LOUD +18dB)");
  });

  test("range keeps only overlapping segments", () => {
    const text = formatTranscript(
      transcript([
        { start: 5, end: 7.5, text: "oh my god" },
        { start: 65, end: 68, text: "wait" },
      ]),
      envelope(80, []),
      { from: 4, to: 10 },
    );
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("oh my god");
    expect(text).not.toContain("wait");
  });
});
