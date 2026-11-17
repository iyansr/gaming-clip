import { join } from "node:path";
import { BIN, PORT, projectPaths } from "./core/config";
import { checkDeps } from "./core/doctor";
import { run } from "./core/exec";
import { grabJpeg } from "./core/frames";
import { formatTranscript } from "./core/highlights";
import {
  addClip,
  clampFrameTime,
  forgetThumbnailCandidates,
  formatClock,
  generateThumbnail,
  parseOptions,
  parseRect,
  parseSettingsPatch,
  parseThumbnailPatch,
  patchClip,
  patchProject,
  removeClip,
  removeOutputs,
  renderProjectClip,
  replaceGeneratedClips,
  runPipeline,
  selectClips,
  updateSettings,
  type ClipFields,
  type PipelineOptions,
} from "./core/pipeline";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  NotFoundError,
  subscribe,
  updateProject,
  ValidationError,
} from "./core/store";
import { STAGE_ORDER, type Clip, type LoudnessEnvelope, type Project, type StageId, type Transcript } from "./shared/types";
import { THUMBNAIL_STYLES } from "./shared/thumbnail";

const USAGE = `Usage: bun run clip <command> [options]

  clip doctor                                  dependency table; exit 1 if anything is missing
  clip serve [--port N]                        start the web UI server
  clip new <url|file>... [--lang auto] [--clips auto|N] [--min 20] [--max 60] [--no-highlights]
                                               create project(s) and run the pipeline to completion
                                               (--json prints an array of projects). --clips auto (the
                                               default) lets the engine choose how many moments are worth posting
  clip rerun <id> [--from <stage>] [--clips auto|N] [--min S] [--max S] [--no-highlights]
                                               run the pipeline again: without --from it resumes at the first
                                               unfinished stage (retry after a failure); stages: download,
                                               transcribe, highlights, webcam. Rerunning highlights replaces non-manual clips
  clip list                                    projects: id, title, duration, stage status, clip counts
  clip show <id>                               stages, webcam, warnings, clips table
  clip transcript <id> [--from T] [--to T]     timed transcript text; with --json the Transcript filtered to the range
  clip frame <id> <T> <out.jpg> [--crop webcam]   write the source frame at T (optionally cropped to the webcam rect)
  clip clips set <id> <file.json>              replace all non-manual clips with picks from a JSON array
                                               [{start,end,title,reason?,score?}] (start/end: seconds or time strings)
  clip clips add <id> <start> <end> [title]    add a manual clip
  clip clips rm <id> <clipId>
  clip clips select <id> <clipId,...|all|none>
  clip webcam <id> [--detect | --none | --rect x,y,w,h]
  clip settings <id> [--clips a,b|all] [--layout split|fill|fit|custom] [--custom-json <file>] [--subtitles on|off]
                     [--style <id>] [--caption-y 0..1] [--focus-x 0..1]
                                               without --clips: project defaults only; all = every clip AND the defaults.
                                               --layout custom starts from the split layout as free elements; --custom-json
                                               sets the whole free-form layout (and --layout custom): {"background":
                                               {"kind":"blur"} | {"kind":"color","color":"#1e1b4b"} | {"kind":"image","file":<uploaded name>},
                                               "game": null | {"src":{x,y,w,h} (source px),"dst":{x,y,w,h} (1080x1920 px)},
                                               "cam": null | {"src","dst","feather":0..300,"radius":0..960,"border":0..40,"borderColor":"#rrggbb"}}
  clip render <id> [--clips a,b|all]           default: selected clips; renders sequentially, prints the output files
  clip thumbnail <id> [--clips a,b|all] [--time T|auto] [--text "..."] [--no-text] [--title-text]
                     [--style <id>] [--text-y 0..1]
                                               default: selected clips; makes their 1080x1920 cover images,
                                               prints the files. --no-text = no headline, --title-text = use the
                                               clip title, auto = pick the best frame. Styles: ${THUMBNAIL_STYLES.map((style) => style.id).join(", ")}
  clip rm <id>                                 delete the project and its files

Times: seconds (83.5) or MM:SS(.s) / H:MM:SS(.s). --json prints machine-readable JSON on stdout (progress goes to stderr).
Exit codes: 0 ok, 1 failure, 2 usage error.
`;

class UsageError extends Error {
  override name = "UsageError";
}

/** Argument values that fail validation are usage errors, not runtime failures. */
function asUsage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ValidationError) throw new UsageError(error.message);
    throw error;
  }
}

type FlagKind = "bool" | "value";

interface CommandSpec {
  flags: Record<string, FlagKind>;
  /** Min/max number of positional arguments. */
  args: [min: number, max: number];
  run: (positionals: string[], flags: Record<string, string | true>) => Promise<number | void>;
}

const abort = new AbortController();
let json = false;

function parseArgs(args: string[], spec: CommandSpec): { positionals: string[]; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  const allowed: Record<string, FlagKind> = { ...spec.flags, json: "bool" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const kind = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
    if (!kind) throw new UsageError(`Unknown flag --${name}`);
    if (kind === "bool") {
      if (eq !== -1) throw new UsageError(`Flag --${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith("--"))) throw new UsageError(`Flag --${name} needs a value`);
    flags[name] = value;
  }
  if (positionals.length < spec.args[0]) throw new UsageError(`Missing argument (expected at least ${spec.args[0]})`);
  if (positionals.length > spec.args[1]) throw new UsageError(`Unexpected argument "${positionals[spec.args[1]]}"`);
  return { positionals, flags };
}

function parseTime(text: string): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (match) {
    const [, h, m, s] = match;
    if (h !== undefined && (Number(m) >= 60 || Number(s) >= 60)) throw new ValidationError(`Invalid time "${text}"`);
    if (Number(s) >= 60) throw new ValidationError(`Invalid time "${text}"`);
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  }
  throw new ValidationError(`Invalid time "${text}" (use seconds, MM:SS or H:MM:SS)`);
}

function parseNumber(text: string, flag: string): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) throw new UsageError(`${flag} needs a number, got "${text}"`);
  return value;
}

function parseClipCount(text: string): number | null {
  if (text.trim().toLowerCase() === "auto") return null;
  return parseNumber(text, "--clips");
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length)));
  return rows.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!))).join("  ")).join("\n");
}

const clock = (clip: { start: number; end: number }) => `${formatClock(clip.start)}-${formatClock(clip.end)}`;

// ---------------------------------------------------------------------------------------------
// Progress on stderr
// ---------------------------------------------------------------------------------------------

const isTty = process.stderr.isTTY === true;

/** TTY: one updating line. Otherwise a line whenever the label or the 10% bucket changes. */
function createStatusLine() {
  let lastKey = "";
  let dirty = false;
  const clear = () => {
    if (isTty && dirty) process.stderr.write("\r\x1b[2K");
    dirty = false;
  };
  return {
    update(label: string, fraction: number) {
      const text = `${label} ${Math.round(fraction * 100)}%`;
      if (isTty) {
        const width = process.stderr.columns || 100;
        process.stderr.write(`\r\x1b[2K${text.slice(0, width - 1)}`);
        dirty = true;
        return;
      }
      const key = `${label}|${Math.floor(fraction * 10)}`;
      if (key === lastKey) return;
      lastKey = key;
      process.stderr.write(`${text}\n`);
    },
    log(line: string) {
      clear();
      process.stderr.write(`${line}\n`);
    },
    clear,
  };
}

/** Shows pipeline progress for one project (the pipeline runs in this process, so store.subscribe sees every write). */
function trackPipeline(project: Project): () => void {
  const status = createStatusLine();
  const last = new Map<StageId, string>(STAGE_ORDER.map((stage) => [stage, project.stages[stage].status]));
  const unsubscribe = subscribe((p) => {
    if (p.id !== project.id) return;
    for (const stage of STAGE_ORDER) {
      const state = p.stages[stage];
      if (state.status === "done" && last.get(stage) !== "done") {
        status.log(`  ${stage.padEnd(10)} done${state.message ? `  ${state.message}` : ""}`);
      } else if (state.status === "error" && last.get(stage) !== "error") {
        status.log(`  ${stage.padEnd(10)} FAILED  ${state.error ?? ""}`);
      } else if (state.status === "running") {
        status.update(`  ${stage.padEnd(10)} ${state.message ?? ""}`.trimEnd(), state.progress);
      }
      last.set(stage, state.status);
    }
  });
  return () => {
    unsubscribe();
    status.clear();
  };
}

function trackRender(projectId: string, clipId: string): () => void {
  const status = createStatusLine();
  const unsubscribe = subscribe((p) => {
    const clip = p.clips.find((candidate) => candidate.id === clipId);
    if (p.id === projectId && clip?.render.status === "rendering") status.update(`  render ${clipId}`, clip.render.progress);
  });
  return () => {
    unsubscribe();
    status.clear();
  };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function pipelineWithProgress(project: Project, opts: PipelineOptions): Promise<Project> {
  const stop = trackPipeline(project);
  try {
    return await runPipeline(project.id, opts, abort.signal);
  } finally {
    stop();
  }
}

function stageSummary(project: Project): string {
  const mark = { pending: ".", running: "~", done: "#", error: "!" } as const;
  return STAGE_ORDER.map((stage) => mark[project.stages[stage].status]).join("");
}

function describeRender(clip: Clip, id: string): string {
  const { status, progress, file, error } = clip.render;
  if (status === "done") return `done ${join(projectPaths(id).clipsDir, file ?? "?")}`;
  if (status === "error") {
    const lines = (error ?? "unknown").trim().split("\n");
    const first = lines[0]!.length > 60 ? `${lines[0]!.slice(0, 59)}…` : lines[0]!;
    return `error: ${first}${lines.length > 1 || first !== lines[0] ? " (…)" : ""}`;
  }
  if (status === "rendering") return `rendering ${Math.round(progress * 100)}%`;
  return status;
}

function showProject(project: Project): void {
  const { source, webcam, defaults } = project;
  const lines = [
    `Project ${project.id}  ${source?.title ?? project.input}`,
    `  input:      ${project.input}`,
    `  source:     ${source ? `${source.width}x${source.height} ${source.fps}fps ${source.duration.toFixed(1)}s (${formatClock(source.duration)})` : "not downloaded"}`,
    `  options:    language ${project.options.language}, clips ${project.options.clipCount ?? "auto"}, ${project.options.minDuration}-${project.options.maxDuration}s`,
    "  stages:",
    ...STAGE_ORDER.map((stage) => {
      const state = project.stages[stage];
      const detail = state.status === "error" ? state.error : state.message;
      const pct = state.status === "running" ? ` ${Math.round(state.progress * 100)}%` : "";
      return `    ${stage.padEnd(10)} ${state.status}${pct}${detail ? `  ${detail}` : ""}`;
    }),
    `  webcam:     ${webcam.source}${webcam.rect ? ` rect ${webcam.rect.x},${webcam.rect.y},${webcam.rect.w},${webcam.rect.h}` : " (no rect)"} confidence ${webcam.confidence}`,
    `  defaults:   layout ${defaults.layout}, subtitles ${defaults.subtitles ? "on" : "off"}, style ${defaults.captionStyle}, captionY ${defaults.captionY}, focusX ${defaults.focusX}`,
    `  highlights: ${project.highlightEngine ?? "-"}`,
  ];
  if (project.warnings.length > 0) lines.push("  warnings:", ...project.warnings.map((warning) => `    - ${warning}`));
  console.log(lines.join("\n"));
  if (project.clips.length === 0) {
    console.log("  clips:      none");
    return;
  }
  console.log("  clips:");
  const rows = [["ID", "TIME", "LEN", "SCORE", "SEL", "SOURCE", "LAYOUT", "SUBS", "THUMB", "RENDER", "TITLE"]];
  for (const clip of project.clips) {
    rows.push([
      clip.id,
      clock(clip),
      `${Math.round(clip.end - clip.start)}s`,
      String(Math.round(clip.score)),
      clip.selected ? "*" : "-",
      clip.source,
      `${clip.settings.layout}`,
      clip.settings.subtitles ? clip.settings.captionStyle : "off",
      clip.thumbnail.file ?? "-",
      describeRender(clip, project.id),
      clip.title,
    ]);
  }
  console.log(table(rows).replace(/^/gm, "    "));
  for (const clip of project.clips) {
    if (clip.render.status !== "error") continue;
    console.log(`  render error for clip ${clip.id}:`);
    console.log((clip.render.error ?? "unknown").trim().replace(/^/gm, "    "));
  }
}

function parseClipList(text: string | undefined, project: Project, fallback: "selected" | "none"): string[] {
  if (text === undefined) return fallback === "selected" ? project.clips.filter((clip) => clip.selected).map((clip) => clip.id) : [];
  if (text === "all") return project.clips.map((clip) => clip.id);
  return text.split(",").map((id) => id.trim()).filter(Boolean);
}

async function readJsonFile(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`File not found: ${path}`);
  try {
    return await file.json();
  } catch (error) {
    throw new ValidationError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

async function readPicks(path: string): Promise<ClipFields[]> {
  const raw = await readJsonFile(path);
  if (!Array.isArray(raw)) throw new ValidationError(`${path} must contain a JSON array of picks`);
  return raw.map((item: unknown, index) => {
    if (typeof item !== "object" || item === null) throw new ValidationError(`pick #${index + 1} must be an object`);
    const pick = item as Record<string, unknown>;
    const time = (key: "start" | "end") => {
      const value = pick[key];
      if (typeof value === "number") return value;
      if (typeof value === "string") return parseTime(value.trim());
      throw new ValidationError(`pick #${index + 1}: ${key} must be a number or a time string`);
    };
    for (const key of ["title", "reason"] as const) {
      if (pick[key] !== undefined && typeof pick[key] !== "string") throw new ValidationError(`pick #${index + 1}: ${key} must be a string`);
    }
    if (pick.score !== undefined && typeof pick.score !== "number") throw new ValidationError(`pick #${index + 1}: score must be a number`);
    return {
      start: time("start"),
      end: time("end"),
      title: (pick.title as string | undefined) ?? "",
      reason: (pick.reason as string | undefined) ?? "",
      score: (pick.score as number | undefined) ?? 50,
    };
  });
}

const COMMANDS: Record<string, CommandSpec> = {
  doctor: {
    flags: {},
    args: [0, 0],
    async run() {
      const deps = await checkDeps();
      if (json) print(deps);
      else {
        console.log(table(deps.map((dep) => [dep.ok ? "OK" : "MISSING", dep.name, dep.detail + (dep.fix ? `  (fix: ${dep.fix})` : "")])));
      }
      return deps.every((dep) => dep.ok) ? 0 : 1;
    },
  },

  serve: {
    flags: { port: "value" },
    args: [0, 0],
    async run(_, flags) {
      const port = typeof flags.port === "string" ? parseNumber(flags.port, "--port") : PORT;
      // Imported lazily: the HTML bundle and server code are not needed by any other command.
      const { startServer } = await import("./server/index");
      await startServer(port);
      return -1;
    },
  },

  new: {
    flags: { lang: "value", clips: "value", min: "value", max: "value", "no-highlights": "bool" },
    args: [1, Infinity],
    async run(inputs, flags) {
      const raw: Record<string, unknown> = {};
      if (typeof flags.lang === "string") raw.language = flags.lang;
      if (typeof flags.clips === "string") raw.clipCount = parseClipCount(flags.clips);
      if (typeof flags.min === "string") raw.minDuration = parseNumber(flags.min, "--min");
      if (typeof flags.max === "string") raw.maxDuration = parseNumber(flags.max, "--max");
      const options = asUsage(() => parseOptions(raw));

      const results: Project[] = [];
      let failures = 0;
      for (const input of inputs) {
        let project = await createProject(input, options);
        console.error(`Project ${project.id}: ${project.input}`);
        try {
          project = await pipelineWithProgress(project, { skipHighlights: flags["no-highlights"] === true });
        } catch (error) {
          if (abort.signal.aborted) throw error;
          failures++;
          console.error(`Project ${project.id} failed: ${error instanceof Error ? error.message : error}`);
          project = await getProject(project.id);
        }
        results.push(project);
        if (!json) {
          console.log(project.id);
        }
      }
      if (json) print(results);
      return failures > 0 ? 1 : 0;
    },
  },

  rerun: {
    flags: { from: "value", clips: "value", min: "value", max: "value", "no-highlights": "bool" },
    args: [1, 1],
    async run([id], flags) {
      const from = flags.from as StageId | undefined;
      if (from !== undefined && !STAGE_ORDER.includes(from)) throw new UsageError(`--from must be one of ${STAGE_ORDER.join(", ")}`);
      let project = await getProject(id!);
      const raw: Record<string, unknown> = {};
      if (typeof flags.clips === "string") raw.clipCount = parseClipCount(flags.clips);
      if (typeof flags.min === "string") raw.minDuration = parseNumber(flags.min, "--min");
      if (typeof flags.max === "string") raw.maxDuration = parseNumber(flags.max, "--max");
      const options = asUsage(() => parseOptions(raw, project.options));
      await updateProject(project.id, (p) => {
        p.options = options;
      });
      project = await pipelineWithProgress(project, { from, skipHighlights: flags["no-highlights"] === true });
      if (json) return print(project);
      console.log(`${project.id}  ${stageSummary(project)}  ${project.clips.length} clips`);
    },
  },

  list: {
    flags: {},
    args: [0, 0],
    async run() {
      const projects = await listProjects();
      if (json) return print(projects);
      if (projects.length === 0) {
        console.log("No projects yet. Create one with: clip new <url|file>");
        return;
      }
      const rows = [["ID", "DURATION", "STAGES", "TARGET", "CLIPS", "SELECTED", "RENDERED", "TITLE"]];
      for (const project of projects) {
        rows.push([
          project.id,
          project.source ? formatClock(project.source.duration) : "-",
          stageSummary(project),
          project.options.clipCount === null ? "auto" : String(project.options.clipCount),
          String(project.clips.length),
          String(project.clips.filter((clip) => clip.selected).length),
          String(project.clips.filter((clip) => clip.render.status === "done").length),
          project.source?.title ?? project.input,
        ]);
      }
      console.log(table(rows));
      console.log(`stages: ${STAGE_ORDER.join(" ")}  (# done, ~ running, . pending, ! error)`);
    },
  },

  show: {
    flags: {},
    args: [1, 1],
    async run([id]) {
      const project = await getProject(id!);
      if (json) print(project);
      else showProject(project);
    },
  },

  transcript: {
    flags: { from: "value", to: "value" },
    args: [1, 1],
    async run([id], flags) {
      const project = await getProject(id!);
      const paths = projectPaths(project.id);
      const transcriptFile = Bun.file(paths.transcript);
      if (!(await transcriptFile.exists())) throw new Error("The transcript is not ready yet");
      const transcript = (await transcriptFile.json()) as Transcript;
      const from = typeof flags.from === "string" ? asUsage(() => parseTime(flags.from as string)) : undefined;
      const to = typeof flags.to === "string" ? asUsage(() => parseTime(flags.to as string)) : undefined;
      const ranged = from !== undefined || to !== undefined;
      const range = { from: from ?? 0, to: to ?? Number.POSITIVE_INFINITY };
      if (json) {
        print({
          ...transcript,
          segments: transcript.segments.filter((segment) => !ranged || (segment.end > range.from && segment.start < range.to)),
        });
        return;
      }
      const loudnessFile = Bun.file(paths.loudness);
      const loudness = (await loudnessFile.exists()) ? ((await loudnessFile.json()) as LoudnessEnvelope) : null;
      console.log(formatTranscript(transcript, loudness, ranged ? range : undefined));
    },
  },

  frame: {
    flags: { crop: "value" },
    args: [3, 3],
    async run([id, time, out], flags) {
      if (flags.crop !== undefined && flags.crop !== "webcam") throw new UsageError(`--crop only supports "webcam"`);
      const t = asUsage(() => parseTime(time!));
      const project = await getProject(id!);
      if (!project.source) throw new Error("The source video is not downloaded yet");
      if (t > project.source.duration) throw new ValidationError(`T ${t}s is beyond the source duration ${project.source.duration.toFixed(1)}s`);
      const at = clampFrameTime(t, project.source.duration);
      const { source } = projectPaths(project.id);
      if (flags.crop === "webcam") {
        const rect = project.webcam.rect;
        if (!rect) throw new Error("This project has no webcam rect (see: clip webcam <id> --rect x,y,w,h)");
        await run(BIN.ffmpeg, [
          "-v", "error", "-y", "-nostdin",
          "-ss", at.toFixed(3), "-i", source,
          "-frames:v", "1",
          "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
          "-q:v", "3",
          out!,
        ]);
      } else {
        await Bun.write(out!, await grabJpeg(source, at, project.source.width));
      }
      if (json) print({ file: out });
      else console.log(out);
    },
  },

  "clips set": {
    flags: {},
    args: [2, 2],
    async run([id, path]) {
      const picks = await readPicks(path!);
      let removed: Clip[] = [];
      const project = await updateProject(id!, (p) => {
        removed = replaceGeneratedClips(p, picks, "agent");
      });
      await removeOutputs(project.id, removed.flatMap((clip) => [clip.render.file, clip.thumbnail.file]));
      if (json) return print(project);
      console.log(`Set ${picks.length} clip(s) (replaced ${removed.length}):`);
      for (const clip of project.clips.filter((candidate) => candidate.source === "agent")) {
        console.log(`  ${clip.id}  ${clock(clip)}  ${clip.title}`);
      }
    },
  },

  "clips add": {
    flags: {},
    args: [3, 4],
    async run([id, start, end, title]) {
      const from = asUsage(() => parseTime(start!));
      const to = asUsage(() => parseTime(end!));
      const before = new Set((await getProject(id!)).clips.map((clip) => clip.id));
      const project = await addClip(id!, from, to, title);
      if (json) return print(project);
      const clip = project.clips.find((candidate) => !before.has(candidate.id));
      console.log(`Added clip ${clip?.id}  ${clip ? clock(clip) : ""}  ${clip?.title ?? ""}`);
    },
  },

  "clips rm": {
    flags: {},
    args: [2, 2],
    async run([id, clipId]) {
      const project = await removeClip(id!, clipId!);
      if (json) print(project);
      else console.log(`Removed clip ${clipId}`);
    },
  },

  "clips select": {
    flags: {},
    args: [2, 2],
    async run([id, which]) {
      const target = which === "all" || which === "none" ? which : which!.split(",").map((clipId) => clipId.trim()).filter(Boolean);
      if (Array.isArray(target) && target.length === 0) throw new UsageError("Give clip ids, all or none");
      const project = await selectClips(id!, target);
      if (json) return print(project);
      const selected = project.clips.filter((clip) => clip.selected).map((clip) => clip.id);
      console.log(`Selected ${selected.length}/${project.clips.length}: ${selected.join(",") || "-"}`);
    },
  },

  webcam: {
    flags: { detect: "bool", none: "bool", rect: "value" },
    args: [1, 1],
    async run([id], flags) {
      const chosen = ["detect", "none", "rect"].filter((flag) => flags[flag] !== undefined);
      if (chosen.length > 1) throw new UsageError("Use only one of --detect, --none, --rect");
      let project = await getProject(id!);
      if (flags.detect) {
        project = await pipelineWithProgress(project, { from: "webcam" });
      } else if (flags.none) {
        project = await patchProject(project.id, { webcam: { rect: null } });
      } else if (typeof flags.rect === "string") {
        const parts = flags.rect.split(",").map((part) => parseNumber(part, "--rect"));
        if (parts.length !== 4) throw new UsageError("--rect needs x,y,w,h");
        const [x, y, w, h] = parts;
        const rect = asUsage(() => parseRect({ x, y, w, h }, project.source));
        project = await patchProject(project.id, { webcam: { rect } });
      }
      if (json) return print(project.webcam);
      const { webcam } = project;
      console.log(`webcam: ${webcam.source}${webcam.rect ? ` rect ${webcam.rect.x},${webcam.rect.y},${webcam.rect.w},${webcam.rect.h}` : " (no rect)"} confidence ${webcam.confidence}`);
    },
  },

  settings: {
    flags: { clips: "value", layout: "value", "custom-json": "value", subtitles: "value", style: "value", "caption-y": "value", "focus-x": "value" },
    args: [1, 1],
    async run([id], flags) {
      const raw: Record<string, unknown> = {};
      if (typeof flags.layout === "string") raw.layout = flags.layout;
      if (typeof flags["custom-json"] === "string") {
        raw.custom = await readJsonFile(flags["custom-json"]);
        // A layout without effect is never what the caller wants.
        raw.layout ??= "custom";
      }
      if (typeof flags.style === "string") raw.captionStyle = flags.style;
      if (typeof flags["caption-y"] === "string") raw.captionY = parseNumber(flags["caption-y"], "--caption-y");
      if (typeof flags["focus-x"] === "string") raw.focusX = parseNumber(flags["focus-x"], "--focus-x");
      if (typeof flags.subtitles === "string") {
        if (flags.subtitles !== "on" && flags.subtitles !== "off") throw new UsageError("--subtitles needs on or off");
        raw.subtitles = flags.subtitles === "on";
      }
      const patch = asUsage(() => parseSettingsPatch(raw));
      let project = await getProject(id!);
      if (Object.keys(patch).length > 0) {
        const target = typeof flags.clips === "string" ? (flags.clips === "all" ? "all" : parseClipList(flags.clips, project, "none")) : null;
        project = await updateSettings(project.id, patch, target);
      } else if (flags.clips !== undefined) {
        throw new UsageError("--clips needs at least one setting to change");
      }
      if (json) return print({ defaults: project.defaults, clips: project.clips.map((clip) => ({ id: clip.id, settings: clip.settings })) });
      const line = (label: string, s: Project["defaults"]) => {
        const layout = s.layout === "custom" && s.custom ? `custom (${s.custom.background.kind} background${s.custom.game ? ", game" : ""}${s.custom.cam ? ", cam" : ""})` : s.layout;
        return `${label} layout ${layout}, subtitles ${s.subtitles ? "on" : "off"}, style ${s.captionStyle}, captionY ${s.captionY}, focusX ${s.focusX}`;
      };
      console.log(line("defaults:", project.defaults));
      for (const clip of project.clips) console.log(line(`${clip.id}:`.padEnd(9), clip.settings));
    },
  },

  render: {
    flags: { clips: "value" },
    args: [1, 1],
    async run([id], flags) {
      let project = await getProject(id!);
      const clipIds = parseClipList(typeof flags.clips === "string" ? flags.clips : undefined, project, "selected");
      if (clipIds.length === 0) throw new Error("No clips to render: select some (clip clips select) or pass --clips");
      for (const clipId of clipIds) {
        if (!project.clips.some((clip) => clip.id === clipId)) throw new NotFoundError(`Clip not found: ${clipId}`);
      }
      const outputs: { clipId: string; file: string }[] = [];
      let failures = 0;
      for (const clipId of clipIds) {
        const stop = trackRender(project.id, clipId);
        try {
          project = await renderProjectClip(project.id, clipId, abort.signal);
          const file = project.clips.find((clip) => clip.id === clipId)?.render.file ?? "";
          outputs.push({ clipId, file: join(projectPaths(project.id).clipsDir, file) });
        } catch (error) {
          if (abort.signal.aborted) throw error;
          failures++;
          console.error(`Clip ${clipId} failed: ${error instanceof Error ? error.message : error}`);
        } finally {
          stop();
        }
      }
      if (json) print(outputs);
      else for (const output of outputs) console.log(output.file);
      return failures > 0 ? 1 : 0;
    },
  },

  thumbnail: {
    flags: {
      clips: "value",
      time: "value",
      text: "value",
      "no-text": "bool",
      "title-text": "bool",
      style: "value",
      "text-y": "value",
    },
    args: [1, 1],
    async run([id], flags) {
      const headline = ["text", "no-text", "title-text"].filter((flag) => flags[flag] !== undefined);
      if (headline.length > 1) throw new UsageError("Use only one of --text, --no-text, --title-text");
      const raw: Record<string, unknown> = {};
      if (typeof flags.text === "string") raw.text = flags.text;
      if (flags["no-text"] === true) raw.text = "";
      if (flags["title-text"] === true) raw.text = null;
      if (typeof flags.style === "string") raw.style = flags.style;
      if (typeof flags["text-y"] === "string") raw.textY = parseNumber(flags["text-y"], "--text-y");
      if (typeof flags.time === "string") {
        raw.time = flags.time === "auto" ? null : asUsage(() => parseTime(flags.time as string));
      }
      const patch = asUsage(() => parseThumbnailPatch(raw));
      let project = await getProject(id!);
      const clipIds = parseClipList(typeof flags.clips === "string" ? flags.clips : undefined, project, "selected");
      if (clipIds.length === 0) throw new Error("No clips to make covers for: select some (clip clips select) or pass --clips");
      for (const clipId of clipIds) {
        if (!project.clips.some((clip) => clip.id === clipId)) throw new NotFoundError(`Clip not found: ${clipId}`);
      }
      const { clipsDir } = projectPaths(project.id);
      const outputs: { clipId: string; file: string; time: number }[] = [];
      for (const clipId of clipIds) {
        if (Object.keys(patch).length > 0) project = await patchClip(project.id, clipId, { thumbnail: patch });
        project = await generateThumbnail(project.id, clipId, abort.signal);
        const clip = project.clips.find((candidate) => candidate.id === clipId);
        if (!clip?.thumbnail.file) throw new Error(`The cover of clip ${clipId} was not generated: the clip changed while it was made`);
        outputs.push({ clipId, file: join(clipsDir, clip.thumbnail.file), time: clip.thumbnail.usedTime ?? 0 });
      }
      if (json) print(outputs);
      else for (const output of outputs) console.log(output.file);
    },
  },

  rm: {
    flags: {},
    args: [1, 1],
    async run([id]) {
      await deleteProject(id!);
      forgetThumbnailCandidates(id!);
      if (json) print({ deleted: id });
      else console.log(`Deleted project ${id}`);
    },
  },
};

async function main(argv: string[]): Promise<number> {
  const [first, second, ...rest] = argv;
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    if (first === undefined) throw new UsageError("Missing command");
    process.stdout.write(USAGE);
    return 0;
  }
  const isGroup = first === "clips";
  const name = isGroup ? `clips ${second ?? ""}` : first;
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!spec) throw new UsageError(isGroup ? `Unknown clips subcommand "${second ?? ""}" (set, add, rm, select)` : `Unknown command "${first}"`);
  const { positionals, flags } = parseArgs(isGroup ? rest : [second, ...rest].filter((arg): arg is string => arg !== undefined), spec);
  json = flags.json === true;
  return (await spec.run(positionals, flags)) ?? 0;
}

process.on("SIGINT", () => {
  if (abort.signal.aborted) process.exit(130);
  abort.abort(new Error("Interrupted"));
});

try {
  const code = await main(Bun.argv.slice(2));
  // serve returns -1: keep the process alive for the HTTP server.
  if (code >= 0) process.exitCode = code;
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (abort.signal.aborted) {
    console.error("Interrupted");
    process.exitCode = 130;
  } else {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
