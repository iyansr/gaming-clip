import { rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { STAGE_ORDER, type Project, type SourceMeta, type StageId } from "../shared/types";
import { FONTS_DIR, HOST, PORT, llmConfigured, projectPaths } from "../core/config";
import { checkDeps } from "../core/doctor";
import { grabJpeg } from "../core/frames";
import {
  cancelAll,
  cancelProject,
  cancelRenders,
  enqueuePipeline,
  enqueueRender,
  recoverInterrupted,
} from "../core/jobs";
import {
  addAsset,
  addClip,
  ASSET_TYPES,
  assetsDir,
  clampFrameTime,
  forgetThumbnailCandidates,
  generateThumbnail,
  MAX_ASSET_BYTES,
  parseClipPatch,
  parseOptions,
  parseProjectPatch,
  patchClip,
  patchProject,
  removeClip,
  thumbnailCandidates,
} from "../core/pipeline";
import {
  ConflictError,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  NotFoundError,
  PayloadTooLargeError,
  subscribe,
  updateProject,
  ValidationError,
} from "../core/store";
import index from "../web/index.html";

const EVENT_MIN_INTERVAL_MS = 200;
const EVENT_POLL_MS = 1000;
const EVENT_HEARTBEAT_MS = 15_000;

function errorResponse(error: unknown): Response {
  if (error instanceof NotFoundError) return Response.json({ error: error.message }, { status: 404 });
  if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof ConflictError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof PayloadTooLargeError) return Response.json({ error: error.message }, { status: 413 });
  console.error(error);
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

const WILDCARD_HOSTS = ["0.0.0.0", "::"];
const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", HOST.includes(":") ? `[${HOST}]` : HOST];

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;
/** Only the asset upload route takes raw image bodies. */
const IMAGE_CONTENT_TYPE = new RegExp(`^(${Object.keys(ASSET_TYPES).join("|")})\\s*(;|$)`, "i");

/**
 * The server only listens locally, but any web page the user visits can still make their browser talk to it
 * (cross-site requests, DNS rebinding). Returns a rejection for requests that did not come from our own UI or a plain client.
 * Requests with a body must carry `bodyType` as Content-Type.
 */
function rejectUnsafe(req: Request, bodyType: RegExp): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!WILDCARD_HOSTS.includes(HOST)) {
    let hostname = "";
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      // malformed Host header: rejected below
    }
    if (!ALLOWED_HOSTNAMES.includes(hostname)) return Response.json({ error: `Host "${host}" is not allowed` }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== `http://${host}`) {
    return Response.json({ error: `Cross-origin request from "${origin}" is not allowed` }, { status: 403 });
  }
  const hasBody = req.headers.has("transfer-encoding") || Number(req.headers.get("content-length") ?? 0) > 0;
  if ((req.method === "POST" || req.method === "PATCH") && hasBody && !bodyType.test(req.headers.get("content-type") ?? "")) {
    const wanted = bodyType === JSON_CONTENT_TYPE ? "application/json" : Object.keys(ASSET_TYPES).join(", ");
    return Response.json({ error: `Content-Type must be ${wanted}` }, { status: 415 });
  }
  return null;
}

/** Applies the request checks, runs a handler and turns thrown errors into `{ error }` responses. */
async function api(req: Request, handler: () => Promise<Response> | Response, bodyType = JSON_CONTENT_TYPE): Promise<Response> {
  const rejected = rejectUnsafe(req, bodyType);
  if (rejected) return rejected;
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Raw request body, refused as soon as it passes `limit` bytes (also for chunked bodies without a Content-Length). */
async function readBytes(req: Request, limit: number): Promise<Uint8Array> {
  const tooLarge = () => new PayloadTooLargeError(`The upload is larger than ${limit / 1024 / 1024} MB`);
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${key} must be a number`);
  return value;
}

function noUnknownKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ValidationError(`Unknown field "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

/** A plain file name: no separators, no traversal, not hidden (partial renders start with a dot). */
function plainFileName(name: string): string {
  if (name === "" || name.startsWith(".") || name !== basename(name) || name.includes("\\") || name.includes("\0")) {
    throw new NotFoundError(`File not found: ${name}`);
  }
  return name;
}

async function serveFile(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new NotFoundError("File not found");
  // Bun answers Range requests (206 + Content-Range + Accept-Ranges) itself for file bodies.
  return new Response(Bun.file(path), { headers });
}

const thumbnails = new Map<string, Promise<string>>();

/** JPEG at 10% of the video, cached next to the source; regenerated when the source is newer. */
function ensureThumbnail(project: Project): Promise<string> {
  const pending = thumbnails.get(project.id);
  if (pending) return pending;
  const paths = projectPaths(project.id);
  const path = join(paths.dir, "thumbnail.jpg");
  const job = (async () => {
    const [thumb, source] = await Promise.all([stat(path).catch(() => null), stat(paths.source).catch(() => null)]);
    if (!source) throw new NotFoundError("Source not downloaded yet");
    if (thumb && thumb.mtimeMs >= source.mtimeMs) return path;
    const bytes = await grabJpeg(paths.source, (project.source?.duration ?? 0) * 0.1, 480);
    const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Bun.write(tmp, bytes);
    await rename(tmp, path);
    return path;
  })().finally(() => thumbnails.delete(project.id));
  thumbnails.set(project.id, job);
  return job;
}

function requireDownloaded(project: Project): SourceMeta {
  if (project.stages.download.status !== "done" || !project.source) throw new NotFoundError("Source not downloaded yet");
  return project.source;
}

/** SSE: a snapshot now, then the latest state after every change (in-process or by another process). */
async function projectEvents(req: Request, server: Bun.Server<undefined>, id: string): Promise<Response> {
  await getProject(id);
  server.timeout(req, 0);
  const jsonPath = projectPaths(id).json;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSent = 0;
      let lastPayload = "";
      let lastMtime = 0;
      let timer: NodeJS.Timeout | undefined;

      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const close = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };
      const flush = async () => {
        timer = undefined;
        if (closed) return;
        try {
          // Stat before reading: a write landing in between is picked up by the next poll.
          lastMtime = (await stat(jsonPath)).mtimeMs;
          const payload = JSON.stringify(await getProject(id));
          lastSent = Date.now();
          if (payload === lastPayload) return;
          lastPayload = payload;
          send(`event: project\ndata: ${payload}\n\n`);
        } catch (error) {
          if (error instanceof NotFoundError || (error as NodeJS.ErrnoException).code === "ENOENT") close();
          else console.error("event stream read failed:", error);
        }
      };
      /** Trailing-edge throttle: at most one event per interval, always carrying the latest state. */
      const schedule = () => {
        if (closed || timer !== undefined) return;
        timer = setTimeout(flush, Math.max(0, lastSent + EVENT_MIN_INTERVAL_MS - Date.now()));
      };

      const unsubscribe = subscribe((project) => {
        if (project.id === id) schedule();
      });
      const poll = setInterval(async () => {
        const info = await stat(jsonPath).catch(() => null);
        if (!info || info.mtimeMs !== lastMtime) schedule();
      }, EVENT_POLL_MS);
      const heartbeat = setInterval(() => send(": ping\n\n"), EVENT_HEARTBEAT_MS);
      cleanup = () => {
        closed = true;
        clearTimeout(timer);
        clearInterval(poll);
        clearInterval(heartbeat);
        unsubscribe();
      };
      void flush();
    },
    cancel() {
      cleanup();
    },
  });
  req.signal.addEventListener("abort", () => cleanup(), { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function startServer(port: number = PORT): Promise<Bun.Server<undefined>> {
  await recoverInterrupted();

  const server = Bun.serve({
    hostname: HOST,
    port,
    // Opt-in only: Bun's dev mode (HMR) ties the process to the browser tab and can exit when the
    // tab goes away, which would kill queued renders. `bun run dev` sets NODE_ENV=development.
    development: process.env.NODE_ENV === "development",
    routes: {
      "/": index,
      "/project/*": index,

      "/api/health": {
        GET: (req) => api(req, async () => Response.json({ deps: await checkDeps(), llm: llmConfigured() })),
      },

      "/api/projects": {
        GET: (req) => api(req, async () => Response.json(await listProjects())),
        POST: (req) =>
          api(req, async () => {
            const body = await readBody(req);
            noUnknownKeys(body, ["inputs", "options"]);
            const { inputs } = body;
            if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) {
              throw new ValidationError("inputs must be a non-empty array of at most 50 URLs or file paths");
            }
            const cleaned = inputs.map((input) => {
              if (typeof input !== "string" || input.trim() === "") throw new ValidationError("Every input must be a non-empty string");
              return input.trim();
            });
            const options = parseOptions(body.options ?? {});
            const projects: Project[] = [];
            for (const input of cleaned) {
              const created = await createProject(input, options);
              projects.push((await enqueuePipeline(created.id)).project);
            }
            return Response.json(projects, { status: 201 });
          }),
      },

      "/api/projects/:id": {
        GET: (req) => api(req, async () => Response.json(await getProject(req.params.id))),
        DELETE: (req) =>
          api(req, async () => {
            await getProject(req.params.id);
            await cancelProject(req.params.id);
            await deleteProject(req.params.id);
            forgetThumbnailCandidates(req.params.id);
            return new Response(null, { status: 204 });
          }),
        PATCH: (req) =>
          api(req, async () => {
            const current = await getProject(req.params.id);
            const patch = parseProjectPatch(await readBody(req), current.source);
            return Response.json(await patchProject(req.params.id, patch));
          }),
      },

      "/api/projects/:id/assets": {
        POST: (req) =>
          api(
            req,
            async () => {
              await getProject(req.params.id);
              const bytes = await readBytes(req, MAX_ASSET_BYTES);
              return Response.json({ file: await addAsset(req.params.id, bytes, req.headers.get("content-type") ?? "") }, { status: 201 });
            },
            IMAGE_CONTENT_TYPE,
          ),
      },

      "/api/projects/:id/rerun": {
        POST: (req) =>
          api(req, async () => {
            const body = await readBody(req);
            noUnknownKeys(body, ["from", "options"]);
            const from = body.from as StageId;
            if (!STAGE_ORDER.includes(from)) throw new ValidationError(`from must be one of ${STAGE_ORDER.join(", ")}`);
            const current = await getProject(req.params.id);
            const options = body.options === undefined ? undefined : parseOptions(body.options, current.options);
            return Response.json((await enqueuePipeline(req.params.id, { from }, options)).project);
          }),
      },

      "/api/projects/:id/transcript": {
        GET: (req) =>
          api(req, async () => {
            await getProject(req.params.id);
            const file = projectPaths(req.params.id).transcript;
            if (!(await Bun.file(file).exists())) throw new NotFoundError("Transcript is not ready yet");
            return new Response(Bun.file(file), { headers: { "Content-Type": "application/json" } });
          }),
      },

      "/api/projects/:id/clips": {
        POST: (req) =>
          api(req, async () => {
            const body = await readBody(req);
            noUnknownKeys(body, ["start", "end", "title"]);
            if (body.title !== undefined && typeof body.title !== "string") throw new ValidationError("title must be a string");
            await getProject(req.params.id);
            return Response.json(await addClip(req.params.id, requireNumber(body, "start"), requireNumber(body, "end"), body.title));
          }),
      },

      "/api/projects/:id/clips/:clipId": {
        PATCH: (req) =>
          api(req, async () => Response.json(await patchClip(req.params.id, req.params.clipId, parseClipPatch(await readBody(req))))),
        DELETE: (req) => api(req, async () => Response.json(await removeClip(req.params.id, req.params.clipId))),
      },

      "/api/projects/:id/clips/:clipId/thumbnail": {
        POST: (req) => api(req, async () => Response.json(await generateThumbnail(req.params.id, req.params.clipId))),
      },

      "/api/projects/:id/clips/:clipId/thumbnail/candidates": {
        GET: (req) => api(req, async () => Response.json(await thumbnailCandidates(req.params.id, req.params.clipId))),
      },

      "/api/projects/:id/render": {
        POST: (req) =>
          api(req, async () => {
            const body = await readBody(req);
            noUnknownKeys(body, ["clipIds"]);
            const project = await getProject(req.params.id);
            let clipIds: string[];
            if (body.clipIds === undefined) {
              clipIds = project.clips.filter((clip) => clip.selected).map((clip) => clip.id);
            } else if (Array.isArray(body.clipIds) && body.clipIds.every((clipId) => typeof clipId === "string")) {
              clipIds = body.clipIds;
            } else {
              throw new ValidationError("clipIds must be an array of clip ids");
            }
            if (clipIds.length === 0) throw new ValidationError("No clips to render: select at least one clip");
            return Response.json(await enqueueRender(req.params.id, clipIds));
          }),
      },

      "/api/projects/:id/render/cancel": {
        POST: (req) =>
          api(req, async () => {
            await getProject(req.params.id);
            await cancelRenders(req.params.id);
            return Response.json(await getProject(req.params.id));
          }),
      },

      "/api/projects/:id/events": {
        GET: (req, server) => api(req, () => projectEvents(req, server, req.params.id)),
      },

      "/media/:id/source": {
        GET: (req) =>
          api(req, async () => {
            requireDownloaded(await getProject(req.params.id));
            return serveFile(projectPaths(req.params.id).source, { "Cache-Control": "no-cache" });
          }),
      },

      "/media/:id/thumbnail": {
        GET: (req) =>
          api(req, async () => {
            const project = await getProject(req.params.id);
            requireDownloaded(project);
            return serveFile(await ensureThumbnail(project), { "Cache-Control": "no-cache" });
          }),
      },

      "/media/:id/frame": {
        GET: (req) =>
          api(req, async () => {
            const project = await getProject(req.params.id);
            const source = requireDownloaded(project);
            const query = new URL(req.url).searchParams;
            const t = Number(query.get("t") ?? "");
            if (query.get("t") === null || query.get("t") === "" || !Number.isFinite(t) || t < 0) {
              throw new ValidationError("t must be a time in seconds >= 0");
            }
            const width = query.get("w") === null ? 960 : Number(query.get("w"));
            // The preview needs a full-resolution frame, but never an upscaled one.
            if (!Number.isInteger(width) || width < 16 || width > source.width) {
              throw new ValidationError(`w must be an integer between 16 and ${source.width}`);
            }
            const bytes = await grabJpeg(projectPaths(project.id).source, clampFrameTime(t, source.duration), width);
            // grabJpeg's bytes come from Response.bytes(): never SharedArrayBuffer-backed.
            return new Response(bytes as Uint8Array<ArrayBuffer>, {
              headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
            });
          }),
      },

      "/media/:id/assets/:file": {
        GET: (req) =>
          api(req, async () => {
            await getProject(req.params.id);
            const file = plainFileName(req.params.file);
            return serveFile(join(assetsDir(req.params.id), file), { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
          }),
      },

      "/media/:id/clips/:file": {
        GET: (req) =>
          api(req, async () => {
            await getProject(req.params.id);
            const file = plainFileName(req.params.file);
            const headers: Record<string, string> = { "Cache-Control": "no-cache" };
            if (new URL(req.url).searchParams.get("download") === "1") {
              headers["Content-Disposition"] = `attachment; filename="${file.replace(/["\\]/g, "_")}"`;
            }
            return serveFile(join(projectPaths(req.params.id).clipsDir, file), headers);
          }),
      },

      "/fonts/:file": {
        GET: (req) =>
          api(req, () => serveFile(join(FONTS_DIR, plainFileName(req.params.file)), { "Cache-Control": "public, max-age=86400" })),
      },
    },
    fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.error(`Received ${signal}: cancelling jobs and shutting down`);
      // Kill running ffmpeg/whisper children and reset their state instead of leaving orphans behind.
      void cancelAll().finally(() => process.exit(0));
    });
  }

  console.log(`gaming-clip UI: http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${server.port}`);
  return server;
}

if (import.meta.main) await startServer();
