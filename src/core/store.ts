import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_CLIP_SETTINGS,
  DEFAULT_OPTIONS,
  STAGE_ORDER,
  type Project,
  type ProjectOptions,
} from "../shared/types";
import { PROJECTS_DIR, projectPaths } from "./config";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** Bad input from a user, CLI flag or API body. The server maps it to HTTP 400. */
export class ValidationError extends Error {
  override name = "ValidationError";
}

/** The request is valid but clashes with current state (e.g. editing a clip that is rendering). HTTP 409. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

const ID_PATTERN = /^[a-z0-9]+$/;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 8;

const listeners = new Set<(project: Project) => void>();

/** Fires after every write made by this process (writes by other processes are not seen). */
export function subscribe(listener: (project: Project) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(project: Project): void {
  for (const listener of listeners) {
    try {
      listener(project);
    } catch (error) {
      console.error("project listener failed:", error);
    }
  }
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new NotFoundError(`Project not found: ${id}`);
}

function randomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

/** 6-char lowercase base36 id for clips. */
export const newClipId = () => randomId(6);

async function writeJson(id: string, project: Project): Promise<void> {
  const { json } = projectPaths(id);
  const tmp = `${json}.${process.pid}.${randomId(6)}.tmp`;
  await Bun.write(tmp, JSON.stringify(project, null, 2));
  await rename(tmp, json);
}

export async function createProject(input: string, options: Partial<ProjectOptions> = {}): Promise<Project> {
  const now = new Date().toISOString();
  const id = randomId(10);
  await mkdir(PROJECTS_DIR, { recursive: true });
  await mkdir(projectPaths(id).dir);
  const project: Project = {
    id,
    createdAt: now,
    updatedAt: now,
    input: /^https?:\/\//i.test(input) ? input : resolve(input),
    options: { ...DEFAULT_OPTIONS, ...options },
    source: null,
    stages: Object.fromEntries(
      STAGE_ORDER.map((stage) => [stage, { status: "pending", progress: 0 }]),
    ) as Project["stages"],
    webcam: { rect: null, confidence: 0, source: "auto" },
    defaults: { ...DEFAULT_CLIP_SETTINGS },
    clips: [],
    highlightEngine: null,
    warnings: [],
  };
  await writeJson(id, project);
  notify(project);
  return project;
}

export async function getProject(id: string): Promise<Project> {
  assertId(id);
  let text: string;
  try {
    text = await readFile(projectPaths(id).json, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError(`Project not found: ${id}`);
    throw error;
  }
  return JSON.parse(text) as Project;
}

/** Newest first. Directories without a readable project.json are skipped. */
export async function listProjects(): Promise<Project[]> {
  const names = await readdir(PROJECTS_DIR).catch(() => [] as string[]);
  const projects = await Promise.all(
    names
      .filter((name) => ID_PATTERN.test(name))
      .map((name) =>
        getProject(name).catch((error) => {
          if (!(error instanceof NotFoundError)) {
            console.error(`Skipping ${projectPaths(name).json}: ${error instanceof Error ? error.message : error}`);
          }
          return null;
        }),
      ),
  );
  return projects
    .filter((project): project is Project => project !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Cross-process lock: atomic mkdir; a lock older than LOCK_STALE_MS belongs to a dead process and is stolen. */
async function acquireLock(lockDir: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await stat(lockDir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    await new Promise((done) => setTimeout(done, LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS));
  }
}

/** Serializes updates inside this process so they do not all hammer the filesystem lock. */
const queues = new Map<string, Promise<unknown>>();

/** Lock -> read fresh -> mutate -> bump updatedAt -> write temp + rename -> unlock. `mutate` must be synchronous. */
export function updateProject(id: string, mutate: (project: Project) => void): Promise<Project> {
  assertId(id);
  const run = async (): Promise<Project> => {
    const lockDir = `${projectPaths(id).json}.lock`;
    // A missing project must not be resurrected by creating the lock dir inside a deleted directory.
    await getProject(id);
    await acquireLock(lockDir);
    try {
      const project = await getProject(id);
      mutate(project);
      project.updatedAt = new Date().toISOString();
      await writeJson(id, project);
      notify(project);
      return project;
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  };
  const result = (queues.get(id) ?? Promise.resolve()).then(run, run);
  const tail = result.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Busy marker: which process is working on a project
// ---------------------------------------------------------------------------------------------

const busyCounts = new Map<string, number>();
const busyChains = new Map<string, Promise<unknown>>();
/** Projects this process has ever written its pid into, for the synchronous exit cleanup. */
const busyTouched = new Set<string>();

const busyFile = (id: string) => join(projectPaths(id).dir, ".busy");

function readBusyPids(id: string, read: (path: string) => string): number[] {
  let text = "";
  try {
    text = read(busyFile(id));
  } catch {
    // no marker
  }
  return text.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Rewrites .busy: other live pids stay, dead ones are dropped, this process is listed while it has work. */
function syncBusyFile(id: string): Promise<void> {
  const run = async () => {
    const lockDir = `${busyFile(id)}.lock`;
    try {
      await acquireLock(lockDir);
    } catch {
      return; // project directory is gone
    }
    try {
      const others = readBusyPids(id, (path) => readFileSync(path, "utf8")).filter(
        (pid) => pid !== process.pid && pidAlive(pid),
      );
      const pids = (busyCounts.get(id) ?? 0) > 0 ? [...others, process.pid] : others;
      if (pids.length > 0) await Bun.write(busyFile(id), pids.join("\n"));
      else await rm(busyFile(id), { force: true });
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  };
  const next = (busyChains.get(id) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => {});
  busyChains.set(id, tail);
  void tail.then(() => {
    if (busyChains.get(id) === tail) busyChains.delete(id);
  });
  return next;
}

/**
 * Records this process as working on the project (pid in `.busy`) until the returned release function is called.
 * Several jobs of one process on one project share the marker. Other processes (a server starting up) must not
 * "recover" a project whose marker names a live process.
 */
export async function markBusy(id: string): Promise<() => Promise<void>> {
  assertId(id);
  busyCounts.set(id, (busyCounts.get(id) ?? 0) + 1);
  busyTouched.add(id);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const left = (busyCounts.get(id) ?? 1) - 1;
    if (left > 0) busyCounts.set(id, left);
    else busyCounts.delete(id);
    await syncBusyFile(id).catch(() => {});
  };
  await syncBusyFile(id).catch(() => {});
  return release;
}

/** True when another live process (not this one) has work on the project. */
export function busyElsewhere(id: string): boolean {
  return readBusyPids(id, (path) => readFileSync(path, "utf8")).some((pid) => pid !== process.pid && pidAlive(pid));
}

/** Drops the marker file of a project nobody is working on. */
export async function clearBusy(id: string): Promise<void> {
  await rm(busyFile(id), { force: true });
}

// Clean exit (including process.exit from a signal handler): never leave this pid behind in a marker.
process.on("exit", () => {
  for (const id of busyTouched) {
    const others = readBusyPids(id, (path) => readFileSync(path, "utf8")).filter((pid) => pid !== process.pid);
    try {
      if (others.length > 0) writeFileSync(busyFile(id), others.join("\n"));
      else rmSync(busyFile(id), { force: true });
    } catch {
      // project directory already deleted
    }
  }
});

export async function deleteProject(id: string): Promise<void> {
  await getProject(id);
  await rm(projectPaths(id).dir, { recursive: true, force: true });
}

export interface ThrottledUpdater {
  (mutate: (project: Project) => void): void;
  /** Writes the pending update now and waits until every write issued through this updater has finished. */
  flush(): Promise<void>;
}

/**
 * For progress updates: keeps only the latest mutation and writes at most once per `intervalMs`.
 * Mutations must be "set to latest value" style, since earlier pending ones are dropped.
 */
export function throttledUpdater(id: string, intervalMs = 330): ThrottledUpdater {
  let lastWrite = 0;
  let pending: ((project: Project) => void) | null = null;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<unknown> = Promise.resolve();

  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    const mutate = pending;
    pending = null;
    if (!mutate) return;
    lastWrite = Date.now();
    // A failed progress write (e.g. project deleted mid-run) is surfaced by the caller's next real update.
    inflight = inflight.then(() => updateProject(id, mutate)).catch(() => {});
  };

  const push = ((mutate) => {
    pending = mutate;
    if (timer === undefined) timer = setTimeout(write, Math.max(0, lastWrite + intervalMs - Date.now()));
  }) as ThrottledUpdater;
  push.flush = async () => {
    write();
    await inflight;
  };
  return push;
}
