/**
 * Domain types shared by the pipeline (src/core), the server and the web UI.
 * All times are seconds on the source video's timeline unless stated otherwise.
 * All rects are pixels in the source video's frame unless stated otherwise.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Transcript {
  /** ISO 639-1 code detected or forced, e.g. "en", "id". */
  language: string;
  /** Whisper model file name used. */
  model: string;
  segments: Segment[];
}

/** RMS loudness of the audio track, one value per `step` seconds, in dBFS (<= 0, silence ~ -90). */
export interface LoudnessEnvelope {
  step: number;
  rms: number[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface SourceMeta {
  /** Original YouTube URL or absolute local file path. */
  input: string;
  /** YouTube video id; null for local files. */
  videoId: string | null;
  title: string;
  channel: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
}

/** "auto" = detector result, "manual" = set by the user, "none" = user said there is no webcam. */
export type WebcamSource = "auto" | "manual" | "none";

export interface Webcam {
  /** Webcam overlay rectangle in source pixels; null when none was found / user disabled it. */
  rect: Rect | null;
  /** 0..1 detector confidence; 1 for manual. */
  confidence: number;
  source: WebcamSource;
}

/**
 * How the 16:9 source is reframed into the vertical short.
 * - split: webcam panel on top, gameplay crop below (falls back to `fill` without a webcam rect)
 * - fill:  gameplay cropped to fill the whole frame
 * - fit:   whole source frame centered over a blurred copy of itself
 */
export type LayoutMode = "split" | "fill" | "fit";

export interface ClipSettings {
  layout: LayoutMode;
  /** 0..1 horizontal focus of the gameplay crop; 0.5 = centered. */
  focusX: number;
  subtitles: boolean;
  /** Id of a preset in CAPTION_STYLES (src/shared/captions.ts). */
  captionStyle: string;
  /** 0..1 vertical center of the caption block in the output frame. */
  captionY: number;
}

export type ClipSource = "heuristic" | "llm" | "agent" | "manual";
export type RenderStatus = "idle" | "queued" | "rendering" | "done" | "error";

export interface ClipRender {
  status: RenderStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  /** File name inside the project's clips directory, set when status is "done". */
  file?: string;
  renderedAt?: string;
}

export interface Clip {
  id: string;
  start: number;
  end: number;
  title: string;
  /** Why this moment was picked. */
  reason: string;
  /** 0..100 */
  score: number;
  source: ClipSource;
  /** Chosen by the user for rendering. */
  selected: boolean;
  settings: ClipSettings;
  render: ClipRender;
}

export type StageId = "download" | "transcribe" | "highlights" | "webcam";
export const STAGE_ORDER: StageId[] = ["download", "transcribe", "highlights", "webcam"];
export type StageStatus = "pending" | "running" | "done" | "error";

export interface StageState {
  status: StageStatus;
  /** 0..1 */
  progress: number;
  message?: string;
  error?: string;
}

export interface ProjectOptions {
  /** Whisper language code or "auto". */
  language: string;
  /** How many highlight candidates to propose. */
  clipCount: number;
  /** Clip length bounds in seconds. */
  minDuration: number;
  maxDuration: number;
}

export type HighlightEngine = "heuristic" | "llm";

export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** YouTube URL or local file path the project was created from. */
  input: string;
  options: ProjectOptions;
  /** Null until the download stage finishes. */
  source: SourceMeta | null;
  stages: Record<StageId, StageState>;
  webcam: Webcam;
  /** Settings given to newly created clips. */
  defaults: ClipSettings;
  clips: Clip[];
  /** Which engine produced the current non-manual clips. */
  highlightEngine: HighlightEngine | null;
  /** Non-fatal problems to show the user (e.g. "LLM call failed, used heuristics"). */
  warnings: string[];
}

export const DEFAULT_OPTIONS: ProjectOptions = {
  language: "auto",
  clipCount: 8,
  minDuration: 20,
  maxDuration: 60,
};

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  layout: "split",
  focusX: 0.5,
  subtitles: true,
  captionStyle: "pop",
  captionY: 0.7,
};

/** Output format of every rendered short. */
export const OUTPUT_SIZE: Size = { width: 1080, height: 1920 };
