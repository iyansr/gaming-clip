import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CAPTION_STYLES } from "../shared/captions";
import {
  DEFAULT_OPTIONS,
  STAGE_ORDER,
  type Clip,
  type ClipSettings,
  type ClipSource,
  type LayoutMode,
  type Project,
  type ProjectOptions,
  type Rect,
  type SourceMeta,
  type StageId,
  type Transcript,
  type LoudnessEnvelope,
  type Webcam,
  type Word,
} from "../shared/types";
import { projectPaths, type ProjectPaths } from "./config";
import { loudnessEnvelope } from "./audio";
import { fetchSource, probeMedia } from "./download";
import { findHighlights } from "./highlights";
import { renderClip } from "./render";
import {
  ConflictError,
  markBusy,
  newClipId,
  NotFoundError,
  throttledUpdater,
  updateProject,
  ValidationError,
} from "./store";
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
    settings: { ...project.defaults },
    render: { status: "idle", progress: 0 },
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
export const WARNING_PREFIX = { transcribe: "Transcript: ", highlights: "Highlights: ", render: "Render: " } as const;

function replaceWarnings(project: Project, prefixes: string[], warnings: string[]): void {
  const kept = project.warnings.filter((warning) => !prefixes.some((prefix) => warning.startsWith(prefix)));
  for (const warning of warnings) if (!kept.includes(warning)) kept.push(warning);
  project.warnings = kept;
}

const byStart = (a: Clip, b: Clip) => a.start - b.start;

const isBusy = (clip: Clip) => clip.render.status === "queued" || clip.render.status === "rendering";

/**
 * Replaces every clip whose source is not "manual" with clips built from `picks`. Throws before changing
 * anything when a pick is invalid. Engine picks get the top half by score selected (at least one).
 * Returns the removed clips so the caller can delete their output files.
 */
export function replaceGeneratedClips(project: Project, picks: ClipFields[], source: "heuristic" | "llm" | "agent"): Clip[] {
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
    files.filter((file): file is string => Boolean(file)).map((file) => rm(join(clipsDir, basename(file)), { force: true })),
  );
}

// ---------------------------------------------------------------------------------------------
// Input parsing (shared by the HTTP API and the CLI)
// ---------------------------------------------------------------------------------------------

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError(`${what} must be an object`);
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ValidationError(`Unknown ${what} field "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

function numberInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/** Validates partial options on top of `base` and returns the full merged options. */
export function parseOptions(raw: unknown, base: ProjectOptions = DEFAULT_OPTIONS): ProjectOptions {
  const obj = asObject(raw, "options");
  rejectUnknownKeys(obj, ["language", "clipCount", "minDuration", "maxDuration"], "option");
  const merged = { ...base, ...obj } as ProjectOptions;
  if (typeof merged.language !== "string" || !/^(auto|[a-z]{2,3})$/.test(merged.language)) {
    throw new ValidationError(`language must be "auto" or a language code like "en"`);
  }
  if (!Number.isInteger(merged.clipCount) || merged.clipCount < 1 || merged.clipCount > 50) {
    throw new ValidationError("clipCount must be an integer between 1 and 50");
  }
  numberInRange(merged.minDuration, "minDuration", MIN_CLIP_SECONDS, MAX_CLIP_SECONDS);
  numberInRange(merged.maxDuration, "maxDuration", MIN_CLIP_SECONDS, MAX_CLIP_SECONDS);
  if (merged.minDuration > merged.maxDuration) throw new ValidationError("minDuration must not exceed maxDuration");
  return merged;
}

const LAYOUTS: LayoutMode[] = ["split", "fill", "fit"];

export function parseSettingsPatch(raw: unknown): Partial<ClipSettings> {
  const obj = asObject(raw, "settings");
  rejectUnknownKeys(obj, ["layout", "focusX", "subtitles", "captionStyle", "captionY"], "settings");
  const patch: Partial<ClipSettings> = {};
  if (obj.layout !== undefined) {
    if (!LAYOUTS.includes(obj.layout as LayoutMode)) throw new ValidationError(`layout must be one of ${LAYOUTS.join(", ")}`);
    patch.layout = obj.layout as LayoutMode;
  }
  if (obj.focusX !== undefined) patch.focusX = numberInRange(obj.focusX, "focusX", 0, 1);
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
}

export function parseClipPatch(raw: unknown): ClipPatch {
  const obj = asObject(raw, "clip patch");
  rejectUnknownKeys(obj, ["start", "end", "title", "selected", "settings"], "clip");
  const patch: ClipPatch = {};
  for (const key of ["start", "end"] as const) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== "number" || !Number.isFinite(obj[key])) throw new ValidationError(`${key} must be a number`);
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
    if (typeof obj.applyDefaultsToClips !== "boolean") throw new ValidationError("applyDefaultsToClips must be true or false");
    patch.applyDefaultsToClips = obj.applyDefaultsToClips;
  }
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Project operations shared by the HTTP API and the CLI
// ---------------------------------------------------------------------------------------------

/** Output of a clip that was changed is stale: drop it, unless a render is in flight. */
function invalidateRender(clip: Clip, stale: string[]): void {
  if (isBusy(clip)) throw new ConflictError(`Clip ${clip.id} is ${clip.render.status}; cancel the render before changing it`);
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
  }
}

const settingsDiffer = (a: ClipSettings, b: ClipSettings) =>
  (Object.keys(b) as (keyof ClipSettings)[]).some((key) => a[key] !== b[key]);

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
    if (isBusy(clip)) throw new ConflictError(`Clip ${clipId} is ${clip.render.status}; cancel the render before deleting it`);
    if (clip.render.file) stale.push(clip.render.file);
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
    const settings = { ...clip.settings, ...patch.settings };
    if (timingChanged) {
      if (!p.source) throw new ValidationError("The source video is not downloaded yet");
      assertClipRange(start, end, p.source.duration);
    }
    if (timingChanged || settingsDiffer(clip.settings, settings)) invalidateRender(clip, stale);
    clip.start = start;
    clip.end = end;
    clip.settings = settings;
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
export async function updateSettings(id: string, patch: Partial<ClipSettings>, target: string[] | "all" | null): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    const clips = target === null ? [] : target === "all" ? p.clips : target.map((clipId) => findClip(p, clipId));
    if (target === null || target === "all") p.defaults = { ...p.defaults, ...patch };
    for (const clip of clips) {
      const settings = { ...clip.settings, ...patch };
      if (!settingsDiffer(clip.settings, settings)) continue;
      invalidateRender(clip, stale);
      clip.settings = settings;
    }
  });
  await removeOutputs(id, stale);
  return project;
}

export async function patchProject(id: string, patch: ProjectPatch): Promise<Project> {
  const stale: string[] = [];
  const project = await updateProject(id, (p) => {
    if (patch.defaults) p.defaults = { ...p.defaults, ...patch.defaults };
    if (patch.webcam) {
      const { rect } = patch.webcam;
      const next = rect ? { rect, confidence: 1, source: "manual" as const } : { rect: null, confidence: 0, source: "none" as const };
      invalidateWebcamClips(p, next, stale, true);
      p.webcam = next;
    }
    if (patch.applyDefaultsToClips) {
      for (const clip of p.clips) {
        if (!settingsDiffer(clip.settings, p.defaults)) continue;
        invalidateRender(clip, stale);
        clip.settings = { ...p.defaults };
      }
    }
  });
  await removeOutputs(id, stale);
  return project;
}

/** Clears the stage states from `from` (or from the first stage that is not done) onward back to pending. */
export function resetStages(project: Project, from?: StageId): void {
  const firstOpen = STAGE_ORDER.findIndex((stage) => project.stages[stage].status !== "done");
  const begin = from ? Math.min(firstOpen === -1 ? STAGE_ORDER.length : firstOpen, STAGE_ORDER.indexOf(from)) : firstOpen;
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
          replaceWarnings(p, [WARNING_PREFIX.transcribe, WARNING_PREFIX.render], [
            `${WARNING_PREFIX.transcribe}The video has no audio track: no transcript, and highlights cannot use speech or loudness`,
          ]);
        },
      };
    }
    report(0, "Extracting audio");
    await extractAudio(paths.source, paths.audio, signal);
    const transcript = await transcribe(
      paths.audio,
      { language: project.options.language, duration: source.duration },
      (progress) => report(0.03 + 0.92 * progress, "Transcribing"),
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
        warnings.push(`${WARNING_PREFIX.highlights}Skipped highlight "${candidate.title}": ${(error as Error).message}`);
      }
    }
    return {
      message: `${picks.length} clips (${result.engine})`,
      commit(p) {
        const removed = replaceGeneratedClips(p, picks, result.engine);
        p.highlightEngine = result.engine;
        replaceWarnings(p, [WARNING_PREFIX.highlights], warnings);
        return removed.map((clip) => clip.render.file);
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

function clipFileName(clip: Clip): string {
  const slug = clip.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${clip.id}-${slug || "clip"}.mp4`;
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
        outPath,
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
    return done;
  } catch (error) {
    await push.flush();
    const aborted = signal?.aborted ?? false;
    const message = error instanceof Error ? error.message : String(error);
    await rm(outPath, { force: true });
    // If the project or clip is gone, the original error is the one worth reporting.
    await updateProject(id, (p) => {
      const target = p.clips.find((candidate) => candidate.id === clipId);
      if (target) target.render = aborted ? { status: "idle", progress: 0 } : { status: "error", progress: 0, error: message };
    }).catch(() => {});
    throw aborted ? signal?.reason : error;
  }
}
