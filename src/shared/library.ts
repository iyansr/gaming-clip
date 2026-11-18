import type { LibraryKind } from "./types";

/**
 * Upload types of the media library, shared by the server (validation) and the web app (file picker, checks).
 * Key: the request's Content-Type.
 */
export const LIBRARY_TYPES: Record<string, { kind: LibraryKind; ext: string }> = {
  "audio/mpeg": { kind: "sound", ext: ".mp3" },
  "audio/wav": { kind: "sound", ext: ".wav" },
  "audio/x-wav": { kind: "sound", ext: ".wav" },
  "audio/ogg": { kind: "sound", ext: ".ogg" },
  "audio/mp4": { kind: "sound", ext: ".m4a" },
  "audio/x-m4a": { kind: "sound", ext: ".m4a" },
  "image/png": { kind: "sticker", ext: ".png" },
  "image/webp": { kind: "sticker", ext: ".webp" },
  "image/jpeg": { kind: "sticker", ext: ".jpg" },
  "video/mp4": { kind: "video", ext: ".mp4" },
  "video/quicktime": { kind: "video", ext: ".mov" },
  "video/webm": { kind: "video", ext: ".webm" },
};

/** Largest upload per kind, bytes; longest sound / video, seconds. */
export const LIBRARY_LIMITS = {
  bytes: { sound: 20 * 1024 * 1024, sticker: 15 * 1024 * 1024, video: 500 * 1024 * 1024 },
  duration: { sound: 30, video: 30 },
  nameLength: 80,
} as const;
