import {
  Copy,
  Flag,
  Loader2,
  Mic,
  Music,
  Palette,
  Sparkles,
  Sticker,
  Trash2,
  Type,
  Vibrate,
  Zap,
  ZoomIn,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { ITEM_LIMITS, MAX_TIMELINE_ITEMS, TEASER_LIMITS } from "../../../shared/effects";
import { computeLayout } from "../../../shared/layout";
import {
  OUTPUT_SIZE,
  type Clip,
  type ClipTimeline,
  type LibraryItem,
  type Project,
  type TimelineItem,
} from "../../../shared/types";
import { api, errorMessage } from "../../lib/api";
import { clamp, cn } from "../../lib/format";
import type { ClipEdit } from "../../lib/hooks";
import { usePlayer, type Player } from "../../lib/player";
import {
  assignLanes,
  BLOCK_CLASS,
  blockKind,
  focusPoints,
  isEmpty,
  itemLabel,
  itemProblem,
  maxLength,
  newItemId,
  placeItem,
  PLAIN_LENGTH,
  plainItem,
  round3,
  snapToGrid,
  SNAP_PX,
  stickerItem,
  STICKER_LENGTH,
  teaserFrom,
  TRACKS,
  trackOf,
  type BlockKind,
  type PlainKind,
  type Span,
  type TrackId,
} from "../../lib/timeline";
import { useLibrary } from "../LibraryDialog";
import { Button } from "../ui";

/** Id the selection uses for the teaser block. */
export const TEASER_ID = "teaser";

const LABEL_WIDTH = 84;
const RULER_HEIGHT = 24;
const LANE_HEIGHT = 26;
const DRAG_THRESHOLD = 3;

const ICONS: Record<BlockKind, typeof ZoomIn> = {
  zoom: ZoomIn,
  shake: Vibrate,
  flash: Zap,
  look: Palette,
  overlay: Type,
  sticker: Sticker,
  sound: Music,
  voice: Mic,
  teaser: Flag,
};

type Mode = "move" | "left" | "right";

interface Drag {
  id: string;
  mode: Mode;
  x0: number;
  orig: Span;
  moved: boolean;
  /** Last position the checks accepted; what the block shows and what is committed on release. */
  valid: Span;
}

interface Notice {
  tone: "info" | "error";
  text: string;
}

interface Props {
  project: Project;
  clip: Clip;
  player: Player;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  flushAll: () => Promise<void>;
  applyProject: (p: Project) => void;
  /** The selected item's id, TEASER_ID for the teaser, or null. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Switch the preview column to the live canvas (where the effects show). */
  onShowPreview: () => void;
}

/** Ruler step in seconds: the first one that leaves at least 56 px between labels. */
function tickStep(pps: number): number {
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 56) ?? 120;
}

function fmtTick(rel: number): string {
  if (rel >= 60) return `${Math.floor(rel / 60)}:${String(Math.round(rel % 60)).padStart(2, "0")}`;
  return `${Number(rel.toFixed(1))}s`;
}

export function Timeline({
  project,
  clip,
  player,
  edit,
  flushAll,
  applyProject,
  selected,
  onSelect,
  onShowPreview,
}: Props) {
  const library = useLibrary();
  const items = clip.timeline.items;
  const teaser = clip.timeline.teaser;
  const length = clip.end - clip.start;
  const locked = clip.render.status === "queued" || clip.render.status === "rendering";

  const time = usePlayer(player, (p) => p.time);
  const playhead = clamp(time, clip.start, clip.end);

  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const pps = width > 0 ? width / length : 0;

  const [drag, setDrag] = useState<{ id: string; span: Span } | null>(null);
  const [range, setRange] = useState<Span | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ai, setAi] = useState<"replace" | "append" | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const marquee = useRef<{ t0: number; moved: boolean } | null>(null);
  const scrubbing = useRef(false);

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

  const commit = (next: ClipTimeline) => edit(clip.id, { timeline: next }, true);
  const clipSpan: Span = { start: clip.start, end: clip.end };

  /** Latest values for pointer handlers, which outlive the render that created them. */
  const latest = useRef({ items, teaser, pps, playhead, clip, byFile: library.byFile });
  useLayoutEffect(() => {
    latest.current = { items, teaser, pps, playhead, clip, byFile: library.byFile };
  });

  const timeAt = (clientX: number): number => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box || latest.current.pps === 0) return clip.start;
    return clamp(clip.start + (clientX - box.left) / latest.current.pps, clip.start, clip.end);
  };

  // --- what a drag may do -----------------------------------------------------------------------------------------

  const problemOf = (id: string, span: Span): string | null => {
    const { items: all, byFile, clip: c } = latest.current;
    if (id === TEASER_ID) {
      const len = span.end - span.start;
      if (len < TEASER_LIMITS.min - 1e-6 || len > TEASER_LIMITS.max + 1e-6)
        return `The teaser is ${TEASER_LIMITS.min}-${TEASER_LIMITS.max} s long`;
      return null;
    }
    const item = all.find((i) => i.id === id);
    return item ? itemProblem(all, { ...item, ...span }, byFile, c.start) : null;
  };

  const propose = (d: Drag, dt: number): Span => {
    const { pps: k, playhead: ph, items: all, byFile, clip: c } = latest.current;
    const isTeaser = d.id === TEASER_ID;
    const minLen = isTeaser ? TEASER_LIMITS.min : ITEM_LIMITS.min;
    const item = all.find((i) => i.id === d.id);
    const maxLen = isTeaser ? TEASER_LIMITS.max : item ? maxLength(item, byFile) : ITEM_LIMITS.max;
    const grid = (t: number) => (Math.abs(t - ph) * k <= SNAP_PX ? ph : c.start + snapToGrid(t - c.start));
    if (d.mode === "move") {
      const dur = d.orig.end - d.orig.start;
      let start = d.orig.start + dt;
      if (Math.abs(start - ph) * k <= SNAP_PX) start = ph;
      else if (Math.abs(start + dur - ph) * k <= SNAP_PX) start = ph - dur;
      else start = c.start + snapToGrid(start - c.start);
      start = clamp(start, c.start, Math.max(c.start, c.end - dur));
      return { start: round3(start), end: round3(start + dur) };
    }
    if (d.mode === "left") {
      const end = d.orig.end;
      const start = clamp(grid(d.orig.start + dt), Math.min(c.start, d.orig.start), end - minLen);
      return { start: round3(Math.max(start, end - maxLen)), end };
    }
    const start = d.orig.start;
    const end = Math.max(start + minLen, Math.min(grid(d.orig.end + dt), c.end));
    return { start, end: round3(Math.min(end, start + maxLen)) };
  };

  const beginDrag = (e: PointerEvent<HTMLElement>, id: string, span: Span) => {
    e.stopPropagation();
    onSelect(id);
    onShowPreview();
    if (locked || ai) return;
    const edge = (e.target as HTMLElement).dataset.edge;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      mode: edge === "left" || edge === "right" ? edge : "move",
      x0: e.clientX,
      orig: span,
      moved: false,
      valid: span,
    };
  };

  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    d.moved = true;
    const next = propose(d, dx / latest.current.pps);
    const problem = problemOf(d.id, next);
    if (problem) {
      setNotice({ tone: "error", text: `${problem}. The block stays where it was.` });
      return;
    }
    setNotice(null);
    d.valid = next;
    setDrag({ id: d.id, span: next });
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.moved || (d.valid.start === d.orig.start && d.valid.end === d.orig.end)) return;
    const { items: all, teaser: t } = latest.current;
    commit(
      d.id === TEASER_ID
        ? { items: all, teaser: d.valid }
        : { items: all.map((i) => (i.id === d.id ? { ...i, ...d.valid } : i)), teaser: t },
    );
  };

  // --- playhead and range selection --------------------------------------------------------------------------------

  const scrubDown = (e: PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    player.seek(timeAt(e.clientX));
  };
  const scrubMove = (e: PointerEvent<HTMLElement>) => {
    if (scrubbing.current) player.seek(timeAt(e.clientX));
  };
  const scrubUp = () => {
    scrubbing.current = false;
  };

  const trackDown = (e: PointerEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    marquee.current = { t0: timeAt(e.clientX), moved: false };
  };
  const trackMove = (e: PointerEvent<HTMLElement>) => {
    const m = marquee.current;
    if (!m) return;
    const t = timeAt(e.clientX);
    if (!m.moved && Math.abs(t - m.t0) * latest.current.pps < DRAG_THRESHOLD) return;
    m.moved = true;
    setRange({ start: round3(Math.min(m.t0, t)), end: round3(Math.max(m.t0, t)) });
  };
  const trackUp = (e: PointerEvent<HTMLElement>) => {
    const m = marquee.current;
    marquee.current = null;
    if (!m || m.moved) return;
    setRange(null);
    onSelect(null);
    player.seek(timeAt(e.clientX));
  };

  // --- edits ---------------------------------------------------------------------------------------------------------

  const fail = (text: string) => setNotice({ tone: "error", text });

  /** Adds an item that starts at the playhead; `make` gets the placed span. */
  const addAt = (kind: TimelineItem["kind"], seconds: number, make: (id: string, span: Span) => TimelineItem) => {
    const { items: all, playhead: ph } = latest.current;
    const placed = placeItem(all, kind, ph, seconds, clipSpan, clip.start);
    if (typeof placed === "string") return fail(placed);
    const item = make(newItemId(all), placed);
    setNotice(null);
    commit({ items: [...all, item], teaser: latest.current.teaser });
    onSelect(item.id);
    onShowPreview();
  };

  const addPlain = (kind: PlainKind) => {
    const focus = focusPoints(layout);
    const split = layout?.mode === "split";
    addAt(kind === "text" ? "overlay" : kind, PLAIN_LENGTH[kind], (id, span) =>
      plainItem(kind, id, span, focus, split),
    );
  };

  const addSticker = (sticker: LibraryItem) =>
    addAt("overlay", STICKER_LENGTH, (id, span) => stickerItem(id, span, sticker));
  const addSound = (sound: LibraryItem) =>
    addAt("sound", Math.min(sound.duration ?? 1, ITEM_LIMITS.max), (id, span) => ({
      id,
      kind: "sound",
      ...span,
      file: sound.file,
      volume: 1,
    }));
  // The picker calls back later, so it goes through the ref and sees the playhead and items of that moment.
  const pickers = useRef({ addSticker, addSound });
  useLayoutEffect(() => {
    pickers.current = { addSticker, addSound };
  });

  const selectedItem = items.find((i) => i.id === selected) ?? null;
  const hasSelection = selectedItem !== null || (selected === TEASER_ID && teaser !== null);

  const remove = () => {
    if (selected === TEASER_ID) commit({ items, teaser: null });
    else if (selectedItem) commit({ items: items.filter((i) => i.id !== selectedItem.id), teaser });
    else return;
    setNotice(null);
    onSelect(null);
  };

  const duplicate = () => {
    if (!selectedItem) return;
    const len = selectedItem.end - selectedItem.start;
    const placed = placeItem(items, selectedItem.kind, selectedItem.end, len, clipSpan, clip.start);
    if (typeof placed === "string") return fail(placed);
    const id = newItemId(items);
    const copy: TimelineItem =
      selectedItem.kind === "overlay"
        ? { ...selectedItem, ...placed, id, element: { ...selectedItem.element, id } }
        : { ...selectedItem, ...placed, id };
    setNotice(null);
    commit({ items: [...items, copy], teaser });
    onSelect(id);
  };

  /** The teaser comes from the dragged range, else from the selected item, else 2 s at the playhead. */
  const setTeaser = () => {
    const want: Span = range ?? (selectedItem ? selectedItem : { start: playhead, end: playhead + 2 });
    const next = teaserFrom(want, clipSpan);
    setNotice(null);
    commit({ items, teaser: next });
    onSelect(TEASER_ID);
    setRange(null);
  };

  const nudge = (delta: number) => {
    const id = selected;
    if (!id) return;
    const current = id === TEASER_ID ? teaser : selectedItem;
    if (!current) return;
    const dur = current.end - current.start;
    const start = round3(clamp(current.start + delta, clip.start, Math.max(clip.start, clip.end - dur)));
    const span = { start, end: round3(start + dur) };
    const problem = problemOf(id, span);
    if (problem) return fail(problem);
    setNotice(null);
    commit(
      id === TEASER_ID
        ? { items, teaser: span }
        : { items: items.map((i) => (i.id === id ? { ...i, ...span } : i)), teaser },
    );
  };

  const runAi = async (replace: boolean) => {
    if (
      replace &&
      !isEmpty(clip.timeline) &&
      !window.confirm("Replace the current timeline (items and teaser) with a new AI edit?")
    )
      return;
    setAi(replace ? "replace" : "append");
    setNotice(null);
    try {
      await flushAll();
      applyProject(await api.autoEdit(project.id, clip.id, replace));
      onSelect(null);
      setNotice({ tone: "info", text: replace ? "AI edit applied." : "AI items added." });
    } catch (e) {
      setNotice({ tone: "error", text: `AI edit failed: ${errorMessage(e)}` });
    } finally {
      setAi(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || locked || ai) return;
    if ((e.key === "Delete" || e.key === "Backspace") && hasSelection) {
      e.preventDefault();
      remove();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedItem) {
      e.preventDefault();
      duplicate();
    } else if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      hasSelection &&
      target.dataset.block !== undefined
    ) {
      e.preventDefault();
      nudge((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.5 : 0.05));
    }
  };

  // --- layout of the rows --------------------------------------------------------------------------------------------

  const lanes = useMemo(() => {
    const result = new Map<TrackId, { of: Map<string, number>; count: number }>();
    for (const track of TRACKS) {
      const inTrack = items.filter((i) => trackOf(i) === track.id);
      const of = assignLanes(inTrack);
      result.set(track.id, { of, count: Math.max(1, ...[...of.values()].map((l) => l + 1)) });
    }
    result.set("teaser", { of: new Map(), count: 1 });
    return result;
  }, [items]);

  const outside = items.filter((i) => i.end <= clip.start || i.start >= clip.end).length;
  const step = pps > 0 ? tickStep(pps) : 1;
  const ticks = pps > 0 ? Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step) : [];
  const px = (t: number) => (t - clip.start) * pps;

  const renderBlock = (id: string, kind: BlockKind, label: string, span: Span, lane: number) => {
    const shown = drag?.id === id ? drag.span : span;
    const from = Math.max(shown.start, clip.start);
    const to = Math.min(shown.end, clip.end);
    if (to <= from) return null;
    const Icon = ICONS[kind];
    const isSelected = selected === id;
    return (
      <div
        key={id}
        role="button"
        tabIndex={0}
        data-block=""
        data-testid={`block-${id}`}
        aria-pressed={isSelected}
        aria-label={`${label}, ${(shown.start - clip.start).toFixed(2)} to ${(shown.end - clip.start).toFixed(2)} seconds`}
        title={`${label} · ${(shown.start - clip.start).toFixed(2)}-${(shown.end - clip.start).toFixed(2)} s`}
        onPointerDown={(e) => beginDrag(e, id, span)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onFocus={() => !isSelected && onSelect(id)}
        className={cn(
          "absolute flex cursor-grab touch-none items-center gap-1 overflow-hidden rounded border px-1.5 text-[11px] leading-none font-medium select-none active:cursor-grabbing",
          BLOCK_CLASS[kind],
          isSelected && "z-10 ring-2 ring-white",
        )}
        style={{
          left: px(from),
          width: Math.max(8, px(to) - px(from)),
          top: 2 + lane * LANE_HEIGHT,
          height: LANE_HEIGHT - 4,
        }}
      >
        <span data-edge="left" className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/25" />
        <Icon className="pointer-events-none size-3 shrink-0" aria-hidden />
        <span className="pointer-events-none truncate">{label}</span>
        <span data-edge="right" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/25" />
      </div>
    );
  };

  const toolButton = (kind: PlainKind, label: string, Icon: typeof ZoomIn, title: string) => (
    <Button key={kind} small onClick={() => addPlain(kind)} title={title}>
      <Icon className="size-3.5" aria-hidden /> {label}
    </Button>
  );

  const busy = ai !== null;

  return (
    // Keys bubble up from the focusable blocks; the section itself is not a control.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <section
      aria-label="Timeline"
      className="rounded-lg border border-zinc-800 bg-zinc-900"
      onKeyDown={onKeyDown}
      data-testid="timeline"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Timeline</h2>
        <fieldset disabled={locked || busy} className="flex min-w-0 flex-wrap items-center gap-1.5 disabled:opacity-60">
          <legend className="sr-only">Add to the timeline at the playhead</legend>
          {toolButton("zoom", "Zoom", ZoomIn, "Punch-in zoom, 1 s")}
          {toolButton("shake", "Shake", Vibrate, "Camera shake, 1 s")}
          {toolButton("flash", "Flash", Zap, "White flash, 0.3 s")}
          {toolButton("look", "Look", Palette, "Deep fry / black & white / blur, 1 s")}
          {toolButton("text", "Text", Type, "Text overlay, 2 s")}
          <Button
            small
            onClick={() => library.open({ kind: "sticker", onPick: (item) => pickers.current.addSticker(item) })}
            title="Sticker from the library"
          >
            <Sticker className="size-3.5" aria-hidden /> Sticker
          </Button>
          <Button
            small
            onClick={() => library.open({ kind: "sound", onPick: (item) => pickers.current.addSound(item) })}
            title="Sound from the library"
          >
            <Music className="size-3.5" aria-hidden /> Sound
          </Button>
          {toolButton("voice", "Voice", Mic, "Voice distortion of the clip's audio, 1 s")}
        </fieldset>
        <span className="hidden h-5 w-px bg-zinc-700 md:block" aria-hidden />
        <fieldset disabled={locked || busy} className="flex flex-wrap items-center gap-1.5 disabled:opacity-60">
          <legend className="sr-only">Edit the selection</legend>
          <Button small onClick={duplicate} disabled={!selectedItem} title="Duplicate the selected item (Ctrl/Cmd+D)">
            <Copy className="size-3.5" aria-hidden /> Duplicate
          </Button>
          <Button
            small
            onClick={remove}
            disabled={!hasSelection}
            title="Delete the selected item (Delete)"
            className="text-red-300"
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
          <Button
            small
            onClick={setTeaser}
            title="Teaser: a 0.5-4 s replay of the finished clip played first. Uses the range you drag on the tracks, else the selected item, else 2 s at the playhead."
          >
            <Flag className="size-3.5" aria-hidden /> Set teaser
          </Button>
        </fieldset>
        <span className="flex-1" />
        <fieldset disabled={locked || busy} className="flex items-center gap-1.5 disabled:opacity-60">
          <legend className="sr-only">AI edit</legend>
          <Button
            small
            variant="primary"
            onClick={() => void runAi(true)}
            title="Let the AI place zooms, overlays, sounds and a teaser. Replaces the timeline."
          >
            {ai === "replace" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            {ai === "replace" ? "Editing..." : "AI edit"}
          </Button>
          <Button
            small
            onClick={() => void runAi(false)}
            title="Add AI items next to the current ones; zooms that would overlap are dropped"
          >
            {ai === "append" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {ai === "append" ? "Adding..." : "Append AI edit"}
          </Button>
        </fieldset>
        <span className="text-xs text-zinc-400 tabular-nums">
          {items.length}/{MAX_TIMELINE_ITEMS}
        </span>
      </header>

      <div className="overflow-x-auto p-3">
        <div className="flex min-w-[32rem] select-none">
          <div className="flex-none" style={{ width: LABEL_WIDTH }}>
            <div style={{ height: RULER_HEIGHT }} />
            {TRACKS.map((track) => (
              <div
                key={track.id}
                className="flex items-center border-t border-zinc-800 pr-2 text-xs font-medium text-zinc-400"
                style={{ height: (lanes.get(track.id)?.count ?? 1) * LANE_HEIGHT + 4 }}
              >
                {track.label}
              </div>
            ))}
          </div>

          <div ref={areaRef} className="relative min-w-0 flex-1">
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the ruler is a pointer scrubber; the slider under the preview is the keyboard path */}
            <div
              onPointerDown={scrubDown}
              onPointerMove={scrubMove}
              onPointerUp={scrubUp}
              onPointerCancel={scrubUp}
              className="relative cursor-pointer touch-none overflow-hidden rounded-t bg-zinc-950"
              style={{ height: RULER_HEIGHT }}
              data-testid="ruler"
            >
              {ticks.map((t) => (
                <span
                  key={t}
                  className="pointer-events-none absolute inset-y-0 border-l border-zinc-700 pl-1 text-[10px] leading-6 text-zinc-400 tabular-nums"
                  style={{ left: t * pps }}
                >
                  {fmtTick(t)}
                </span>
              ))}
            </div>

            {TRACKS.map((track) => {
              const { of, count } = lanes.get(track.id)!;
              return (
                // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- empty space seeks or selects a range; blocks are the keyboard path
                <div
                  key={track.id}
                  data-testid={`track-${track.id}`}
                  onPointerDown={trackDown}
                  onPointerMove={trackMove}
                  onPointerUp={trackUp}
                  onPointerCancel={() => (marquee.current = null)}
                  className="relative touch-none border-t border-zinc-800 bg-zinc-950/50"
                  style={{ height: count * LANE_HEIGHT + 4 }}
                >
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className="pointer-events-none absolute inset-y-0 border-l border-zinc-800/70"
                      style={{ left: t * pps }}
                    />
                  ))}
                  {track.id === "teaser"
                    ? teaser && renderBlock(TEASER_ID, "teaser", "Teaser", teaser, 0)
                    : items
                        .filter((i) => trackOf(i) === track.id)
                        .map((item) =>
                          renderBlock(
                            item.id,
                            blockKind(item),
                            itemLabel(item, library.byFile),
                            item,
                            of.get(item.id) ?? 0,
                          ),
                        )}
                  {track.id === "effects" && items.length === 0 && (
                    <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-xs text-zinc-500">
                      Nothing here yet. Add an item at the playhead, or try AI edit.
                    </span>
                  )}
                  {track.id === "teaser" && !teaser && (
                    <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-xs text-zinc-500">
                      Optional: replay a moment first. Only in the rendered file.
                    </span>
                  )}
                </div>
              );
            })}

            {range && (
              <div
                className="pointer-events-none absolute inset-y-0 border-x border-white/50 bg-white/10"
                style={{ left: px(range.start), width: Math.max(1, px(range.end) - px(range.start)) }}
                data-testid="range"
              />
            )}
            <div
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-rose-400"
              style={{ left: px(playhead) }}
              data-testid="playhead"
            >
              <span className="absolute -top-px -left-1.5 size-3 rounded-b-full bg-rose-400" />
            </div>
          </div>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-xs">
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={notice.tone === "error" ? "text-red-300" : "text-emerald-300"}
          >
            {notice.text}
          </p>
        ) : (
          <p className="text-zinc-500">
            Click the ruler to seek. Drag blocks to move, their edges to resize (snaps to 0.05 s and the playhead). Drag
            on empty track space to pick a range. Delete removes the selection.
          </p>
        )}
        {outside > 0 && (
          <span className="text-amber-300">
            {outside} item{outside === 1 ? " lies" : "s lie"} outside this clip and {outside === 1 ? "is" : "are"} not
            rendered.
          </span>
        )}
        {locked && <span className="text-amber-300">Locked while this clip is rendering.</span>}
      </footer>
    </section>
  );
}
