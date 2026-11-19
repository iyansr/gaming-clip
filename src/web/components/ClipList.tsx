import { AlertCircle, CheckCircle2, Captions, Clapperboard, FolderOpen, ImageIcon, Loader2, Plus } from "lucide-react";

import type { Clip, ClipSource, Project } from "../../shared/types";
import { cn, FILE_MANAGER, fmtTime } from "../lib/format";
import { Badge, Button, Empty, ProgressBar } from "./ui";

export type ClipSort = "time" | "score";

interface Props {
  project: Project;
  clips: Clip[];
  activeId: string | null;
  sort: ClipSort;
  onSortChange: (sort: ClipSort) => void;
  onActivate: (id: string) => void;
  onSelect: (id: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onAdd: () => void;
  /** Queues this one clip (again, when it is already rendered). */
  onRender: (id: string) => void;
  /** Shows the rendered file in Finder / Explorer. */
  onReveal: (id: string) => void;
  /** False until the source video is downloaded. */
  canRender: boolean;
}

const SOURCE_LABEL: Record<ClipSource, string> = {
  heuristic: "Heuristic",
  llm: "LLM",
  agent: "Agent",
  manual: "Manual",
};

export function sortClips(clips: Clip[], sort: ClipSort): Clip[] {
  return [...clips].sort((a, b) => (sort === "time" ? a.start - b.start : b.score - a.score || a.start - b.start));
}

export function ClipList({
  project,
  clips,
  activeId,
  sort,
  onSortChange,
  onActivate,
  onSelect,
  onSelectAll,
  onAdd,
  onRender,
  onReveal,
  canRender,
}: Props) {
  const sorted = sortClips(clips, sort);
  const selectedCount = clips.filter((c) => c.selected).length;
  const highlights = project.stages.highlights;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <div role="group" aria-label="Sort clips" className="inline-flex rounded-md border border-zinc-700 p-0.5">
          {(["score", "time"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sort === s}
              onClick={() => onSortChange(s)}
              className={cn(
                "h-6 rounded px-2 text-xs font-medium transition-colors",
                sort === s ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {s === "time" ? "By time" : "By score"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label
          className={cn(
            "flex items-center gap-1.5 text-xs text-zinc-300",
            clips.length === 0 ? "cursor-not-allowed opacity-45" : "cursor-pointer",
          )}
        >
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = selectedCount > 0 && selectedCount < clips.length;
            }}
            checked={clips.length > 0 && selectedCount === clips.length}
            disabled={clips.length === 0}
            onChange={() => onSelectAll(selectedCount < clips.length)}
            className="size-4"
          />
          All
        </label>
        <Button variant="secondary" small onClick={onAdd} title="Add a 30 s clip at the playhead">
          <Plus className="size-3.5" aria-hidden /> Add
        </Button>
      </div>

      {sorted.length === 0 ? (
        <Empty>
          {highlights.status === "running" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Finding moments...
            </span>
          ) : highlights.status === "pending" ? (
            "Clips appear here after the highlights stage."
          ) : (
            "No clips yet. Add one at the playhead, or find moments again."
          )}
        </Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-1.5 p-2" aria-label="Clips">
          {sorted.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              active={clip.id === activeId}
              onActivate={() => onActivate(clip.id)}
              onSelect={(v) => onSelect(clip.id, v)}
              onRender={canRender ? () => onRender(clip.id) : null}
              onReveal={() => onReveal(clip.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClipCard({
  clip,
  active,
  onActivate,
  onSelect,
  onRender,
  onReveal,
}: {
  clip: Clip;
  active: boolean;
  onActivate: () => void;
  onSelect: (v: boolean) => void;
  onRender: (() => void) | null;
  onReveal: () => void;
}) {
  const r = clip.render;
  const busy = r.status === "queued" || r.status === "rendering";
  return (
    <li
      className={cn(
        "relative rounded-lg border bg-zinc-900 transition-colors",
        active ? "border-indigo-400 ring-1 ring-indigo-400/40" : "border-zinc-800 hover:border-zinc-600",
      )}
    >
      <input
        type="checkbox"
        checked={clip.selected}
        onChange={(e) => onSelect(e.target.checked)}
        aria-label={`Select "${clip.title}" for rendering`}
        className="absolute top-2.5 left-2.5 size-4"
      />
      <button
        type="button"
        onClick={onActivate}
        aria-current={active}
        className="flex w-full flex-col gap-1 rounded-lg py-2 pr-2.5 pl-9 text-left"
      >
        <span className="line-clamp-2 text-sm leading-snug font-medium text-zinc-100">
          {clip.title || "Untitled clip"}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400 tabular-nums">
          <span className="text-zinc-200">
            {fmtTime(clip.start)} - {fmtTime(clip.end)}
          </span>
          <span>{(clip.end - clip.start).toFixed(0)}s</span>
          <Badge tone={clip.score >= 80 ? "good" : clip.score >= 60 ? "info" : "neutral"} title="Highlight score">
            {Math.round(clip.score)}
          </Badge>
          <Badge tone={clip.source === "manual" ? "warn" : "neutral"}>{SOURCE_LABEL[clip.source]}</Badge>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
          <Badge>{clip.settings.layout}</Badge>
          <span
            className="inline-flex items-center gap-1"
            title={clip.settings.subtitles ? `Captions: ${clip.settings.captionStyle}` : "No captions"}
          >
            <Captions
              className={cn("size-3.5", clip.settings.subtitles ? "text-indigo-300" : "text-zinc-600")}
              aria-hidden
            />
            {clip.settings.subtitles ? clip.settings.captionStyle : "off"}
          </span>
          {clip.thumbnail.file && (
            <span className="inline-flex items-center gap-1" title="Thumbnail generated">
              <ImageIcon className="size-3.5 text-indigo-300" aria-hidden /> cover
            </span>
          )}
        </span>
        {clip.reason && <span className="line-clamp-2 text-xs leading-snug text-zinc-400">{clip.reason}</span>}
        {(r.status === "queued" || r.status === "rendering") && (
          <span className="flex items-center gap-2 text-xs text-indigo-300">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {r.status === "queued" ? "Queued" : `Rendering ${Math.round(r.progress * 100)}%`}
            <ProgressBar value={r.status === "queued" ? 0 : r.progress} className="flex-1" label="Render progress" />
          </span>
        )}
        {r.status === "done" && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden /> Rendered
          </span>
        )}
        {r.status === "error" && (
          <span className="flex items-start gap-1.5 text-xs text-red-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{" "}
            <span className="min-w-0 [overflow-wrap:anywhere]">Render failed: {r.error ?? "unknown error"}</span>
          </span>
        )}
      </button>
      {/* Outside the card button: buttons cannot nest. */}
      <div className="flex flex-wrap gap-1.5 px-2.5 pb-2 pl-9">
        <Button
          small
          variant="secondary"
          onClick={onRender ?? undefined}
          disabled={!onRender || busy}
          title={r.status === "done" ? "Render this clip again with its current settings" : "Render only this clip"}
        >
          <Clapperboard className="size-3.5" aria-hidden /> {r.status === "done" ? "Re-render" : "Render"}
        </Button>
        {r.status === "done" && (
          <Button small variant="secondary" onClick={onReveal} title={`Show the video file in ${FILE_MANAGER}`}>
            <FolderOpen className="size-3.5" aria-hidden /> Show in {FILE_MANAGER}
          </Button>
        )}
      </div>
    </li>
  );
}
