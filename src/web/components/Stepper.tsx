import { AlertCircle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { STAGE_ORDER, type Project, type StageId, type StageState } from "../../shared/types";
import { cn } from "../lib/format";
import { ProgressBar } from "./ui";

export const STAGE_LABEL: Record<StageId, string> = {
  download: "Download",
  transcribe: "Transcribe",
  highlights: "Highlights",
  webcam: "Webcam",
};

function StageIcon({ stage }: { stage: StageState }) {
  switch (stage.status) {
    case "done":
      return <CheckCircle2 className="size-4 text-emerald-400" aria-hidden />;
    case "running":
      return <Loader2 className="size-4 animate-spin text-indigo-300" aria-hidden />;
    case "error":
      return <AlertCircle className="size-4 text-red-400" aria-hidden />;
    default:
      return <Circle className="size-4 text-zinc-600" aria-hidden />;
  }
}

const STATUS_TEXT: Record<StageState["status"], string> = { pending: "Waiting", running: "Running", done: "Done", error: "Failed" };

/** Full stepper for the project header: progress and message per stage. */
export function Stepper({ project }: { project: Project }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Pipeline stages">
      {STAGE_ORDER.map((id, i) => {
        const stage = project.stages[id];
        return (
          <li
            key={id}
            data-stage={id}
            data-status={stage.status}
            className={cn(
              "flex min-w-0 flex-col gap-1 rounded-md border px-2.5 py-1.5",
              stage.status === "running" ? "border-indigo-500/60 bg-indigo-950/30" : stage.status === "error" ? "border-red-800 bg-red-950/30" : "border-zinc-800 bg-zinc-900",
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-100">
              <StageIcon stage={stage} />
              <span className="text-zinc-500 tabular-nums">{i + 1}</span>
              {STAGE_LABEL[id]}
              <span className="ml-auto text-[11px] font-normal text-zinc-400">
                {stage.status === "running" ? `${Math.round(stage.progress * 100)}%` : STATUS_TEXT[stage.status]}
              </span>
            </span>
            {stage.status === "running" ? (
              <>
                <ProgressBar value={stage.progress} label={`${STAGE_LABEL[id]} progress`} />
                <span className="truncate text-[11px] text-zinc-400" title={stage.message}>
                  {stage.message ?? "\u00a0"}
                </span>
              </>
            ) : (
              <span className="truncate text-[11px] text-zinc-400" title={stage.message}>
                {stage.status === "error" ? "See error below" : (stage.message ?? "\u00a0")}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** True while the pipeline or the render queue is doing work for this project. */
export function isProcessing(project: Project): boolean {
  const stages = STAGE_ORDER.map((s) => project.stages[s]);
  if (stages.some((s) => s.status === "running")) return true;
  if (project.clips.some((c) => c.render.status === "queued" || c.render.status === "rendering")) return true;
  return stages.some((s) => s.status === "pending") && !stages.some((s) => s.status === "error");
}

/** Compact one-line-per-stage strip for project cards. */
export function StageStrip({ project }: { project: Project }) {
  return (
    <ul className="grid grid-cols-4 gap-1" aria-label="Pipeline stages">
      {STAGE_ORDER.map((id) => {
        const stage = project.stages[id];
        const color =
          stage.status === "done" ? "bg-emerald-500" : stage.status === "error" ? "bg-red-500" : stage.status === "running" ? "bg-indigo-400" : "bg-zinc-700";
        return (
          <li key={id} className="min-w-0" data-stage={id} data-status={stage.status}>
            <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
              <div className={cn("h-full rounded-full transition-[width] duration-300", color)} style={{ width: stage.status === "running" ? `${Math.max(6, stage.progress * 100)}%` : stage.status === "pending" ? "0%" : "100%" }} />
            </div>
            <span className={cn("mt-1 flex items-center justify-between gap-1 text-[10px] leading-3", stage.status === "error" ? "text-red-300" : stage.status === "running" ? "text-indigo-300" : "text-zinc-400")}>
              <span className="truncate">{STAGE_LABEL[id]}</span>
              {stage.status === "running" && <span className="tabular-nums">{Math.round(stage.progress * 100)}%</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
