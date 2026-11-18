import { ChevronDown, ChevronUp, ImagePlus, Loader2, Trash2, Type } from "lucide-react";
import { useRef, useState } from "react";

import { CAPTION_FONTS } from "../../shared/captions";
import type { Clip, Project, Watermark } from "../../shared/types";
import { MAX_WATERMARKS } from "../../shared/watermark";
import { api, ASSET_TYPES, errorMessage, MAX_ASSET_BYTES, media, uploadAsset } from "../lib/api";
import { clamp, cn } from "../lib/format";
import type { ClipEdit } from "../lib/hooks";
import { loadAssetImage } from "../lib/images";
import { useToast } from "../lib/toast";
import { newImageWatermark, newTextWatermark, WM_SIZE, WM_STROKE_MAX, WM_TEXT_MAX, WM_WIDTH } from "../lib/watermarks";
import { ColorField, Slider } from "./CustomLayoutPanel";
import { Button, inputClass, Panel, ProgressBar } from "./ui";

interface Props {
  project: Project;
  clip: Clip;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  flushAll: () => Promise<void>;
  applyProject: (p: Project) => void;
  /** Show the live canvas, where the overlay boxes are. */
  onShowPreview: () => void;
}

/** Whole-number field that commits while typing when the value is valid and snaps back on blur. */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft ?? String(Math.round(value))}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onCommit(clamp(Math.round(n), min, max));
        }}
        onBlur={() => setDraft(null)}
        className={cn(inputClass, "tabular-nums")}
      />
    </label>
  );
}

/** Text field of a text overlay: commits non-blank values while typing, restores the stored value on blur. */
function TextField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex justify-between">
        <span>Text</span>
        <span className="tabular-nums">
          {(draft ?? value).length}/{WM_TEXT_MAX}
        </span>
      </span>
      <input
        type="text"
        maxLength={WM_TEXT_MAX}
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim() !== "") onCommit(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={inputClass}
      />
    </label>
  );
}

const label = (wm: Watermark) => (wm.kind === "text" ? wm.text : wm.file);

export function WatermarkPanel({
  project,
  clip,
  edit,
  flushAll,
  applyProject,
  selected,
  onSelect,
  onShowPreview,
}: Props) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ fraction: number } | null>(null);
  const list = clip.settings.watermarks;
  const current = list.find((w) => w.id === selected) ?? null;
  const full = list.length >= MAX_WATERMARKS;
  const [copying, setCopying] = useState(false);
  const others = project.clips.filter((c) => c.id !== clip.id);

  const commit = (next: Watermark[], immediate = false) => edit(clip.id, { settings: { watermarks: next } }, immediate);
  const patch = (id: string, change: Partial<Watermark>, immediate = false) =>
    commit(
      list.map((w) => (w.id === id ? ({ ...w, ...change } as Watermark) : w)),
      immediate,
    );
  const add = (wm: Watermark) => {
    commit([...list, wm], true);
    onSelect(wm.id);
    onShowPreview();
  };
  const copyToAll = async () => {
    const idle = others.filter((c) => c.render.status !== "queued" && c.render.status !== "rendering");
    const json = JSON.stringify(list);
    const targets = idle.filter((c) => JSON.stringify(c.settings.watermarks) !== json);
    const replacing = targets.filter((c) => c.settings.watermarks.length > 0).length;
    if (
      replacing > 0 &&
      !window.confirm(`This replaces the watermarks on ${replacing} other clip${replacing === 1 ? "" : "s"}.`)
    )
      return;
    setCopying(true);
    try {
      await flushAll();
      let failed = 0;
      for (const target of targets) {
        try {
          await api.patchClip(project.id, target.id, { settings: { watermarks: list } });
        } catch (e) {
          failed++;
          toast.error(new Error(`"${target.title}": ${errorMessage(e)}`));
        }
      }
      applyProject(await api.getProject(project.id));
      const copied = targets.length - failed;
      toast.info(`Copied the watermarks to ${copied} other clip${copied === 1 ? "" : "s"}`);
      const skipped = others.length - idle.length;
      if (skipped > 0) {
        toast.info(
          `Skipped ${skipped} clip${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "is" : "are"} queued or rendering`,
        );
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setCopying(false);
    }
  };

  const move = (index: number, by: -1 | 1) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    commit(next, true);
  };
  const remove = (id: string) => {
    commit(
      list.filter((w) => w.id !== id),
      true,
    );
    if (selected === id) onSelect(null);
  };

  const onFile = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    if (!ASSET_TYPES.includes(file.type)) return toast.error(new Error("Use a PNG, JPEG or WebP image"));
    if (file.size > MAX_ASSET_BYTES)
      return toast.error(new Error(`That image is ${(file.size / 1048576).toFixed(1)} MB; the limit is 15 MB`));
    setUpload({ fraction: 0 });
    try {
      const { file: name } = await uploadAsset(project.id, file, (fraction) => setUpload({ fraction }));
      const image = await loadAssetImage(project.id, name);
      add(newImageWatermark(list, name, { width: image.naturalWidth, height: image.naturalHeight }));
    } catch (e) {
      toast.error(e);
    } finally {
      setUpload(null);
    }
  };

  return (
    <Panel
      title="Watermark"
      actions={
        <span className="text-xs text-zinc-400 tabular-nums">
          {list.length}/{MAX_WATERMARKS}
        </span>
      }
    >
      <div className="flex flex-col gap-3 p-3" data-testid="wm-panel">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button small disabled={full} onClick={() => add(newTextWatermark(list))}>
            <Type className="size-3.5" aria-hidden /> Add text
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={ASSET_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => void onFile(e.target.files?.[0])}
            aria-label="Watermark image file"
          />
          <Button small disabled={full || upload !== null} onClick={() => fileInput.current?.click()}>
            {upload ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ImagePlus className="size-3.5" aria-hidden />
            )}
            Add image
          </Button>
          {full && <span className="text-[11px] text-zinc-500">At most {MAX_WATERMARKS} overlays.</span>}
        </div>
        {upload && <ProgressBar value={upload.fraction} label="Upload progress" />}

        {list.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Text or logo painted over the video, under the captions. Placed freely, with the same look in the preview
            and the render.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Watermarks, painted first to last">
            {list.map((wm, i) => (
              <li
                key={wm.id}
                className={cn(
                  "flex items-center gap-1 rounded-md border p-1",
                  wm.id === selected ? "border-emerald-400/70 bg-emerald-400/5" : "border-zinc-800",
                )}
              >
                <button
                  type="button"
                  aria-pressed={wm.id === selected}
                  onClick={() => {
                    onSelect(wm.id);
                    onShowPreview();
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-zinc-800"
                >
                  {wm.kind === "image" ? (
                    <img
                      src={media.asset(project.id, wm.file)}
                      alt=""
                      className="size-6 shrink-0 rounded-sm bg-zinc-950 object-contain"
                    />
                  ) : (
                    <Type className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  )}
                  <span className="truncate">{label(wm)}</span>
                </button>
                <Button
                  small
                  variant="ghost"
                  className="w-7 px-0"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${label(wm)} earlier (below)`}
                  title="Paint earlier"
                >
                  <ChevronUp className="size-4" aria-hidden />
                </Button>
                <Button
                  small
                  variant="ghost"
                  className="w-7 px-0"
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${label(wm)} later (above)`}
                  title="Paint later"
                >
                  <ChevronDown className="size-4" aria-hidden />
                </Button>
                <Button
                  small
                  variant="ghost"
                  className="w-7 px-0 text-red-300 hover:text-red-200"
                  onClick={() => remove(wm.id)}
                  aria-label={`Remove ${label(wm)}`}
                  title="Remove"
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {current && (
          <div
            key={current.id}
            className="flex flex-col gap-3 rounded-md border border-emerald-400/30 p-2.5"
            data-testid="wm-fields"
          >
            {current.kind === "text" ? (
              <>
                <TextField value={current.text} onCommit={(text) => patch(current.id, { text })} />
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Font
                  <select
                    value={current.font}
                    onChange={(e) => patch(current.id, { font: e.target.value }, true)}
                    className={inputClass}
                  >
                    {CAPTION_FONTS.map((f) => (
                      <option key={f.family} value={f.family}>
                        {f.family}
                      </option>
                    ))}
                  </select>
                </label>
                <Slider
                  label="Size"
                  value={current.size}
                  min={WM_SIZE.min}
                  max={WM_SIZE.max}
                  onChange={(size) => patch(current.id, { size })}
                />
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="w-12 shrink-0">Colour</span>
                  <ColorField
                    label="Text colour"
                    value={current.color}
                    onChange={(color) => patch(current.id, { color })}
                  />
                </div>
                <Slider
                  label="Outline"
                  value={current.stroke}
                  min={0}
                  max={WM_STROKE_MAX}
                  onChange={(stroke) => patch(current.id, { stroke })}
                >
                  <ColorField
                    label="Outline colour"
                    value={current.strokeColor}
                    onChange={(strokeColor) => patch(current.id, { strokeColor })}
                  />
                </Slider>
              </>
            ) : (
              <Slider
                label="Width"
                value={current.width}
                min={WM_WIDTH.min}
                max={WM_WIDTH.max}
                onChange={(width) => patch(current.id, { width })}
              />
            )}
            <Slider
              label="Opacity"
              value={Math.round(current.opacity * 100)}
              min={0}
              max={100}
              suffix="%"
              onChange={(v) => patch(current.id, { opacity: v / 100 })}
            />
            <Slider
              label="Rotation"
              value={Math.round(current.rotation)}
              min={-180}
              max={180}
              suffix="°"
              onChange={(rotation) => patch(current.id, { rotation })}
            >
              <Button small onClick={() => patch(current.id, { rotation: 0 }, true)} title="Back to level">
                Reset
              </Button>
            </Slider>
            <div className="flex gap-2">
              <NumberField
                label="X (centre)"
                value={current.x}
                min={0}
                max={1080}
                onCommit={(x) => patch(current.id, { x })}
              />
              <NumberField
                label="Y (centre)"
                value={current.y}
                min={0}
                max={1920}
                onCommit={(y) => patch(current.id, { y })}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                role="switch"
                aria-checked={current.onThumbnail}
                checked={current.onThumbnail}
                onChange={(e) => patch(current.id, { onThumbnail: e.target.checked }, true)}
                className="size-4"
              />
              Show on thumbnail
            </label>
            <p className="text-[11px] leading-snug text-zinc-500">
              On the preview: drag to move, corner handles resize, the round handle rotates (Shift snaps to 15°), arrow
              keys nudge (Shift = 10 px), Delete removes.
            </p>
          </div>
        )}

        {others.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => void copyToAll()}
            disabled={copying}
            className="w-full"
            title="Replaces the watermarks of the other clips with these; their layout and captions stay as they are"
          >
            {copying ? "Copying..." : "Copy watermarks to all clips"}
          </Button>
        )}
      </div>
    </Panel>
  );
}
