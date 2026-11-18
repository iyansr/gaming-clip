import { Film, Replace, Trash2 } from "lucide-react";

import type { Clip, ClipSettings } from "../../../shared/types";
import { media } from "../../lib/api";
import type { ClipEdit } from "../../lib/hooks";
import { useVideoPoster } from "../../lib/posters";
import type { BookendSlot } from "../../lib/timeline";
import { useLibrary } from "../LibraryDialog";
import { Button, Panel } from "../ui";

interface Props {
  clip: Clip;
  slot: BookendSlot;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  onSelect: (ids: string[]) => void;
}

/** The intro or outro video: what it is, a small player, and replace / remove. Saved as a clip setting. */
export function BookendInspector({ clip, slot, edit, onSelect }: Props) {
  const { byFile, open } = useLibrary();
  const file = clip.settings[slot];
  const info = file ? byFile.get(file) : undefined;
  const poster = useVideoPoster(file);
  const locked = clip.render.status === "queued" || clip.render.status === "rendering";
  const title = slot === "intro" ? "Intro" : "Outro";
  if (!file) return null;

  const set = (next: string | null) =>
    edit(clip.id, { settings: { [slot]: next } satisfies Partial<ClipSettings> }, true);

  return (
    <Panel
      title={title}
      actions={
        <span className="rounded border border-violet-300 bg-violet-700 px-1.5 py-0.5 text-[11px] font-medium text-white">
          Media
        </span>
      }
    >
      <fieldset
        disabled={locked}
        className="flex min-w-0 flex-col gap-3 p-3 disabled:opacity-60"
        data-testid="inspector"
      >
        <legend className="sr-only">The {title.toLowerCase()} video</legend>
        <div className="flex items-start gap-2 text-sm">
          <Film className="mt-0.5 size-4 shrink-0 text-violet-300" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium" title={info?.name}>
              {info?.name ?? "Missing from the library"}
            </span>
            {info && (
              <span className="block text-xs text-zinc-400 tabular-nums">
                {info.duration != null ? `${info.duration.toFixed(1)} s` : "unknown length"}
                {info.width ? ` · ${info.width}×${info.height}` : ""}
              </span>
            )}
          </span>
        </div>
        {info ? (
          // oxlint-disable-next-line jsx-a11y/media-has-caption -- a library clip the user uploaded; there is no caption track
          <video
            key={file}
            src={media.library(file)}
            poster={poster ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="mx-auto aspect-[9/16] max-h-56 rounded border border-zinc-800 bg-black object-contain"
            aria-label={`${title} video preview`}
          />
        ) : (
          <p role="alert" className="text-xs text-red-300">
            This video was removed from the library. The render fails until you replace or remove it.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button
            small
            onClick={() => open({ kind: "video", onPick: (item) => set(item.file) })}
            title={`Pick or upload another video for the ${title.toLowerCase()}`}
          >
            <Replace className="size-3.5" aria-hidden /> Replace
          </Button>
          <Button
            small
            variant="ghost"
            className="text-red-300 hover:text-red-200"
            onClick={() => {
              set(null);
              onSelect([]);
            }}
            aria-label={`Remove the ${title.toLowerCase()}`}
          >
            <Trash2 className="size-3.5" aria-hidden /> Remove
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-zinc-500">
          Rendered order: intro, teaser, clip, outro. On the timeline it sits {slot === "intro" ? "before" : "after"}{" "}
          the clip's {slot === "intro" ? "0 s" : "end"}; scrub into it to see it in the preview.
        </p>
      </fieldset>
    </Panel>
  );
}
