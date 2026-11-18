import { Upload } from "lucide-react";

import { LIBRARY_LIMITS } from "../../shared/library";
import type { Clip, ClipSettings } from "../../shared/types";
import type { ClipEdit } from "../lib/hooks";
import { useLibrary } from "./LibraryDialog";
import { Button, inputClass, Panel } from "./ui";

interface Props {
  clip: Clip;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
}

/** Intro and outro: library videos the render joins before and after the clip. */
export function BookendsPanel({ clip, edit }: Props) {
  const { items, byFile, open } = useLibrary();
  const videos = items.filter((i) => i.kind === "video");

  const row = (field: "intro" | "outro", label: string) => {
    const value = clip.settings[field];
    const set = (file: string | null) =>
      edit(clip.id, { settings: { [field]: file } satisfies Partial<ClipSettings> }, true);
    return (
      <div className="flex items-end gap-1.5">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-400">
          {label}
          <select value={value ?? ""} onChange={(e) => set(e.target.value || null)} className={inputClass}>
            <option value="">None</option>
            {value !== null && !byFile.has(value) && <option value={value}>Missing from the library</option>}
            {videos.map((v) => (
              <option key={v.file} value={v.file}>
                {v.name}
                {v.duration != null ? ` (${v.duration.toFixed(1)} s)` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => open({ kind: "video", onPick: (item) => set(item.file) })}
          title={`Pick or upload a video for the ${label.toLowerCase()}`}
          aria-label={`Pick or upload ${label.toLowerCase()} video`}
        >
          <Upload className="size-4" aria-hidden /> Upload
        </Button>
      </div>
    );
  };

  return (
    <Panel title="Bookends" collapsible defaultOpen={false}>
      <div className="flex flex-col gap-3 p-3">
        {row("intro", "Intro")}
        {row("outro", "Outro")}
        <p className="text-[11px] leading-snug text-zinc-500">
          Added in the rendered file only: intro, then the teaser (set on the timeline), then the clip, then the outro.
          None of them show in the preview. Videos from the library, up to {LIBRARY_LIMITS.duration.video} s.
        </p>
      </div>
    </Panel>
  );
}
