import type {
  ClipSettings,
  Project,
  ProjectOptions,
  Rect,
  StageId,
  Transcript,
} from "../../shared/types";

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
  cancelRender: (id: string) => request<Project>("POST", `${projectUrl(id)}/render/cancel`, {}),
};

export const media = {
  source: (id: string) => `/media/${id}/source`,
  thumbnail: (id: string) => `/media/${id}/thumbnail`,
  frame: (id: string, t: number, w: number) => `/media/${id}/frame?t=${t.toFixed(2)}&w=${w}`,
  clip: (id: string, file: string, download = false) =>
    `/media/${id}/clips/${encodeURIComponent(file)}${download ? "?download=1" : ""}`,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
