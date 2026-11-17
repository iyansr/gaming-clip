import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Brain, Cpu, Film, Loader2, Plus, Trash2 } from "lucide-react";
import { DEFAULT_OPTIONS, STAGE_ORDER, type Project } from "../../shared/types";
import { api, errorMessage, media, type Health } from "../lib/api";
import { cn, fmtTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useToast } from "../lib/toast";
import { isProcessing, STAGE_LABEL, StageStrip } from "../components/Stepper";
import { Badge, Button, Empty, inputClass } from "../components/ui";

export function HomePage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setListError(null);
    } catch (e) {
      setListError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.health().then(setHealth, (e: unknown) => setHealthError(errorMessage(e)));
  }, [refresh]);

  const processing = projects?.some(isProcessing) ?? false;
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [processing, refresh]);

  const remove = async (project: Project) => {
    try {
      await api.deleteProject(project.id);
      setProjects((all) => all?.filter((p) => p.id !== project.id) ?? null);
      toast.info("Project deleted");
    } catch (e) {
      toast.error(e);
    }
  };

  const brokenDeps = health?.deps.filter((d) => !d.ok) ?? [];

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-5 p-6">
      <header className="flex items-center gap-3">
        <Film className="size-6 text-indigo-400" aria-hidden />
        <h1 className="text-xl font-semibold">Gaming Clip</h1>
        <span className="text-sm text-zinc-400">Long gameplay videos in, vertical shorts out.</span>
      </header>

      {healthError && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-100">
          Could not check dependencies: {healthError}
        </div>
      )}
      {brokenDeps.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-100">
            <AlertTriangle className="size-4 text-red-400" aria-hidden /> {brokenDeps.length} required tool{brokenDeps.length === 1 ? " is" : "s are"} missing. New projects will fail until this is fixed.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {brokenDeps.map((d) => (
              <li key={d.name} className="flex flex-wrap items-baseline gap-x-2 text-red-100">
                <b>{d.name}</b>
                <span className="text-red-200/80">{d.detail}</span>
                {d.fix && <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-amber-200">{d.fix}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-[minmax(320px,400px)_minmax(0,1fr)] items-start gap-6">
        <div className="flex flex-col gap-3">
          <NewProjectForm onCreated={(created) => (created.length === 1 && created[0] ? navigate(`/project/${created[0].id}`) : void refresh())} />
          {health && (
            <p
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                health.llm ? "border-indigo-800 bg-indigo-950/40 text-indigo-200" : "border-zinc-800 bg-zinc-900 text-zinc-300",
              )}
            >
              {health.llm ? <Brain className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Cpu className="mt-0.5 size-4 shrink-0" aria-hidden />}
              {health.llm ? (
                <span>
                  <b>Highlights engine: LLM.</b> Moments are chosen by your configured model.
                </span>
              ) : (
                <span>
                  <b>Highlights engine: heuristics.</b> Moments come from audio loudness and transcript cues. To let a model pick them, set <code>LLM_COMMAND</code> (a signed-in agent CLI, e.g. <code>claude -p --tools ""</code>) or <code>LLM_MODEL</code> with <code>LLM_PROVIDER</code> and <code>LLM_API_KEY</code> in <code>.env</code>.
                </span>
              )}
            </p>
          )}
        </div>

        <section aria-label="Projects" className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-400 uppercase">Projects</h2>
            {projects && <span className="text-xs text-zinc-500">{projects.length}</span>}
            {processing && (
              <span className="inline-flex items-center gap-1 text-xs text-indigo-300">
                <Loader2 className="size-3 animate-spin" aria-hidden /> live
              </span>
            )}
          </div>
          {listError && (
            <div role="alert" className="mb-3 flex items-center gap-3 rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-100">
              <span className="flex-1">Could not load projects: {listError}</span>
              <Button small onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          )}
          {projects === null ? (
            !listError && (
              <Empty>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> Loading projects...
              </Empty>
            )
          ) : projects.length === 0 ? (
            <Empty>No projects yet. Paste a YouTube link or a file path to start.</Empty>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-4">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onDelete={() => remove(p)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

const LANGUAGES: [string, string][] = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["id", "Indonesian"],
  ["ja", "Japanese"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
];
const OTHER = "__other";

function NewProjectForm({ onCreated }: { onCreated: (projects: Project[]) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [language, setLanguage] = useState(DEFAULT_OPTIONS.language);
  const [custom, setCustom] = useState("");
  const [autoClips, setAutoClips] = useState(DEFAULT_OPTIONS.clipCount === null);
  const [clipCount, setClipCount] = useState("8");
  const [minDuration, setMinDuration] = useState(String(DEFAULT_OPTIONS.minDuration));
  const [maxDuration, setMaxDuration] = useState(String(DEFAULT_OPTIONS.maxDuration));
  const [busy, setBusy] = useState(false);

  const inputs = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const lang = language === OTHER ? custom.trim() : language;
    if (!lang) {
      toast.error("Enter a language code, for example fr");
      return;
    }
    setBusy(true);
    try {
      const created = await api.createProjects(inputs, {
        language: lang,
        clipCount: autoClips ? null : Number(clipCount),
        minDuration: Number(minDuration),
        maxDuration: Number(maxDuration),
      });
      setText("");
      toast.info(`${created.length} project${created.length === 1 ? "" : "s"} created`);
      onCreated(created);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const clipField = (
    <div className="flex flex-col gap-1 text-xs text-zinc-400">
      <span>Clips to find</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={60}
          value={clipCount}
          onChange={(e) => setClipCount(e.target.value)}
          disabled={autoClips}
          required={!autoClips}
          aria-label="Clips to find"
          className={cn(inputClass, autoClips && "opacity-40")}
        />
        <label className="flex items-center gap-1 whitespace-nowrap text-zinc-300">
          <input type="checkbox" checked={autoClips} onChange={(e) => setAutoClips(e.target.checked)} />
          Auto
        </label>
      </div>
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4" aria-label="New project">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-400 uppercase">New project</h2>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        YouTube URLs or local file paths, one per line
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={"https://www.youtube.com/watch?v=...\n/Users/me/Videos/stream.mp4"}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
            <option value={OTHER}>Other...</option>
          </select>
        </label>
        {language === OTHER ? (
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Language code
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="fr" className={inputClass} required />
          </label>
        ) : (
          clipField
        )}
        {language === OTHER && clipField}
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Min clip (s)
          <input type="number" min={3} value={minDuration} onChange={(e) => setMinDuration(e.target.value)} className={inputClass} required />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Max clip (s)
          <input type="number" max={180} value={maxDuration} onChange={(e) => setMaxDuration(e.target.value)} className={inputClass} required />
        </label>
      </div>
      <Button variant="primary" type="submit" disabled={busy || inputs.length === 0}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        {inputs.length > 1 ? `Create ${inputs.length} projects` : "Create project"}
      </Button>
    </form>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const downloaded = project.stages.download.status === "done";
  const total = project.clips.length;
  const selected = project.clips.filter((c) => c.selected).length;
  const rendered = project.clips.filter((c) => c.render.status === "done").length;
  const running = STAGE_ORDER.find((s) => project.stages[s].status === "running");
  const failed = STAGE_ORDER.find((s) => project.stages[s].status === "error");
  const title = project.source?.title ?? project.input;

  return (
    <li className="group flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-600" data-project={project.id}>
      <Link href={`/project/${project.id}`} className="relative block aspect-video bg-zinc-950" aria-label={`Open ${title}`}>
        {downloaded && !thumbFailed ? (
          <img src={media.thumbnail(project.id)} alt="" onError={() => setThumbFailed(true)} className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-zinc-600">
            {running === "download" ? <Loader2 className="size-7 animate-spin" aria-hidden /> : <Film className="size-8" aria-hidden />}
          </span>
        )}
        {project.source && (
          <span className="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs text-white tabular-nums">{fmtTime(project.source.duration)}</span>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <Link href={`/project/${project.id}`} className="line-clamp-2 text-sm leading-snug font-medium hover:text-indigo-300" title={title}>
          {title}
        </Link>
        <StageStrip project={project} />
        {running && (
          <p className="truncate text-xs text-indigo-300" title={project.stages[running].message}>
            {STAGE_LABEL[running]}: {project.stages[running].message ?? "working..."}
          </p>
        )}
        {failed && (
          <p className="line-clamp-2 text-xs text-red-300" title={project.stages[failed].error}>
            {STAGE_LABEL[failed]} failed: {project.stages[failed].error}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Badge title="Clips found">{total} clips</Badge>
          <Badge tone={selected > 0 ? "info" : "neutral"} title="Selected for rendering">
            {selected} selected
          </Badge>
          <Badge tone={rendered > 0 ? "good" : "neutral"} title="Rendered shorts">
            {rendered} rendered
          </Badge>
          <span className="flex-1" />
          {confirming ? (
            <span className="flex items-center gap-1" role="group" aria-label="Confirm delete">
              <Button
                variant="danger"
                small
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  void onDelete().finally(() => setDeleting(false));
                }}
              >
                Delete
              </Button>
              <Button small onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button variant="ghost" small onClick={() => setConfirming(true)} aria-label={`Delete project ${title}`} title="Delete project">
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
