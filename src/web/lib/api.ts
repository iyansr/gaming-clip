import type { WhisperModelStatus } from "../../core/whisper-models";
import { LIBRARY_LIMITS, LIBRARY_TYPES } from "../../shared/library";
import type {
  ClipSettings,
  ClipThumbnail,
  ClipTimeline,
  LibraryItem,
  LibraryKind,
  Project,
  ProjectOptions,
  Rect,
  StageId,
  Transcript,
} from "../../shared/types";
import type { SettingsPatch, SettingsResponse } from "./settings";

export interface DepStatus {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface Health {
  deps: DepStatus[];
  llm: boolean;
}

export interface ClipPatch {
  start?: number;
  end?: number;
  title?: string;
  selected?: boolean;
  settings?: Partial<ClipSettings>;
  thumbnail?: Partial<Pick<ClipThumbnail, "time" | "text" | "style" | "textY">>;
  /** Whole replacement of the editor timeline. */
  timeline?: ClipTimeline;
}

/** A suggested cover frame inside a clip; `score` is 0..1. */
export interface ThumbnailCandidate {
  time: number;
  score: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const sendsBody = method === "POST" || method === "PATCH" || body !== undefined;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // The server rejects POST/PATCH without a JSON content type, even when there is nothing to send.
      headers: sendsBody ? { "Content-Type": "application/json" } : undefined,
      body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is it still running?", 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data: unknown = await res.json();
      if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
        message = data.error;
      }
    } catch {
      // keep the status line
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const projectUrl = (id: string) => `/api/projects/${id}`;

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  createProjects: (inputs: string[], options: Partial<ProjectOptions>) =>
    request<Project[]>("POST", "/api/projects", { inputs, options }),
  deleteProject: (id: string) => request<void>("DELETE", projectUrl(id)),
  patchProject: (
    id: string,
    patch: { webcam?: { rect: Rect | null }; defaults?: Partial<ClipSettings>; applyDefaultsToClips?: boolean },
  ) => request<Project>("PATCH", projectUrl(id), patch),
  rerun: (id: string, from: StageId, options?: Partial<ProjectOptions>) =>
    request<Project>("POST", `${projectUrl(id)}/rerun`, { from, options }),
  getProject: (id: string) => request<Project>("GET", projectUrl(id)),
  transcript: (id: string) => request<Transcript>("GET", `${projectUrl(id)}/transcript`),
  addClip: (id: string, start: number, end: number, title?: string) =>
    request<Project>("POST", `${projectUrl(id)}/clips`, { start, end, title }),
  patchClip: (id: string, clipId: string, patch: ClipPatch) =>
    request<Project>("PATCH", `${projectUrl(id)}/clips/${clipId}`, patch),
  deleteClip: (id: string, clipId: string) => request<Project>("DELETE", `${projectUrl(id)}/clips/${clipId}`),
  render: (id: string, clipIds?: string[]) => request<Project>("POST", `${projectUrl(id)}/render`, { clipIds }),
  thumbnailCandidates: (id: string, clipId: string) =>
    request<ThumbnailCandidate[]>("GET", `${projectUrl(id)}/clips/${clipId}/thumbnail/candidates`),
  generateThumbnail: (id: string, clipId: string) =>
    request<Project>("POST", `${projectUrl(id)}/clips/${clipId}/thumbnail`, {}),
  generateSocial: (id: string, clipId: string, language?: string) =>
    request<Project>("POST", `${projectUrl(id)}/clips/${clipId}/social`, language ? { language } : {}),
  autoEdit: (id: string, clipId: string, replace: boolean) =>
    request<Project>("POST", `${projectUrl(id)}/clips/${clipId}/autoedit`, { replace }),
  cancelRender: (id: string) => request<Project>("POST", `${projectUrl(id)}/render/cancel`, {}),
  library: () => request<LibraryItem[]>("GET", "/api/library"),
  renameLibraryItem: (file: string, name: string) =>
    request<LibraryItem>("PATCH", `/api/library/${encodeURIComponent(file)}`, { name }),
  deleteLibraryItem: (file: string) => request<void>("DELETE", `/api/library/${encodeURIComponent(file)}`),
  settings: () => request<SettingsResponse>("GET", "/api/settings"),
  patchSettings: (patch: SettingsPatch) => request<SettingsResponse>("PATCH", "/api/settings", patch),
  testAi: () => request<{ ok: boolean; ms: number; error?: string }>("POST", "/api/settings/test-ai", {}),
  whisperModels: () => request<WhisperModelStatus[]>("GET", "/api/settings/whisper-models"),
  downloadWhisperModel: (name: string) =>
    request<WhisperModelStatus[]>("POST", `/api/settings/whisper-models/${encodeURIComponent(name)}/download`, {}),
};

export const ASSET_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

/** POSTs a file as the raw request body (fetch has no upload progress, XHR does) and resolves with the parsed JSON. */
function uploadBody<T>(url: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", url);
  xhr.setRequestHeader("Content-Type", file.type);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) onProgress(e.loaded / e.total);
  };
  xhr.onerror = () => reject(new ApiError("Cannot reach the server. Is it still running?", 0));
  xhr.onload = () => {
    let data: unknown = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      // not JSON: fall through to the status line
    }
    if (xhr.status >= 200 && xhr.status < 300 && typeof data === "object" && data !== null) resolve(data as T);
    else {
      const message =
        typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error
          : `${xhr.status} ${xhr.statusText}`;
      reject(new ApiError(message, xhr.status));
    }
  };
  xhr.send(file);
  return promise;
}

/** Uploads a background image as raw bytes. */
export function uploadAsset(
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ file: string }> {
  return uploadBody<{ file: string }>(`${projectUrl(projectId)}/assets`, file, onProgress);
}

/** What the file picker of the media library accepts, by kind (all kinds when omitted). */
export function libraryAccept(kind?: LibraryKind): string {
  return Object.entries(LIBRARY_TYPES)
    .filter(([, t]) => kind === undefined || t.kind === kind)
    .flatMap(([mime, t]) => [mime, t.ext])
    .join(",");
}

/** Why a file cannot go into the library, checked before the upload; null when it looks fine. */
export function libraryFileError(file: File): string | null {
  const type = LIBRARY_TYPES[file.type];
  if (!type) return `${file.name}: unsupported type. Use MP3, WAV, OGG, M4A, PNG, WebP, JPEG, MP4, MOV or WebM.`;
  const limit = LIBRARY_LIMITS.bytes[type.kind];
  if (file.size > limit)
    return `${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit for ${type.kind}s is ${limit / 1048576} MB`;
  return null;
}

/** Uploads one library file; the server probes it and answers with the stored item. */
export function uploadLibraryFile(
  file: File,
  name: string,
  onProgress: (fraction: number) => void,
): Promise<LibraryItem> {
  return uploadBody<LibraryItem>(`/api/library?name=${encodeURIComponent(name)}`, file, onProgress);
}

export const media = {
  source: (id: string) => `/media/${id}/source`,
  asset: (id: string, file: string) => `/media/${id}/assets/${encodeURIComponent(file)}`,
  library: (file: string) => `/media/library/${encodeURIComponent(file)}`,
  thumbnail: (id: string) => `/media/${id}/thumbnail`,
  frame: (id: string, t: number, w: number) => `/media/${id}/frame?t=${t.toFixed(2)}&w=${w}`,
  clip: (id: string, file: string, download = false) =>
    `/media/${id}/clips/${encodeURIComponent(file)}${download ? "?download=1" : ""}`,
  /** A regenerated thumbnail keeps its file name, so the generation time busts the browser cache. */
  thumbnailFile: (id: string, file: string, version?: string) =>
    `/media/${id}/clips/${encodeURIComponent(file)}${version ? `?v=${encodeURIComponent(version)}` : ""}`,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
