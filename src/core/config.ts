import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import pkg from "../../package.json";

export const VERSION: string = pkg.version;

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "windows-x64"] as const;
export type PlatformId = (typeof PLATFORMS)[number];

function detectPlatform(): PlatformId | null {
  const id = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  return PLATFORMS.find((platform) => platform === id) ?? null;
}
/** null on an unsupported OS/CPU (e.g. Linux): `bun run setup` cannot download tools there. */
export const PLATFORM = detectPlatform();
const EXE = process.platform === "win32" ? ".exe" : "";

/** Repository root (this file lives in src/core). */
export const ROOT = resolve(import.meta.dir, "../..");

/** Tools `bun run setup` downloads (gitignored); BIN prefers them over the ones on PATH. */
export const TOOLS_DIR = join(ROOT, "tools");

/** All project data lives here: workspace/projects/<id>/... */
export const WORKSPACE_DIR = resolve(ROOT, Bun.env.GCLIP_WORKSPACE || "workspace");
export const PROJECTS_DIR = join(WORKSPACE_DIR, "projects");
/** User uploads shared by every project: sounds, stickers and intro/outro videos. Created on demand. */
export const LIBRARY_DIR = join(WORKSPACE_DIR, "library");
export const MODELS_DIR = resolve(ROOT, Bun.env.GCLIP_MODELS || "models");
export const FONTS_DIR = join(ROOT, "assets/fonts");

/**
 * An env override always wins, then the tool `setup` downloaded into tools/, then the bare name
 * (resolved through PATH, e.g. a Homebrew install).
 */
function locate(envName: string, name: string, downloaded: string): string {
  return Bun.env[envName] || (existsSync(downloaded) ? downloaded : name);
}

/** Resolved on every access so a tool that `setup` just downloaded is found without a restart. */
export const BIN = {
  get ffmpeg() {
    return locate("FFMPEG_BIN", "ffmpeg", join(TOOLS_DIR, "ffmpeg", "bin", `ffmpeg${EXE}`));
  },
  get ffprobe() {
    return locate("FFPROBE_BIN", "ffprobe", join(TOOLS_DIR, "ffmpeg", "bin", `ffprobe${EXE}`));
  },
  get ytDlp() {
    return locate("YT_DLP_BIN", "yt-dlp", join(TOOLS_DIR, `yt-dlp${EXE}`));
  },
  get whisper() {
    return locate("WHISPER_BIN", "whisper-cli", join(TOOLS_DIR, "whisper", `whisper-cli${EXE}`));
  },
};

/** whisper.cpp ggml model name; file is models/ggml-<name>.bin. */
export const WHISPER_MODEL = Bun.env.WHISPER_MODEL || "large-v3-turbo-q5_0";

/**
 * Path and download URL of a whisper.cpp ggml model. GCLIP_WHISPER_MODEL_URL replaces the URL
 * (an https:// mirror or a file:// path) for offline installs and tests.
 */
export function whisperModelFile(name: string): { path: string; url: string } {
  return {
    path: join(MODELS_DIR, `ggml-${name}.bin`),
    url:
      Bun.env.GCLIP_WHISPER_MODEL_URL || `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`,
  };
}
const FACE_MODEL_FILE = "face_detection_yunet_2023mar.onnx";

export const MODELS = {
  whisper: whisperModelFile(WHISPER_MODEL),
  /** YuNet face detector (ONNX, fixed 640x640 input) used to locate the webcam overlay. */
  face: {
    path: join(MODELS_DIR, FACE_MODEL_FILE),
    url: `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/${FACE_MODEL_FILE}`,
  },
};

export const PORT = Number(Bun.env.PORT || 4321);
/**
 * Loopback by default: the API accepts local file paths as project input and serves media,
 * so it must not be reachable from the network unless the user opts in.
 */
export const HOST = Bun.env.HOST || "127.0.0.1";

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
