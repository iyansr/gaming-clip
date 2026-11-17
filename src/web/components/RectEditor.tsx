import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import type { Rect, Size } from "../../shared/types";
import { media } from "../lib/api";
import { clamp, cn, fmtTime } from "../lib/format";
import { inputClass } from "./ui";

/** Smallest rectangle (source px) the editors allow. */
export const RECT_MIN = 40;

export type Edge = "n" | "s" | "e" | "w";

/** `outer` centres the handle on the box edge; `inner` keeps it inside (for boxes that touch the clipped frame edge). */
export const HANDLES: { id: string; edges: Edge[]; outer: string; inner: string; cursor: string }[] = [
  { id: "nw", edges: ["n", "w"], outer: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", inner: "left-0 top-0", cursor: "nwse-resize" },
  { id: "n", edges: ["n"], outer: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", inner: "left-1/2 top-0 -translate-x-1/2", cursor: "ns-resize" },
  { id: "ne", edges: ["n", "e"], outer: "left-full top-0 -translate-x-1/2 -translate-y-1/2", inner: "right-0 top-0", cursor: "nesw-resize" },
  { id: "e", edges: ["e"], outer: "left-full top-1/2 -translate-x-1/2 -translate-y-1/2", inner: "right-0 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", edges: ["s", "e"], outer: "left-full top-full -translate-x-1/2 -translate-y-1/2", inner: "right-0 bottom-0", cursor: "nwse-resize" },
  { id: "s", edges: ["s"], outer: "left-1/2 top-full -translate-x-1/2 -translate-y-1/2", inner: "left-1/2 bottom-0 -translate-x-1/2", cursor: "ns-resize" },
  { id: "sw", edges: ["s", "w"], outer: "left-0 top-full -translate-x-1/2 -translate-y-1/2", inner: "bottom-0 left-0", cursor: "nesw-resize" },
  { id: "w", edges: ["w"], outer: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", inner: "left-0 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
];

interface Drag {
  edges: Edge[] | null;
  startX: number;
  startY: number;
  rect: Rect;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/** Source frame with one draggable, resizable rectangle (source pixels) on top. */
export function RectStage({
  projectId,
  time,
  rect,
  onChange,
  size,
  label,
  minSize = RECT_MIN,
}: {
  projectId: string;
  time: number;
  rect: Rect;
  onChange: (rect: Rect) => void;
  size: Size;
  label: string;
  minSize?: number;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const { width: sw, height: sh } = size;
  const [frameTime, setFrameTime] = useState(time);
  const [loaded, setLoaded] = useState<{ time: number; ok: boolean } | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setFrameTime(time), 250);
    return () => window.clearTimeout(id);
  }, [time]);
  const frameState = loaded?.time !== frameTime ? "loading" : loaded.ok ? "ready" : "error";

  const beginDrag = (e: PointerEvent, edges: Edge[] | null) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { edges, startX: e.clientX, startY: e.clientY, rect };
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = stage.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = ((e.clientX - d.startX) / box.width) * sw;
    const dy = ((e.clientY - d.startY) / box.height) * sh;
    const r = d.rect;
    if (!d.edges) {
      onChange({ ...r, x: Math.round(clamp(r.x + dx, 0, sw - r.w)), y: Math.round(clamp(r.y + dy, 0, sh - r.h)) });
      return;
    }
    let x1 = r.x;
    let y1 = r.y;
    let x2 = r.x + r.w;
    let y2 = r.y + r.h;
    if (d.edges.includes("w")) x1 = clamp(r.x + dx, 0, x2 - minSize);
    if (d.edges.includes("e")) x2 = clamp(r.x + r.w + dx, x1 + minSize, sw);
    if (d.edges.includes("n")) y1 = clamp(r.y + dy, 0, y2 - minSize);
    if (d.edges.includes("s")) y2 = clamp(r.y + r.h + dy, y1 + minSize, sh);
    onChange({ x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) });
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ ...rect, x: clamp(rect.x + d[0], 0, sw - rect.w), y: clamp(rect.y + d[1], 0, sh - rect.h) });
  };

  return (
    <div ref={stage} className="relative mx-auto w-full max-w-[880px] touch-none bg-black select-none" style={{ aspectRatio: `${sw} / ${sh}` }}>
      <img
        src={media.frame(projectId, frameTime, 1280)}
        alt={`Source frame at ${fmtTime(frameTime)}`}
        draggable={false}
        onLoad={() => setLoaded({ time: frameTime, ok: true })}
        onError={() => setLoaded({ time: frameTime, ok: false })}
        className={cn("absolute inset-0 size-full object-fill transition-opacity", frameState === "ready" ? "opacity-100" : "opacity-40")}
      />
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div
          className="absolute shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
          style={{ left: pct(rect.x, sw), top: pct(rect.y, sh), width: pct(rect.w, sw), height: pct(rect.h, sh) }}
        />
      </div>
      {frameState === "loading" && <Loader2 className="absolute top-3 right-3 size-5 animate-spin text-white" aria-label="Loading frame" />}
      {frameState === "error" && <p className="absolute inset-x-0 top-3 text-center text-sm text-red-300">Could not load this frame.</p>}
      <div
        tabIndex={0}
        role="group"
        aria-label={`${label} x ${rect.x}, y ${rect.y}, ${rect.w} by ${rect.h}. Arrow keys move it.`}
        onPointerDown={(e) => beginDrag(e, null)}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKey}
        className="absolute cursor-move border-2 border-amber-400 bg-amber-400/10"
        style={{ left: pct(rect.x, sw), top: pct(rect.y, sh), width: pct(rect.w, sw), height: pct(rect.h, sh) }}
      >
        {HANDLES.map((h) => (
          <span
            key={h.id}
            data-handle={h.id}
            onPointerDown={(e) => beginDrag(e, h.edges)}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn("absolute size-3 rounded-sm border border-zinc-900 bg-amber-300", h.outer)}
            style={{ cursor: h.cursor }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * X / Y / W / H number fields; a typed value is parsed, clamped and applied on blur or Enter, an unparsable one is dropped.
 * `setField` replaces the default "clamp inside `size`" rule (the free-form layout lets boxes leave the frame and keeps aspect ratios).
 */
export function RectFields({
  rect,
  onChange,
  size,
  minSize = RECT_MIN,
  setField,
  className = "w-[408px] max-w-full",
}: {
  rect: Rect;
  onChange: (rect: Rect) => void;
  size: Size;
  minSize?: number;
  setField?: (field: keyof Rect, value: number) => Rect;
  className?: string;
}) {
  const [draft, setDraft] = useState<Partial<Record<keyof Rect, string>>>({});
  const { width: sw, height: sh } = size;

  const commitField = (field: keyof Rect) => {
    const raw = draft[field];
    setDraft((d) => {
      const { [field]: _dropped, ...rest } = d;
      return rest;
    });
    if (raw === undefined || raw.trim() === "") return;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return;
    if (setField) return onChange(setField(field, v));
    switch (field) {
      case "x":
        return onChange({ ...rect, x: clamp(v, 0, sw - rect.w) });
      case "y":
        return onChange({ ...rect, y: clamp(v, 0, sh - rect.h) });
      case "w":
        return onChange({ ...rect, w: clamp(v, minSize, sw - rect.x) });
      case "h":
        return onChange({ ...rect, h: clamp(v, minSize, sh - rect.y) });
    }
  };

  return (
    <div className={cn("grid grid-cols-4 gap-2", className)}>
      {(["x", "y", "w", "h"] as const).map((f) => (
        <label key={f} className="flex min-w-0 flex-col gap-1 text-xs text-zinc-400">
          {f.toUpperCase()} (px)
          <input
            type="number"
            value={draft[f] ?? rect[f]}
            onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
            onBlur={() => commitField(f)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitField(f);
            }}
            className={cn(inputClass, "min-w-0 tabular-nums")}
          />
        </label>
      ))}
    </div>
  );
}

export function FrameTime({ time, max, onChange }: { time: number; max: number; onChange: (t: number) => void }) {
  return (
    <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-zinc-400">
      <span className="flex justify-between">
        <span>Frame time</span>
        <span className="text-zinc-200 tabular-nums">{fmtTime(time)}</span>
      </span>
      <input type="range" min={0} max={max} step={0.5} value={time} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** Native modal dialog with the editors' shared title bar. */
export function Modal({ titleId, icon, title, extra, onClose, children }: { titleId: string; icon: ReactNode; title: string; extra?: ReactNode; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[min(980px,94vw)] max-w-none rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70"
    >
      <div className="flex max-h-[94vh] flex-col gap-3 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          {icon}
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {extra}
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
