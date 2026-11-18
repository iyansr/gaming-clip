import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { LIBRARY_LIMITS, LIBRARY_TYPES } from "../shared/library";
import type { Clip, LibraryItem, LibraryKind } from "../shared/types";
import { BIN, LIBRARY_DIR } from "./config";
import { run } from "./exec";
import { ConflictError, listProjects, NotFoundError, PayloadTooLargeError, ValidationError } from "./store";

/**
 * Container the bytes really are, from their magic number. Several content types share one container
 * (audio/mp4, video/mp4 and video/quicktime are all ISO-BMFF).
 */
type Container = "mp3" | "wav" | "ogg" | "mp4" | "webm" | "png" | "jpeg" | "webp";

/** Which containers each stored extension may hold; a WAV renamed .mp3 is rejected. */
const EXT_CONTAINERS: Record<string, Container[]> = {
  ".mp3": ["mp3"],
  ".wav": ["wav"],
  ".ogg": ["ogg"],
  ".m4a": ["mp4"],
  ".mp4": ["mp4"],
  ".mov": ["mp4"],
  ".webm": ["webm"],
  ".png": ["png"],
  ".jpg": ["jpeg"],
  ".webp": ["webp"],
};

const EXTENSIONS = [...new Set(Object.values(LIBRARY_TYPES).map((type) => type.ext.slice(1)))];
/** What an upload generates: 32 hex digits and a known media extension. */
const FILE_PATTERN = new RegExp(`^[0-9a-f]{32}\\.(${EXTENSIONS.join("|")})$`);

const INDEX_FILE = join(LIBRARY_DIR, "library.json");
const EPSILON = 1e-6;

const starts = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

function tag(bytes: Uint8Array, text: string, offset = 0): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** The container the upload really is (by magic number), whatever its Content-Type claims. */
function sniffContainer(bytes: Uint8Array): Container | null {
  // MP3: an ID3 tag or a frame sync (11 set bits).
  if (tag(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
  if (tag(bytes, "RIFF") && tag(bytes, "WAVE", 8)) return "wav";
  if (tag(bytes, "OggS")) return "ogg";
  if (tag(bytes, "ftyp", 4)) return "mp4";
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (tag(bytes, "RIFF") && tag(bytes, "WEBP", 8)) return "webp";
  return null;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

/** ffprobe never sees the .partial suffix's meaning: it sniffs the content. */
async function probe(path: string): Promise<ProbeResult> {
  try {
    const { stdout } = await run(BIN.ffprobe, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ]);
    return JSON.parse(stdout) as ProbeResult;
  } catch (error) {
    throw new ValidationError(
      `The file cannot be read by ffprobe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Duration, width and height of the uploaded file; enforced against LIBRARY_LIMITS. */
async function probeUpload(
  path: string,
  kind: LibraryKind,
): Promise<Pick<LibraryItem, "duration" | "width" | "height">> {
  const json = await probe(path);
  const streams = json.streams ?? [];
  if (kind === "sticker") {
    const image = streams.find((stream) => stream.codec_type === "video" && stream.width && stream.height);
    if (!image?.width || !image.height) throw new ValidationError("The sticker has no readable size");
    return { duration: null, width: image.width, height: image.height };
  }
  const seconds = Number(json.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ValidationError(`The ${kind} has no readable duration`);
  const limit = LIBRARY_LIMITS.duration[kind];
  if (seconds > limit + EPSILON) {
    throw new ValidationError(`The ${kind} is ${seconds.toFixed(1)}s long; the maximum is ${limit}s`);
  }
  const video = streams.find((stream) => stream.codec_type === "video");
  if (kind === "sound") {
    if (!streams.some((stream) => stream.codec_type === "audio"))
      throw new ValidationError("The sound has no audio track");
    return { duration: seconds, width: null, height: null };
  }
  if (!video?.width || !video.height) throw new ValidationError("The video has no video track");
  return { duration: seconds, width: video.width, height: video.height };
}

function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function assertName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("name must be a string");
  const name = normalizeName(raw);
  if (name === "" || name.length > LIBRARY_LIMITS.nameLength) {
    throw new ValidationError(`name must be 1-${LIBRARY_LIMITS.nameLength} characters`);
  }
  return name;
}

function parseIndex(text: string): LibraryItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is LibraryItem => {
    if (typeof item !== "object" || item === null) return false;
    const entry = item as Partial<LibraryItem>;
    return (
      typeof entry.file === "string" &&
      FILE_PATTERN.test(entry.file) &&
      (entry.kind === "sound" || entry.kind === "sticker" || entry.kind === "video") &&
      typeof entry.name === "string" &&
      typeof entry.addedAt === "string"
    );
  });
}

async function readIndex(): Promise<LibraryItem[]> {
  try {
    return parseIndex(await readFile(INDEX_FILE, "utf8"));
  } catch {
    return [];
  }
}

/** Index as it is on disk right now; used by project mutations, which must not await. */
export function libraryIndexSync(): LibraryItem[] {
  try {
    return parseIndex(readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return [];
  }
}

/** Index writes are serialised inside this process so two uploads cannot drop each other's entry. */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function writeIndex(items: LibraryItem[]): Promise<void> {
  await mkdir(LIBRARY_DIR, { recursive: true });
  const temp = `${INDEX_FILE}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Bun.write(temp, JSON.stringify(items, null, 2));
  await rename(temp, INDEX_FILE);
}

/** Absolute path of a library file; rejects any name the upload did not generate (no traversal). */
export function libraryPath(file: string): string {
  if (!FILE_PATTERN.test(file)) throw new NotFoundError(`Library file not found: ${file}`);
  return join(LIBRARY_DIR, file);
}

/**
 * Newest first (the index stores newest first); entries whose file disappeared are dropped
 * because they cannot be used or served anyway.
 */
export async function listLibrary(): Promise<LibraryItem[]> {
  const items = await readIndex();
  const present = await Promise.all(
    items.map(async (item) => ((await stat(libraryPath(item.file)).catch(() => null)) ? item : null)),
  );
  return present.filter((item): item is LibraryItem => item !== null);
}

export async function getLibraryItem(file: string): Promise<LibraryItem | null> {
  if (!FILE_PATTERN.test(file)) return null;
  const item = (await readIndex()).find((candidate) => candidate.file === file);
  if (!item) return null;
  return (await stat(libraryPath(file)).catch(() => null)) ? item : null;
}

async function requireItem(file: string): Promise<LibraryItem> {
  const item = await getLibraryItem(file);
  if (!item) throw new NotFoundError(`Library file not found: ${file}`);
  return item;
}

/**
 * Validates and stores an upload under a random name, then adds it to the index. `name` is the user-facing
 * label; an empty one becomes a generic kind name. Returns the stored item.
 */
export async function addLibraryItem(bytes: Uint8Array, contentType: string, name: string): Promise<LibraryItem> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const entry = LIBRARY_TYPES[type];
  if (!entry) throw new ValidationError(`Content-Type must be one of ${Object.keys(LIBRARY_TYPES).join(", ")}`);
  if (bytes.length === 0) throw new ValidationError("The upload is empty");
  const limit = LIBRARY_LIMITS.bytes[entry.kind];
  if (bytes.length > limit) {
    throw new PayloadTooLargeError(`The upload is larger than ${Math.round(limit / 1024 / 1024)} MB`);
  }
  const container = sniffContainer(bytes);
  if (!container || !EXT_CONTAINERS[entry.ext]?.includes(container)) {
    throw new ValidationError(`The file is not a ${type} file`);
  }
  const fallback = entry.kind === "sound" ? "Sound" : entry.kind === "sticker" ? "Sticker" : "Video";
  const label = normalizeName(name) === "" ? fallback : assertName(name);
  const file = `${crypto.randomUUID().replaceAll("-", "")}${entry.ext}`;
  await mkdir(LIBRARY_DIR, { recursive: true });
  const partial = join(LIBRARY_DIR, `.${file}.partial`);
  try {
    await Bun.write(partial, bytes);
    const media = await probeUpload(partial, entry.kind);
    await rename(partial, join(LIBRARY_DIR, file));
    const item: LibraryItem = { file, kind: entry.kind, name: label, ...media, addedAt: new Date().toISOString() };
    try {
      await serialized(async () => {
        await writeIndex([item, ...(await readIndex())]);
      });
    } catch (error) {
      // The file is published but the index cannot name it: drop the file so the library stays consistent.
      await rm(join(LIBRARY_DIR, file), { force: true });
      throw error;
    }
    return item;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export async function renameLibraryItem(file: string, name: string): Promise<LibraryItem> {
  const item = await requireItem(file);
  const label = assertName(name);
  const renamed: LibraryItem = { ...item, name: label };
  await serialized(async () => {
    const items = await readIndex();
    await writeIndex(items.map((candidate) => (candidate.file === file ? renamed : candidate)));
  });
  return renamed;
}

/** Every clip that would break if `file` disappeared: timeline overlays/sounds, intro/outro. */
function clipUsesLibraryFile(clip: Clip, file: string): boolean {
  if (clip.settings.intro === file || clip.settings.outro === file) return true;
  return clip.timeline.items.some(
    (item) =>
      (item.kind === "sound" && item.file === file) ||
      (item.kind === "overlay" && item.element.kind === "image" && item.element.file === file),
  );
}

function usageMessage(file: string, clipIds: string[], projects: string[]): string {
  const parts: string[] = [];
  if (clipIds.length > 0) {
    const plural = clipIds.length === 1 ? "" : "s";
    parts.push(`${clipIds.length} clip${plural} (${clipIds.join(", ")})`);
  }
  if (projects.length > 0) {
    const plural = projects.length === 1 ? "" : "s";
    parts.push(`the defaults of ${projects.length} project${plural}`);
  }
  return `Cannot remove ${file}: it is used by ${parts.join(" and ")}`;
}

/** Deletes an unused upload. A file named by any clip (timeline, intro, outro) or project defaults is refused. */
export async function removeLibraryItem(file: string): Promise<void> {
  const item = await requireItem(file);
  const clipIds: string[] = [];
  const projects: string[] = [];
  for (const project of await listProjects()) {
    if (project.defaults.intro === item.file || project.defaults.outro === item.file) projects.push(project.id);
    for (const clip of project.clips) if (clipUsesLibraryFile(clip, item.file)) clipIds.push(clip.id);
  }
  if (clipIds.length > 0 || projects.length > 0) throw new ConflictError(usageMessage(item.file, clipIds, projects));
  await serialized(async () => {
    const items = await readIndex();
    await writeIndex(items.filter((candidate) => candidate.file !== item.file));
  });
  await rm(libraryPath(item.file), { force: true });
}
