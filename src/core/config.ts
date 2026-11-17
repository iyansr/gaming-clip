import { join, resolve } from "node:path";

/** Repository root (this file lives in src/core). */
export const ROOT = resolve(import.meta.dir, "../..");

/** All project data lives here: workspace/projects/<id>/... */
export const WORKSPACE_DIR = resolve(ROOT, process.env.GCLIP_WORKSPACE || "workspace");
export const PROJECTS_DIR = join(WORKSPACE_DIR, "projects");
export const MODELS_DIR = resolve(ROOT, process.env.GCLIP_MODELS || "models");
export const FONTS_DIR = join(ROOT, "assets/fonts");

export const BIN = {
  ffmpeg: process.env.FFMPEG_BIN || "ffmpeg",
  ffprobe: process.env.FFPROBE_BIN || "ffprobe",
  ytDlp: process.env.YT_DLP_BIN || "yt-dlp",
  whisper: process.env.WHISPER_BIN || "whisper-cli",
};

/** whisper.cpp ggml model name; file is models/ggml-<name>.bin. */
export const WHISPER_MODEL = process.env.WHISPER_MODEL || "large-v3-turbo-q5_0";
const FACE_MODEL_FILE = "face_detection_yunet_2023mar.onnx";

export const MODELS = {
  whisper: {
    path: join(MODELS_DIR, `ggml-${WHISPER_MODEL}.bin`),
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`,
  },
  /** YuNet face detector (ONNX, fixed 640x640 input) used to locate the webcam overlay. */
  face: {
    path: join(MODELS_DIR, FACE_MODEL_FILE),
    url: `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/${FACE_MODEL_FILE}`,
  },
};

/**
 * Optional model for highlight selection; unset = heuristics only. Either a shell command that
 * reads the prompt on stdin and prints the answer (a headless agent CLI such as `claude -p`,
 * no API key needed), or an API reached through Anvia: `provider` "openai" speaks Chat
 * Completions (base URL ends in /v1), "anthropic" speaks Messages (base URL without /v1).
 * Without a base URL the provider's own API is used. The command wins when both are set.
 */
export const LLM = {
  command: process.env.LLM_COMMAND || "",
  provider: process.env.LLM_PROVIDER || "openai",
  baseUrl: (process.env.LLM_BASE_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "",
};
export const llmConfigured = () => Boolean(LLM.command || LLM.model);

export const PORT = Number(process.env.PORT || 4321);
/**
 * Loopback by default: the API accepts local file paths as project input and serves media,
 * so it must not be reachable from the network unless the user opts in.
 */
export const HOST = process.env.HOST || "127.0.0.1";

export interface ProjectPaths {
  dir: string;
  /** project.json: the Project record. */
  json: string;
  /** source.mp4: the downloaded video (h264/aac). */
  source: string;
  /** audio.wav: 16 kHz mono s16 PCM for whisper + loudness. */
  audio: string;
  transcript: string;
  loudness: string;
  /** clips/: rendered shorts. */
  clipsDir: string;
}

export function projectPaths(id: string): ProjectPaths {
  const dir = join(PROJECTS_DIR, id);
  return {
    dir,
    json: join(dir, "project.json"),
    source: join(dir, "source.mp4"),
    audio: join(dir, "audio.wav"),
    transcript: join(dir, "transcript.json"),
    loudness: join(dir, "loudness.json"),
    clipsDir: join(dir, "clips"),
  };
}
