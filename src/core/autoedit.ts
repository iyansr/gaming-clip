/**
 * "AI edit": fills a clip's timeline with a hook headline, punch-ins, shake, voice distortion, library sounds and
 * stickers, and a teaser of the payoff. The model plans; this file validates the answer, converts clip-relative
 * times to source times and falls back to a deterministic heuristic when no AI is configured or the answer is
 * unusable. The pure planner is exported for tests.
 */
import { CAPTION_FONTS } from "../shared/captions";
import { ITEM_LIMITS, MAX_TIMELINE_ITEMS, TEASER_LIMITS, ZOOM_LIMITS } from "../shared/effects";
import { computeLayout, type LayoutLayer } from "../shared/layout";
import {
  OUTPUT_SIZE,
  type Clip,
  type ClipTimeline,
  type LibraryItem,
  type LibraryKind,
  type LookId,
  type LoudnessEnvelope,
  type OverlayAnimation,
  type OverlayItem,
  type Project,
  type TextWatermark,
  type TimelineItem,
  type Transcript,
  type VoiceFx,
  type Watermark,
} from "../shared/types";
import { projectPaths } from "./config";
import { listLibrary } from "./library";
import { chatJson, type ChatMessage, LlmTruncatedError } from "./llm";
import { parseTimeline, patchClip } from "./pipeline";
import { DEFAULT_EDIT_GUIDANCE } from "./prompts";
import { llmConfigured } from "./settings";
import { ConflictError, getProject, markBusy, NotFoundError, ValidationError } from "./store";

/** Most transcript characters sent to the model. */
const MAX_TRANSCRIPT_CHARS = 6000;
/** Peak is this many dB above the baseline to count as an impact. */
const PEAK_DB = 6;
/** At most this many impacts get a punch-in. */
const MAX_PEAKS = 3;
/** Two impact punch-ins are at least this far apart; a zoom lasts 1.3 s. */
const PEAK_GAP = 1.6;
/** A voice distortion only makes sense on a real scream. */
const EAR_RAPE_DB = 10;
const AUDIBLE_DB = -60;
/** Teaser only when the payoff is this far into the clip. */
const TEASER_AFTER = 6;

const HOOK_END = 2.2;
const HOOK_MAX_WORDS = 6;
const HOOK_MAX_CHARS = 40;
const HOOK_SIZE = 110;
const HOOK_Y = 560;
const HOOK_STROKE = 12;
const HOOK_FAMILY = "Anton";
const LABEL_SIZE = 80;
const LABEL_Y = 1180;
const LABEL_STROKE = 10;
const ZOOM_SCALE = 1.4;
const ZOOM_LEAD = 0.3;
const ZOOM_TAIL = 1;
const SHAKE_INTENSITY = 0.8;
const EAR_RAPE_LENGTH = 1.2;
/** Longest library sound used; a boom should hit, not play a whole song. */
const SOUND_LENGTH = 1.5;
const STICKER_WIDTH = 360;
const STICKER_Y = 900;

const SOUND_HINTS = [/boom/i, /bruh/i, /vine/i, /hit/i, /bonk/i, /scream/i, /laugh/i, /wow/i];
const LOOKS = new Set<LookId>(["deepfry", "bw", "blur"]);
const VOICES = new Set<VoiceFx>(["earrape", "bass", "chipmunk", "deep", "echo", "robot"]);
const ANIMATIONS = new Set<OverlayAnimation>(["pop", "shake", "slide", "none"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ATTEMPTS = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const uid = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

/** Seconds from a JSON number or a numeric string; null for anything else. */
function secondsOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : null;
  }
  return null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// ---------------------------------------------------------------------------------------------
// Input: clip facts, transcript lines, library and focus points
// ---------------------------------------------------------------------------------------------

export interface FocusPoint {
  /** 0..1 of the output frame. */
  x: number;
  y: number;
}

export type FocusName = "face" | "action" | "centre";
export type EditFocusPoints = Record<FocusName, FocusPoint>;

export interface EditInput {
  /** Clip range in source seconds. */
  start: number;
  end: number;
  title: string;
  /** Why the moment was picked; the hook may take its punchline from it. */
  reason: string;
  transcript: Transcript | null;
  loudness: LoudnessEnvelope | null;
  library: LibraryItem[];
  /** Focus points of the current layout, in output-frame fractions. */
  focus: EditFocusPoints;
}

/** Baseline loudness: the median of the audible part of the envelope (a whole video, not just the clip). */
function baselineOf(loudness: LoudnessEnvelope | null): number | null {
  if (!loudness) return null;
  return median(loudness.rms.filter((value) => value > AUDIBLE_DB));
}

function stepOf(loudness: LoudnessEnvelope): number {
  return loudness.step > 0 ? loudness.step : 0.5;
}

/** Loudest sample inside [from, to], dBFS; -Infinity when the range is outside the envelope. */
function peakDb(loudness: LoudnessEnvelope, from: number, to: number): number {
  const step = stepOf(loudness);
  let peak = -Infinity;
  for (let i = 0; i < loudness.rms.length; i++) {
    const time = i * step;
    if (time < from) continue;
    if (time >= to) break;
    peak = Math.max(peak, loudness.rms[i]!);
  }
  return peak;
}

/** `LOUD +NdB` when the loudest sample of the range is far enough above the baseline; null otherwise. */
function loudLabel(
  loudness: LoudnessEnvelope | null,
  baseline: number | null,
  from: number,
  to: number,
): string | null {
  if (!loudness || baseline === null) return null;
  const peak = peakDb(loudness, from, to);
  if (!Number.isFinite(peak)) return null;
  const diff = peak - baseline;
  return diff >= 9 ? `LOUD +${Math.round(diff)}dB` : null;
}

/**
 * Transcript lines of the clip with CLIP-RELATIVE times, e.g. `[1.2 -> 2.8] oh my god (LOUD +14dB)`.
 * Empty when the clip has no speech.
 */
function editTranscript(input: EditInput): string {
  if (!input.transcript) return "";
  const baseline = baselineOf(input.loudness);
  const lines: string[] = [];
  for (const segment of input.transcript.segments) {
    if (segment.end <= input.start || segment.start >= input.end) continue;
    const from = Math.max(segment.start, input.start);
    const to = Math.min(segment.end, input.end);
    const label = loudLabel(input.loudness, baseline, from, to);
    lines.push(
      `[${(from - input.start).toFixed(1)} -> ${(to - input.start).toFixed(1)}] ${segment.text.trim()}${label ? ` (${label})` : ""}`,
    );
  }
  const text = lines.join("\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text;
}

/** Centre of a layout layer in output-frame fractions. */
function layerFocus(layer: LayoutLayer | undefined): FocusPoint | null {
  if (!layer) return null;
  return {
    x: clamp((layer.dst.x + layer.dst.w / 2) / OUTPUT_SIZE.width, 0, 1),
    y: clamp((layer.dst.y + layer.dst.h / 2) / OUTPUT_SIZE.height, 0, 1),
  };
}

/** Focus points of the clip's current layout: the webcam panel centre, the gameplay centre, the frame centre. */
function clipFocus(project: Project, clip: Clip): EditFocusPoints {
  if (!project.source) throw new ValidationError("The source video is not downloaded yet");
  const layout = computeLayout(
    { width: project.source.width, height: project.source.height },
    project.webcam.rect,
    clip.settings,
    OUTPUT_SIZE,
  );
  const centre: FocusPoint = { x: 0.5, y: 0.5 };
  const action =
    layerFocus(layout.layers.find((layer) => layer.role === "game")) ?? layerFocus(layout.layers[0]) ?? centre;
  const face = layerFocus(layout.layers.find((layer) => layer.role === "cam")) ?? action;
  return { face, action, centre };
}

// ---------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------

const EDIT_SYSTEM: ChatMessage = {
  role: "system",
  content:
    "You edit vertical gaming shorts: you place punch-in zooms, shake, flashes, colour looks, text, stickers, sounds and voice effects on one clip. Reply with one JSON object only, no prose.",
};

function describeLibrary(item: LibraryItem): string {
  const length = item.duration === null ? "" : `, ${item.duration.toFixed(1)} s`;
  return `- "${item.name}" [${item.file}]${length}`;
}

function focusLine(name: FocusName, point: FocusPoint): string {
  return `- ${name}: x=${point.x.toFixed(2)}, y=${point.y.toFixed(2)}`;
}

/**
 * The structural part: output schema, library-only rule, limits. Always last in the prompt, after the editable
 * guidance, so a custom guidance can change taste but not the format the parser relies on.
 */
function editFormat(): string {
  return [
    "Output format. These rules always apply and override anything above:",
    "Reply with exactly one JSON object and nothing else: no prose, no code fence, no comments. Use this shape:",
    '{"hook":{"text":string,"end":number},"teaser":{"start":number,"end":number}|null,"items":[{"kind":"zoom","start":number,"end":number,"scale":number,"focus":"face"|"action"|"centre","ease":"punch"|"smooth"},{"kind":"shake","start":number,"end":number,"intensity":number},{"kind":"flash","start":number,"end":number,"color":"#rrggbb"},{"kind":"look","start":number,"end":number,"look":"deepfry"|"bw"|"blur"},{"kind":"text","start":number,"end":number,"text":string,"animation":"pop"|"shake"|"slide"|"none"},{"kind":"sticker","start":number,"end":number,"name":string,"animation":"pop"|"shake"|"slide"|"none"},{"kind":"sound","start":number,"end":number,"name":string,"volume":number},{"kind":"voice","start":number,"end":number,"preset":"earrape"|"bass"|"chipmunk"|"deep"|"echo"|"robot"}]}',
    "Every start and end is in seconds from the START OF THE CLIP (0 = the clip's first frame), never a source-video time, and inside the clip.",
    `hook: 2 to ${HOOK_MAX_WORDS} words, ALL CAPS, in the language spoken in the clip, no emoji; it starts at 0 and ends between 1 and 3 seconds.`,
    `zoom: scale ${ZOOM_LIMITS.min} to ${ZOOM_LIMITS.max}, focus by name; zoom items must not overlap in time.`,
    "shake: intensity 0.1 to 1. flash: any #rrggbb colour. look: one of the three ids.",
    `text: at most 120 characters, one line. sticker and sound: "name" must be copied exactly from the library lists above; a sticker or sound that is not in the library is dropped.`,
    "sound: volume 0 to 2, and start to end may not be longer than the sound's duration. voice: preset only.",
    `Items last between ${ITEM_LIMITS.min} and ${ITEM_LIMITS.max} seconds; at most ${MAX_TIMELINE_ITEMS} items in total.`,
    `teaser: null, or a ${TEASER_LIMITS.min} to ${TEASER_LIMITS.max} second range inside the clip.`,
    "Escape quotes and line breaks inside JSON strings.",
  ].join("\n");
}

/** Messages for one edit: facts, then the editable guidance, then the fixed output format. */
function editMessages(input: EditInput, guidance: string): ChatMessage[] {
  const sounds = input.library.filter((item) => item.kind === "sound");
  const stickers = input.library.filter((item) => item.kind === "sticker");
  const transcript = editTranscript(input);
  const facts = [
    `Clip title: ${input.title || "(none)"}`,
    `Why it was picked: ${input.reason || "(not given)"}`,
    `Clip length: ${Math.round(input.end - input.start)} seconds`,
    `Language: the hook and any label use the language spoken in the clip (${input.transcript?.language ?? "unknown"}).`,
    "",
    "Focus points of the 1080x1920 output frame (use these names in zoom items):",
    focusLine("face", input.focus.face),
    focusLine("action", input.focus.action),
    focusLine("centre", input.focus.centre),
    "",
    "Library sounds (place one by its name):",
    sounds.length ? sounds.map(describeLibrary).join("\n") : "(none)",
    "",
    "Library stickers (place one by its name):",
    stickers.length ? stickers.map(describeLibrary).join("\n") : "(none)",
    "",
    "What is said in the clip (times in seconds from the start of the clip; LOUD marks a spike over the audio baseline):",
    transcript || "(no speech in this clip)",
  ];
  return [
    EDIT_SYSTEM,
    {
      role: "user",
      content: [
        ...facts,
        "",
        "Guidance from the creator (it decides taste, placement and restraint only):",
        guidance.trim() || DEFAULT_EDIT_GUIDANCE,
        "",
        editFormat(),
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Planning: shared helpers
// ---------------------------------------------------------------------------------------------

/** Items clamped into the clip; null when too short to be valid. */
function clipTiming(input: EditInput, relStart: number, relEnd: number): { start: number; end: number } | null {
  if (!Number.isFinite(relStart) || !Number.isFinite(relEnd) || relStart >= relEnd) return null;
  const start = clamp(input.start + relStart, input.start, input.end);
  let end = clamp(input.start + relEnd, input.start, input.end);
  if (end - start > ITEM_LIMITS.max) end = start + ITEM_LIMITS.max;
  if (end - start < ITEM_LIMITS.min) return null;
  return { start, end };
}

function fontOf(family: string): string {
  return CAPTION_FONTS.find((font) => font.family === family)?.family ?? CAPTION_FONTS[0]!.family;
}

function textElement(text: string, y: number, size: number, family: string, stroke: number): TextWatermark {
  return {
    id: uid(),
    kind: "text",
    x: OUTPUT_SIZE.width / 2,
    y,
    rotation: 0,
    opacity: 1,
    onThumbnail: false,
    text,
    font: fontOf(family),
    size,
    color: "#ffffff",
    stroke,
    strokeColor: "#000000",
  };
}

function hookElement(text: string): TextWatermark {
  return textElement(text, HOOK_Y, HOOK_SIZE, HOOK_FAMILY, HOOK_STROKE);
}

/** The hook is the only overlay `hookItem` builds, so its face tells it apart from labels and stickers. */
function isHookOverlay(item: TimelineItem): item is OverlayItem {
  return item.kind === "overlay" && item.element.kind === "text" && item.element.font === fontOf(HOOK_FAMILY);
}

function labelElement(text: string): TextWatermark {
  return textElement(text, LABEL_Y, LABEL_SIZE, "Bangers", LABEL_STROKE);
}

function stickerElement(item: LibraryItem): Watermark {
  return {
    id: uid(),
    kind: "image",
    x: OUTPUT_SIZE.width / 2,
    y: STICKER_Y,
    rotation: 0,
    opacity: 1,
    onThumbnail: false,
    file: item.file,
    width: STICKER_WIDTH,
  };
}

/** Uppercased hook text, at most six words and forty characters. */
function hookText(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean).slice(0, HOOK_MAX_WORDS);
  return words.join(" ").toLocaleUpperCase().slice(0, HOOK_MAX_CHARS).trim();
}

/** The hook is also drawn over the teaser when one exists, so the short opens on its headline. */
function hookItem(input: EditInput, text: string, endRel: number, overTeaser: boolean): OverlayItem | null {
  const timing = clipTiming(input, 0, clamp(endRel, 0.5, Math.min(3.5, input.end - input.start)));
  if (!timing) return null;
  return { id: uid(), kind: "overlay", ...timing, element: hookElement(text), overTeaser, animation: "pop" };
}

interface LoudPeak {
  /** Clip-relative seconds. */
  time: number;
  /** dB over the baseline. */
  diff: number;
}

/** Impact peaks inside the clip, strongest first, at least PEAK_GAP apart. */
function loudPeaks(loudness: LoudnessEnvelope | null, start: number, end: number): LoudPeak[] {
  if (!loudness) return [];
  const baseline = baselineOf(loudness);
  if (baseline === null) return [];
  const step = stepOf(loudness);

  // Samples of the clip above the impact threshold, grouped into contiguous bursts.
  const groups: { time: number; db: number }[] = [];
  let group: { time: number; db: number } | null = null;
  let lastIndex = -2;
  for (let i = 0; i < loudness.rms.length; i++) {
    const time = i * step;
    if (time < start) continue;
    if (time >= end) break;
    const db = loudness.rms[i]!;
    if (db - baseline < PEAK_DB) {
      group = null;
      continue;
    }
    if (group && i - lastIndex <= 1) {
      if (db > group.db) {
        group.time = time;
        group.db = db;
      }
    } else {
      group = { time, db };
      groups.push(group);
    }
    lastIndex = i;
  }

  const peaks = groups
    .map((entry) => ({ time: entry.time - start, diff: entry.db - baseline }))
    .toSorted((a, b) => b.diff - a.diff);
  const chosen: LoudPeak[] = [];
  for (const peak of peaks) {
    if (chosen.length >= MAX_PEAKS) break;
    if (chosen.some((other) => Math.abs(other.time - peak.time) < PEAK_GAP)) continue;
    chosen.push(peak);
  }
  return chosen;
}

/** Best library sound for an impact: the first hint word that any sound name contains. */
function matchingSound(library: LibraryItem[]): LibraryItem | null {
  const sounds = library.filter((item) => item.kind === "sound");
  for (const hint of SOUND_HINTS) {
    const hit = sounds.find((item) => hint.test(item.name));
    if (hit) return hit;
  }
  return null;
}

/**
 * Deterministic edit, also the fallback when the AI answer is unusable: title hook, face punch-ins on the loudest
 * impacts, shake and an earrape voice on the biggest one, a matching library sound on it, and a teaser of the payoff.
 */
export function heuristicTimeline(input: EditInput): ClipTimeline {
  const items: TimelineItem[] = [];
  const peaks = loudPeaks(input.loudness, input.start, input.end);
  const top = peaks[0] ?? null;
  const zooms: TimelineItem[] = [];
  for (const peak of peaks) {
    const timing = clipTiming(input, peak.time - ZOOM_LEAD, peak.time + ZOOM_TAIL);
    if (!timing) continue;
    zooms.push({ id: uid(), kind: "zoom", ...timing, scale: ZOOM_SCALE, ...input.focus.face, ease: "punch" });
  }

  let teaser: ClipTimeline["teaser"] = null;
  if (top) {
    const shake = clipTiming(input, top.time - 0.1, top.time + 0.45);
    if (shake) items.push({ id: uid(), kind: "shake", ...shake, intensity: SHAKE_INTENSITY });

    if (top.diff >= EAR_RAPE_DB) {
      const voice = clipTiming(input, top.time - 0.2, top.time - 0.2 + EAR_RAPE_LENGTH);
      if (voice) items.push({ id: uid(), kind: "voice", ...voice, preset: "earrape", volume: 1 });
    }

    const match = matchingSound(input.library);
    if (match) {
      const length = Math.min(match.duration ?? SOUND_LENGTH, SOUND_LENGTH);
      const timing = clipTiming(input, top.time, top.time + length);
      if (timing) {
        items.push({ id: uid(), kind: "sound", ...timing, file: match.file, volume: 1.4 });
      }
    }

    if (top.time > TEASER_AFTER) {
      const timing = clipTiming(input, top.time - 1, top.time + 1.5);
      if (timing && timing.end - timing.start >= TEASER_LIMITS.min) teaser = timing;
    }
  }

  // Built after the teaser: the hook must also replay over it when there is one.
  const title = hookText(input.title);
  if (title) {
    const duration = input.end - input.start;
    const hook = hookItem(input, title, Math.min(HOOK_END, duration), teaser !== null);
    if (hook) items.push(hook);
  }

  items.push(...zooms);
  items.sort((a, b) => a.start - b.start);
  return { items: dedupeZooms(items), teaser };
}

/** Later zooms that overlap an earlier one are dropped (the server rejects overlapping zooms). */
function dedupeZooms(items: TimelineItem[]): TimelineItem[] {
  const zooms: { start: number; end: number }[] = [];
  return items.filter((item) => {
    if (item.kind !== "zoom") return true;
    if (zooms.some((zoom) => zoom.start < item.end && zoom.end > item.start)) return false;
    zooms.push({ start: item.start, end: item.end });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Planning: model answer
// ---------------------------------------------------------------------------------------------

/** The model answered, but not with a usable edit. */
class EditFormatError extends Error {
  override name = "EditFormatError";
}

function focusOf(value: unknown, focus: EditFocusPoints): FocusPoint | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLocaleLowerCase();
  if (name !== "face" && name !== "action" && name !== "centre") return null;
  return focus[name];
}

function libraryItem(library: LibraryItem[], kind: LibraryKind, name: unknown, file: unknown): LibraryItem | null {
  if (typeof file === "string") {
    const byFile = library.find((item) => item.kind === kind && item.file === file);
    if (byFile) return byFile;
  }
  if (typeof name !== "string") return null;
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  return library.find((item) => item.kind === kind && item.name.trim().toLocaleLowerCase() === wanted) ?? null;
}

function animationOf(value: unknown): OverlayAnimation {
  return ANIMATIONS.has(value as OverlayAnimation) ? (value as OverlayAnimation) : "pop";
}

function itemFromAnswer(entry: unknown, input: EditInput): TimelineItem | null {
  if (!isRecord(entry)) return null;
  const relStart = secondsOf(entry.start);
  const relEnd = secondsOf(entry.end);
  if (relStart === null || relEnd === null) return null;
  const timing = clipTiming(input, relStart, relEnd);
  if (!timing) return null;
  const id = uid();

  switch (entry.kind) {
    case "zoom": {
      const scale = secondsOf(entry.scale);
      if (scale === null || scale < ZOOM_LIMITS.min || scale > ZOOM_LIMITS.max) return null;
      const focus = focusOf(entry.focus, input.focus);
      if (!focus) return null;
      if (entry.ease !== undefined && entry.ease !== "punch" && entry.ease !== "smooth") return null;
      const ease = entry.ease === "smooth" ? "smooth" : "punch";
      return { id, kind: "zoom", ...timing, scale, ...focus, ease };
    }
    case "shake": {
      const intensity = secondsOf(entry.intensity);
      if (intensity === null || intensity < 0.1 || intensity > 1) return null;
      return { id, kind: "shake", ...timing, intensity };
    }
    case "flash": {
      const color = entry.color === undefined ? "#ffffff" : entry.color;
      if (typeof color !== "string" || !HEX_COLOR.test(color)) return null;
      return { id, kind: "flash", ...timing, color: color.toLocaleLowerCase() };
    }
    case "look": {
      if (!LOOKS.has(entry.look as LookId)) return null;
      return { id, kind: "look", ...timing, look: entry.look as LookId };
    }
    case "text": {
      if (typeof entry.text !== "string") return null;
      const text = entry.text.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) return null;
      return {
        id,
        kind: "overlay",
        ...timing,
        element: labelElement(text),
        overTeaser: false,
        animation: animationOf(entry.animation),
      };
    }
    case "sticker": {
      const sticker = libraryItem(input.library, "sticker", entry.name, entry.file);
      if (!sticker) return null;
      return {
        id,
        kind: "overlay",
        ...timing,
        element: stickerElement(sticker),
        overTeaser: false,
        animation: animationOf(entry.animation),
      };
    }
    case "sound": {
      const item = libraryItem(input.library, "sound", entry.name, entry.file);
      if (!item) return null;
      const volume = secondsOf(entry.volume) ?? 1;
      if (volume < 0 || volume > 2) return null;
      const limit = (item.duration ?? Number.POSITIVE_INFINITY) + 0.05;
      const end = Math.min(timing.end, timing.start + limit);
      if (end - timing.start < ITEM_LIMITS.min) return null;
      return { id, kind: "sound", start: timing.start, end, file: item.file, volume };
    }
    case "voice": {
      if (!VOICES.has(entry.preset as VoiceFx)) return null;
      return { id, kind: "voice", ...timing, preset: entry.preset as VoiceFx, volume: 1 };
    }
    default:
      return null;
  }
}

function teaserFromAnswer(raw: unknown, input: EditInput): ClipTimeline["teaser"] {
  if (!isRecord(raw)) return null;
  const relStart = secondsOf(raw.start);
  const relEnd = secondsOf(raw.end);
  if (relStart === null || relEnd === null) return null;
  const start = clamp(input.start + relStart, input.start, input.end);
  let end = clamp(input.start + relEnd, input.start, input.end);
  if (end - start > TEASER_LIMITS.max) end = start + TEASER_LIMITS.max;
  if (end - start < TEASER_LIMITS.min) return null;
  return { start, end };
}

/**
 * Validates the model's JSON: clip-relative times become source times, focus and library names are resolved, and
 * every unusable item is dropped (unknown file, out-of-range zoom, bad enum, times outside the clip). Throws
 * EditFormatError when the answer has no usable hook, items or teaser at all.
 */
export function timelineFromAnswer(raw: unknown, input: EditInput): ClipTimeline {
  if (!isRecord(raw)) throw new EditFormatError("the answer is not a JSON object");
  // The teaser comes first: the hook must also replay over it when the answer asks for one.
  const teaser = teaserFromAnswer(raw.teaser, input);
  const hookRaw = raw.hook;
  let hook: OverlayItem | null = null;
  if (isRecord(hookRaw) && typeof hookRaw.text === "string") {
    const text = hookText(hookRaw.text);
    if (text) hook = hookItem(input, text, secondsOf(hookRaw.end) ?? HOOK_END, teaser !== null);
  }

  const list = Array.isArray(raw.items) ? raw.items : [];
  const items: TimelineItem[] = [];
  for (const entry of list) {
    if (items.length >= MAX_TIMELINE_ITEMS) break;
    const item = itemFromAnswer(entry, input);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.start - b.start);
  const cleaned = dedupeZooms(items).slice(0, MAX_TIMELINE_ITEMS);

  if (!hook && !cleaned.length && !teaser) throw new EditFormatError("no usable hook, items or teaser");
  const withHook = hook ? [hook, ...cleaned] : cleaned;
  return { items: withHook.slice(0, MAX_TIMELINE_ITEMS), teaser };
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/** `project:clip` of edits in flight in this process. */
const generating = new Set<string>();

/**
 * replace=false keeps the old items, drops new zooms that would overlap an existing zoom and keeps an existing
 * teaser; replace=true starts from an empty timeline.
 */
export function mergeTimeline(
  existing: ClipTimeline | null | undefined,
  planned: ClipTimeline,
  replace: boolean,
): ClipTimeline {
  const oldItems = existing?.items ?? [];
  const items: TimelineItem[] = replace ? [] : [...oldItems];
  for (const item of planned.items) {
    if (items.length >= MAX_TIMELINE_ITEMS) break;
    const clashes =
      item.kind === "zoom" &&
      items.some((other) => other.kind === "zoom" && other.start < item.end && other.end > item.start);
    if (clashes) continue;
    items.push(item);
  }
  items.sort((a, b) => a.start - b.start);
  const teaser = replace ? planned.teaser : (existing?.teaser ?? planned.teaser);
  // The hook follows the teaser the merge actually keeps: a kept teaser must open on the newly added headline.
  const overTeaser = teaser !== null;
  return {
    items: items.map((item) =>
      isHookOverlay(item) && item.overTeaser !== overTeaser ? { ...item, overTeaser } : item,
    ),
    teaser,
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as T) : null;
}

function findClip(project: Project, clipId: string): Clip {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new NotFoundError(`Clip not found: ${clipId}`);
  return clip;
}

/**
 * Fills the clip's timeline with an AI edit (the model plans, this file validates) or, without a configured AI or
 * with an unusable answer, with the heuristic edit. The whole timeline is saved through patchClip, which also
 * invalidates a rendered file.
 */
export async function generateEdit(
  projectId: string,
  clipId: string,
  options: { replace?: boolean } = {},
  signal?: AbortSignal,
): Promise<Project> {
  const project = await getProject(projectId);
  const clip = findClip(project, clipId);
  const replace = options.replace ?? true;
  const key = `${projectId}:${clipId}`;
  if (generating.has(key)) throw new ConflictError("The timeline of this clip is already being generated");
  generating.add(key);
  const release = await markBusy(projectId).catch((error: unknown) => {
    generating.delete(key);
    throw error;
  });
  try {
    const paths = projectPaths(projectId);
    const [transcript, loudness, library] = await Promise.all([
      readJson<Transcript>(paths.transcript),
      readJson<LoudnessEnvelope>(paths.loudness),
      listLibrary(),
    ]);
    const input: EditInput = {
      start: clip.start,
      end: clip.end,
      title: clip.title,
      reason: clip.reason,
      transcript,
      loudness,
      library,
      focus: clipFocus(project, clip),
    };

    let planned: ClipTimeline | null = null;
    if (llmConfigured()) {
      const messages = editMessages(input, DEFAULT_EDIT_GUIDANCE);
      for (let attempt = 0; attempt < ATTEMPTS && !planned; attempt++) {
        signal?.throwIfAborted();
        try {
          planned = timelineFromAnswer(await chatJson(messages, signal), input);
        } catch (error) {
          // Unusable answers (bad shape, broken or cut-off JSON) fall through to the heuristic edit below.
          if (!(error instanceof EditFormatError || error instanceof SyntaxError || error instanceof LlmTruncatedError))
            throw error;
        }
      }
    }
    planned ??= heuristicTimeline(input);
    signal?.throwIfAborted();

    const timeline = parseTimeline(mergeTimeline(clip.timeline, planned, replace));
    return await patchClip(projectId, clipId, { timeline });
  } finally {
    generating.delete(key);
    await release();
  }
}
