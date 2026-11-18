import { Crosshair, Lock, Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { computeLayout } from "../../shared/layout";
import {
  OUTPUT_SIZE,
  type Clip,
  type ClipSettings,
  type LayoutMode,
  type Project,
  type Rect,
} from "../../shared/types";
import { api } from "../lib/api";
import type { CustomUi } from "../lib/custom";
import { cn, fmtSeconds, parseTime, round2, validateRange } from "../lib/format";
import type { ClipEdit } from "../lib/hooks";
import { usePlayer, type Player } from "../lib/player";
import { useToast } from "../lib/toast";
import { CaptionGallery } from "./CaptionGallery";
import { CustomLayoutPanel } from "./CustomLayoutPanel";
import { ThumbnailPanel, type CandidateState } from "./ThumbnailEditor";
import { Button, inputClass, Panel } from "./ui";

interface Props {
  project: Project;
  clip: Clip;
  player: Player;
  fontsReady: boolean;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  flushAll: () => Promise<void>;
  applyProject: (p: Project) => void;
  candidates: CandidateState;
  onShowThumbnail: () => void;
  /** Switch the preview column back to the live canvas (where the layout boxes are). */
  onShowPreview: () => void;
  onOpenWebcam: () => void;
  onDeleteClip: (clip: Clip) => void;
  customUi: CustomUi;
  onCustomUiChange: (ui: CustomUi) => void;
}

const NUDGE = 0.5;

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function SettingsPanel({
  project,
  clip,
  player,
  fontsReady,
  edit,
  flushAll,
  applyProject,
  candidates,
  onShowThumbnail,
  onShowPreview,
  onOpenWebcam,
  onDeleteClip,
  customUi,
  onCustomUiChange,
}: Props) {
  const toast = useToast();
  const [trimError, setTrimError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const duration = project.source?.duration ?? 0;
  const locked = clip.render.status === "queued" || clip.render.status === "rendering";
  const s = clip.settings;
  const hasWebcam = project.webcam.rect !== null;

  const setSettings = (settings: Partial<ClipSettings>, immediate = false) => edit(clip.id, { settings }, immediate);

  const select = (layout: LayoutMode) => {
    setSettings({ layout }, true);
    if (layout === "custom") onShowPreview();
  };

  /** The server trims titles and rejects blank ones, so only commit a trimmed non-blank title. */
  const commitTitle = () => {
    const next = titleDraft?.trim() ?? "";
    setTitleDraft(null);
    if (next !== "" && next !== clip.title) edit(clip.id, { title: next }, true);
  };

  /** Validates, then applies a new range; returns whether it was accepted. */
  const setRange = (start: number, end: number, seekTo: "start" | "end"): boolean => {
    const error = validateRange(start, end, duration);
    setTrimError(error);
    if (error) return false;
    edit(clip.id, { start, end });
    // The page effect syncs the player range after render; seeking now would clamp to the old one.
    player.setRange(start, end);
    player.seek(seekTo === "start" ? start : Math.max(start, end - 0.3));
    return true;
  };

  const layout = project.source
    ? computeLayout({ width: project.source.width, height: project.source.height }, project.webcam.rect, s, OUTPUT_SIZE)
    : null;
  const camVisible =
    layout?.mode === "split" && project.webcam.rect
      ? layout.layers.some((l) => l.role === "game" && intersects(l.src, project.webcam.rect!))
      : false;

  const applyAll = async () => {
    setApplying(true);
    try {
      await flushAll();
      applyProject(await api.patchProject(project.id, { defaults: s, applyDefaultsToClips: true }));
      toast.info(`Applied layout and caption settings to all ${project.clips.length} clips`);
    } catch (e) {
      toast.error(e);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {locked && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-800 bg-amber-950 px-3 py-2 text-xs text-amber-200"
          role="status"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden />
          This clip is {clip.render.status === "queued" ? "queued" : "rendering"}. Cancel the render to edit it.
        </div>
      )}
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3 disabled:opacity-60">
        <Panel title="Clip">
          <div className="flex flex-col gap-3 p-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Title
              <input
                type="text"
                value={titleDraft ?? clip.title}
                onFocus={() => setTitleDraft(clip.title)}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setTitleDraft(null);
                }}
                className={inputClass}
              />
            </label>

            <div className="flex flex-col gap-2">
              <TrimRow
                label="Start"
                value={clip.start}
                onCommit={(t) => setRange(t, clip.end, "start")}
                onPlayhead={() => setRange(player.time, clip.end, "start")}
                onNudge={(d) => setRange(round2(clip.start + d), clip.end, "start")}
                onBlur={() => setTrimError(null)}
                player={player}
              />
              <TrimRow
                label="End"
                value={clip.end}
                onCommit={(t) => setRange(clip.start, t, "end")}
                onPlayhead={() => setRange(clip.start, player.time, "end")}
                onNudge={(d) => setRange(clip.start, round2(clip.end + d), "end")}
                onBlur={() => setTrimError(null)}
                player={player}
              />
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">
                  Length{" "}
                  <span className="font-medium text-zinc-100 tabular-nums">{(clip.end - clip.start).toFixed(1)} s</span>
                  <span className="text-zinc-500"> (3-180 s)</span>
                </span>
                <Button
                  variant="ghost"
                  small
                  onClick={() => onDeleteClip(clip)}
                  className="text-red-300 hover:text-red-200"
                >
                  <Trash2 className="size-3.5" aria-hidden /> Delete clip
                </Button>
              </div>
              {trimError && (
                <p role="alert" className="text-xs text-red-300">
                  {trimError}
                </p>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Layout">
          <div className="flex flex-col gap-3 p-3">
            <div role="radiogroup" aria-label="Layout" className="grid grid-cols-4 gap-2">
              {(["split", "fill", "fit", "custom"] as const).map((mode) => (
                <LayoutOption key={mode} mode={mode} selected={s.layout === mode} onSelect={() => select(mode)} />
              ))}
            </div>
            {s.layout === "split" && !hasWebcam && (
              <p className="text-xs text-amber-300">
                No webcam rectangle: split falls back to fill.{" "}
                <button
                  type="button"
                  onClick={onOpenWebcam}
                  className="underline underline-offset-2 hover:text-amber-200"
                >
                  Open the webcam editor
                </button>
              </p>
            )}
            {s.layout === "custom" ? (
              <CustomLayoutPanel
                project={project}
                clip={clip}
                player={player}
                ui={customUi}
                onUiChange={onCustomUiChange}
                edit={edit}
                onApplyAll={() => void applyAll()}
                applying={applying}
              />
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  <span className="flex justify-between">
                    <span className="flex items-center gap-1">
                      <Crosshair className="size-3.5" aria-hidden /> Focus X
                    </span>
                    <span className="text-zinc-200 tabular-nums">{Math.round(s.focusX * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={s.focusX}
                    disabled={s.layout === "fit"}
                    onChange={(e) => setSettings({ focusX: Number(e.target.value) })}
                  />
                  {s.layout === "fit" && (
                    <span className="text-zinc-500">Fit shows the whole frame; focus is not used.</span>
                  )}
                </label>
                {camVisible && (
                  <p className="text-xs text-amber-300">
                    The webcam is visible in the gameplay area. Moving focus X can slide it out.
                  </p>
                )}
              </>
            )}
          </div>
        </Panel>

        <Panel title="Subtitles">
          <div className="flex flex-col gap-3 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                role="switch"
                aria-checked={s.subtitles}
                checked={s.subtitles}
                onChange={(e) => setSettings({ subtitles: e.target.checked }, true)}
                className="size-4"
              />
              Burn in captions
            </label>
            <div
              className={cn("flex flex-col gap-3", !s.subtitles && "pointer-events-none opacity-40")}
              aria-disabled={!s.subtitles}
            >
              <CaptionGallery
                value={s.captionStyle}
                onChange={(id) => setSettings({ captionStyle: id }, true)}
                fontsReady={fontsReady}
                disabled={!s.subtitles}
              />
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                <span className="flex justify-between">
                  <span>Caption vertical position</span>
                  <span className="text-zinc-200 tabular-nums">{Math.round(s.captionY * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.005}
                  value={s.captionY}
                  disabled={!s.subtitles}
                  onChange={(e) => setSettings({ captionY: Number(e.target.value) })}
                />
              </label>
            </div>
          </div>
        </Panel>
      </fieldset>

      <ThumbnailPanel
        project={project}
        clip={clip}
        player={player}
        fontsReady={fontsReady}
        candidates={candidates}
        edit={edit}
        flushAll={flushAll}
        applyProject={applyProject}
        onShow={onShowThumbnail}
      />

      <Button variant="secondary" onClick={() => void applyAll()} disabled={applying || locked} className="w-full">
        {applying ? "Applying..." : "Apply these settings to all clips"}
      </Button>
    </div>
  );
}

function TrimRow({
  label,
  value,
  onCommit,
  onBlur,
  onPlayhead,
  onNudge,
  player,
}: {
  label: string;
  value: number;
  onCommit: (t: number) => boolean;
  onBlur: () => void;
  onPlayhead: () => boolean;
  onNudge: (delta: number) => boolean;
  player: Player;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const playhead = usePlayer(player, (p) => p.time);
  /** Applies a typed value when it parses and differs; returns false when the value was rejected. */
  const commit = (text: string): boolean => {
    const t = parseTime(text);
    if (t === null) return false;
    return round2(t) === value || onCommit(round2(t));
  };
  return (
    <div className="flex items-end gap-1.5">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-400">
        {label} (s)
        <input
          type="text"
          inputMode="decimal"
          value={draft ?? fmtSeconds(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null) commit(draft);
            setDraft(null);
            onBlur();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || draft === null) return;
            if (commit(draft)) setDraft(null);
          }}
          className={cn(inputClass, "tabular-nums")}
        />
      </label>
      <Button
        variant="secondary"
        onClick={() => onNudge(-NUDGE)}
        aria-label={`${label} minus 0.5 seconds`}
        title="-0.5 s"
        className="w-9 px-0"
      >
        <Minus className="size-4" aria-hidden />
      </Button>
      <Button
        variant="secondary"
        onClick={() => onNudge(NUDGE)}
        aria-label={`${label} plus 0.5 seconds`}
        title="+0.5 s"
        className="w-9 px-0"
      >
        <Plus className="size-4" aria-hidden />
      </Button>
      <Button
        variant="secondary"
        onClick={onPlayhead}
        title={`Set ${label.toLowerCase()} to the playhead (${fmtSeconds(playhead)} s)`}
      >
        Playhead
      </Button>
    </div>
  );
}

function LayoutOption({ mode, selected, onSelect }: { mode: LayoutMode; selected: boolean; onSelect: () => void }) {
  const names: Record<LayoutMode, string> = { split: "Split", fill: "Fill", fit: "Fit", custom: "Custom" };
  const hints: Record<LayoutMode, string> = {
    split: "Webcam on top",
    fill: "Crop to fill",
    fit: "Whole frame",
    custom: "Free-form",
  };
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-md border-2 px-2 py-2 text-xs transition-colors",
        selected
          ? "border-indigo-400 bg-indigo-950/40 text-white"
          : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
      )}
    >
      <svg viewBox="0 0 36 64" className="h-14" aria-hidden>
        <rect x="0.5" y="0.5" width="35" height="63" rx="3" fill="#18181b" stroke="#52525b" />
        {mode === "split" && (
          <>
            <rect x="2" y="2" width="32" height="20" rx="2" fill="#f59e0b" />
            <rect x="2" y="24" width="32" height="38" rx="2" fill="#6366f1" />
          </>
        )}
        {mode === "fill" && <rect x="2" y="2" width="32" height="60" rx="2" fill="#6366f1" />}
        {mode === "fit" && (
          <>
            <rect x="2" y="2" width="32" height="60" rx="2" fill="#3f3f6e" />
            <rect x="2" y="23" width="32" height="18" fill="#6366f1" />
          </>
        )}
        {mode === "custom" && (
          <>
            <rect x="2" y="2" width="32" height="60" rx="2" fill="#3f3f6e" />
            <rect x="2" y="13" width="26" height="30" rx="2" fill="#6366f1" />
            <circle cx="25" cy="48" r="8" fill="#f59e0b" stroke="#fde68a" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <span className="font-medium">{names[mode]}</span>
      <span className="text-[10px] text-zinc-400">{hints[mode]}</span>
    </button>
  );
}
