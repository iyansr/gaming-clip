import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { loadImage } from "@napi-rs/canvas";

import { CAPTION_FONTS, CAPTION_STYLES } from "../shared/captions";
import { ITEM_LIMITS, MAX_TIMELINE_ITEMS, overlappingZooms, TEASER_LIMITS, ZOOM_LIMITS } from "../shared/effects";
import { defaultCustomLayout } from "../shared/layout";
import { THUMBNAIL_STYLES } from "../shared/thumbnail";
import {
  DEFAULT_OPTIONS,
  DEFAULT_THUMBNAIL,
  EMPTY_TIMELINE,
  OUTPUT_SIZE,
  STAGE_ORDER,
  type CamElement,
  type Clip,
  type ClipSettings,
  type ClipSource,
  type ClipThumbnail,
  type ClipTimeline,
  type CustomLayout,
  type LayoutBackground,
  type LayoutElement,
  type LayoutMode,
  type LibraryItem,
  type LibraryKind,
  type LoudnessEnvelope,
  type Project,
  type ProjectOptions,
  type Rect,
  type SourceMeta,
  type StageId,
  type TimelineItem,
  type Transcript,
  type VoiceItem,
  type Webcam,
  type Watermark,
  type Word,
} from "../shared/types";
import { MAX_WATERMARKS } from "../shared/watermark";
import { loudnessEnvelope } from "./audio";
import { LIBRARY_DIR, projectPaths, type ProjectPaths } from "./config";
import { fetchSource, probeMedia } from "./download";
import { findHighlights } from "./highlights";
import { libraryIndexSync, libraryPath } from "./library";
import { renderClip } from "./render";
import { getSettings } from "./settings";
import {
  ConflictError,
  getProject,
  markBusy,
  newClipId,
  NotFoundError,
  PayloadTooLargeError,
  throttledUpdater,
  updateProject,
  ValidationError,
} from "./store";
import { renderThumbnail, suggestThumbnailTimes, type ThumbnailCandidate } from "./thumbnail";
import { extractAudio, transcribe } from "./transcribe";
import { detectWebcam } from "./webcam";

export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 180;
const EPSILON = 1e-6;

/** "83.5" -> "1:23"; hours only when needed. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Clip validity: 0 <= start < end <= duration, length between 3 s and 180 s. */
export function assertClipRange(start: number, end: number, duration: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new ValidationError("Clip start and end must be numbers");
  if (start < 0) throw new ValidationError(`Clip start ${start}s must be >= 0`);
  if (end <= start) throw new ValidationError(`Clip end ${end}s must be after its start ${start}s`);
  if (end > duration + EPSILON) {
    throw new ValidationError(`Clip end ${end}s is beyond the source duration ${duration.toFixed(1)}s`);
  }
  const length = end - start;
  if (length < MIN_CLIP_SECONDS - EPSILON) {
    throw new ValidationError(`Clip is ${length.toFixed(1)}s long; the minimum is ${MIN_CLIP_SECONDS}s`);
  }
  if (length > MAX_CLIP_SECONDS + EPSILON) {
    throw new ValidationError(`Clip is ${length.toFixed(1)}s long; the maximum is ${MAX_CLIP_SECONDS}s`);
  }
}

export interface ClipFields {
  start: number;
  end: number;
  title: string;
  reason: string;
  score: number;
}

/**
 * New clip with a fresh id and a copy of the project defaults. `selected` is true for agent/manual clips;
 * engine clips start unselected because choosing the top half needs the whole batch (see `replaceGeneratedClips`).
 */
export function makeClip(project: Project, fields: ClipFields, source: ClipSource): Clip {
  if (!project.source) throw new ValidationError("The source video is not downloaded yet");
  assertClipRange(fields.start, fields.end, project.source.duration);
  let id = newClipId();
  while (project.clips.some((clip) => clip.id === id)) id = newClipId();
  return {
    id,
    start: fields.start,
    end: fields.end,
    title: fields.title.trim() || `Clip ${formatClock(fields.start)}`,
    reason: fields.reason,
    score: Math.min(100, Math.max(0, fields.score)),
    source,
    selected: source === "agent" || source === "manual",
    settings: concreteSettings(project, { ...project.defaults }),
    render: { status: "idle", progress: 0 },
    thumbnail: { ...DEFAULT_THUMBNAIL },
    social: null,
    timeline: structuredClone(EMPTY_TIMELINE),
  };
}

/** The video stream is slightly shorter than the container, so single-frame grabs stay clear of the very end. */
export function clampFrameTime(t: number, duration: number): number {
  return Math.min(t, Math.max(0, duration - 0.5));
}

/**
 * Warnings carry a fixed prefix per origin so a re-run of that origin replaces its own warnings
 * instead of piling up (Project.warnings stays a plain string[]).
 */
export const WARNING_PREFIX = {
  transcribe: "Transcript: ",
  highlights: "Highlights: ",
  render: "Render: ",
  thumbnail: "Thumbnail: ",
} as const;

function replaceWarnings(project: Project, prefixes: string[], warnings: string[]): void {
  const kept = project.warnings.filter((warning) => !prefixes.some((prefix) => warning.startsWith(prefix)));
  for (const warning of warnings) if (!kept.includes(warning)) kept.push(warning);
  project.warnings = kept;
}

/** Thumbnail warnings are replaced per clip, so a retry of one clip keeps the failures of the others. */
function replaceThumbnailWarning(project: Project, clipId: string, message: string | null): void {
  const prefix = `${WARNING_PREFIX.thumbnail}Clip ${clipId}: `;
  project.warnings = project.warnings.filter((warning) => !warning.startsWith(prefix));
  if (message !== null) project.warnings.push(prefix + message);
}

const byStart = (a: Clip, b: Clip) => a.start - b.start;

const isBusy = (clip: Clip) => clip.render.status === "queued" || clip.render.status === "rendering";

/**
 * Replaces every clip whose source is not "manual" with clips built from `picks`. Throws before changing
 * anything when a pick is invalid. Engine picks get the top half by score selected (at least one).
 * Returns the removed clips so the caller can delete their output files.
 */
export function replaceGeneratedClips(
  project: Project,
  picks: ClipFields[],
  source: "heuristic" | "llm" | "agent",
): Clip[] {
  const made = picks.map((pick) => makeClip(project, pick, source));
  if (source !== "agent") {
    const keep = Math.max(1, Math.floor(made.length / 2));
    for (const clip of [...made].sort((a, b) => b.score - a.score).slice(0, keep)) clip.selected = true;
  }
  const removed = project.clips.filter((clip) => clip.source !== "manual");
  project.clips = [...project.clips.filter((clip) => clip.source === "manual"), ...made].sort(byStart);
  return removed;
}

export async function removeOutputs(id: string, files: (string | undefined)[]): Promise<void> {
  const { clipsDir } = projectPaths(id);
  await Promise.all(
    files
      .filter((file): file is string => Boolean(file))
      .map((file) => rm(join(clipsDir, basename(file)), { force: true })),
  );
}

// ---------------------------------------------------------------------------------------------
// Input parsing (shared by the HTTP API and the CLI)
// ---------------------------------------------------------------------------------------------

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ValidationError(`${what} must be an object`);
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      throw new ValidationError(`Unknown ${what} field "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

function numberInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/** Validates partial options on top of `base` (default: the built-in options with the language chosen in Settings) and returns the merged options. */
export function parseOptions(
  raw: unknown,
  base: ProjectOptions = { ...DEFAULT_OPTIONS, language: getSettings().values.defaultLanguage },
): ProjectOptions {
  const obj = asObject(raw, "options");
  rejectUnknownKeys(obj, ["language", "clipCount", "minDuration", "maxDuration"], "option");
  const merged = { ...base, ...obj };
  if (typeof merged.language !== "string" || !/^(auto|[a-z]{2,3})$/.test(merged.language)) {
    throw new ValidationError(`language must be "auto" or a language code like "en"`);
  }
  if (
    merged.clipCount !== null &&
    (!Number.isInteger(merged.clipCount) || merged.clipCount < 1 || merged.clipCount > 60)
  ) {
    throw new ValidationError("clipCount must be null (auto) or an integer between 1 and 60");
  }
  numberInRange(merged.minDuration, "minDuration", MIN_CLIP_SECONDS, MAX_CLIP_SECONDS);
  numberInRange(merged.maxDuration, "maxDuration", MIN_CLIP_SECONDS, MAX_CLIP_SECONDS);
  if (merged.minDuration > merged.maxDuration) throw new ValidationError("minDuration must not exceed maxDuration");
  return merged;
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** What the asset upload generates (random hex + image extension); anything else cannot name an asset. */
const ASSET_NAME_PATTERN = /^[a-f0-9]{8,64}\.(png|jpg|webp)$/;
const MIN_ELEMENT_PX = 16;

function parseElementRect(
  raw: unknown,
  what: string,
  bounds: { x: [number, number]; y: [number, number]; w: [number, number]; h: [number, number] },
): Rect {
  const obj = asObject(raw, what);
  rejectUnknownKeys(obj, ["x", "y", "w", "h"], what);
  return {
    x: numberInRange(obj.x, `${what}.x`, ...bounds.x),
    y: numberInRange(obj.y, `${what}.y`, ...bounds.y),
    w: numberInRange(obj.w, `${what}.w`, ...bounds.w),
    h: numberInRange(obj.h, `${what}.h`, ...bounds.h),
  };
}

function parseElement(
  raw: unknown,
  what: string,
  extra: string[],
): { obj: Record<string, unknown>; src: Rect; dst: Rect } {
  const obj = asObject(raw, what);
  rejectUnknownKeys(obj, ["src", "dst", ...extra], what);
  const { width, height } = OUTPUT_SIZE;
  const src = parseElementRect(obj.src, `${what}.src`, {
    x: [0, 1e5],
    y: [0, 1e5],
    w: [MIN_ELEMENT_PX, 1e5],
    h: [MIN_ELEMENT_PX, 1e5],
  });
  const dst = parseElementRect(obj.dst, `${what}.dst`, {
    x: [-width, 2 * width],
    y: [-height, 2 * height],
    w: [MIN_ELEMENT_PX, 4 * width],
    h: [MIN_ELEMENT_PX, 4 * height],
  });
  return { obj, src, dst };
}

/**
 * Strict structure and range check of a free-form layout (unknown keys rejected). What depends on the
 * project (the source frame size, uploaded image files) is checked by `checkCustomLayout`.
 */
export function parseCustomLayout(raw: unknown): CustomLayout {
  const obj = asObject(raw, "custom");
  rejectUnknownKeys(obj, ["background", "game", "cam"], "custom");

  const background = asObject(obj.background, "custom.background");
  let parsedBackground: LayoutBackground;
  if (background.kind === "blur") {
    rejectUnknownKeys(background, ["kind"], "custom.background");
    parsedBackground = { kind: "blur" };
  } else if (background.kind === "color") {
    rejectUnknownKeys(background, ["kind", "color"], "custom.background");
    if (typeof background.color !== "string" || !COLOR_PATTERN.test(background.color)) {
      throw new ValidationError("custom.background.color must be a colour like #1e1b4b");
    }
    parsedBackground = { kind: "color", color: background.color.toLowerCase() };
  } else if (background.kind === "image") {
    rejectUnknownKeys(background, ["kind", "file"], "custom.background");
    if (typeof background.file !== "string" || !ASSET_NAME_PATTERN.test(background.file)) {
      throw new ValidationError("custom.background.file must be the file name returned by the assets upload");
    }
    parsedBackground = { kind: "image", file: background.file };
  } else {
    throw new ValidationError(`custom.background.kind must be one of blur, color, image`);
  }

  let game: LayoutElement | null = null;
  if (obj.game !== null) {
    const { src, dst } = parseElement(obj.game, "custom.game", []);
    game = { src, dst };
  }

  let cam: CamElement | null = null;
  if (obj.cam !== null) {
    const {
      obj: style,
      src,
      dst,
    } = parseElement(obj.cam, "custom.cam", ["feather", "radius", "border", "borderColor"]);
    if (typeof style.borderColor !== "string" || !COLOR_PATTERN.test(style.borderColor)) {
      throw new ValidationError("custom.cam.borderColor must be a colour like #ffffff");
    }
    cam = {
      src,
      dst,
      feather: numberInRange(style.feather, "custom.cam.feather", 0, 300),
      radius: numberInRange(style.radius, "custom.cam.radius", 0, 960),
      border: numberInRange(style.border, "custom.cam.border", 0, 40),
      borderColor: style.borderColor.toLowerCase(),
    };
  }
  return { background: parsedBackground, game, cam };
}

/** Directory of a project's uploaded background images. */
export const assetsDir = (id: string) => join(projectPaths(id).dir, "assets");

/** Image types accepted for background uploads, with the file extension they are stored under. */
export const ASSET_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

/** The image type the bytes really are (by magic number), whatever the upload claims. */
function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  // RIFF <size> WEBP
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Stores an uploaded background image under a random name in the project's assets directory and returns that name. */
export async function addAsset(id: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await getProject(id);
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = ASSET_TYPES[type];
  if (!ext) throw new ValidationError(`Content-Type must be one of ${Object.keys(ASSET_TYPES).join(", ")}`);
  if (bytes.length === 0) throw new ValidationError("The upload is empty");
  if (bytes.length > MAX_ASSET_BYTES)
    throw new PayloadTooLargeError(`The image is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  if (sniffImageType(bytes) !== type) throw new ValidationError(`The file is not a ${type} image`);
  try {
    await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new ValidationError(`The ${type} image cannot be decoded`);
  }
  const name = `${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}.${ext}`;
  const dir = assetsDir(id);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${name}.partial`);
  try {
    await Bun.write(temp, bytes);
    await rename(temp, join(dir, name));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return name;
}

/** The parts of a valid layout that depend on the project: elements cut from inside the source frame, uploaded image present. */
function checkCustomLayout(custom: CustomLayout, project: Project): void {
  if (!project.source)
    throw new ValidationError("The source video is not downloaded yet, so a custom layout cannot be checked");
  const { width, height } = project.source;
  const elements = { game: custom.game, cam: custom.cam };
  for (const [name, element] of Object.entries(elements)) {
    if (!element) continue;
    const { x, y, w, h } = element.src;
    if (x + w > width + EPSILON || y + h > height + EPSILON) {
      throw new ValidationError(`custom.${name}.src ${x},${y},${w},${h} exceeds the ${width}x${height} source frame`);
    }
  }
  if (custom.background.kind === "image" && !existsSync(join(assetsDir(project.id), custom.background.file))) {
    throw new ValidationError(`custom.background.file ${custom.background.file} was not uploaded to this project`);
  }
}

const WATERMARK_ID_PATTERN = /^[a-z0-9]{4,12}$/;
const WATERMARK_TEXT_LIMIT = 120;
const WATERMARK_KEYS = ["id", "kind", "x", "y", "rotation", "opacity", "onThumbnail"];

function parseColor(value: unknown, name: string): string {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value))
    throw new ValidationError(`${name} must be a colour like #ffffff`);
  return value.toLowerCase();
}

/** Strict structure and range check of one watermark (unknown keys rejected); its file is checked by `checkWatermarks`. */
function parseWatermark(entry: unknown, what: string): Watermark {
  const obj = asObject(entry, what);
  if (obj.kind !== "text" && obj.kind !== "image") throw new ValidationError(`${what}.kind must be "text" or "image"`);
  rejectUnknownKeys(
    obj,
    [
      ...WATERMARK_KEYS,
      ...(obj.kind === "image" ? ["file", "width"] : ["text", "font", "size", "color", "stroke", "strokeColor"]),
    ],
    what,
  );
  if (typeof obj.id !== "string" || !WATERMARK_ID_PATTERN.test(obj.id))
    throw new ValidationError(`${what}.id must be 4-12 lowercase letters or digits`);
  if (typeof obj.onThumbnail !== "boolean") throw new ValidationError(`${what}.onThumbnail must be true or false`);
  const base = {
    id: obj.id,
    x: numberInRange(obj.x, `${what}.x`, -OUTPUT_SIZE.width, 2 * OUTPUT_SIZE.width),
    y: numberInRange(obj.y, `${what}.y`, -OUTPUT_SIZE.height, 2 * OUTPUT_SIZE.height),
    rotation: numberInRange(obj.rotation, `${what}.rotation`, -180, 180),
    opacity: numberInRange(obj.opacity, `${what}.opacity`, 0, 1),
    onThumbnail: obj.onThumbnail,
  };
  if (obj.kind === "image") {
    if (typeof obj.file !== "string" || !ASSET_NAME_PATTERN.test(obj.file))
      throw new ValidationError(`${what}.file must be the file name returned by an upload`);
    return {
      ...base,
      kind: "image",
      file: obj.file,
      width: numberInRange(obj.width, `${what}.width`, 16, 2 * OUTPUT_SIZE.width),
    };
  }
  if (typeof obj.text !== "string" || obj.text.length < 1 || obj.text.length > WATERMARK_TEXT_LIMIT)
    throw new ValidationError(`${what}.text must be 1-${WATERMARK_TEXT_LIMIT} characters`);
  if (/[\r\n\u2028\u2029]/.test(obj.text)) throw new ValidationError(`${what}.text must be a single line`);
  const families = CAPTION_FONTS.map((font) => font.family);
  if (typeof obj.font !== "string" || !families.includes(obj.font))
    throw new ValidationError(`${what}.font must be one of ${families.join(", ")}`);
  return {
    ...base,
    kind: "text",
    text: obj.text,
    font: obj.font,
    size: numberInRange(obj.size, `${what}.size`, 8, 400),
    color: parseColor(obj.color, `${what}.color`),
    stroke: numberInRange(obj.stroke, `${what}.stroke`, 0, 40),
    strokeColor: parseColor(obj.strokeColor, `${what}.strokeColor`),
  };
}

/** Strict structure and range check of a watermark list; uploaded files are checked by `checkWatermarks`. */
function parseWatermarks(raw: unknown): Watermark[] {
  if (!Array.isArray(raw)) throw new ValidationError("watermarks must be an array");
  if (raw.length > MAX_WATERMARKS) throw new ValidationError(`At most ${MAX_WATERMARKS} watermarks are allowed`);
  const watermarks = raw.map((entry, i) => parseWatermark(entry, `watermarks[${i}]`));
  const ids = new Set<string>();
  for (const [i, watermark] of watermarks.entries()) {
    if (ids.has(watermark.id)) throw new ValidationError(`watermarks[${i}].id "${watermark.id}" is used twice`);
    ids.add(watermark.id);
  }
  return watermarks;
}

/** The part of a valid watermark list that depends on the project: every image was uploaded to it. */
function checkWatermarks(watermarks: Watermark[], project: Project): void {
  for (const wm of watermarks) {
    if (wm.kind === "image" && !existsSync(join(assetsDir(project.id), wm.file)))
      throw new ValidationError(`Watermark image ${wm.file} was not uploaded to this project`);
  }
}

const LAYOUTS: LayoutMode[] = ["split", "fill", "fit", "custom"];

export function parseSettingsPatch(raw: unknown): Partial<ClipSettings> {
  const obj = asObject(raw, "settings");
  rejectUnknownKeys(
    obj,
    ["layout", "focusX", "custom", "subtitles", "captionStyle", "captionY", "watermarks", "intro", "outro"],
    "settings",
  );
  const patch: Partial<ClipSettings> = {};
  if (obj.layout !== undefined) {
    if (!LAYOUTS.includes(obj.layout as LayoutMode))
      throw new ValidationError(`layout must be one of ${LAYOUTS.join(", ")}`);
    patch.layout = obj.layout as LayoutMode;
  }
  if (obj.focusX !== undefined) patch.focusX = numberInRange(obj.focusX, "focusX", 0, 1);
  if (obj.custom !== undefined) patch.custom = obj.custom === null ? null : parseCustomLayout(obj.custom);
  if (obj.captionY !== undefined) patch.captionY = numberInRange(obj.captionY, "captionY", 0, 1);
  if (obj.subtitles !== undefined) {
    if (typeof obj.subtitles !== "boolean") throw new ValidationError("subtitles must be true or false");
    patch.subtitles = obj.subtitles;
  }
  if (obj.captionStyle !== undefined) {
    const ids = CAPTION_STYLES.map((style) => style.id);
    if (typeof obj.captionStyle !== "string" || !ids.includes(obj.captionStyle)) {
      throw new ValidationError(`captionStyle must be one of ${ids.join(", ")}`);
    }
    patch.captionStyle = obj.captionStyle;
  }
  if (obj.watermarks !== undefined) patch.watermarks = parseWatermarks(obj.watermarks);
  for (const key of ["intro", "outro"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "string" || value === ""))
      throw new ValidationError(`settings.${key} must be a library file name or null`);
    patch[key] = value;
  }
  return patch;
}

const TIMELINE_ITEM_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TIMELINE_KINDS = ["zoom", "shake", "flash", "look", "overlay", "sound", "voice"] as const;
const ITEM_BASE_KEYS = ["id", "kind", "start", "end"];
/** Fields each kind adds to the base; everything else in an item is a typo. */
const ITEM_KEYS: Record<TimelineItem["kind"], string[]> = {
  zoom: ["scale", "x", "y", "ease"],
  shake: ["intensity"],
  flash: ["color"],
  look: ["look"],
  overlay: ["element", "animation", "overTeaser"],
  sound: ["file", "volume"],
  voice: ["preset", "volume"],
};

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${name} must be a number`);
  return value;
}

function parseTimelineItem(entry: unknown, what: string): TimelineItem {
  const obj = asObject(entry, what);
  const kind = TIMELINE_KINDS.find((candidate) => candidate === obj.kind);
  if (!kind) throw new ValidationError(`${what}.kind must be one of ${TIMELINE_KINDS.join(", ")}`);
  rejectUnknownKeys(obj, [...ITEM_BASE_KEYS, ...ITEM_KEYS[kind]], what);
  if (typeof obj.id !== "string" || !TIMELINE_ITEM_ID.test(obj.id))
    throw new ValidationError(`${what}.id must be 1-32 letters, digits, "_" or "-"`);
  const start = finiteNumber(obj.start, `${what}.start`);
  if (start < 0) throw new ValidationError(`${what}.start must be >= 0`);
  const end = finiteNumber(obj.end, `${what}.end`);
  if (end <= start) throw new ValidationError(`${what}.end must be after ${what}.start`);
  const length = end - start;
  if (length < ITEM_LIMITS.min - EPSILON || length > ITEM_LIMITS.max + EPSILON) {
    throw new ValidationError(
      `${what} is ${length.toFixed(2)}s long; items must be ${ITEM_LIMITS.min}-${ITEM_LIMITS.max}s`,
    );
  }
  const base = { id: obj.id, start, end };
  switch (kind) {
    case "zoom": {
      const scale = numberInRange(obj.scale, `${what}.scale`, ZOOM_LIMITS.min, ZOOM_LIMITS.max);
      const x = numberInRange(obj.x, `${what}.x`, 0, 1);
      const y = numberInRange(obj.y, `${what}.y`, 0, 1);
      if (obj.ease !== "punch" && obj.ease !== "smooth")
        throw new ValidationError(`${what}.ease must be "punch" or "smooth"`);
      return { ...base, kind, scale, x, y, ease: obj.ease };
    }
    case "shake":
      return { ...base, kind, intensity: numberInRange(obj.intensity, `${what}.intensity`, 0.1, 1) };
    case "flash":
      return { ...base, kind, color: parseColor(obj.color, `${what}.color`) };
    case "look": {
      if (obj.look !== "deepfry" && obj.look !== "bw" && obj.look !== "blur")
        throw new ValidationError(`${what}.look must be one of deepfry, bw, blur`);
      return { ...base, kind, look: obj.look };
    }
    case "overlay": {
      if (obj.animation !== "pop" && obj.animation !== "shake" && obj.animation !== "slide" && obj.animation !== "none")
        throw new ValidationError(`${what}.animation must be one of pop, shake, slide, none`);
      // Optional so projects and clients from before the flag keep working; anything but a boolean is a typo.
      const overTeaser = obj.overTeaser ?? false;
      if (typeof overTeaser !== "boolean") throw new ValidationError(`${what}.overTeaser must be true or false`);
      return {
        ...base,
        kind,
        element: parseWatermark(obj.element, `${what}.element`),
        overTeaser,
        animation: obj.animation,
      };
    }
    case "sound": {
      if (typeof obj.file !== "string" || obj.file === "" || obj.file.length > 120)
        throw new ValidationError(`${what}.file must be a library file name`);
      return { ...base, kind, file: obj.file, volume: numberInRange(obj.volume, `${what}.volume`, 0, 2) };
    }
    case "voice": {
      const presets = ["earrape", "bass", "chipmunk", "deep", "echo", "robot"];
      if (typeof obj.preset !== "string" || !presets.includes(obj.preset))
        throw new ValidationError(`${what}.preset must be one of ${presets.join(", ")}`);
      // Optional so clients from before voice volume keep working.
      const volume = obj.volume === undefined ? 1 : numberInRange(obj.volume, `${what}.volume`, 0, 2);
      return { ...base, kind, preset: obj.preset as VoiceItem["preset"], volume };
    }
  }
}

/** Strict syntax check of a whole timeline; library files and the clip range are checked by `checkTimeline`. */
export function parseTimeline(raw: unknown): ClipTimeline {
  const obj = asObject(raw, "timeline");
  rejectUnknownKeys(obj, ["items", "teaser"], "timeline");
  if (!Array.isArray(obj.items)) throw new ValidationError("timeline.items must be an array");
  if (obj.items.length > MAX_TIMELINE_ITEMS)
    throw new ValidationError(`At most ${MAX_TIMELINE_ITEMS} timeline items are allowed`);
  const items = obj.items.map((entry, i) => parseTimelineItem(entry, `timeline.items[${i}]`));
  const ids = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (ids.has(item.id)) throw new ValidationError(`timeline.items[${i}].id "${item.id}" is used twice`);
    ids.add(item.id);
  }
  let teaser: ClipTimeline["teaser"] = null;
  if (obj.teaser !== undefined && obj.teaser !== null) {
    const teaserObj = asObject(obj.teaser, "timeline.teaser");
    rejectUnknownKeys(teaserObj, ["start", "end"], "timeline.teaser");
    const start = finiteNumber(teaserObj.start, "timeline.teaser.start");
    const end = finiteNumber(teaserObj.end, "timeline.teaser.end");
    if (start < 0) throw new ValidationError("timeline.teaser.start must be >= 0");
    if (end <= start) throw new ValidationError("timeline.teaser.end must be after timeline.teaser.start");
    teaser = { start, end };
  }
  return { items, teaser };
}

/** Library item for a reference in a timeline or settings, or null when the file is gone or of another kind. */
function libraryItem(file: string, kind: LibraryKind): LibraryItem | null {
  let path: string;
  try {
    path = libraryPath(file);
  } catch {
    return null;
  }
  const item = libraryIndexSync().find((candidate) => candidate.file === file);
  return item && item.kind === kind && existsSync(path) ? item : null;
}

/** The part of a timeline that depends on the library and the clip: sticker/sound files exist, zooms do not overlap, teaser fits. */
function checkTimeline(timeline: ClipTimeline, clip: { start: number; end: number }): void {
  for (const [i, item] of timeline.items.entries()) {
    const what = `timeline.items[${i}]`;
    if (item.kind === "overlay" && item.element.kind === "image" && !libraryItem(item.element.file, "sticker")) {
      throw new ValidationError(`${what}.element.file ${item.element.file} is not a sticker in the library`);
    }
    if (item.kind === "sound") {
      const sound = libraryItem(item.file, "sound");
      if (!sound) throw new ValidationError(`${what}.file ${item.file} is not a sound in the library`);
      if (sound.duration === null) throw new ValidationError(`${what}.file ${item.file} has no known duration`);
      const length = item.end - item.start;
      if (length > sound.duration + 0.05) {
        throw new ValidationError(
          `${what} is ${length.toFixed(2)}s long but the sound ${sound.name} is only ${sound.duration.toFixed(2)}s`,
        );
      }
    }
  }
  const overlap = overlappingZooms(timeline.items);
  if (overlap) throw new ValidationError(`Zoom items ${overlap[0].id} and ${overlap[1].id} overlap`);
  const teaser = timeline.teaser;
  if (!teaser) return;
  if (teaser.start < clip.start - EPSILON || teaser.end > clip.end + EPSILON) {
    throw new ValidationError(
      `Teaser ${teaser.start}s-${teaser.end}s must lie inside the clip (${clip.start}s-${clip.end}s)`,
    );
  }
  const length = teaser.end - teaser.start;
  if (length < TEASER_LIMITS.min - EPSILON || length > TEASER_LIMITS.max + EPSILON) {
    throw new ValidationError(
      `Teaser is ${length.toFixed(2)}s long; it must be ${TEASER_LIMITS.min}-${TEASER_LIMITS.max}s`,
    );
  }
}

/** An intro/outro must be a library video; null clears it. */
function checkLibraryVideo(file: string | null, what: "intro" | "outro"): void {
  if (file !== null && !libraryItem(file, "video")) {
    throw new ValidationError(`settings.${what} ${file} is not a video in the library`);
  }
}

export interface ThumbnailPatch {
  time?: number | null;
  text?: string | null;
  style?: string;
  textY?: number;
}

const THUMBNAIL_TEXT_LIMIT = 120;

export function parseThumbnailPatch(raw: unknown): ThumbnailPatch {
  const obj = asObject(raw, "thumbnail");
  rejectUnknownKeys(obj, ["time", "text", "style", "textY"], "thumbnail");
  const patch: ThumbnailPatch = {};
  if ("time" in obj) {
    if (obj.time !== null && (typeof obj.time !== "number" || !Number.isFinite(obj.time))) {
      throw new ValidationError("thumbnail.time must be a number or null");
    }
    patch.time = obj.time;
  }
  if ("text" in obj) {
    if (obj.text !== null && typeof obj.text !== "string")
      throw new ValidationError("thumbnail.text must be a string or null");
    if (typeof obj.text === "string" && obj.text.length > THUMBNAIL_TEXT_LIMIT) {
      throw new ValidationError(`thumbnail.text must be at most ${THUMBNAIL_TEXT_LIMIT} characters`);
    }
    patch.text = obj.text;
  }
  if ("style" in obj) {
    const ids = THUMBNAIL_STYLES.map((style) => style.id);
    if (typeof obj.style !== "string" || !ids.includes(obj.style)) {
      throw new ValidationError(`thumbnail.style must be one of ${ids.join(", ")}`);
    }
    patch.style = obj.style;
  }
  if ("textY" in obj) patch.textY = numberInRange(obj.textY, "thumbnail.textY", 0, 1);
  return patch;
}

/** Pixel rect inside the source frame (when the frame size is known). */
export function parseRect(raw: unknown, frame: { width: number; height: number } | null): Rect {
  const obj = asObject(raw, "rect");
  rejectUnknownKeys(obj, ["x", "y", "w", "h"], "rect");
  const [x, y, w, h] = (["x", "y", "w", "h"] as const).map((key) => {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`rect.${key} must be a number`);
    return Math.round(value);
  }) as [number, number, number, number];
  if (x < 0 || y < 0 || w < 1 || h < 1) throw new ValidationError("rect needs x >= 0, y >= 0, w >= 1, h >= 1");
  if (frame && (x + w > frame.width || y + h > frame.height)) {
    throw new ValidationError(`rect ${x},${y},${w},${h} exceeds the ${frame.width}x${frame.height} source frame`);
  }
  return { x, y, w, h };
}

export interface ClipPatch {
  start?: number;
  end?: number;
  title?: string;
  selected?: boolean;
  settings?: Partial<ClipSettings>;
  thumbnail?: ThumbnailPatch;
  /** Whole replacement of the clip's editor timeline. */
  timeline?: ClipTimeline;
}

export function parseClipPatch(raw: unknown): ClipPatch {
  const obj = asObject(raw, "clip patch");
  rejectUnknownKeys(obj, ["start", "end", "title", "selected", "settings", "thumbnail", "timeline"], "clip");
  const patch: ClipPatch = {};
  for (const key of ["start", "end"] as const) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== "number" || !Number.isFinite(obj[key]))
      throw new ValidationError(`${key} must be a number`);
    patch[key] = obj[key];
  }
  if (obj.title !== undefined) {
    if (typeof obj.title !== "string" || obj.title.trim() === "" || obj.title.length > 200) {
      throw new ValidationError("title must be a non-empty string of at most 200 characters");
    }
    patch.title = obj.title.trim();
  }
  if (obj.selected !== undefined) {
    if (typeof obj.selected !== "boolean") throw new ValidationError("selected must be true or false");
    patch.selected = obj.selected;
  }
  if (obj.settings !== undefined) patch.settings = parseSettingsPatch(obj.settings);
  if (obj.thumbnail !== undefined) patch.thumbnail = parseThumbnailPatch(obj.thumbnail);
  if (obj.timeline !== undefined) patch.timeline = parseTimeline(obj.timeline);
  return patch;
}

export interface ProjectPatch {
  webcam?: { rect: Rect | null };
  defaults?: Partial<ClipSettings>;
  applyDefaultsToClips?: boolean;
}

export function parseProjectPatch(raw: unknown, frame: { width: number; height: number } | null): ProjectPatch {
  const obj = asObject(raw, "project patch");
  rejectUnknownKeys(obj, ["webcam", "defaults", "applyDefaultsToClips"], "project");
  const patch: ProjectPatch = {};
  if (obj.webcam !== undefined) {
    const webcam = asObject(obj.webcam, "webcam");
    rejectUnknownKeys(webcam, ["rect"], "webcam");
    if (!("rect" in webcam)) throw new ValidationError("webcam.rect is required (a rect or null)");
    patch.webcam = { rect: webcam.rect === null ? null : parseRect(webcam.rect, frame) };
  }
  if (obj.defaults !== undefined) patch.defaults = parseSettingsPatch(obj.defaults);
  if (obj.applyDefaultsToClips !== undefined) {
    if (typeof obj.applyDefaultsToClips !== "boolean")
      throw new ValidationError("applyDefaultsToClips must be true or false");
    patch.applyDefaultsToClips = obj.applyDefaultsToClips;
  }
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Project operations shared by the HTTP API and the CLI
// ---------------------------------------------------------------------------------------------

/** Drops the generated cover of a clip: its file joins `stale` (deleted after the write), the stored fields are unset. */
function clearGeneratedThumbnail(clip: Clip, stale: string[]): void {
  if (clip.thumbnail.file) stale.push(clip.thumbnail.file);
  delete clip.thumbnail.file;
  delete clip.thumbnail.generatedAt;
  delete clip.thumbnail.usedTime;
}

/** Output of a clip that was changed is stale: drop it, unless a render is in flight. */
function invalidateRender(clip: Clip, stale: string[]): void {
  if (isBusy(clip))
    throw new ConflictError(`Clip ${clip.id} is ${clip.render.status}; cancel the render before changing it`);
  if (clip.render.file) stale.push(clip.render.file);
  clip.render = { status: "idle", progress: 0 };
}

/**
 * A new webcam rect changes the output of every clip that uses the webcam panel (layout "split").
 * Busy clips are skipped unless `strict` (user edits refuse to touch a clip that is being rendered).
 */
function invalidateWebcamClips(project: Project, next: Webcam, stale: string[], strict: boolean): void {
  if (JSON.stringify(next.rect) === JSON.stringify(project.webcam.rect)) return;
  for (const clip of project.clips) {
    if (clip.settings.layout !== "split") continue;
    if (isBusy(clip) && !strict) continue;
    invalidateRender(clip, stale);
    clearGeneratedThumbnail(clip, stale);
  }
}

/** Settings that change the picture of the frame (not the captions). `custom` only counts while it is in use. */
const framingDiffers = (a: ClipSettings, b: ClipSettings) =>
  a.layout !== b.layout ||
  a.focusX !== b.focusX ||
  (b.layout === "custom" && JSON.stringify(a.custom) !== JSON.stringify(b.custom));

/** The watermarks painted on the cover, as comparable text. */
const coverWatermarks = (settings: Pick<ClipSettings, "watermarks">) =>
  JSON.stringify(settings.watermarks.filter((wm) => wm.onThumbnail));

/** Settings that change the cover image: the framing and the watermarks shown on it. */
const coverDiffers = (a: ClipSettings, b: ClipSettings) =>
  framingDiffers(a, b) || coverWatermarks(a) !== coverWatermarks(b);

const settingsDiffer = (a: ClipSettings, b: ClipSettings) =>
  framingDiffers(a, b) ||
  JSON.stringify(a.watermarks) !== JSON.stringify(b.watermarks) ||
  (Object.keys(b) as (keyof ClipSettings)[]).some(
    (key) => key !== "custom" && key !== "watermarks" && a[key] !== b[key],
  );

/**
 * A clip in the custom layout always stores a concrete layout: without one it starts from the
 * default (the current split) so later webcam changes do not move its elements.
 */
function concreteSettings(project: Project, settings: ClipSettings): ClipSettings {
  if (settings.layout !== "custom" || settings.custom) return settings;
  if (!project.source)
    throw new ValidationError("The source video is not downloaded yet, so the custom layout has no starting point");
  const { width, height } = project.source;
  return { ...settings, custom: defaultCustomLayout({ width, height }, project.webcam.rect, OUTPUT_SIZE) };
}

function findClip(project: Project, clipId: string): Clip {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new NotFoundError(`Clip not found: ${clipId}`);
  return clip;
}

export async function addClip(id: string, start: number, end: number, title?: string): Promise<Project> {
  return updateProject(id, (project) => {
    const clip = makeClip(project, { start, end, title: title ?? "", reason: "Added manually", score: 0 }, "manual");
    project.clips = [...project.clips, clip].sort(byStart);
  });
}

export async function removeClip(id: string, clipId: string): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    const clip = findClip(p, clipId);
    if (isBusy(clip))
      throw new ConflictError(`Clip ${clipId} is ${clip.render.status}; cancel the render before deleting it`);
    if (clip.render.file) stale.push(clip.render.file);
    clearGeneratedThumbnail(clip, stale);
    p.clips = p.clips.filter((candidate) => candidate !== clip);
  });
  await removeOutputs(id, stale);
  return project;
}

export async function patchClip(id: string, clipId: string, patch: ClipPatch): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    const clip = findClip(p, clipId);
    const start = patch.start ?? clip.start;
    const end = patch.end ?? clip.end;
    const timingChanged = start !== clip.start || end !== clip.end;
    if (patch.settings?.custom) checkCustomLayout(patch.settings.custom, p);
    if (patch.settings?.watermarks) checkWatermarks(patch.settings.watermarks, p);
    if (patch.settings?.intro !== undefined) checkLibraryVideo(patch.settings.intro, "intro");
    if (patch.settings?.outro !== undefined) checkLibraryVideo(patch.settings.outro, "outro");
    const settings = concreteSettings(p, { ...clip.settings, ...patch.settings });
    if (timingChanged) {
      if (!p.source) throw new ValidationError("The source video is not downloaded yet");
      assertClipRange(start, end, p.source.duration);
    }
    if (patch.timeline) checkTimeline(patch.timeline, { start, end });
    let timeline = patch.timeline ?? clip.timeline;
    if (patch.timeline && JSON.stringify(patch.timeline) === JSON.stringify(clip.timeline)) timeline = clip.timeline;
    // Trimming must not leave a teaser pointing outside the clip: drop it instead of refusing the trim.
    if (timingChanged && timeline.teaser) {
      const { teaser } = timeline;
      if (teaser.start < start - EPSILON || teaser.end > end + EPSILON) timeline = { ...timeline, teaser: null };
    }
    const requestedTime = patch.thumbnail?.time;
    if (requestedTime !== undefined && requestedTime !== null && (requestedTime < start || requestedTime > end)) {
      throw new ValidationError(`thumbnail.time ${requestedTime}s is outside the clip (${start}s-${end}s)`);
    }
    const thumbnail: ClipThumbnail = { ...clip.thumbnail, ...patch.thumbnail };
    if (thumbnail.time !== null && (thumbnail.time < start || thumbnail.time > end)) thumbnail.time = null;
    const thumbnailChanged =
      patch.thumbnail !== undefined &&
      (Object.keys(patch.thumbnail) as (keyof ThumbnailPatch)[]).some(
        (key) => patch.thumbnail?.[key] !== clip.thumbnail[key],
      );
    const framingChanged = timingChanged || coverDiffers(clip.settings, settings);
    // A timeline change makes the rendered file stale but not the cover image: overlays are not painted on it.
    if (timingChanged || settingsDiffer(clip.settings, settings) || timeline !== clip.timeline)
      invalidateRender(clip, stale);
    clip.start = start;
    clip.end = end;
    clip.settings = settings;
    clip.timeline = timeline;
    clip.thumbnail = thumbnail;
    // A cover without its own text shows the clip title.
    const headlineChanged = patch.title !== undefined && patch.title !== clip.title && thumbnail.text === null;
    if (framingChanged || thumbnailChanged || headlineChanged) clearGeneratedThumbnail(clip, stale);
    if (patch.title !== undefined) clip.title = patch.title;
    if (patch.selected !== undefined) clip.selected = patch.selected;
    p.clips.sort(byStart);
  });
  await removeOutputs(id, stale);
  return project;
}

/** Sets `selected` on exactly the given clips (and clears it everywhere else). */
export async function selectClips(id: string, which: string[] | "all" | "none"): Promise<Project> {
  return updateProject(id, (p) => {
    if (Array.isArray(which)) for (const clipId of which) findClip(p, clipId);
    for (const clip of p.clips) clip.selected = which === "all" || (Array.isArray(which) && which.includes(clip.id));
  });
}

/**
 * Applies a settings patch. `target` null = project defaults only, "all" = defaults and every clip,
 * a list = just those clips.
 */
export async function updateSettings(
  id: string,
  patch: Partial<ClipSettings>,
  target: string[] | "all" | null,
): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    if (patch.custom) checkCustomLayout(patch.custom, p);
    if (patch.watermarks) checkWatermarks(patch.watermarks, p);
    if (patch.intro !== undefined) checkLibraryVideo(patch.intro, "intro");
    if (patch.outro !== undefined) checkLibraryVideo(patch.outro, "outro");
    const clips = target === null ? [] : target === "all" ? p.clips : target.map((clipId) => findClip(p, clipId));
    if (target === null || target === "all") p.defaults = { ...p.defaults, ...patch };
    for (const clip of clips) {
      const settings = concreteSettings(p, { ...clip.settings, ...patch });
      if (!settingsDiffer(clip.settings, settings)) continue;
      invalidateRender(clip, stale);
      if (coverDiffers(clip.settings, settings)) clearGeneratedThumbnail(clip, stale);
      clip.settings = settings;
    }
  });
  await removeOutputs(id, stale);
  return project;
}

export async function patchProject(id: string, patch: ProjectPatch): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    if (patch.defaults) {
      if (patch.defaults.custom) checkCustomLayout(patch.defaults.custom, p);
      if (patch.defaults.watermarks) checkWatermarks(patch.defaults.watermarks, p);
      if (patch.defaults.intro !== undefined) checkLibraryVideo(patch.defaults.intro, "intro");
      if (patch.defaults.outro !== undefined) checkLibraryVideo(patch.defaults.outro, "outro");
      p.defaults = { ...p.defaults, ...patch.defaults };
    }
    if (patch.webcam) {
      const { rect } = patch.webcam;
      const next = rect
        ? { rect, confidence: 1, source: "manual" as const }
        : { rect: null, confidence: 0, source: "none" as const };
      invalidateWebcamClips(p, next, stale, true);
      p.webcam = next;
    }
    if (patch.applyDefaultsToClips) {
      for (const clip of p.clips) {
        const settings = concreteSettings(p, { ...p.defaults });
        if (!settingsDiffer(clip.settings, settings)) continue;
        invalidateRender(clip, stale);
        if (coverDiffers(clip.settings, settings)) clearGeneratedThumbnail(clip, stale);
        clip.settings = settings;
      }
    }
  });
  await removeOutputs(id, stale);
  return project;
}

/** Clears the stage states from `from` (or from the first stage that is not done) onward back to pending. */
export function resetStages(project: Project, from?: StageId): void {
  const firstOpen = STAGE_ORDER.findIndex((stage) => project.stages[stage].status !== "done");
  const begin = from
    ? Math.min(firstOpen === -1 ? STAGE_ORDER.length : firstOpen, STAGE_ORDER.indexOf(from))
    : firstOpen;
  if (begin === -1) return;
  for (const stage of STAGE_ORDER.slice(begin)) project.stages[stage] = { status: "pending", progress: 0 };
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

export interface PipelineOptions {
  from?: StageId;
  skipHighlights?: boolean;
}

type Report = (progress: number, message?: string) => void;

interface StageContext {
  project: Project;
  paths: ProjectPaths;
  opts: PipelineOptions;
  report: Report;
  signal: AbortSignal | undefined;
}

interface StageResult {
  message?: string;
  /** Applied to the fresh project together with the "done" status; returns output files that are now stale. */
  commit?: (project: Project) => (string | undefined)[] | void;
}

function requireSource(project: Project): SourceMeta {
  if (!project.source) throw new Error("The source video is missing; re-run the pipeline from the download stage");
  return project.source;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`The ${what} is missing; re-run the pipeline from the transcribe stage`);
  return (await file.json()) as T;
}

const STAGES: Record<StageId, (ctx: StageContext) => Promise<StageResult>> = {
  async download({ project, paths, report, signal }) {
    const source = await fetchSource(project.input, paths.dir, report, signal);
    return {
      message: source.title,
      commit(p) {
        p.source = source;
      },
    };
  },

  async transcribe({ project, paths, report, signal }) {
    const source = requireSource(project);
    if (!(await probeMedia(paths.source)).hasAudio) {
      const empty: Transcript = { language: "", model: "", segments: [] };
      const silence: LoudnessEnvelope = { step: 0.5, rms: [] };
      await Bun.write(paths.transcript, JSON.stringify(empty));
      await Bun.write(paths.loudness, JSON.stringify(silence));
      return {
        message: "no audio track",
        commit(p) {
          replaceWarnings(
            p,
            [WARNING_PREFIX.transcribe, WARNING_PREFIX.render],
            [
              `${WARNING_PREFIX.transcribe}The video has no audio track: no transcript, and highlights cannot use speech or loudness`,
            ],
          );
        },
      };
    }
    report(0, "Extracting audio");
    await extractAudio(paths.source, paths.audio, signal);
    const transcript = await transcribe(
      paths.audio,
      { language: project.options.language, duration: source.duration },
      (progress, message) => report(0.03 + 0.92 * progress, message ?? "Transcribing"),
      signal,
    );
    report(0.95, "Measuring loudness");
    const loudness = await loudnessEnvelope(paths.audio);
    await Bun.write(paths.transcript, JSON.stringify(transcript));
    await Bun.write(paths.loudness, JSON.stringify(loudness));
    const words = transcript.segments.reduce((sum, segment) => sum + segment.words.length, 0);
    return {
      message: `${words} words, language ${transcript.language}`,
      commit(p) {
        replaceWarnings(p, [WARNING_PREFIX.transcribe, WARNING_PREFIX.render], []);
      },
    };
  },

  async highlights({ project, paths, opts, report, signal }) {
    if (opts.skipHighlights) return { message: "skipped" };
    const source = requireSource(project);
    const transcript = await readJson<Transcript>(paths.transcript, "transcript");
    const loudness = await readJson<LoudnessEnvelope>(paths.loudness, "loudness envelope");
    const result = await findHighlights(
      { transcript, loudness, duration: source.duration, title: source.title, options: project.options },
      (progress) => report(progress),
      signal,
    );
    const warnings = result.warnings.map((warning) => WARNING_PREFIX.highlights + warning);
    const picks: ClipFields[] = [];
    for (const candidate of result.candidates) {
      const pick = { ...candidate, start: Math.max(0, candidate.start), end: Math.min(source.duration, candidate.end) };
      try {
        assertClipRange(pick.start, pick.end, source.duration);
        picks.push(pick);
      } catch (error) {
        warnings.push(
          `${WARNING_PREFIX.highlights}Skipped highlight "${candidate.title}": ${(error as Error).message}`,
        );
      }
    }
    return {
      message: `${picks.length} clips (${result.engine}${result.requestedClips === null ? ", auto" : ""})`,
      commit(p) {
        const removed = replaceGeneratedClips(p, picks, result.engine);
        p.highlightEngine = result.engine;
        replaceWarnings(p, [WARNING_PREFIX.highlights], warnings);
        return removed.flatMap((clip) => [clip.render.file, clip.thumbnail.file]);
      },
    };
  },

  async webcam({ project, paths, opts, report, signal }) {
    if (project.webcam.source !== "auto" && opts.from !== "webcam") {
      return { message: project.webcam.source === "manual" ? "kept manual rect" : "kept: no webcam" };
    }
    const webcam = await detectWebcam(paths.source, requireSource(project), report, signal);
    return {
      message: webcam.rect ? `webcam found (${Math.round(webcam.confidence * 100)}%)` : "no webcam found",
      commit(p) {
        const stale: string[] = [];
        invalidateWebcamClips(p, webcam, stale, false);
        p.webcam = webcam;
        return stale;
      },
    };
  },
};

async function runStage(id: string, stage: StageId, opts: PipelineOptions, signal?: AbortSignal): Promise<void> {
  const project = await updateProject(id, (p) => {
    p.stages[stage] = { status: "running", progress: 0 };
  });
  const push = throttledUpdater(id);
  const report: Report = (progress, message) =>
    push((p) => {
      const state = p.stages[stage];
      state.progress = Math.min(1, Math.max(0, progress));
      if (message !== undefined) state.message = message;
    });
  let dropped: (string | undefined)[] = [];
  try {
    const result = await STAGES[stage]({ project, paths: projectPaths(id), opts, report, signal });
    await push.flush();
    await updateProject(id, (p) => {
      p.stages[stage] = { status: "done", progress: 1, ...(result.message ? { message: result.message } : {}) };
      dropped = result.commit?.(p) ?? [];
    });
  } catch (error) {
    await push.flush();
    const aborted = signal?.aborted ?? false;
    const message = error instanceof Error ? error.message : String(error);
    // If the project is gone (deleted while running) the original error is the one worth reporting.
    await updateProject(id, (p) => {
      p.stages[stage] = aborted
        ? { status: "pending", progress: 0 }
        : { status: "error", progress: p.stages[stage].progress, error: message };
    }).catch(() => {});
    throw aborted ? signal?.reason : error;
  }
  await removeOutputs(id, dropped);
}

/**
 * Runs the stages in STAGE_ORDER, starting at the first stage that is not done (or at `opts.from`, whichever
 * is earlier; that stage and everything after it is reset first).
 */
export async function runPipeline(id: string, opts: PipelineOptions = {}, signal?: AbortSignal): Promise<Project> {
  const release = await markBusy(id);
  try {
    const project = await updateProject(id, (p) => resetStages(p, opts.from));
    const begin = STAGE_ORDER.findIndex((stage) => project.stages[stage].status !== "done");
    if (begin === -1) return project;
    for (const stage of STAGE_ORDER.slice(begin)) {
      signal?.throwIfAborted();
      await runStage(id, stage, opts, signal);
    }
    return await updateProject(id, () => {});
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Lowercase ASCII slug of a clip title, shared by the rendered short and its cover image file names. */
function clipSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function clipFileName(clip: Clip): string {
  return `${clip.id}-${clipSlug(clip.title) || "clip"}.mp4`;
}

function thumbnailFileName(clip: Clip): string {
  return `${clip.id}-${clipSlug(clip.title) || "clip"}.jpg`;
}

export async function renderProjectClip(id: string, clipId: string, signal?: AbortSignal): Promise<Project> {
  const release = await markBusy(id);
  try {
    return await renderClipUnmarked(id, clipId, signal);
  } finally {
    await release();
  }
}

async function renderClipUnmarked(id: string, clipId: string, signal?: AbortSignal): Promise<Project> {
  const paths = projectPaths(id);
  let oldFile: string | undefined;
  const started = await updateProject(id, (p) => {
    const clip = findClip(p, clipId);
    oldFile = clip.render.file;
    clip.render = { status: "rendering", progress: 0 };
  });
  const clip = findClip(started, clipId);
  const fileName = clipFileName(clip);
  const outPath = join(paths.clipsDir, fileName);
  const push = throttledUpdater(id);
  try {
    const source = requireSource(started);
    if (oldFile && oldFile !== fileName) await removeOutputs(id, [oldFile]);

    let words: Word[] = [];
    let missingTranscript = false;
    if (clip.settings.subtitles) {
      const transcript = Bun.file(paths.transcript);
      if (await transcript.exists()) {
        words = ((await transcript.json()) as Transcript).segments.flatMap((segment) => segment.words);
      } else {
        missingTranscript = true;
      }
    }

    await renderClip(
      {
        sourcePath: paths.source,
        source: { width: source.width, height: source.height, fps: source.fps, duration: source.duration },
        start: clip.start,
        end: clip.end,
        settings: clip.settings,
        webcam: started.webcam.rect,
        words,
        timeline: clip.timeline,
        libraryDir: LIBRARY_DIR,
        outPath,
        assetsDir: assetsDir(id),
      },
      (progress) =>
        push((p) => {
          const target = p.clips.find((candidate) => candidate.id === clipId);
          if (target?.render.status === "rendering") target.render.progress = Math.min(1, Math.max(0, progress));
        }),
      signal,
    );
    await push.flush();
    let orphaned = false;
    const done = await updateProject(id, (p) => {
      const target = p.clips.find((candidate) => candidate.id === clipId);
      if (!target) {
        orphaned = true;
        return;
      }
      target.render = { status: "done", progress: 1, file: fileName, renderedAt: new Date().toISOString() };
      if (missingTranscript) {
        replaceWarnings(p, [], [`${WARNING_PREFIX.render}Transcript missing: a clip was rendered without captions`]);
      }
    });
    if (orphaned) await rm(outPath, { force: true });
    const target = done.clips.find((candidate) => candidate.id === clipId);
    if (!target || target.thumbnail.file) return done;
    return (await addThumbnailAfterRender(id, clipId, signal)) ?? done;
  } catch (error) {
    await push.flush();
    const aborted = signal?.aborted ?? false;
    const message = error instanceof Error ? error.message : String(error);
    await rm(outPath, { force: true });
    // If the project or clip is gone, the original error is the one worth reporting.
    await updateProject(id, (p) => {
      const target = p.clips.find((candidate) => candidate.id === clipId);
      if (target)
        target.render = aborted ? { status: "idle", progress: 0 } : { status: "error", progress: 0, error: message };
    }).catch(() => {});
    throw aborted ? signal?.reason : error;
  }
}

// ---------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------

const CANDIDATE_COUNT = 6;

/** Good cover frames per clip; keyed by everything that changes the suggestion. */
const candidateCache = new Map<string, ThumbnailCandidate[]>();

function candidateKey(project: Project, clip: Clip): string {
  return [project.id, clip.id, clip.start, clip.end, JSON.stringify(project.webcam.rect)].join("|");
}

/** Forgets the cached suggestions of a project's clips (called when the project is deleted). */
export function forgetThumbnailCandidates(projectId: string): void {
  for (const key of candidateCache.keys()) if (key.startsWith(`${projectId}|`)) candidateCache.delete(key);
}

async function resolveCandidates(project: Project, clip: Clip, signal?: AbortSignal): Promise<ThumbnailCandidate[]> {
  const key = candidateKey(project, clip);
  const cached = candidateCache.get(key);
  if (cached) return cached;
  if (!project.source) throw new ConflictError("The source video is not downloaded yet");
  const paths = projectPaths(project.id);
  const loudnessFile = Bun.file(paths.loudness);
  const loudness = (await loudnessFile.exists()) ? ((await loudnessFile.json()) as LoudnessEnvelope) : null;
  const candidates = await suggestThumbnailTimes(
    {
      sourcePath: paths.source,
      source: { width: project.source.width, height: project.source.height, duration: project.source.duration },
      start: clip.start,
      end: clip.end,
      webcam: project.webcam.rect,
      loudness,
    },
    CANDIDATE_COUNT,
    signal,
  );
  candidateCache.set(key, candidates);
  return candidates;
}

export async function thumbnailCandidates(
  id: string,
  clipId: string,
  signal?: AbortSignal,
): Promise<ThumbnailCandidate[]> {
  const project = await getProject(id);
  return resolveCandidates(project, findClip(project, clipId), signal);
}

/** Writes the cover image of one clip now (about a second) and stores its file name, time and timestamp. */
export async function generateThumbnail(id: string, clipId: string, signal?: AbortSignal): Promise<Project> {
  const release = await markBusy(id);
  try {
    return await generateThumbnailUnmarked(id, clipId, signal);
  } finally {
    await release();
  }
}

async function generateThumbnailUnmarked(id: string, clipId: string, signal?: AbortSignal): Promise<Project> {
  const paths = projectPaths(id);
  const project = await getProject(id);
  const clip = findClip(project, clipId);
  const { source } = project;
  if (!source) throw new ConflictError("The source video is not downloaded yet");
  const time =
    clip.thumbnail.time ??
    (await resolveCandidates(project, clip, signal))[0]?.time ??
    clampFrameTime((clip.start + clip.end) / 2, source.duration);
  const rendered = {
    start: clip.start,
    end: clip.end,
    layout: clip.settings.layout,
    focusX: clip.settings.focusX,
    custom: JSON.stringify(clip.settings.custom),
    watermarks: coverWatermarks(clip.settings),
    thumbnail: JSON.stringify(clip.thumbnail),
  };
  const fileName = thumbnailFileName(clip);
  const outPath = join(paths.clipsDir, fileName);
  await mkdir(paths.clipsDir, { recursive: true });
  await renderThumbnail(
    {
      sourcePath: paths.source,
      source: { width: source.width, height: source.height },
      time,
      settings: {
        layout: clip.settings.layout,
        focusX: clip.settings.focusX,
        custom: clip.settings.custom,
        watermarks: clip.settings.watermarks,
      },
      webcam: project.webcam.rect,
      text: clip.thumbnail.text ?? clip.title,
      style: clip.thumbnail.style,
      textY: clip.thumbnail.textY,
      outPath,
      assetsDir: assetsDir(id),
    },
    signal,
  );

  let staleFile: string | undefined;
  let updated: Project;
  try {
    updated = await updateProject(id, (p) => {
      const target = p.clips.find((candidate) => candidate.id === clipId);
      if (!target) return;
      // Someone edited the clip while the frame was rendering: the image no longer matches the clip.
      const unchanged =
        target.start === rendered.start &&
        target.end === rendered.end &&
        target.settings.layout === rendered.layout &&
        target.settings.focusX === rendered.focusX &&
        JSON.stringify(target.settings.custom) === rendered.custom &&
        coverWatermarks(target.settings) === rendered.watermarks &&
        JSON.stringify(target.thumbnail) === rendered.thumbnail;
      if (!unchanged) return;
      if (target.thumbnail.file && target.thumbnail.file !== fileName) staleFile = target.thumbnail.file;
      target.thumbnail = { ...target.thumbnail, file: fileName, generatedAt: new Date().toISOString(), usedTime: time };
      replaceThumbnailWarning(p, clipId, null);
    });
  } catch (error) {
    await rm(outPath, { force: true });
    throw error;
  }

  const current = updated.clips.find((candidate) => candidate.id === clipId);
  // Unless the stored thumbnail points at this very file (a concurrent run of ours), it is an orphan.
  if (current?.thumbnail.file !== fileName) await rm(outPath, { force: true });
  if (staleFile && staleFile !== fileName) await removeOutputs(id, [staleFile]);
  return updated;
}

/**
 * Generates the cover of a freshly rendered clip when it has none. A failure only adds a warning: the render
 * itself already succeeded and must stay "done".
 */
async function addThumbnailAfterRender(id: string, clipId: string, signal?: AbortSignal): Promise<Project | null> {
  try {
    return await generateThumbnailUnmarked(id, clipId, signal);
  } catch (error) {
    if (signal?.aborted) return null;
    const message = error instanceof Error ? error.message : String(error);
    return await updateProject(id, (p) => replaceThumbnailWarning(p, clipId, message)).catch(() => null);
  }
}
