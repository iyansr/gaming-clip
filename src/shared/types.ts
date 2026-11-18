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
 * - split:  webcam panel on top, gameplay crop below (falls back to `fill` without a webcam rect)
 * - fill:   gameplay cropped to fill the whole frame
 * - fit:    whole source frame centered over a blurred copy of itself
 * - custom: free-form `ClipSettings.custom` (gameplay and webcam placed anywhere, styled webcam, chosen background)
 */
export type LayoutMode = "split" | "fill" | "fit" | "custom";

/** Base canvas behind the custom layout's elements. */
export type LayoutBackground =
  | { kind: "blur" }
  | { kind: "color"; color: string }
  /** `file` is a basename inside the project's assets directory (uploaded by the user). */
  | { kind: "image"; file: string };

/** One piece of the source placed on the output: `src` in source pixels, `dst` in output pixels (may reach past the frame edges). */
export interface LayoutElement {
  src: Rect;
  dst: Rect;
}

export interface CamElement extends LayoutElement {
  /** Soft edge width in output px (0 = hard edge). */
  feather: number;
  /** Corner radius in output px (half the shorter side = circle/pill). */
  radius: number;
  /** Border width in output px (0 = none) and its colour (#rrggbb). */
  border: number;
  borderColor: string;
}

export interface CustomLayout {
  background: LayoutBackground;
  /** Null hides the element. Painted in this order: background, game, cam. */
  game: LayoutElement | null;
  cam: CamElement | null;
}

export interface ClipSettings {
  layout: LayoutMode;
  /** 0..1 horizontal focus of the gameplay crop; 0.5 = centered. Not used by `custom`. */
  focusX: number;
  /** Free-form layout; used when `layout` is "custom", kept (but ignored) otherwise so switching back restores it. */
  custom: CustomLayout | null;
  subtitles: boolean;
  /** Id of a preset in CAPTION_STYLES (src/shared/captions.ts). */
  captionStyle: string;
  /** 0..1 vertical center of the caption block in the output frame. */
  captionY: number;
  /** Overlays painted on every frame (under the captions), in paint order. */
  watermarks: Watermark[];
}

interface WatermarkBase {
  /** Stable id (short random string) so the editor can select and update one overlay. */
  id: string;
  /** Centre of the overlay in output pixels (1080x1920 frame); may lie partly outside the frame. */
  x: number;
  y: number;
  /** Clockwise rotation in degrees, -180..180. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  /** Also paint it on the clip's thumbnail. */
  onThumbnail: boolean;
}

export interface TextWatermark extends WatermarkBase {
  kind: "text";
  /** Single line, at most 120 characters. */
  text: string;
  /** Must be a family in CAPTION_FONTS. */
  font: string;
  /** Font size in output px; resizing a text overlay changes this. */
  size: number;
  color: string;
  /** Outline width in output px (0 = none) and its colour. */
  stroke: number;
  strokeColor: string;
}

export interface ImageWatermark extends WatermarkBase {
  kind: "image";
  /** Basename in the project's assets directory (uploaded like custom-layout backgrounds). */
  file: string;
  /** Width in output px; height follows the image's aspect ratio. Resizing changes this. */
  width: number;
}

export type Watermark = TextWatermark | ImageWatermark;

/** Post text for one platform; hashtags are stored without the leading `#`. */
export interface SocialPost {
  caption: string;
  hashtags: string[];
}

export interface YoutubeShortPost {
  /** At most 100 characters. */
  title: string;
  description: string;
  hashtags: string[];
}

/** Ready-to-paste post text for a rendered short, generated on request by the highlight AI. */
export interface ClipSocial {
  /** Language the text was written in (ISO code). */
  language: string;
  instagram: SocialPost;
  tiktok: SocialPost;
  youtube: YoutubeShortPost;
  generatedAt: string;
  /** Clip range it was written for; differs from the clip once the clip is trimmed. */
  start: number;
  end: number;
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

/** Cover image of a clip: one reframed source frame with a headline, 1080x1920 JPEG. */
export interface ClipThumbnail {
  /** Source time of the frame; null = pick automatically (sharp frame near the clip's loudest moment). */
  time: number | null;
  /** Headline; `*word*` marks accent words; "" = no text; null = use the clip title. */
  text: string | null;
  /** Id of a preset in THUMBNAIL_STYLES (src/shared/thumbnail.ts). */
  style: string;
  /** 0..1 vertical center of the headline in the output frame. */
  textY: number;
  /** File name inside the project's clips directory, set once generated; cleared by any change that affects it. */
  file?: string;
  generatedAt?: string;
  /** Source time the generated file shows (the resolved value when `time` is null). */
  usedTime?: number;
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
  thumbnail: ClipThumbnail;
  /** Null until generated (manual action). */
  social: ClipSocial | null;
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
  /**
   * How many clips to propose. null = automatic: the engine decides from the content how many
   * moments are worth posting (a long stream yields more, a dull one fewer). A number is a target.
   */
  clipCount: number | null;
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
  clipCount: null,
  minDuration: 20,
  maxDuration: 60,
};

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  layout: "split",
  focusX: 0.5,
  custom: null,
  subtitles: true,
  captionStyle: "pop",
  captionY: 0.7,
  watermarks: [],
};

export const DEFAULT_THUMBNAIL: ClipThumbnail = {
  time: null,
  text: null,
  style: "impact",
  textY: 0.72,
};

/** Output format of every rendered short. */
export const OUTPUT_SIZE: Size = { width: 1080, height: 1920 };
