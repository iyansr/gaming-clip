import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  Film,
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
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { ITEM_LIMITS, MAX_TIMELINE_ITEMS, TEASER_LIMITS } from "../../../shared/effects";
import { computeLayout } from "../../../shared/layout";
import { LIBRARY_TYPES } from "../../../shared/library";
import {
  OUTPUT_SIZE,
  type Clip,
  type ClipSettings,
  type ClipTimeline,
  type LibraryItem,
  type Project,
  type TimelineItem,
} from "../../../shared/types";
import { api, errorMessage, libraryFileError, libraryNameOf, uploadLibraryFile } from "../../lib/api";
import { clamp, cn } from "../../lib/format";
import type { ClipEdit } from "../../lib/hooks";
import { usePlayer, type Player } from "../../lib/player";
import { useVideoPoster } from "../../lib/posters";
import {
  assignLanes,
  BLOCK_CLASS,
  blockKind,
  bookendLength,
  duplicateItems,
  focusPoints,
  INTRO_ID,
  isEmpty,
  itemLabel,
  itemProblem,
  maxLength,
  newItemId,
  OUTRO_ID,
  placeItem,
  PLAIN_LENGTH,
  plainItem,
  round3,
  shiftItems,
  snapToGrid,
  SNAP_PX,
  stickerItem,
  STICKER_LENGTH,
  teaserFrom,
  TRACKS,
  trackOf,
  type BlockKind,
  type BookendSlot,
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
/** The media row is taller so the intro/outro posters read as pictures. */
const MEDIA_HEIGHT = 46;
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
  /** Every block that moves with this one (a drag of a selected block moves the whole selection), at its start. */
  group: ReadonlySet<string> | null;
  /** Last accepted spans of the group. */
  validGroup: Map<string, Span> | null;
  /** A plain press on one of several selected blocks keeps the selection for a drag; a click then narrows it. */
  collapse: boolean;
}

/** Selection rectangle, in px from the top-left of the track area. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type EmptyPress = { kind: "range"; t0: number; moved: boolean } | { kind: "box"; moved: boolean; hits: string };

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
  /** Ids of the selected items, or TEASER_ID / INTRO_ID / OUTRO_ID alone. */
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** Switch the preview column to the live canvas (where the effects show). */
  onShowPreview: () => void;
}

/** Ruler step in seconds: the first one that leaves at least 56 px between labels. */
function tickStep(pps: number): number {
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 56) ?? 120;
}

function fmtTick(rel: number): string {
  if (rel < 0) return `-${fmtTick(-rel)}`;
  if (rel >= 60) return `${Math.floor(rel / 60)}:${String(Math.round(rel % 60)).padStart(2, "0")}`;
  return `${Number(rel.toFixed(1))}s`;
}

/** Which half of the timeline a drag is over: the left sets the intro, the right the outro. */
function zoneAt(e: DragEvent<HTMLElement>): BookendSlot {
  const a = e.currentTarget.getBoundingClientRect();
  return e.clientX < a.left + a.width / 2 ? "intro" : "outro";
}

const SLOT_LABEL: Record<BookendSlot, string> = { intro: "Intro", outro: "Outro" };

/** The intro or outro on the media row: as wide as the video, with a strip of stills behind its name. */
function BookendBlock({
  slot,
  file,
  name,
  length,
  left,
  width,
  selected,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onFocus,
}: {
  slot: BookendSlot;
  file: string;
  name: string;
  length: number | null;
  left: number;
  width: number;
  selected: boolean;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
}) {
  const poster = useVideoPoster(file);
  const label = `${SLOT_LABEL[slot]}: ${name}${length !== null ? `, ${length.toFixed(1)} s` : ""}`;
  return (
    <div
      role="button"
      tabIndex={0}
      data-block=""
      data-testid={`block-${slot}`}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cn(
        "absolute flex cursor-pointer touch-none items-end overflow-hidden rounded border border-violet-300 bg-violet-800 p-0.5 text-[11px] leading-none font-medium text-white select-none",
        selected && "z-10 ring-2 ring-white",
      )}
      style={{
        left,
        width: Math.max(8, width),
        top: 2,
        height: MEDIA_HEIGHT - 4,
        backgroundImage: poster ? `url(${poster})` : undefined,
        backgroundSize: "auto 100%",
        backgroundRepeat: "repeat-x",
      }}
    >
      <span className="pointer-events-none flex max-w-full items-center gap-1 rounded bg-black/70 px-1 py-0.5">
        <Film className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          {SLOT_LABEL[slot]} · {name}
        </span>
        {length !== null && <span className="shrink-0 text-zinc-300 tabular-nums">{length.toFixed(1)}s</span>}
      </span>
    </div>
  );
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

  // The intro and outro sit on the same time scale, before the clip's 0 s and after its end.
  const introFile = clip.settings.intro;
  const outroFile = clip.settings.outro;
  const lead = bookendLength(introFile, library.byFile);
  const tail = bookendLength(outroFile, library.byFile);
  const axisStart = clip.start - lead;
  const axisLength = lead + length + tail;

  const time = usePlayer(player, (p) => p.time);
  const segment = usePlayer(player, (p) => p.segment);
  const offset = usePlayer(player, (p) => p.offset);
  /** Where edits happen: the playhead inside the clip (at its edge while an intro or outro shows). */
  const playhead =
    segment === "intro" ? clip.start : segment === "outro" ? clip.end : clamp(time, clip.start, clip.end);
  /** Where the playhead is drawn, which can be inside a bookend. */
  const headAt =
    segment === "intro"
      ? clip.start - lead + Math.min(offset, lead)
      : segment === "outro"
        ? clip.end + Math.min(offset, tail)
        : playhead;

  const areaRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const pps = width > 0 ? width / axisLength : 0;

  const [drag, setDrag] = useState<Map<string, Span> | null>(null);
  const [range, setRange] = useState<Span | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [drop, setDrop] = useState<BookendSlot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ai, setAi] = useState<"replace" | "append" | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<EmptyPress | null>(null);
  const boxStart = useRef<{ x: number; y: number } | null>(null);
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
  const latest = useRef({
    items,
    teaser,
    pps,
    playhead,
    clip,
    byFile: library.byFile,
    axisStart,
    lead,
    tail,
    ids: selected,
  });
  useLayoutEffect(() => {
    latest.current = {
      items,
      teaser,
      pps,
      playhead,
      clip,
      byFile: library.byFile,
      axisStart,
      lead,
      tail,
      ids: selected,
    };
  });

  /** Source time under a pointer, anywhere on the axis (intro and outro included). */
  const axisAt = (clientX: number): number => {
    const rect = areaRef.current?.getBoundingClientRect();
    const { pps: k, axisStart: a0, clip: c, tail: tl } = latest.current;
    if (!rect || k === 0) return c.start;
    return clamp(a0 + (clientX - rect.left) / k, a0, c.end + tl);
  };
  /** Source time under a pointer, held inside the clip (for items and ranges). */
  const timeAt = (clientX: number): number => clamp(axisAt(clientX), clip.start, clip.end);

  /** Moves the preview to an axis time: into the intro/outro when it lies there, else into the clip. */
  const seekAxis = (t: number) => {
    const { clip: c, lead: l } = latest.current;
    if (t < c.start && l > 0) player.seekBookend("intro", Math.max(0, t - (c.start - l)));
    else if (t > c.end) player.seekBookend("outro", t - c.end);
    else player.seek(t);
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

  /** Where a moved block starts for a pointer travel of `dt` s: snapped to the playhead (either edge) or the grid. */
  const snappedStart = (d: Drag, dt: number): number => {
    const { pps: k, playhead: ph, clip: c } = latest.current;
    const dur = d.orig.end - d.orig.start;
    const start = d.orig.start + dt;
    if (Math.abs(start - ph) * k <= SNAP_PX) return ph;
    if (Math.abs(start + dur - ph) * k <= SNAP_PX) return ph - dur;
    return c.start + snapToGrid(start - c.start);
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
      const start = clamp(snappedStart(d, dt), c.start, Math.max(c.start, c.end - dur));
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

  /** Shift/Ctrl/Cmd-click: adds or drops one item. The teaser and the bookends are never part of a multi-selection. */
  const toggle = (id: string) => {
    const { items: all, ids } = latest.current;
    const base = ids.filter((s) => all.some((i) => i.id === s));
    onSelect(base.includes(id) ? base.filter((s) => s !== id) : [...base, id]);
  };

  const beginDrag = (e: PointerEvent<HTMLElement>, id: string, span: Span) => {
    e.stopPropagation();
    onShowPreview();
    const isItem = id !== TEASER_ID;
    if (isItem && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      toggle(id);
      return;
    }
    const edge = (e.target as HTMLElement).dataset.edge;
    const members = latest.current.items.filter((i) => latest.current.ids.includes(i.id));
    const grouped = isItem && !edge && members.length > 1 && members.some((i) => i.id === id);
    if (!grouped) onSelect([id]);
    setNotice(null);
    if (locked || ai) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      mode: edge === "left" || edge === "right" ? edge : "move",
      x0: e.clientX,
      orig: span,
      moved: false,
      valid: span,
      group: grouped ? new Set(members.map((i) => i.id)) : null,
      validGroup: null,
      collapse: grouped,
    };
  };

  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    d.moved = true;
    const dt = dx / latest.current.pps;
    if (d.group) {
      // The dragged block snaps; the others keep their distance to it. The group is held inside the clip.
      const { items: all, byFile, clip: c } = latest.current;
      const moved = shiftItems(
        all,
        d.group,
        snappedStart(d, dt) - d.orig.start,
        { start: c.start, end: c.end },
        byFile,
      );
      if (typeof moved === "string") {
        setNotice({ tone: "error", text: `${moved}. The selection stops at the last free position.` });
        return;
      }
      setNotice(null);
      d.validGroup = moved.moved;
      setDrag(moved.moved);
      return;
    }
    const next = propose(d, dt);
    const problem = problemOf(d.id, next);
    if (problem) {
      setNotice({ tone: "error", text: `${problem}. The block stops at the last free position.` });
      return;
    }
    setNotice(null);
    d.valid = next;
    setDrag(new Map([[d.id, next]]));
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) {
      if (d.collapse) onSelect([d.id]);
      return;
    }
    const { items: all, teaser: t } = latest.current;
    if (d.group) {
      const spans = d.validGroup;
      if (!spans || spans.get(d.id)?.start === d.orig.start) return;
      // One request for the whole move.
      commit({ items: all.map((i) => ({ ...i, ...spans.get(i.id) })), teaser: t });
      return;
    }
    if (d.valid.start === d.orig.start && d.valid.end === d.orig.end) return;
    commit(
      d.id === TEASER_ID
        ? { items: all, teaser: d.valid }
        : { items: all.map((i) => (i.id === d.id ? { ...i, ...d.valid } : i)), teaser: t },
    );
  };

  // --- playhead, range selection and the selection box --------------------------------------------------------------

  const scrubDown = (e: PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    seekAxis(axisAt(e.clientX));
  };
  const scrubMove = (e: PointerEvent<HTMLElement>) => {
    if (scrubbing.current) seekAxis(axisAt(e.clientX));
  };
  const scrubUp = () => {
    scrubbing.current = false;
  };

  /** Ids of the item blocks the box touches. */
  const itemsInBox = (b: Box): string[] => {
    const area = areaRef.current;
    if (!area) return [];
    const a = area.getBoundingClientRect();
    const [left, right] = [Math.min(b.x0, b.x1) + a.left, Math.max(b.x0, b.x1) + a.left];
    const [top, bottom] = [Math.min(b.y0, b.y1) + a.top, Math.max(b.y0, b.y1) + a.top];
    return [...area.querySelectorAll<HTMLElement>("[data-item-id]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < right && r.right > left && r.top < bottom && r.bottom > top;
      })
      .map((el) => el.dataset.itemId!);
  };

  const relative = (e: PointerEvent<HTMLElement>) => {
    const a = areaRef.current!.getBoundingClientRect();
    return { x: e.clientX - a.left, y: e.clientY - a.top };
  };

  const trackDown = (e: PointerEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    sectionRef.current?.focus({ preventScroll: true });
    setNotice(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.shiftKey || e.altKey) {
      boxStart.current = relative(e);
      press.current = { kind: "box", moved: false, hits: "" };
    } else {
      press.current = { kind: "range", t0: timeAt(e.clientX), moved: false };
    }
  };
  const trackMove = (e: PointerEvent<HTMLElement>) => {
    const m = press.current;
    if (!m) return;
    if (m.kind === "box") {
      const from = boxStart.current!;
      const to = relative(e);
      if (!m.moved && Math.hypot(to.x - from.x, to.y - from.y) < DRAG_THRESHOLD) return;
      m.moved = true;
      const next = { x0: from.x, y0: from.y, x1: to.x, y1: to.y };
      setBox(next);
      const hits = itemsInBox(next);
      if (hits.join(",") !== m.hits) {
        m.hits = hits.join(",");
        onSelect(hits);
      }
      return;
    }
    const t = timeAt(e.clientX);
    if (!m.moved && Math.abs(t - m.t0) * latest.current.pps < DRAG_THRESHOLD) return;
    m.moved = true;
    setRange({ start: round3(Math.min(m.t0, t)), end: round3(Math.max(m.t0, t)) });
  };
  const trackUp = (e: PointerEvent<HTMLElement>) => {
    const m = press.current;
    press.current = null;
    setBox(null);
    if (!m || m.moved) return;
    setRange(null);
    onSelect([]);
    seekAxis(axisAt(e.clientX));
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
    onSelect([item.id]);
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

  /** Sets (or with null clears) the intro or outro through the settings, like any other clip setting. */
  const setBookend = (slot: BookendSlot, file: string | null) => {
    setNotice(null);
    edit(clip.id, { settings: { [slot]: file } satisfies Partial<ClipSettings> }, true);
    if (file) {
      onSelect([slot === "intro" ? INTRO_ID : OUTRO_ID]);
      onShowPreview();
    } else if (latest.current.ids.includes(slot === "intro" ? INTRO_ID : OUTRO_ID)) onSelect([]);
  };

  /** A video file dropped on the timeline goes into the library, then becomes the intro or outro. */
  const uploadBookend = async (slot: BookendSlot, file: File) => {
    const problem =
      libraryFileError(file) ??
      (LIBRARY_TYPES[file.type]?.kind === "video"
        ? null
        : `${file.name}: the ${slot} has to be a video (MP4, MOV or WebM)`);
    if (problem) return fail(problem);
    const label = SLOT_LABEL[slot].toLowerCase();
    try {
      setNotice({ tone: "info", text: `Uploading the ${label}...` });
      const item = await uploadLibraryFile(file, libraryNameOf(file), (fraction) =>
        setNotice({ tone: "info", text: `Uploading the ${label}: ${Math.round(fraction * 100)}%` }),
      );
      library.upsert(item);
      pickers.current.setBookend(slot, item.file);
      setNotice({ tone: "info", text: `${SLOT_LABEL[slot]} set to "${item.name}".` });
    } catch (e) {
      fail(`Could not add the ${label}: ${errorMessage(e)}`);
    }
  };

  // The picker and the upload call back later, so they go through the ref and see the playhead and items of that moment.
  const pickers = useRef({ addSticker, addSound, setBookend });
  useLayoutEffect(() => {
    pickers.current = { addSticker, addSound, setBookend };
  });

  const sel = useMemo(() => new Set(selected), [selected]);
  const selItems = items.filter((i) => sel.has(i.id));
  const teaserSelected = selected.length === 1 && selected[0] === TEASER_ID && teaser !== null;
  const bookendSelected: BookendSlot | null =
    selected.length === 1 && selected[0] === INTRO_ID && introFile
      ? "intro"
      : selected.length === 1 && selected[0] === OUTRO_ID && outroFile
        ? "outro"
        : null;
  const hasSelection = selItems.length > 0 || teaserSelected || bookendSelected !== null;

  const remove = () => {
    if (bookendSelected) return setBookend(bookendSelected, null);
    if (teaserSelected) commit({ items, teaser: null });
    else if (selItems.length > 0) commit({ items: items.filter((i) => !sel.has(i.id)), teaser });
    else return;
    setNotice(null);
    onSelect([]);
  };

  const duplicate = () => {
    if (selItems.length === 0) return;
    const copies = duplicateItems(items, sel, clipSpan);
    if (typeof copies === "string") return fail(copies);
    setNotice(null);
    commit({ items: copies.items, teaser });
    onSelect(copies.copies);
  };

  /** The teaser comes from the dragged range, else from the selected items, else 2 s at the playhead. */
  const setTeaser = () => {
    const want: Span =
      range ??
      (selItems.length > 0
        ? { start: Math.min(...selItems.map((i) => i.start)), end: Math.max(...selItems.map((i) => i.end)) }
        : { start: playhead, end: playhead + 2 });
    const next = teaserFrom(want, clipSpan);
    setNotice(null);
    commit({ items, teaser: next });
    onSelect([TEASER_ID]);
    setRange(null);
  };

  const nudge = (delta: number) => {
    if (teaserSelected && teaser) {
      const dur = teaser.end - teaser.start;
      const start = round3(clamp(teaser.start + delta, clip.start, Math.max(clip.start, clip.end - dur)));
      const span = { start, end: round3(start + dur) };
      const problem = problemOf(TEASER_ID, span);
      if (problem) return fail(problem);
      setNotice(null);
      commit({ items, teaser: span });
      return;
    }
    if (selItems.length === 0) return;
    const moved = shiftItems(items, sel, delta, clipSpan, library.byFile);
    if (typeof moved === "string") return fail(moved);
    if (moved.delta === 0) return;
    setNotice(null);
    commit({ items: moved.items, teaser });
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
      onSelect([]);
      setNotice({ tone: "info", text: replace ? "AI edit applied." : "AI items added." });
    } catch (e) {
      setNotice({ tone: "error", text: `AI edit failed: ${errorMessage(e)}` });
    } finally {
      setAi(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (selected.length > 0 || range) {
        e.preventDefault();
        setRange(null);
        onSelect([]);
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelect(items.map((i) => i.id));
      return;
    }
    if (locked || ai) return;
    if ((e.key === "Delete" || e.key === "Backspace") && hasSelection) {
      e.preventDefault();
      remove();
    } else if (mod && e.key.toLowerCase() === "d" && selItems.length > 0) {
      e.preventDefault();
      duplicate();
    } else if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      hasSelection &&
      (target.dataset.block !== undefined || target === e.currentTarget)
    ) {
      e.preventDefault();
      nudge((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.5 : 0.05));
    }
  };

  // --- dropping a video file on the start or end of the timeline ------------------------------------------------------

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes("Files") || locked || ai) return;
    e.preventDefault();
    setDrop(zoneAt(e));
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes("Files") || locked || ai) return;
    e.preventDefault();
    setDrop(null);
    const file = e.dataTransfer.files[0];
    if (file) void uploadBookend(zoneAt(e), file);
  };

  // --- layout of the rows --------------------------------------------------------------------------------------------

  const lanes = useMemo(() => {
    const result = new Map<TrackId, { of: Map<string, number>; count: number }>();
    for (const track of TRACKS) {
      const inTrack = items.filter((i) => trackOf(i) === track.id);
      const of = assignLanes(inTrack);
      result.set(track.id, { of, count: Math.max(1, ...[...of.values()].map((l) => l + 1)) });
    }
    return result;
  }, [items]);
  const rowHeight = (id: TrackId) => (id === "media" ? MEDIA_HEIGHT : (lanes.get(id)?.count ?? 1) * LANE_HEIGHT + 4);

  const outside = items.filter((i) => i.end <= clip.start || i.start >= clip.end).length;
  const step = pps > 0 ? tickStep(pps) : 1;
  const ticks: number[] = [];
  if (pps > 0)
    for (let k = Math.ceil((-lead - 1e-9) / step); k * step <= length + tail + 1e-9; k++) ticks.push(round3(k * step));
  const px = (t: number) => (t - axisStart) * pps;

  const renderBlock = (id: string, kind: BlockKind, label: string, span: Span, lane: number) => {
    const shown = drag?.get(id) ?? span;
    const from = Math.max(shown.start, clip.start);
    const to = Math.min(shown.end, clip.end);
    if (to <= from) return null;
    const Icon = ICONS[kind];
    const isSelected = sel.has(id);
    return (
      <div
        key={id}
        role="button"
        tabIndex={0}
        data-block=""
        data-item-id={id === TEASER_ID ? undefined : id}
        data-testid={`block-${id}`}
        aria-pressed={isSelected}
        aria-label={`${label}, ${(shown.start - clip.start).toFixed(2)} to ${(shown.end - clip.start).toFixed(2)} seconds`}
        title={`${label} · ${(shown.start - clip.start).toFixed(2)}-${(shown.end - clip.start).toFixed(2)} s`}
        onPointerDown={(e) => beginDrag(e, id, span)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Only keyboard focus selects; a pointer press has already decided what is selected.
        onFocus={(e) => !isSelected && e.currentTarget.matches(":focus-visible") && onSelect([id])}
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

  const renderBookend = (slot: BookendSlot) => {
    const file = clip.settings[slot];
    if (!file) return null;
    const id = slot === "intro" ? INTRO_ID : OUTRO_ID;
    const span = slot === "intro" ? lead : tail;
    const info = library.byFile.get(file);
    return (
      <BookendBlock
        key={id}
        slot={slot}
        file={file}
        name={info?.name ?? "Missing from the library"}
        length={info?.duration ?? null}
        left={slot === "intro" ? px(clip.start - lead) : px(clip.end)}
        width={span * pps}
        selected={sel.has(id)}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect([id]);
          onShowPreview();
          scrubDown(e);
        }}
        onPointerMove={scrubMove}
        onPointerUp={scrubUp}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          onSelect([id]);
          onShowPreview();
          player.seekBookend(slot, 0);
        }}
        onFocus={(e) => !sel.has(id) && e.currentTarget.matches(":focus-visible") && onSelect([id])}
      />
    );
  };

  const toolButton = (kind: PlainKind, label: string, Icon: typeof ZoomIn, title: string) => (
    <Button key={kind} small onClick={() => addPlain(kind)} title={title}>
      <Icon className="size-3.5" aria-hidden /> {label}
    </Button>
  );

  const busy = ai !== null;
  const headX = (headAt - axisStart) * pps;

  return (
    // Keys bubble up from the focusable blocks; the section itself is not a control.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <section
      ref={sectionRef}
      aria-label="Timeline"
      tabIndex={-1}
      className="rounded-lg border border-zinc-800 bg-zinc-900 focus-visible:outline-none!"
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
          <legend className="sr-only">Intro and outro video</legend>
          <Button
            small
            onClick={() =>
              library.open({ kind: "video", onPick: (item) => pickers.current.setBookend("intro", item.file) })
            }
            title="Intro video before the clip: pick or upload from the library (or drop a video on the left half of the timeline)"
          >
            <ArrowLeftToLine className="size-3.5" aria-hidden /> Intro
          </Button>
          <Button
            small
            onClick={() =>
              library.open({ kind: "video", onPick: (item) => pickers.current.setBookend("outro", item.file) })
            }
            title="Outro video after the clip: pick or upload from the library (or drop a video on the right half of the timeline)"
          >
            <ArrowRightToLine className="size-3.5" aria-hidden /> Outro
          </Button>
        </fieldset>
        <span className="hidden h-5 w-px bg-zinc-700 md:block" aria-hidden />
        <fieldset disabled={locked || busy} className="flex flex-wrap items-center gap-1.5 disabled:opacity-60">
          <legend className="sr-only">Edit the selection</legend>
          <Button
            small
            onClick={duplicate}
            disabled={selItems.length === 0}
            title="Duplicate the selected items (Ctrl/Cmd+D)"
          >
            <Copy className="size-3.5" aria-hidden /> Duplicate
          </Button>
          <Button
            small
            onClick={remove}
            disabled={!hasSelection}
            title="Delete the selection (Delete)"
            className="text-red-300"
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
          <Button
            small
            onClick={setTeaser}
            title="Teaser: a 0.5-4 s replay of the finished clip played first. Uses the range you drag on the tracks, else the selected items, else 2 s at the playhead."
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
        {/* The selection count lives in the inspector: a longer label here wrapped the header and shifted the tracks. */}
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
                style={{ height: rowHeight(track.id) }}
              >
                {track.label}
              </div>
            ))}
          </div>

          {/* Dropping a video file on the left half sets the intro, on the right half the outro. */}
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a pointer-only drop target; the toolbar buttons are the keyboard path */}
          <div
            ref={areaRef}
            className="relative min-w-0 flex-1"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
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
              {lead > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-violet-500/20"
                  style={{ width: lead * pps }}
                />
              )}
              {tail > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 bg-violet-500/20"
                  style={{ left: px(clip.end), width: tail * pps }}
                />
              )}
              {ticks.map((t) => (
                <span
                  key={t}
                  className="pointer-events-none absolute inset-y-0 border-l border-zinc-700 pl-1 text-[10px] leading-6 text-zinc-400 tabular-nums"
                  style={{ left: px(clip.start + t) }}
                >
                  {fmtTick(t)}
                </span>
              ))}
            </div>

            {TRACKS.map((track) => {
              const { of } = lanes.get(track.id)!;
              return (
                // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- empty space seeks or selects a range; blocks are the keyboard path
                <div
                  key={track.id}
                  data-testid={`track-${track.id}`}
                  onPointerDown={trackDown}
                  onPointerMove={trackMove}
                  onPointerUp={trackUp}
                  onPointerCancel={() => {
                    press.current = null;
                    setBox(null);
                  }}
                  className="relative touch-none border-t border-zinc-800 bg-zinc-950/50"
                  style={{ height: rowHeight(track.id) }}
                >
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className="pointer-events-none absolute inset-y-0 border-l border-zinc-800/70"
                      style={{ left: px(clip.start + t) }}
                    />
                  ))}
                  {track.id === "media" && (
                    <>
                      {renderBookend("intro")}
                      {renderBookend("outro")}
                      {teaser && (
                        <span
                          className="pointer-events-none absolute z-[5] flex items-center gap-1 rounded-r border-l-2 border-amber-300 bg-amber-400/90 px-1.5 py-0.5 text-[10px] leading-none font-medium text-zinc-900"
                          style={{ left: px(clip.start), top: (MEDIA_HEIGHT - 16) / 2 }}
                        >
                          <Flag className="size-2.5" aria-hidden /> Teaser {(teaser.end - teaser.start).toFixed(1)} s ·
                          plays first
                        </span>
                      )}
                      {!introFile && !outroFile && !teaser && (
                        <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-xs text-zinc-500">
                          Intro and outro videos: use the toolbar buttons, or drop a video file on the left or right
                          half of the timeline.
                        </span>
                      )}
                    </>
                  )}
                  {track.id === "teaser"
                    ? teaser && renderBlock(TEASER_ID, "teaser", "Teaser", teaser, 0)
                    : track.id !== "media" &&
                      items
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

            {lead > 0 && (
              <div
                className="pointer-events-none absolute inset-y-0 left-0 border-r border-dashed border-violet-300/60 bg-violet-400/5"
                style={{ width: lead * pps }}
              />
            )}
            {tail > 0 && (
              <div
                className="pointer-events-none absolute inset-y-0 border-l border-dashed border-violet-300/60 bg-violet-400/5"
                style={{ left: px(clip.end), width: tail * pps }}
              />
            )}
            {range && (
              <div
                className="pointer-events-none absolute inset-y-0 border-x border-white/50 bg-white/10"
                style={{ left: px(range.start), width: Math.max(1, px(range.end) - px(range.start)) }}
                data-testid="range"
              />
            )}
            {box && (
              <div
                className="pointer-events-none absolute z-30 border border-indigo-300 bg-indigo-400/20"
                style={{
                  left: Math.min(box.x0, box.x1),
                  top: Math.min(box.y0, box.y1),
                  width: Math.abs(box.x1 - box.x0),
                  height: Math.abs(box.y1 - box.y0),
                }}
                data-testid="marquee"
              />
            )}
            {drop && (
              <div
                className="pointer-events-none absolute inset-y-0 z-30 flex items-center justify-center border-2 border-dashed border-violet-300 bg-violet-500/25 text-xs font-medium text-white"
                style={{ left: drop === "intro" ? 0 : "50%", width: "50%" }}
                data-testid="drop-zone"
              >
                Drop a video to set the {drop}
              </div>
            )}
            <div
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-rose-400"
              style={{ left: headX }}
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
            Click the ruler to seek. Drag blocks to move (snaps to 0.05 s and the playhead), their edges to resize.
            Shift/Cmd-click adds to the selection; Shift-drag on empty space draws a selection box; plain drag picks a
            range for the teaser. Esc clears, Delete removes.
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
