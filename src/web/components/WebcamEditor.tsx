import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Loader2, RotateCcw, Save, ScanFace, VideoOff, X } from "lucide-react";
import type { Project, Rect } from "../../shared/types";
import { api, media } from "../lib/api";
import { clamp, cn, fmtTime } from "../lib/format";
import { useToast } from "../lib/toast";
import { Button, inputClass } from "./ui";

const MIN_SIZE = 40;

type Edge = "n" | "s" | "e" | "w";
const HANDLES: { id: string; edges: Edge[]; style: string; cursor: string }[] = [
  { id: "nw", edges: ["n", "w"], style: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { id: "n", edges: ["n"], style: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { id: "ne", edges: ["n", "e"], style: "left-full top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { id: "e", edges: ["e"], style: "left-full top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", edges: ["s", "e"], style: "left-full top-full -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { id: "s", edges: ["s"], style: "left-1/2 top-full -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { id: "sw", edges: ["s", "w"], style: "left-0 top-full -translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { id: "w", edges: ["w"], style: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
];

interface Drag {
  edges: Edge[] | null;
  startX: number;
  startY: number;
  rect: Rect;
}

export function WebcamEditor({ project, initialTime, onClose, applyProject }: { project: Project; initialTime: number; onClose: () => void; applyProject: (p: Project) => void }) {
  const toast = useToast();
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const source = project.source;
  if (!source) throw new Error("WebcamEditor needs a downloaded source");
  const { width: sw, height: sh, duration } = source;

  const saved = project.webcam.rect;
  const fallback: Rect = { x: 0, y: 0, w: Math.round(sw * 0.25), h: Math.round(sw * 0.25 * (9 / 16)) };
  const [rect, setRect] = useState<Rect>(saved ?? fallback);
  const [time, setTime] = useState(clamp(initialTime, 0, Math.max(0, duration - 0.5)));
  const [frameTime, setFrameTime] = useState(time);
  const [loaded, setLoaded] = useState<{ time: number; ok: boolean } | null>(null);
  const [draft, setDraft] = useState<Partial<Record<keyof Rect, string>>>({});
  const [busy, setBusy] = useState<null | "save" | "none" | "detect">(null);

  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setFrameTime(time), 250);
    return () => window.clearTimeout(id);
  }, [time]);
  const frameState = loaded?.time !== frameTime ? "loading" : loaded.ok ? "ready" : "error";

  const dirty = !saved || saved.x !== rect.x || saved.y !== rect.y || saved.w !== rect.w || saved.h !== rect.h;

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
      setRect({ ...r, x: Math.round(clamp(r.x + dx, 0, sw - r.w)), y: Math.round(clamp(r.y + dy, 0, sh - r.h)) });
      return;
    }
    let x1 = r.x;
    let y1 = r.y;
    let x2 = r.x + r.w;
    let y2 = r.y + r.h;
    if (d.edges.includes("w")) x1 = clamp(r.x + dx, 0, x2 - MIN_SIZE);
    if (d.edges.includes("e")) x2 = clamp(r.x + r.w + dx, x1 + MIN_SIZE, sw);
    if (d.edges.includes("n")) y1 = clamp(r.y + dy, 0, y2 - MIN_SIZE);
    if (d.edges.includes("s")) y2 = clamp(r.y + r.h + dy, y1 + MIN_SIZE, sh);
    setRect({ x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) });
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
    setRect((r) => ({ ...r, x: clamp(r.x + d[0], 0, sw - r.w), y: clamp(r.y + d[1], 0, sh - r.h) }));
  };

  /** Parses, clamps and applies a typed value; an unparsable draft is dropped. */
  const commitField = (field: keyof Rect) => {
    const raw = draft[field];
    setDraft((d) => {
      const { [field]: _dropped, ...rest } = d;
      return rest;
    });
    if (raw === undefined || raw.trim() === "") return;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return;
    setRect((r) => {
      switch (field) {
        case "x":
          return { ...r, x: clamp(v, 0, sw - r.w) };
        case "y":
          return { ...r, y: clamp(v, 0, sh - r.h) };
        case "w":
          return { ...r, w: clamp(v, MIN_SIZE, sw - r.x) };
        case "h":
          return { ...r, h: clamp(v, MIN_SIZE, sh - r.y) };
      }
    });
  };

  const run = async (kind: "save" | "none" | "detect") => {
    setBusy(kind);
    try {
      if (kind === "detect") {
        applyProject(await api.rerun(project.id, "webcam"));
        toast.info("Detecting the webcam again...");
      } else {
        applyProject(await api.patchProject(project.id, { webcam: { rect: kind === "save" ? rect : null } }));
        toast.info(kind === "save" ? "Webcam rectangle saved" : "Webcam removed: split layout falls back to fill");
      }
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const wc = project.webcam;

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="webcam-editor-title"
      className="m-auto w-[min(980px,94vw)] max-w-none rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70"
    >
      <div className="flex max-h-[94vh] flex-col gap-3 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <ScanFace className="size-5 text-indigo-300" aria-hidden />
          <h2 id="webcam-editor-title" className="text-base font-semibold">
            Webcam rectangle
          </h2>
          <span className="text-xs text-zinc-400">
            Current: <b className="text-zinc-200">{wc.source}</b>
            {wc.rect ? ` · confidence ${Math.round(wc.confidence * 100)}%` : wc.source === "none" ? " · no webcam" : " · nothing found"}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        <div
          ref={stage}
          className="relative mx-auto w-full max-w-[880px] touch-none bg-black select-none"
          style={{ aspectRatio: `${sw} / ${sh}` }}
        >
          <img
            src={media.frame(project.id, frameTime, 1280)}
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
            aria-label={`Webcam rectangle x ${rect.x}, y ${rect.y}, ${rect.w} by ${rect.h}. Arrow keys move it.`}
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
                className={cn("absolute size-3 rounded-sm border border-zinc-900 bg-amber-300", h.style)}
                style={{ cursor: h.cursor }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="grid grid-cols-4 gap-2">
            {(["x", "y", "w", "h"] as const).map((f) => (
              <label key={f} className="flex flex-col gap-1 text-xs text-zinc-400">
                {f.toUpperCase()} (px)
                <input
                  type="number"
                  value={draft[f] ?? rect[f]}
                  min={0}
                  max={f === "x" || f === "w" ? sw : sh}
                  onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                  onBlur={() => commitField(f)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitField(f);
                  }}
                  className={cn(inputClass, "w-24 tabular-nums")}
                />
              </label>
            ))}
          </div>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-zinc-400">
            <span className="flex justify-between">
              <span>Frame time</span>
              <span className="text-zinc-200 tabular-nums">{fmtTime(time)}</span>
            </span>
            <input type="range" min={0} max={Math.max(0, duration - 0.5)} step={0.5} value={time} onChange={(e) => setTime(Number(e.target.value))} />
          </label>
        </div>
        {!saved && <p className="text-xs text-amber-300">No webcam rectangle is set. Position the rectangle and save it to enable the split layout.</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <Button variant="primary" onClick={() => void run("save")} disabled={busy !== null || !dirty}>
            <Save className="size-4" aria-hidden /> Save
          </Button>
          <Button onClick={() => saved && setRect(saved)} disabled={!saved || !dirty}>
            <RotateCcw className="size-4" aria-hidden /> Reset
          </Button>
          <span className="flex-1" />
          <Button onClick={() => void run("none")} disabled={busy !== null}>
            <VideoOff className="size-4" aria-hidden /> No webcam
          </Button>
          <Button onClick={() => void run("detect")} disabled={busy !== null}>
            <ScanFace className="size-4" aria-hidden /> Detect again
          </Button>
        </div>
      </div>
    </dialog>
  );
}
