import { CAPTION_FONTS } from "../../shared/captions";
import { ITEM_LIMITS, MAX_TIMELINE_ITEMS, TEASER_LIMITS } from "../../shared/effects";
import type { FrameLayout } from "../../shared/layout";
import {
  OUTPUT_SIZE,
  type ClipTimeline,
  type LibraryItem,
  type LookId,
  type OverlayItem,
  type Size,
  type TimelineItem,
  type TimelineItemKind,
  type VoiceFx,
} from "../../shared/types";
import { clamp } from "./format";
import { newWatermarkId, WM_WIDTH } from "./watermarks";

/** Items snap to this grid, in seconds from the clip start. */
export const GRID = 0.05;
/** Snap distance to the playhead, in screen px. */
export const SNAP_PX = 7;
/** Slack the server allows a sound item over the sound's own length. */
const SOUND_SLACK = 0.05;

/** Rounds away the float noise that clip.start + n * 0.05 would leave in a stored time. */
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** Nearest grid line of a clip-relative time. */
export const snapToGrid = (rel: number) => Math.round(rel / GRID) * GRID;

export const LOOK_LABELS: Record<LookId, string> = { deepfry: "Deep fry", bw: "Black & white", blur: "Blur" };
export const VOICE_LABELS: Record<VoiceFx, string> = {
  earrape: "Earrape",
  bass: "Bass boost",
  chipmunk: "Chipmunk",
  deep: "Deep",
  echo: "Echo",
  robot: "Robot",
};

/** What the timeline draws for an item or the teaser: row, colour and caption. */
export type BlockKind = TimelineItemKind | "sticker" | "teaser";
export type TrackId = "media" | "effects" | "overlays" | "audio" | "teaser";

/** Rows of the timeline, top to bottom. Items live in effects, overlays and audio; media and teaser are drawn apart. */
export const TRACKS: { id: TrackId; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "effects", label: "Effects" },
  { id: "overlays", label: "Overlays" },
  { id: "audio", label: "Audio" },
  { id: "teaser", label: "Teaser" },
];

export function blockKind(item: TimelineItem): BlockKind {
  return item.kind === "overlay" && item.element.kind === "image" ? "sticker" : item.kind;
}

export type ItemTrackId = Exclude<TrackId, "media" | "teaser">;

export function trackOf(item: TimelineItem): ItemTrackId {
  switch (item.kind) {
    case "overlay":
      return "overlays";
    case "sound":
    case "voice":
      return "audio";
    default:
      return "effects";
  }
}

/** Ids the selection uses for the intro and the outro block. */
export const INTRO_ID = "intro";
export const OUTRO_ID = "outro";
export type BookendSlot = "intro" | "outro";

/** Seconds a bookend block is drawn for when its library video is unknown (not loaded yet, or deleted). */
const BOOKEND_FALLBACK = 2;

/** Length of the intro/outro video on the timeline axis; 0 when none is set. */
export function bookendLength(file: string | null, library: Map<string, LibraryItem>): number {
  if (file === null) return 0;
  return library.get(file)?.duration ?? BOOKEND_FALLBACK;
}

/** Tailwind classes of a block, by what it is. */
export const BLOCK_CLASS: Record<BlockKind, string> = {
  zoom: "border-indigo-300 bg-indigo-600 text-white",
  shake: "border-orange-300 bg-orange-600 text-white",
  flash: "border-yellow-200 bg-yellow-400 text-zinc-900",
  look: "border-fuchsia-300 bg-fuchsia-600 text-white",
  overlay: "border-emerald-300 bg-emerald-600 text-white",
  sticker: "border-teal-300 bg-teal-600 text-white",
  sound: "border-sky-300 bg-sky-600 text-white",
  voice: "border-rose-300 bg-rose-600 text-white",
  teaser: "border-amber-200 bg-amber-400 text-zinc-900",
};

export function itemLabel(item: TimelineItem, library: Map<string, LibraryItem>): string {
  switch (item.kind) {
    case "zoom":
      return `Zoom ${Number(item.scale.toFixed(2))}×`;
    case "shake":
      return "Shake";
    case "flash":
      return "Flash";
    case "look":
      return LOOK_LABELS[item.look];
    case "overlay":
      return item.element.kind === "text" ? item.element.text : (library.get(item.element.file)?.name ?? "Sticker");
    case "sound":
      return library.get(item.file)?.name ?? "Sound";
    case "voice":
      return VOICE_LABELS[item.preset];
  }
}

/** Short random id of a new item; the server accepts 1..32 chars of [A-Za-z0-9_-]. */
export function newItemId(items: TimelineItem[]): string {
  for (;;) {
    const id = newWatermarkId([]);
    if (!items.some((i) => i.id === id)) return id;
  }
}

/** A span of source time. */
export interface Span {
  start: number;
  end: number;
}

/** The first zoom (other than `except`) that overlaps `span`, or null. */
export function zoomClash(items: TimelineItem[], span: Span, except: string): TimelineItem | null {
  return items.find((i) => i.kind === "zoom" && i.id !== except && i.start < span.end && span.start < i.end) ?? null;
}

/**
 * Why `next` cannot go into the timeline in place of the item with its id (or as a new one), or null. Mirrors the
 * server's checks (ITEM_LIMITS, zoom overlap, sound length); `origin` is the clip start, for the times in messages.
 */
export function itemProblem(
  items: TimelineItem[],
  next: TimelineItem,
  library: Map<string, LibraryItem>,
  origin: number,
): string | null {
  const length = next.end - next.start;
  if (!Number.isFinite(next.start) || !Number.isFinite(next.end)) return "Enter a valid time";
  if (length < ITEM_LIMITS.min - 1e-6) return `An item is at least ${ITEM_LIMITS.min} s long`;
  if (length > ITEM_LIMITS.max + 1e-6) return `An item is at most ${ITEM_LIMITS.max} s long`;
  if (next.kind === "sound") {
    const sound = library.get(next.file);
    if (sound?.duration != null && length > sound.duration + SOUND_SLACK + 1e-6)
      return `"${sound.name}" is only ${sound.duration.toFixed(2)} s long`;
  }
  if (next.kind === "zoom") {
    const clash = zoomClash(items, next, next.id);
    if (clash)
      return `Zooms cannot overlap: this one would run into the zoom at ${(clash.start - origin).toFixed(2)}-${(clash.end - origin).toFixed(2)} s`;
  }
  return null;
}

/** Longest a sound item can be: the sound's own length, capped like every item. */
export function maxLength(item: TimelineItem, library: Map<string, LibraryItem>): number {
  if (item.kind === "sound") {
    const d = library.get(item.file)?.duration;
    if (d != null) return Math.min(ITEM_LIMITS.max, d + SOUND_SLACK);
  }
  return ITEM_LIMITS.max;
}

/**
 * Moves the items with `ids` by `delta` seconds as one group. The delta is cut down so no member leaves the clip
 * (a member already outside may not go further out), then every moved item gets the same checks as a single edit.
 * Returns the new item list, the delta that applied and the new span of each moved item, or why it cannot be done.
 */
export function shiftItems(
  items: TimelineItem[],
  ids: ReadonlySet<string>,
  delta: number,
  clip: Span,
  library: Map<string, LibraryItem>,
): { items: TimelineItem[]; delta: number; moved: Map<string, Span> } | string {
  const members = items.filter((i) => ids.has(i.id));
  let lo = -Infinity;
  let hi = Infinity;
  for (const m of members) {
    lo = Math.max(lo, Math.min(0, clip.start - m.start));
    hi = Math.min(hi, Math.max(0, clip.end - m.end));
  }
  const applied = round3(clamp(delta, lo, hi));
  const moved = new Map<string, Span>();
  const next = items.map((i) => {
    if (!ids.has(i.id)) return i;
    const span = { start: round3(i.start + applied), end: round3(i.end + applied) };
    moved.set(i.id, span);
    return { ...i, ...span };
  });
  for (const i of next) {
    if (!moved.has(i.id)) continue;
    const problem = itemProblem(next, i, library, clip.start);
    if (problem) return problem;
  }
  return { items: next, delta: applied, moved };
}

/** Copies of the items with `ids`, each placed right after its original; the copies' ids, or why it cannot be done. */
export function duplicateItems(
  items: TimelineItem[],
  ids: ReadonlySet<string>,
  clip: Span,
): { items: TimelineItem[]; copies: string[] } | string {
  const all = [...items];
  const copies: string[] = [];
  for (const original of items.filter((i) => ids.has(i.id))) {
    const placed = placeItem(all, original.kind, original.end, original.end - original.start, clip, clip.start);
    if (typeof placed === "string") return placed;
    const id = newItemId(all);
    all.push(
      original.kind === "overlay"
        ? { ...original, ...placed, id, element: { ...original.element, id } }
        : { ...original, ...placed, id },
    );
    copies.push(id);
  }
  return { items: all, copies };
}

/** Row of every item, so overlapping items of one track stack instead of hiding each other. */
export function assignLanes(items: (Span & { id: string })[]): Map<string, number> {
  const sorted = items.toSorted((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end <= item.start + 1e-6);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = item.end;
    lanes.set(item.id, lane);
  }
  return lanes;
}

/**
 * Where a new item of up to `length` seconds goes for a playhead at `at`: starting at the playhead (on the grid),
 * cut at the clip end, or moved back when less than half a second (or the whole item) would be left; and free of
 * other zooms. A message when it cannot be placed.
 */
export function placeItem(
  items: TimelineItem[],
  kind: TimelineItemKind,
  at: number,
  length: number,
  clip: Span,
  origin: number,
): Span | string {
  if (items.length >= MAX_TIMELINE_ITEMS) return `The timeline holds at most ${MAX_TIMELINE_ITEMS} items`;
  const len = Math.min(length, clip.end - clip.start);
  if (len < ITEM_LIMITS.min - 1e-6) return "The clip is too short for that";
  const grid = (t: number) => round3(clip.start + snapToGrid(t - clip.start));
  let start = clamp(grid(at), clip.start, clip.end - ITEM_LIMITS.min);
  if (clip.end - start < Math.min(len, 0.5)) start = clip.end - len;
  let end = Math.min(start + len, clip.end);
  if (kind === "zoom") {
    // Slide past the zoom under the playhead; give up when there is no room left before the clip end.
    for (;;) {
      const clash = zoomClash(items, { start, end }, "");
      if (!clash) break;
      start = round3(clash.end);
      end = Math.min(start + len, clip.end);
      if (end - start < Math.min(len, 0.5) - 1e-6)
        return `No room for a zoom at ${(at - origin).toFixed(2)} s: zooms cannot overlap. Move the playhead to a free spot.`;
    }
  }
  return { start: round3(start), end: round3(end) };
}

/** Where the zoom focus buttons point, as 0..1 of the output frame; null when the layout has no such part. */
export interface FocusPoints {
  face: { x: number; y: number } | null;
  action: { x: number; y: number } | null;
}

export function focusPoints(layout: FrameLayout | null, output: Size = OUTPUT_SIZE): FocusPoints {
  const centre = (role: "cam" | "game") => {
    const layer = layout?.layers.find((l) => l.role === role);
    if (!layer) return null;
    return {
      x: clamp(round3((layer.dst.x + layer.dst.w / 2) / output.width), 0, 1),
      y: clamp(round3((layer.dst.y + layer.dst.h / 2) / output.height), 0, 1),
    };
  };
  return { face: centre("cam"), action: centre("game") };
}

/** The kinds that are added with one click and need nothing from the library. */
export type PlainKind = "zoom" | "shake" | "flash" | "look" | "voice" | "text";

export const PLAIN_LENGTH: Record<PlainKind, number> = { zoom: 1, shake: 1, flash: 0.3, look: 1, voice: 1, text: 2 };

export function plainItem(kind: PlainKind, id: string, span: Span, focus: FocusPoints, split: boolean): TimelineItem {
  switch (kind) {
    case "zoom": {
      const at = split && focus.face ? focus.face : { x: 0.5, y: 0.5 };
      return { id, kind: "zoom", ...span, scale: 1.5, x: at.x, y: at.y, ease: "punch" };
    }
    case "shake":
      return { id, kind: "shake", ...span, intensity: 0.6 };
    case "flash":
      return { id, kind: "flash", ...span, color: "#ffffff" };
    case "look":
      return { id, kind: "look", ...span, look: "deepfry" };
    case "voice":
      return { id, kind: "voice", ...span, preset: "earrape", volume: 1 };
    case "text":
      return {
        id,
        kind: "overlay",
        ...span,
        animation: "pop",
        overTeaser: false,
        element: {
          id,
          kind: "text",
          x: 540,
          y: 380,
          rotation: 0,
          opacity: 1,
          onThumbnail: false,
          text: "TEXT",
          font: CAPTION_FONTS.find((f) => f.family === "Anton")?.family ?? CAPTION_FONTS[0]!.family,
          size: 110,
          color: "#ffffff",
          stroke: 8,
          strokeColor: "#000000",
        },
      };
  }
}

export const STICKER_LENGTH = 1.5;

export function stickerItem(id: string, span: Span, sticker: LibraryItem): OverlayItem {
  const natural = sticker.width ?? 360;
  return {
    id,
    kind: "overlay",
    ...span,
    animation: "pop",
    overTeaser: false,
    element: {
      id,
      kind: "image",
      x: 540,
      y: 960,
      rotation: 0,
      opacity: 1,
      onThumbnail: false,
      file: sticker.file,
      width: clamp(Math.min(natural, 420), WM_WIDTH.min, WM_WIDTH.max),
    },
  };
}

/** A new teaser around `want`, kept inside the clip and within TEASER_LIMITS. */
export function teaserFrom(want: Span, clip: Span): Span {
  const length = clamp(want.end - want.start, TEASER_LIMITS.min, Math.min(TEASER_LIMITS.max, clip.end - clip.start));
  const start = clamp(want.start, clip.start, clip.end - length);
  return { start: round3(start), end: round3(start + length) };
}

/** True when the timeline has nothing in it. */
export const isEmpty = (t: ClipTimeline) => t.items.length === 0 && t.teaser === null;
