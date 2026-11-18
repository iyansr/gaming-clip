/**
 * Caption styles, cue building and drawing. Isomorphic: the Bun renderer (@napi-rs/canvas) and the
 * browser preview (CanvasRenderingContext2D) call the same code, so keep it free of runtime imports.
 */
import type { Word } from "./types";

export interface CaptionFont {
  /** Family name used in `ctx.font`; the renderer registers each file under exactly this name. */
  family: string;
  weight: number;
  /** File name inside assets/fonts. */
  file: string;
}

const ANTON: CaptionFont = { family: "Anton", weight: 400, file: "Anton-Regular.ttf" };
const BANGERS: CaptionFont = { family: "Bangers", weight: 400, file: "Bangers-Regular.ttf" };
const POPPINS_EXTRABOLD: CaptionFont = { family: "Poppins ExtraBold", weight: 800, file: "Poppins-ExtraBold.ttf" };
const POPPINS_SEMIBOLD: CaptionFont = { family: "Poppins SemiBold", weight: 600, file: "Poppins-SemiBold.ttf" };

/** Fonts every style needs. The web app loads `/fonts/<file>`. */
export const CAPTION_FONTS: CaptionFont[] = [ANTON, BANGERS, POPPINS_EXTRABOLD, POPPINS_SEMIBOLD];

/** Colours of one word state. `null` disables that layer. */
interface WordPaint {
  fill: string;
  stroke: string | null;
  shadow: string | null;
}

export interface CaptionStyle {
  id: string;
  name: string;
  font: CaptionFont;
  /** Font size in px on a 1080-wide frame. */
  size: number;
  uppercase: boolean;
  maxWords: number;
  /** Character budget of one cue (about two lines). */
  maxChars: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight: number;
  /** Extra space between words in px at 1080, on top of the font's space glyph; keeps the active word's box/pop off its neighbours. */
  wordGap: number;
  /** Outline width in px (1080-wide frame), drawn outside the glyphs. */
  strokeWidth: number;
  /** Shadow / glow geometry (px at 1080); colours come from the word paint. `passes` repeats the pass for a stronger glow. */
  shadow: { blur: number; offsetX: number; offsetY: number; passes: number };
  base: WordPaint;
  /** Highlight of the spoken word; `null` = the phrase is shown statically. */
  active: {
    paint: WordPaint;
    /** Scale peak of the pop at the word start, then it settles to `rest`. */
    pop: number;
    rest: number;
    /** Rounded box behind the word (px at 1080). */
    box: { color: string; radius: number; padX: number; padY: number } | null;
  } | null;
  /** Opacity of the words that are not the active one. */
  dimAlpha: number;
  /** Rotation of the whole block, degrees. */
  tilt: number;
  /** Cue entrance: fade + scale from `scale` to 1 over `dur` seconds. */
  enter: { dur: number; scale: number };
}

const NO_SHADOW = { blur: 0, offsetX: 0, offsetY: 0, passes: 1 };

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: "pop",
    name: "Pop",
    font: POPPINS_EXTRABOLD,
    size: 72,
    uppercase: true,
    maxWords: 3,
    maxChars: 26,
    lineHeight: 1.2,
    wordGap: 20,
    strokeWidth: 10,
    shadow: { blur: 10, offsetX: 0, offsetY: 6, passes: 1 },
    base: { fill: "#ffffff", stroke: "#000000", shadow: "rgba(0,0,0,0.55)" },
    active: {
      paint: { fill: "#ffe600", stroke: "#000000", shadow: "rgba(0,0,0,0.55)" },
      pop: 1.14,
      rest: 1.04,
      box: null,
    },
    dimAlpha: 1,
    tilt: 0,
    enter: { dur: 0.1, scale: 0.9 },
  },
  {
    id: "neon",
    name: "Neon",
    font: ANTON,
    size: 96,
    uppercase: true,
    maxWords: 3,
    maxChars: 24,
    lineHeight: 1.15,
    wordGap: 12,
    strokeWidth: 2.5,
    shadow: { blur: 26, offsetX: 0, offsetY: 0, passes: 2 },
    base: { fill: "#f4ffff", stroke: "#00c8e6", shadow: "#00e5ff" },
    active: {
      paint: { fill: "#eaffd9", stroke: "#39ff88", shadow: "#39ff88" },
      pop: 1.14,
      rest: 1.04,
      box: null,
    },
    dimAlpha: 1,
    tilt: 0,
    enter: { dur: 0.12, scale: 0.94 },
  },
  {
    id: "box",
    name: "Box",
    font: ANTON,
    size: 90,
    uppercase: true,
    maxWords: 3,
    maxChars: 22,
    lineHeight: 1.4,
    wordGap: 28,
    strokeWidth: 7,
    shadow: NO_SHADOW,
    base: { fill: "#ffffff", stroke: "#000000", shadow: null },
    active: {
      paint: { fill: "#ffffff", stroke: null, shadow: null },
      pop: 1.1,
      rest: 1.03,
      box: { color: "#ff2e63", radius: 20, padX: 26, padY: 16 },
    },
    dimAlpha: 1,
    tilt: 0,
    enter: { dur: 0.1, scale: 0.92 },
  },
  {
    id: "comic",
    name: "Comic",
    font: BANGERS,
    size: 104,
    uppercase: true,
    maxWords: 3,
    maxChars: 22,
    lineHeight: 1.12,
    wordGap: 14,
    strokeWidth: 9,
    shadow: { blur: 0, offsetX: 7, offsetY: 7, passes: 1 },
    base: { fill: "#ffe347", stroke: "#1b0f3b", shadow: "#1b0f3b" },
    active: {
      paint: { fill: "#ff3e9a", stroke: "#1b0f3b", shadow: "#1b0f3b" },
      pop: 1.18,
      rest: 1.06,
      box: null,
    },
    dimAlpha: 1,
    tilt: -4,
    enter: { dur: 0.12, scale: 0.8 },
  },
  {
    id: "clean",
    name: "Clean",
    font: POPPINS_SEMIBOLD,
    size: 56,
    uppercase: false,
    maxWords: 7,
    maxChars: 44,
    lineHeight: 1.3,
    wordGap: 0,
    strokeWidth: 0,
    shadow: { blur: 14, offsetX: 0, offsetY: 3, passes: 2 },
    base: { fill: "#ffffff", stroke: null, shadow: "rgba(0,0,0,0.75)" },
    active: null,
    dimAlpha: 1,
    tilt: 0,
    enter: { dur: 0.15, scale: 1 },
  },
  {
    id: "focus",
    name: "Focus",
    font: ANTON,
    size: 84,
    uppercase: true,
    maxWords: 4,
    maxChars: 28,
    lineHeight: 1.2,
    wordGap: 10,
    strokeWidth: 0,
    shadow: { blur: 8, offsetX: 0, offsetY: 4, passes: 1 },
    base: { fill: "#ffffff", stroke: null, shadow: "rgba(0,0,0,0.8)" },
    active: {
      paint: { fill: "#ffffff", stroke: null, shadow: "rgba(0,0,0,0.8)" },
      pop: 1.1,
      rest: 1.04,
      box: null,
    },
    dimAlpha: 0.45,
    tilt: 0,
    enter: { dur: 0.1, scale: 0.96 },
  },
];

export function getCaptionStyle(id: string): CaptionStyle {
  const style = CAPTION_STYLES.find((s) => s.id === id);
  if (!style) throw new Error(`Unknown caption style "${id}" (known: ${CAPTION_STYLES.map((s) => s.id).join(", ")})`);
  return style;
}

/** Words shown together. Times are seconds relative to the clip start. */
export interface CaptionCue {
  start: number;
  end: number;
  words: Word[];
}

const SILENCE_BREAK = 0.6;
const CUE_HOLD = 0.4;
/** Shortest time a cue stays up; the next cue is pushed later rather than cutting it shorter. */
const MIN_CUE = 0.12;
/** Spacing forced between word starts when the transcript gives several words the same timestamp. */
const WORD_EPSILON = 0.02;
const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Every input word overlapping the clip ends up in exactly one cue. Word starts are strictly increasing
 * across the whole clip (so each word owns a non-empty active interval), and cues never overlap.
 */
export function buildCues(words: Word[], clipStart: number, clipEnd: number, styleId: string): CaptionCue[] {
  const style = getCaptionStyle(styleId);
  const duration = clipEnd - clipStart;
  const clamp = (v: number) => Math.min(duration, Math.max(0, v));

  const local: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text || w.end <= clipStart || w.start >= clipEnd) continue;
    local.push({ text, start: clamp(w.start - clipStart), end: clamp(w.end - clipStart) });
  }
  local.sort((a, b) => a.start - b.start);

  const eps = Math.min(WORD_EPSILON, duration / (local.length + 1));
  // Spread equal/out-of-order starts forward, then pull the tail back inside the clip.
  for (let i = 1; i < local.length; i++) local[i]!.start = Math.max(local[i]!.start, local[i - 1]!.start + eps);
  for (let i = local.length - 1; i >= 0; i--) {
    const w = local[i]!;
    if (i === local.length - 1) w.start = Math.min(w.start, duration - eps);
    else w.start = Math.min(w.start, local[i + 1]!.start - eps);
  }
  for (const w of local) w.end = Math.max(w.end, w.start + eps);

  const groups: Word[][] = [];
  let group: Word[] = [];
  let chars = 0;
  for (const w of local) {
    const prev = group[group.length - 1];
    if (
      prev &&
      (group.length >= style.maxWords ||
        chars + 1 + w.text.length > style.maxChars ||
        w.start - prev.end > SILENCE_BREAK ||
        SENTENCE_END.test(prev.text))
    ) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    chars += (group.length ? 1 : 0) + w.text.length;
    group.push(w);
  }
  if (group.length) groups.push(group);

  // A cue that would be shorter than MIN_CUE delays the next cue's start (and the words after it).
  let prevWord: Word | undefined;
  let minStart = 0;
  for (const g of groups) {
    for (const w of g) {
      if (w === g[0]) w.start = Math.max(w.start, minStart);
      if (prevWord) w.start = Math.max(w.start, prevWord.start + eps);
      w.end = Math.max(w.end, w.start + eps);
      prevWord = w;
    }
    minStart = g[0]!.start + MIN_CUE;
  }

  return groups.map((g, i) => {
    const start = g[0]!.start;
    const nextStart = groups[i + 1]?.[0]?.start ?? duration;
    const end = Math.min(Math.max(g[g.length - 1]!.end + CUE_HOLD, start + MIN_CUE), nextStart, duration);
    return { start, end, words: g };
  });
}

/** Structural subset of the 2D context used here; satisfied by CanvasRenderingContext2D and @napi-rs/canvas. */
export interface CaptionContext {
  font: string;
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  miterLimit: number;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number; actualBoundingBoxAscent: number };
}

export function activeCue(cues: CaptionCue[], t: number): CaptionCue | undefined {
  return cues.find((c) => c.start <= t && t < c.end);
}

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFEFC]/g;
const LETTER_CHAR = /\p{L}/gu;

/** Mostly Arabic/Hebrew text: words keep logical order but each line is laid out right to left. */
function isRtl(text: string): boolean {
  const rtl = text.match(RTL_CHAR)?.length ?? 0;
  return rtl > 0 && rtl * 2 > (text.match(LETTER_CHAR)?.length ?? 0);
}

const MAX_BLOCK_WIDTH = 0.86;
const MAX_LINES = 2;
const POP_DUR = 0.16;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/** Pure function of the time since the word started: dip -> peak -> settle at `rest`. */
function popScale(active: NonNullable<CaptionStyle["active"]>, local: number): number {
  if (local >= POP_DUR) return active.rest;
  const k = Math.max(0, local) / POP_DUR;
  if (k < 0.4) return lerp(active.rest * 0.88, active.pop, easeOut(k / 0.4));
  return lerp(active.pop, active.rest, easeInOut((k - 0.4) / 0.6));
}

/** Split word widths into one line if it fits, else the most balanced two-line split; null if nothing fits. */
function breakLines(widths: number[], space: number, maxWidth: number): number[][] | null {
  const span = (from: number, to: number) => {
    let w = space * (to - from - 1);
    for (let i = from; i < to; i++) w += widths[i]!;
    return w;
  };
  const n = widths.length;
  const all = Array.from({ length: n }, (_, i) => i);
  if (span(0, n) <= maxWidth) return [all];
  let best: number | null = null;
  let bestWidth = Infinity;
  for (let i = 1; i < n; i++) {
    const w = Math.max(span(0, i), span(i, n));
    if (w <= maxWidth && w < bestWidth) {
      best = i;
      bestWidth = w;
    }
  }
  return best === null ? null : [all.slice(0, best), all.slice(best)];
}

function paintGlyphs(
  ctx: CaptionContext,
  style: CaptionStyle,
  paint: WordPaint,
  text: string,
  baselineY: number,
  k: number,
): void {
  const { shadow } = style;
  const setShadow = (on: boolean) => {
    ctx.shadowColor = on && paint.shadow ? paint.shadow : "rgba(0,0,0,0)";
    ctx.shadowBlur = on ? shadow.blur * k : 0;
    ctx.shadowOffsetX = on ? shadow.offsetX * k : 0;
    ctx.shadowOffsetY = on ? shadow.offsetY * k : 0;
  };
  const outlined = paint.stroke !== null && style.strokeWidth > 0;
  if (outlined) {
    ctx.strokeStyle = paint.stroke!;
    ctx.lineWidth = style.strokeWidth * 2 * k;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (let p = 0; p < (paint.shadow ? shadow.passes : 1); p++) {
      setShadow(true);
      ctx.strokeText(text, 0, baselineY);
    }
    setShadow(false);
    ctx.fillStyle = paint.fill;
    ctx.fillText(text, 0, baselineY);
    return;
  }
  ctx.fillStyle = paint.fill;
  for (let p = 0; p < (paint.shadow ? shadow.passes : 1); p++) {
    setShadow(true);
    ctx.fillText(text, 0, baselineY);
  }
  setShadow(false);
}

/**
 * Draw the caption state at clip time `t` in OUTPUT-FRAME coordinates (font sizes scale with
 * frame.width / 1080). Draws nothing when no cue is active. Does not clear the canvas; restores ctx state.
 */
export function drawCaptions(
  ctx: CaptionContext,
  cues: CaptionCue[],
  t: number,
  styleId: string,
  frame: { width: number; height: number; centerY: number },
): void {
  const style = getCaptionStyle(styleId);
  const cue = activeCue(cues, t);
  if (!cue || cue.words.length === 0) return;

  const k = frame.width / 1080;
  const maxWidth = frame.width * MAX_BLOCK_WIDTH;
  const texts = cue.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  const rtl = isRtl(texts.join(" "));

  ctx.save();
  try {
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // Shrink uniformly until the cue fits in MAX_LINES lines within maxWidth (a single over-wide word included).
    let px = 0;
    let widths: number[] = [];
    let space = 0;
    let lines: number[][] | null = null;
    for (let f = 1; f > 0.05 && !lines; f *= 0.94) {
      px = style.size * k * f;
      ctx.font = `${style.font.weight} ${px}px "${style.font.family}"`;
      widths = texts.map((s) => ctx.measureText(s).width);
      space = ctx.measureText(" ").width + style.wordGap * k * f;
      lines = breakLines(widths, space, maxWidth);
    }
    if (!lines || lines.length > MAX_LINES) throw new Error("Caption text cannot be fitted into the frame");
    const capHeight = ctx.measureText("H").actualBoundingBoxAscent;
    const pitch = px * style.lineHeight;

    let activeIndex = -1;
    if (style.active) {
      activeIndex = 0;
      cue.words.forEach((w, i) => {
        if (w.start <= t) activeIndex = i;
      });
    }

    const enterK = style.enter.dur > 0 ? Math.min(1, Math.max(0, (t - cue.start) / style.enter.dur)) : 1;
    const enter = easeOut(enterK);
    ctx.translate(frame.width / 2, frame.centerY);
    ctx.rotate((style.tilt * Math.PI) / 180);
    const blockScale = lerp(style.enter.scale, 1, enter);
    ctx.scale(blockScale, blockScale);

    // Positions come from base-size measurements, so scaling a word never moves its neighbours.
    const placed = lines.flatMap((line, row) => {
      const lineWidth = line.reduce((sum, i) => sum + widths[i]!, 0) + space * (line.length - 1);
      let x = -lineWidth / 2;
      return (rtl ? [...line].reverse() : line).map((i) => {
        const cx = x + widths[i]! / 2;
        x += widths[i]! + space;
        return { i, cx, cy: (row - (lines.length - 1) / 2) * pitch };
      });
    });
    // Active word last so its pop overlaps neighbours instead of being overdrawn.
    placed.sort((a, b) => Number(a.i === activeIndex) - Number(b.i === activeIndex));

    for (const { i, cx, cy } of placed) {
      const isActive = i === activeIndex && style.active !== null;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalAlpha = enter * (isActive ? 1 : style.dimAlpha);
      let paint = style.base;
      if (isActive && style.active) {
        const s = popScale(style.active, t - cue.words[i]!.start);
        ctx.scale(s, s);
        paint = style.active.paint;
        const box = style.active.box;
        if (box) {
          const w = widths[i]! + 2 * box.padX * k;
          const h = capHeight + 2 * box.padY * k;
          const r = Math.min(box.radius * k, h / 2);
          ctx.fillStyle = box.color;
          ctx.beginPath();
          ctx.moveTo(-w / 2 + r, -h / 2);
          ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
          ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
          ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
          ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
          ctx.closePath();
          ctx.fill();
        }
      }
      paintGlyphs(ctx, style, paint, texts[i]!, capHeight / 2, k);
      ctx.restore();
    }
  } finally {
    ctx.restore();
  }
}
