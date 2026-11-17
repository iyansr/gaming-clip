import { useState } from "react";
import { CheckCircle2, Clapperboard, X } from "lucide-react";
import type { Clip, Project } from "../../shared/types";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { Button, ProgressBar } from "./ui";

interface Props {
  project: Project;
  clips: Clip[];
  flushAll: () => Promise<void>;
  applyProject: (p: Project) => void;
}

export function RenderBar({ project, clips, flushAll, applyProject }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const active = clips.filter((c) => c.render.status === "queued" || c.render.status === "rendering");
  const finished = clips.filter((c) => c.render.status === "done").length;
  const todo = clips.filter((c) => c.selected && c.render.status !== "done" && c.render.status !== "queued" && c.render.status !== "rendering");
  // Clips of the batch started from this page, plus anything queued by someone else (CLI, other tab).
  const batch = clips.filter((c) => batchIds.includes(c.id) || c.render.status === "queued" || c.render.status === "rendering");
  const overall = batch.length === 0 ? 0 : batch.reduce((sum, c) => sum + (c.render.status === "done" ? 1 : c.render.status === "rendering" ? c.render.progress : 0), 0) / batch.length;
  const ready = project.stages.download.status === "done";

  const render = async () => {
    setBusy(true);
    try {
      await flushAll();
      const ids = todo.map((c) => c.id);
      applyProject(await api.render(project.id, ids));
      setBatchIds(ids);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      applyProject(await api.cancelRender(project.id));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-4 py-2.5">
      {active.length > 0 ? (
        <>
          <Button variant="danger" onClick={() => void cancel()} disabled={busy}>
            <X className="size-4" aria-hidden /> Cancel render
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
            <span className="text-sm whitespace-nowrap text-zinc-200">
              Rendering {active.length} clip{active.length === 1 ? "" : "s"}
            </span>
            <ProgressBar value={overall} className="max-w-md flex-1" label="Overall render progress" />
            <span className="text-sm text-zinc-300 tabular-nums">{Math.round(overall * 100)}%</span>
          </div>
        </>
      ) : (
        <>
          <Button variant="primary" onClick={() => void render()} disabled={busy || todo.length === 0 || !ready}>
            <Clapperboard className="size-4" aria-hidden /> Render {todo.length} selected
          </Button>
          <span className="text-xs text-zinc-400">
            {todo.length === 0 ? (clips.some((c) => c.selected) ? "Every selected clip is already rendered." : "Tick clips in the list to render them.") : "Sequential, one clip at a time."}
          </span>
        </>
      )}
      <span className="flex-1" />
      <span className="inline-flex items-center gap-1.5 text-sm text-zinc-300">
        <CheckCircle2 className={finished > 0 ? "size-4 text-emerald-400" : "size-4 text-zinc-600"} aria-hidden />
        {finished} finished
      </span>
    </div>
  );
}
