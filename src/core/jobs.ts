import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Project, ProjectOptions, StageId } from "../shared/types";
import { projectPaths } from "./config";
import { removeOutputs, renderProjectClip, resetStages, runPipeline, type PipelineOptions } from "./pipeline";
import { getSettings } from "./settings";
import { busyElsewhere, clearBusy, ConflictError, listProjects, markBusy, NotFoundError, updateProject } from "./store";

interface Job {
  projectId: string;
  kind: "pipeline" | "render";
  clipId?: string;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<unknown>;
  /** Resolves (never rejects) when the job has finished, been cancelled while queued, or been aborted. */
  settled: Promise<void>;
  settle: () => void;
}

/**
 * FIFO queue. Renders run up to `renderJobs` (Settings) at a time, read when a job starts so a change applies to newly
 * started jobs (ffmpeg already uses several cores, so a few overlapping encodes mostly hide the single-threaded
 * caption/canvas work). A pipeline job (download, whisper) runs alone.
 */
const queue: Job[] = [];
const running = new Set<Job>();

function createJob(projectId: string, kind: Job["kind"], run: Job["run"], clipId?: string): Job {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { projectId, kind, clipId, controller: new AbortController(), run, settled: promise, settle: resolve };
}

async function execute(job: Job): Promise<void> {
  try {
    await job.run(job.controller.signal);
  } catch (error) {
    // Failures are already recorded in project.json by the pipeline / renderer; cancellations are expected.
    if (!job.controller.signal.aborted) {
      console.error(
        `${job.kind} job for project ${job.projectId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  } finally {
    running.delete(job);
    job.settle();
    pump();
  }
}

function pump(): void {
  for (let next = queue[0]; next; next = queue[0]) {
    const alone = next.kind === "pipeline";
    const exclusive = [...running].some((job) => job.kind === "pipeline");
    if (exclusive || (alone ? running.size > 0 : running.size >= getSettings().values.renderJobs)) return;
    queue.shift();
    running.add(next);
    void execute(next);
  }
}

function push(job: Job): Promise<void> {
  queue.push(job);
  pump();
  return job.settled;
}

/** Projects whose pipeline was accepted but is not in the queue yet (still awaiting its first write). */
const reservedPipelines = new Set<string>();

export function isPipelineActive(projectId: string): boolean {
  return (
    reservedPipelines.has(projectId) ||
    [...running, ...queue].some((job) => job.projectId === projectId && job.kind === "pipeline")
  );
}

/**
 * Queues the pipeline for a project, optionally replacing its options in the same write. The returned project
 * already shows the stages that will re-run as pending; `done` resolves when the job is finished and never rejects.
 * Throws ConflictError (changing nothing) when the project's pipeline is already queued or running.
 */
export async function enqueuePipeline(
  projectId: string,
  opts: PipelineOptions = {},
  options?: ProjectOptions,
): Promise<{ project: Project; done: Promise<void> }> {
  // Reserve before the first await: two simultaneous requests must not both pass the check.
  if (isPipelineActive(projectId)) throw new ConflictError("This project's pipeline is already queued or running");
  reservedPipelines.add(projectId);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await markBusy(projectId);
    const project = await updateProject(projectId, (p) => {
      if (options) p.options = options;
      resetStages(p, opts.from);
    });
    const job = createJob(projectId, "pipeline", (signal) => runPipeline(projectId, opts, signal));
    const done = push(job);
    void done.then(release);
    return { project, done };
  } catch (error) {
    await release?.();
    throw error;
  } finally {
    reservedPipelines.delete(projectId);
  }
}

/**
 * Marks the clips queued right away and adds one queue entry per clip. Clips that are already queued/rendering are
 * skipped: the check and the mark are one atomic project update, so a double request never queues a clip twice.
 */
export async function enqueueRender(projectId: string, clipIds: string[]): Promise<Project> {
  const queued: string[] = [];
  const replaced: (string | undefined)[] = [];
  const release = await markBusy(projectId);
  let project: Project;
  try {
    project = await updateProject(projectId, (p) => {
      if (!p.source) throw new ConflictError("The source video is not downloaded yet");
      for (const clipId of new Set(clipIds)) {
        const clip = p.clips.find((candidate) => candidate.id === clipId);
        if (!clip) throw new NotFoundError(`Clip not found: ${clipId}`);
        if (clip.render.status === "queued" || clip.render.status === "rendering") continue;
        replaced.push(clip.render.file);
        clip.render = { status: "queued", progress: 0 };
        queued.push(clipId);
      }
    });
    await removeOutputs(projectId, replaced);
  } catch (error) {
    await release();
    throw error;
  }
  const jobs = queued.map((clipId) =>
    push(createJob(projectId, "render", (signal) => renderProjectClip(projectId, clipId, signal), clipId)),
  );
  void Promise.all(jobs).then(release);
  return project;
}

/** Removes queued jobs of a project from the queue and aborts its running job, waiting until it has stopped. */
async function cancelJobs(projectId: string, kinds: Job["kind"][]): Promise<Job[]> {
  const matches = (job: Job) => job.projectId === projectId && kinds.includes(job.kind);
  const cancelledQueued = queue.filter(matches);
  for (const job of cancelledQueued) {
    queue.splice(queue.indexOf(job), 1);
    job.controller.abort();
    job.settle();
  }
  const active = [...running].filter(matches);
  for (const job of active) job.controller.abort();
  await Promise.all(active.map((job) => job.settled));
  return cancelledQueued;
}

async function cancel(projectId: string, kinds: Job["kind"][]): Promise<void> {
  const cancelled = await cancelJobs(projectId, kinds);
  const clipIds = new Set(cancelled.map((job) => job.clipId));
  if (clipIds.size === 0) return;
  await updateProject(projectId, (p) => {
    for (const clip of p.clips) {
      if (clipIds.has(clip.id) && clip.render.status === "queued") clip.render = { status: "idle", progress: 0 };
    }
  }).catch((error) => {
    // The project may have been deleted right after the cancel.
    if (!(error instanceof NotFoundError)) throw error;
  });
}

/** Queued and running render jobs of the project; their clips go back to idle. */
export const cancelRenders = (projectId: string) => cancel(projectId, ["render"]);

/** Every queued and running job of the project. */
export const cancelProject = (projectId: string) => cancel(projectId, ["pipeline", "render"]);

/** Graceful shutdown: aborts the running job (killing its ffmpeg/whisper child) and drops everything queued. */
export async function cancelAll(): Promise<void> {
  const projectIds = new Set([...running, ...queue].map((job) => job.projectId));
  await Promise.all([...projectIds].map(cancelProject));
}

/**
 * Called at server start: anything left marked running/queued is a leftover of a crash, unless the project's `.busy`
 * marker names another live process (a CLI render, another server), whose work must not be touched.
 * Runs once per OS process: `bun --hot` re-runs the entry (and this function) on every file change in the same
 * process, where jobs are still alive and their `.busy` marker holds this very pid.
 */
const RECOVERY_FLAG = "__gclipRecoveryDone";
const recoveryGlobal = globalThis as typeof globalThis & { [RECOVERY_FLAG]?: boolean };

export async function recoverInterrupted(): Promise<void> {
  if (recoveryGlobal[RECOVERY_FLAG]) return;
  recoveryGlobal[RECOVERY_FLAG] = true;
  for (const project of await listProjects()) {
    if (busyElsewhere(project.id)) continue;
    const stagesRunning = Object.values(project.stages).some((stage) => stage.status === "running");
    const clipsBusy = project.clips.some(
      (clip) => clip.render.status === "queued" || clip.render.status === "rendering",
    );
    if (clipsBusy) {
      // Partial renders from the killed process are never renamed into place.
      const { clipsDir } = projectPaths(project.id);
      for (const name of await readdir(clipsDir).catch(() => [] as string[])) {
        if (name.startsWith(".") && name.endsWith(".partial.mp4")) await rm(join(clipsDir, name), { force: true });
      }
    }
    await clearBusy(project.id);
    if (!stagesRunning && !clipsBusy) continue;
    await updateProject(project.id, (p) => {
      for (const stage of Object.keys(p.stages) as StageId[]) {
        const state = p.stages[stage];
        if (state.status === "running")
          p.stages[stage] = { status: "error", progress: state.progress, error: "Interrupted by restart" };
      }
      for (const clip of p.clips) {
        if (clip.render.status === "queued" || clip.render.status === "rendering")
          clip.render = { status: "idle", progress: 0 };
      }
    });
  }
}
