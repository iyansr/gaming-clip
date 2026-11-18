import { Copy, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { ZOOM_LIMITS } from "../../../shared/effects";
import type {
  Clip,
  ClipTimeline,
  LookId,
  OverlayAnimation,
  TimelineItem,
  VoiceFx,
  ZoomEase,
} from "../../../shared/types";
import { clamp, cn } from "../../lib/format";
import type { ClipEdit } from "../../lib/hooks";
import {
  BLOCK_CLASS,
  blockKind,
  duplicateItems,
  LOOK_LABELS,
  round3,
  shiftItems,
  VOICE_LABELS,
  type BlockKind,
} from "../../lib/timeline";
import { ColorField } from "../CustomLayoutPanel";
import { useLibrary } from "../LibraryDialog";
import { Button, Panel } from "../ui";
import { DecimalSlider, SecondsField, SelectField } from "./fields";

interface Props {
  clip: Clip;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  selected: string[];
  onSelect: (ids: string[]) => void;
}

const EASES: { value: ZoomEase; label: string }[] = [
  { value: "punch", label: "Punch" },
  { value: "smooth", label: "Smooth" },
];
const LOOKS = (Object.keys(LOOK_LABELS) as LookId[]).map((value) => ({ value, label: LOOK_LABELS[value] }));
const VOICES = (Object.keys(VOICE_LABELS) as VoiceFx[]).map((value) => ({ value, label: VOICE_LABELS[value] }));
const ANIMATIONS: { value: OverlayAnimation; label: string }[] = [
  { value: "pop", label: "Pop" },
  { value: "shake", label: "Shake" },
  { value: "slide", label: "Slide in" },
  { value: "none", label: "None" },
];

type Kind = TimelineItem["kind"];
type OfKind<K extends Kind> = Extract<TimelineItem, { kind: K }>;

/**
 * Inspector for several selected items: the count and kinds, group Delete / Duplicate, a shift of their start, and,
 * when they are all of one kind, that kind's shared fields (the value shown is the first item's; editing sets all).
 */
export function MultiInspector({ clip, edit, selected, onSelect }: Props) {
  const { byFile } = useLibrary();
  const { items, teaser } = clip.timeline;
  const ids = useMemo(() => new Set(selected), [selected]);
  const members = items.filter((i) => ids.has(i.id));
  const locked = clip.render.status === "queued" || clip.render.status === "rendering";
  if (members.length < 2) return null;

  const counts = new Map<BlockKind, number>();
  for (const m of members) counts.set(blockKind(m), (counts.get(blockKind(m)) ?? 0) + 1);
  const kind = members.every((m) => m.kind === members[0]!.kind) ? members[0]!.kind : null;

  const commit = (next: ClipTimeline, immediate = false) => edit(clip.id, { timeline: next }, immediate);
  /** Sets the same fields on every selected item of kind `k`; sliders pass immediate = false so a drag is one request. */
  const apply = <K extends Kind>(k: K, patch: Partial<OfKind<K>>, immediate = false) =>
    commit({ items: items.map((i) => (ids.has(i.id) && i.kind === k ? { ...i, ...patch } : i)), teaser }, immediate);

  const remove = () => {
    commit({ items: items.filter((i) => !ids.has(i.id)), teaser }, true);
    onSelect([]);
  };
  const duplicate = () => {
    const result = duplicateItems(items, ids, { start: clip.start, end: clip.end });
    if (typeof result === "string") return result;
    commit({ items: result.items, teaser }, true);
    onSelect(result.copies);
    return null;
  };
  const shift = (seconds: number): string | null => {
    const result = shiftItems(items, ids, seconds, { start: clip.start, end: clip.end }, byFile);
    if (typeof result === "string") return result;
    if (result.delta !== 0) commit({ items: result.items, teaser }, true);
    return null;
  };

  const first = members[0]!;
  return (
    <Panel
      title={`${members.length} items selected`}
      actions={
        <Button
          small
          variant="ghost"
          onClick={remove}
          disabled={locked}
          className="text-red-300 hover:text-red-200"
          aria-label={`Delete ${members.length} items`}
        >
          <Trash2 className="size-3.5" aria-hidden /> Delete
        </Button>
      }
    >
      <fieldset
        disabled={locked}
        className="flex min-w-0 flex-col gap-3 p-3 disabled:opacity-60"
        data-testid="inspector"
      >
        <legend className="sr-only">Fields of {members.length} selected items</legend>
        <ul className="flex flex-wrap gap-1.5" aria-label="Kinds selected">
          {[...counts].map(([k, n]) => (
            <li
              key={k}
              className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium capitalize", BLOCK_CLASS[k])}
            >
              {n} {k}
            </li>
          ))}
        </ul>
        <DuplicateRow onDuplicate={duplicate} />
        <SecondsField label="Shift start by" value={0} onCommit={shift} />
        <p className="-mt-1 text-[11px] text-zinc-500">
          Moves the whole selection; it stays inside the clip. Drag any selected block, or use the arrow keys (Shift:
          0.5 s).
        </p>

        {kind === null && (
          <p className="text-xs leading-snug text-zinc-400">
            Mixed kinds: only timing and delete apply. Select items of one kind to edit their fields together.
          </p>
        )}

        {first.kind === "zoom" && kind === "zoom" && (
          <>
            <DecimalSlider
              label="Zoom"
              value={first.scale}
              min={ZOOM_LIMITS.min}
              max={ZOOM_LIMITS.max}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(scale) => apply("zoom", { scale: round3(scale) })}
            />
            <SelectField
              label="Ease"
              value={first.ease}
              options={EASES}
              onChange={(ease) => apply("zoom", { ease }, true)}
            />
          </>
        )}
        {first.kind === "shake" && kind === "shake" && (
          <DecimalSlider
            label="Intensity"
            value={first.intensity}
            min={0.1}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(intensity) => apply("shake", { intensity: round3(intensity) })}
          />
        )}
        {first.kind === "flash" && kind === "flash" && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="w-12 shrink-0">Colour</span>
            <ColorField label="Flash colour" value={first.color} onChange={(color) => apply("flash", { color })} />
          </div>
        )}
        {first.kind === "look" && kind === "look" && (
          <SelectField
            label="Look"
            value={first.look}
            options={LOOKS}
            onChange={(look) => apply("look", { look }, true)}
          />
        )}
        {first.kind === "voice" && kind === "voice" && (
          <>
            <SelectField
              label="Voice effect"
              value={first.preset}
              options={VOICES}
              onChange={(preset) => apply("voice", { preset }, true)}
            />
            <DecimalSlider
              label="Volume"
              value={first.volume}
              min={0}
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(volume) => apply("voice", { volume: round3(clamp(volume, 0, 2)) })}
            />
          </>
        )}
        {first.kind === "sound" && kind === "sound" && (
          <DecimalSlider
            label="Volume"
            value={first.volume}
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(volume) => apply("sound", { volume: round3(clamp(volume, 0, 2)) })}
          />
        )}
        {first.kind === "overlay" && kind === "overlay" && (
          <>
            <SelectField
              label="Animation"
              value={first.animation}
              options={ANIMATIONS}
              onChange={(animation) => apply("overlay", { animation }, true)}
            />
            <DecimalSlider
              label="Opacity"
              value={first.element.opacity}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(opacity) =>
                commit({
                  items: items.map((i) =>
                    ids.has(i.id) && i.kind === "overlay"
                      ? { ...i, element: { ...i.element, opacity: round3(opacity) } }
                      : i,
                  ),
                  teaser,
                })
              }
            />
          </>
        )}
      </fieldset>
    </Panel>
  );
}

/** Duplicate button that reports why the copies do not fit (zoom overlap, item limit) in place. */
function DuplicateRow({ onDuplicate }: { onDuplicate: () => string | null }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        small
        onClick={() => setProblem(onDuplicate())}
        className="self-start"
        title="Copy every selected item right after itself (Ctrl/Cmd+D)"
      >
        <Copy className="size-3.5" aria-hidden /> Duplicate
      </Button>
      {problem && (
        <span role="alert" className="text-xs text-red-300">
          {problem}
        </span>
      )}
    </div>
  );
}
