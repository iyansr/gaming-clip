import { Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CAPTION_FONTS } from "../../../shared/captions";
import { ITEM_LIMITS, TEASER_LIMITS, ZOOM_LIMITS } from "../../../shared/effects";
import { computeLayout } from "../../../shared/layout";
import {
  OUTPUT_SIZE,
  type Clip,
  type ClipTimeline,
  type LookId,
  type OverlayAnimation,
  type Project,
  type TimelineItem,
  type VoiceFx,
  type ZoomEase,
} from "../../../shared/types";
import { clamp, cn } from "../../lib/format";
import type { ClipEdit } from "../../lib/hooks";
import type { Player } from "../../lib/player";
import {
  BLOCK_CLASS,
  blockKind,
  focusPoints,
  itemLabel,
  itemProblem,
  LOOK_LABELS,
  maxLength,
  round3,
  VOICE_LABELS,
} from "../../lib/timeline";
import { WM_SIZE, WM_STROKE_MAX, WM_WIDTH } from "../../lib/watermarks";
import { ColorField, Slider } from "../CustomLayoutPanel";
import { useLibrary } from "../LibraryDialog";
import { Button, inputClass, Panel } from "../ui";
import { NumberField, TextField } from "../WatermarkPanel";
import { TEASER_ID } from "./Timeline";

interface Props {
  project: Project;
  clip: Clip;
  player: Player;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

/** Seconds field that commits a valid value on Enter or blur; `onCommit` returns why a value is refused. */
function SecondsField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (seconds: number) => string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    const parsed = draft === null || draft.trim() === "" ? Number.NaN : Number(draft);
    setDraft(null);
    if (draft === null) return;
    if (!Number.isFinite(parsed)) return setProblem("Enter a number of seconds");
    const rounded = round3(parsed);
    setProblem(rounded === round3(value) ? null : onCommit(rounded));
  };
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-400">
      {label} (s)
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? String(round3(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            setProblem(null);
          }
        }}
        aria-invalid={problem !== null}
        className={cn(inputClass, "tabular-nums")}
      />
      {problem && (
        <span role="alert" className="text-red-300">
          {problem}
        </span>
      )}
    </label>
  );
}

/** Range slider with a decimal value (the shared Slider only does whole numbers). */
function DecimalSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-zinc-200 tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={inputClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const EASES: { value: ZoomEase; label: string }[] = [
  { value: "punch", label: "Punch (snaps in 0.08 s, out 0.12 s)" },
  { value: "smooth", label: "Smooth (eases 0.4 s each way)" },
];
const LOOKS = (Object.keys(LOOK_LABELS) as LookId[]).map((value) => ({ value, label: LOOK_LABELS[value] }));
const VOICES = (Object.keys(VOICE_LABELS) as VoiceFx[]).map((value) => ({ value, label: VOICE_LABELS[value] }));
const ANIMATIONS: { value: OverlayAnimation; label: string }[] = [
  { value: "pop", label: "Pop" },
  { value: "shake", label: "Shake" },
  { value: "slide", label: "Slide in" },
  { value: "none", label: "None" },
];

/** Every field of the selected timeline item, with the limits the server enforces. */
export function Inspector({ project, clip, player, edit, selected, onSelect }: Props) {
  const library = useLibrary();
  const { items, teaser } = clip.timeline;
  const item = items.find((i) => i.id === selected) ?? null;
  const isTeaser = selected === TEASER_ID && teaser !== null;
  const locked = clip.render.status === "queued" || clip.render.status === "rendering";

  const layout = useMemo(
    () =>
      project.source
        ? computeLayout(
            { width: project.source.width, height: project.source.height },
            project.webcam.rect,
            clip.settings,
            OUTPUT_SIZE,
          )
        : null,
    [project.source, project.webcam.rect, clip.settings],
  );
  const focus = focusPoints(layout);

  if (!item && !isTeaser) return null;

  const commit = (next: ClipTimeline, immediate = false) => edit(clip.id, { timeline: next }, immediate);
  /** Replaces the selected item with `next`; sliders pass immediate = false so a drag sends one request. */
  const update = (next: TimelineItem, immediate = false) =>
    commit({ items: items.map((i) => (i.id === next.id ? next : i)), teaser }, immediate);
  const remove = () => {
    commit({ items: items.filter((i) => i.id !== selected), teaser: isTeaser ? null : teaser }, true);
    onSelect(null);
  };

  /** Applies a new span to the item or the teaser after the same checks the timeline drag makes. */
  const setSpan = (start: number, end: number): string | null => {
    const origin = clip.start;
    if (start < clip.start - 1e-6 || end > clip.end + 1e-6)
      return `Keep it inside the clip (0-${(clip.end - clip.start).toFixed(2)} s)`;
    if (isTeaser) {
      if (end - start < TEASER_LIMITS.min - 1e-6 || end - start > TEASER_LIMITS.max + 1e-6)
        return `The teaser is ${TEASER_LIMITS.min}-${TEASER_LIMITS.max} s long`;
      commit({ items, teaser: { start, end } }, true);
      return null;
    }
    if (!item) return null;
    const next = { ...item, start, end };
    const problem = itemProblem(items, next, library.byFile, origin);
    if (problem) return problem;
    update(next, true);
    return null;
  };

  const current = item ?? teaser!;
  const length = current.end - current.start;
  const kind = item ? blockKind(item) : "teaser";
  const title = item ? itemLabel(item, library.byFile) : "Teaser";
  const limitMax = item ? maxLength(item, library.byFile) : TEASER_LIMITS.max;

  return (
    <Panel
      title="Timeline item"
      actions={
        <span className="flex items-center gap-2">
          <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium capitalize", BLOCK_CLASS[kind])}>
            {kind}
          </span>
          <Button
            small
            variant="ghost"
            onClick={remove}
            disabled={locked}
            className="text-red-300 hover:text-red-200"
            aria-label={`Delete ${title}`}
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
        </span>
      }
    >
      <fieldset
        disabled={locked}
        className="flex min-w-0 flex-col gap-3 p-3 disabled:opacity-60"
        data-testid="inspector"
      >
        <legend className="sr-only">Fields of {title}</legend>
        <div className="flex gap-2">
          <SecondsField
            label="Start"
            value={current.start - clip.start}
            onCommit={(s) => {
              const start = round3(clip.start + s);
              return setSpan(start, round3(start + length));
            }}
          />
          <SecondsField
            label="Length"
            value={length}
            onCommit={(l) =>
              l > limitMax + 1e-6 ? `At most ${round3(limitMax)} s` : setSpan(current.start, round3(current.start + l))
            }
          />
        </div>
        <p className="-mt-1 text-[11px] text-zinc-500">
          Seconds from the clip start;{" "}
          {isTeaser ? `${TEASER_LIMITS.min}-${TEASER_LIMITS.max}` : `${ITEM_LIMITS.min}-${ITEM_LIMITS.max}`} s long.
        </p>

        {isTeaser && (
          <p className="text-xs leading-snug text-zinc-400">
            This range of the finished clip (effects and captions included) plays first in the rendered file, then the
            clip from its start. It is not part of the preview.
          </p>
        )}

        {item?.kind === "zoom" && (
          <>
            <DecimalSlider
              label="Zoom"
              value={item.scale}
              min={ZOOM_LIMITS.min}
              max={ZOOM_LIMITS.max}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(scale) => update({ ...item, scale: round3(scale) })}
            />
            <SelectField
              label="Ease"
              value={item.ease}
              options={EASES}
              onChange={(ease) => update({ ...item, ease }, true)}
            />
            <div className="flex flex-col gap-1.5 text-xs text-zinc-400">
              <span className="flex justify-between">
                <span>Focus</span>
                <span className="text-zinc-200 tabular-nums">
                  {Math.round(item.x * 100)}%, {Math.round(item.y * 100)}%
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                <Button
                  small
                  disabled={!focus.face}
                  onClick={() => focus.face && update({ ...item, ...focus.face }, true)}
                  title={focus.face ? "Centre of the webcam" : "This layout has no webcam"}
                >
                  Face
                </Button>
                <Button
                  small
                  disabled={!focus.action}
                  onClick={() => focus.action && update({ ...item, ...focus.action }, true)}
                  title="Centre of the gameplay"
                >
                  Action
                </Button>
                <Button small onClick={() => update({ ...item, x: 0.5, y: 0.5 }, true)} title="Centre of the frame">
                  Centre
                </Button>
              </span>
              <span className="text-[11px] text-zinc-500">
                Or pause and drag the crosshair on the preview. The focus point stays where it is on screen.
              </span>
            </div>
          </>
        )}

        {item?.kind === "shake" && (
          <DecimalSlider
            label="Intensity"
            value={item.intensity}
            min={0.1}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(intensity) => update({ ...item, intensity: round3(intensity) })}
          />
        )}

        {item?.kind === "flash" && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="w-12 shrink-0">Colour</span>
            <ColorField label="Flash colour" value={item.color} onChange={(color) => update({ ...item, color })} />
          </div>
        )}

        {item?.kind === "look" && (
          <SelectField
            label="Look"
            value={item.look}
            options={LOOKS}
            onChange={(look) => update({ ...item, look }, true)}
          />
        )}

        {item?.kind === "voice" && (
          <>
            <SelectField
              label="Voice effect"
              value={item.preset}
              options={VOICES}
              onChange={(preset) => update({ ...item, preset }, true)}
            />
            <DecimalSlider
              label="Volume"
              value={item.volume}
              min={0}
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(volume) => update({ ...item, volume: round3(clamp(volume, 0, 2)) })}
            />
            <p className="text-[11px] leading-snug text-amber-300/90">
              The preview is approximate (it never changes the playback rate); the render is exact.
            </p>
          </>
        )}

        {item?.kind === "sound" && <SoundFields item={item} player={player} update={update} />}

        {item?.kind === "overlay" && (
          <>
            <SelectField
              label="Animation"
              value={item.animation}
              options={ANIMATIONS}
              onChange={(animation) => update({ ...item, animation }, true)}
            />
            <label
              className={cn(
                "flex items-center gap-2 text-sm",
                teaser ? "cursor-pointer" : "cursor-not-allowed opacity-60",
              )}
              title={teaser ? undefined : "Set a teaser on the timeline first"}
            >
              <input
                type="checkbox"
                role="switch"
                aria-checked={item.overTeaser}
                checked={item.overTeaser}
                disabled={teaser === null}
                onChange={(e) => update({ ...item, overTeaser: e.target.checked }, true)}
                className="size-4"
              />
              Show over teaser
            </label>
            {teaser === null && (
              <p className="-mt-2 text-[11px] text-zinc-500">
                Also draws this over the hook replay from its first frame once the clip has a teaser.
              </p>
            )}
            {item.element.kind === "text" ? (
              <TextOverlayFields item={item} element={item.element} update={update} />
            ) : (
              <Slider
                label="Width"
                value={Math.round(item.element.width)}
                min={WM_WIDTH.min}
                max={WM_WIDTH.max}
                onChange={(width) => update({ ...item, element: { ...item.element, width } as typeof item.element })}
              />
            )}
            <Slider
              label="Opacity"
              value={Math.round(item.element.opacity * 100)}
              min={0}
              max={100}
              suffix="%"
              onChange={(v) => update({ ...item, element: { ...item.element, opacity: v / 100 } })}
            />
            <Slider
              label="Rotation"
              value={Math.round(item.element.rotation)}
              min={-180}
              max={180}
              suffix="°"
              onChange={(rotation) => update({ ...item, element: { ...item.element, rotation } })}
            >
              <Button small onClick={() => update({ ...item, element: { ...item.element, rotation: 0 } }, true)}>
                Reset
              </Button>
            </Slider>
            <div className="flex gap-2">
              <NumberField
                label="X (centre)"
                value={item.element.x}
                min={0}
                max={1080}
                onCommit={(x) => update({ ...item, element: { ...item.element, x } })}
              />
              <NumberField
                label="Y (centre)"
                value={item.element.y}
                min={0}
                max={1920}
                onCommit={(y) => update({ ...item, element: { ...item.element, y } })}
              />
            </div>
            <p className="text-[11px] leading-snug text-zinc-500">
              On the preview (paused, while the item is showing): drag to move, corner handles resize, the round handle
              rotates.
            </p>
          </>
        )}
      </fieldset>
    </Panel>
  );
}

function SoundFields({
  item,
  player,
  update,
}: {
  item: Extract<TimelineItem, { kind: "sound" }>;
  player: Player;
  update: (next: TimelineItem, immediate?: boolean) => void;
}) {
  const { byFile } = useLibrary();
  const sound = byFile.get(item.file);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => player.audio.stopPreview(), [player]);

  const toggle = () => {
    if (playing) {
      player.audio.stopPreview();
      return;
    }
    setPlaying(true);
    player.audio
      .previewSound(item.file, item.volume, () => setPlaying(false))
      .catch((e: unknown) => {
        console.error(e);
        setPlaying(false);
      });
  };

  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <Button
          small
          variant="secondary"
          onClick={toggle}
          aria-label={playing ? "Stop the sound" : "Play the sound"}
          className="w-8 px-0"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
        </Button>
        <span className="min-w-0 flex-1 truncate">{sound?.name ?? item.file}</span>
        {sound?.duration != null && (
          <span className="text-xs text-zinc-400 tabular-nums">{sound.duration.toFixed(1)} s</span>
        )}
      </div>
      <DecimalSlider
        label="Volume"
        value={item.volume}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(volume) => update({ ...item, volume: round3(clamp(volume, 0, 2)) })}
      />
    </>
  );
}

function TextOverlayFields({
  item,
  element,
  update,
}: {
  item: Extract<TimelineItem, { kind: "overlay" }>;
  element: Extract<Extract<TimelineItem, { kind: "overlay" }>["element"], { kind: "text" }>;
  update: (next: TimelineItem, immediate?: boolean) => void;
}) {
  const patch = (change: Partial<typeof element>, immediate = false) =>
    update({ ...item, element: { ...element, ...change } }, immediate);
  return (
    <>
      <TextField value={element.text} onCommit={(text) => patch({ text })} />
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Font
        <select value={element.font} onChange={(e) => patch({ font: e.target.value }, true)} className={inputClass}>
          {CAPTION_FONTS.map((f) => (
            <option key={f.family} value={f.family}>
              {f.family}
            </option>
          ))}
        </select>
      </label>
      <Slider
        label="Size"
        value={element.size}
        min={WM_SIZE.min}
        max={WM_SIZE.max}
        onChange={(size) => patch({ size })}
      />
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="w-12 shrink-0">Colour</span>
        <ColorField label="Text colour" value={element.color} onChange={(color) => patch({ color })} />
      </div>
      <Slider
        label="Outline"
        value={element.stroke}
        min={0}
        max={WM_STROKE_MAX}
        onChange={(stroke) => patch({ stroke })}
      >
        <ColorField
          label="Outline colour"
          value={element.strokeColor}
          onChange={(strokeColor) => patch({ strokeColor })}
        />
      </Slider>
    </>
  );
}
