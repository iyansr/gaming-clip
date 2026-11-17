import { useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Camera, ExternalLink, RefreshCw, Sparkles, WifiOff } from "lucide-react";
import { STAGE_ORDER, type Project, type StageId } from "../../shared/types";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { useToast } from "../lib/toast";
import { STAGE_LABEL, Stepper } from "./Stepper";
import { Button, inputClass } from "./ui";

interface Props {
  project: Project;
  online: boolean;
  applyProject: (p: Project) => void;
  onOpenWebcam: () => void;
}

export function ProjectHeader({ project, online, applyProject, onOpenWebcam }: Props) {
  const toast = useToast();
  const [retrying, setRetrying] = useState<StageId | null>(null);
  const failed = STAGE_ORDER.filter((s) => project.stages[s].status === "error");
  const isUrl = /^https?:\/\//i.test(project.input);
  const title = project.source?.title ?? project.input;
  const downloaded = project.stages.download.status === "done";
  const busy = STAGE_ORDER.some((s) => project.stages[s].status === "running");

  const retry = async (stage: StageId) => {
    setRetrying(stage);
    try {
      applyProject(await api.rerun(project.id, stage));
    } catch (e) {
      toast.error(e);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <header className="flex flex-col gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Link href="/" className="inline-flex shrink-0 items-center gap-1 rounded text-sm text-zinc-300 hover:text-white">
          <ArrowLeft className="size-4" aria-hidden /> Projects
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base leading-tight font-semibold" title={title}>
            {title}
          </h1>
          <p className="flex items-center gap-1.5 text-xs text-zinc-400">
            {project.source?.channel && <span className="truncate">{project.source.channel}</span>}
            {isUrl ? (
              <a href={project.input} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-indigo-300 hover:underline">
                <span className="truncate">{project.input}</span> <ExternalLink className="size-3 shrink-0" aria-hidden />
              </a>
            ) : (
              <span className="truncate" title={project.input}>
                {project.input}
              </span>
            )}
          </p>
        </div>
        {!online && (
          <span role="status" className="inline-flex items-center gap-1.5 rounded-md bg-amber-950 px-2 py-1 text-xs text-amber-300" title="Live updates paused; reconnecting">
            <WifiOff className="size-3.5" aria-hidden /> Offline, reconnecting
          </span>
        )}
        <Button onClick={onOpenWebcam} disabled={!downloaded} title="Edit the webcam rectangle">
          <Camera className="size-4" aria-hidden /> Webcam
          <span className="text-xs font-normal text-zinc-400">{project.webcam.source === "none" ? "none" : project.webcam.rect ? project.webcam.source : "not found"}</span>
        </Button>
        <FindMoments project={project} disabled={!downloaded || busy} applyProject={applyProject} />
      </div>

      <Stepper project={project} />

      {failed.map((stage) => (
        <div key={stage} role="alert" className="flex items-start gap-2 rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <b>{STAGE_LABEL[stage]} failed.</b> <span className="break-words whitespace-pre-wrap">{project.stages[stage].error ?? "Unknown error"}</span>
          </div>
          <Button variant="danger" small onClick={() => void retry(stage)} disabled={retrying !== null}>
            <RefreshCw className={retrying === stage ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden /> Retry
          </Button>
        </div>
      ))}
      {project.warnings.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Warnings">
          {project.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md border border-amber-800/70 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> <span className="break-words">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function FindMoments({ project, disabled, applyProject }: { project: Project; disabled: boolean; applyProject: (p: Project) => void }) {
  const toast = useToast();
  const dialog = useRef<HTMLDialogElement>(null);
  const [autoCount, setAutoCount] = useState(project.options.clipCount === null);
  const [count, setCount] = useState(project.options.clipCount === null ? "8" : String(project.options.clipCount));
  const [min, setMin] = useState(String(project.options.minDuration));
  const [max, setMax] = useState(String(project.options.maxDuration));
  const [busy, setBusy] = useState(false);
  const replaced = project.clips.filter((c) => c.source !== "manual").length;

  const open = () => {
    const current = project.options.clipCount;
    setAutoCount(current === null);
    setCount(current === null ? "8" : String(current));
    setMin(String(project.options.minDuration));
    setMax(String(project.options.maxDuration));
    dialog.current?.showModal();
  };

  const submit = async () => {
    setBusy(true);
    try {
      applyProject(
        await api.rerun(project.id, "highlights", { clipCount: autoCount ? null : Number(count), minDuration: Number(min), maxDuration: Number(max) }),
      );
      dialog.current?.close();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" onClick={open} disabled={disabled} title={disabled ? "Wait for the pipeline to finish" : undefined}>
        <Sparkles className="size-4" aria-hidden /> Find moments again
      </Button>
      <dialog ref={dialog} className="m-auto w-[26rem] rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/60">
        <form
          method="dialog"
          className="flex flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 className="text-base font-semibold">Find moments again</h2>
          <p className="rounded-md border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
            This replaces every clip that was not added by hand
            {replaced > 0 ? ` (${replaced} clip${replaced === 1 ? "" : "s"}), including your trims and settings on them` : ""}. Manual clips are kept.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1 text-xs text-zinc-400">
              <span>Clips</span>
              <input
                type="number"
                min={1}
                max={60}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                disabled={autoCount}
                required={!autoCount}
                aria-label="Clips"
                className={`${inputClass}${autoCount ? " opacity-40" : ""}`}
              />
              <label className="flex items-center gap-1 whitespace-nowrap text-zinc-300">
                <input type="checkbox" checked={autoCount} onChange={(e) => setAutoCount(e.target.checked)} />
                Auto
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Min (s)
              <input type="number" min={3} value={min} onChange={(e) => setMin(e.target.value)} className={inputClass} required />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Max (s)
              <input type="number" max={180} value={max} onChange={(e) => setMax(e.target.value)} className={inputClass} required />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Starting..." : "Replace clips"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
