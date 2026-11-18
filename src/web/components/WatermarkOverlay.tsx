import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { OUTPUT_SIZE, type Watermark } from "../../shared/types";
import { SNAP_PX } from "../lib/custom";
import { clamp, cn } from "../lib/format";
import { WM_SIZE, WM_WIDTH, type WatermarkBox } from "../lib/watermarks";
import { HANDLES } from "./RectEditor";

const { width: W, height: H } = OUTPUT_SIZE;
const pct = (v: number, total: number) => `${(v / total) * 100}%`;
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Distance of the rotation handle from the box edge, in screen px. */
const ROTATE_OFFSET = 28;
/** Same distance in output px at a typical preview size; only decides whether the handle would leave the frame. */
const ROTATE_OFFSET_OUT = 90;
const CORNERS = HANDLES.filter((h) => h.edges.length === 2);

type Mode = { kind: "move" } | { kind: "rotate"; flip: boolean } | { kind: "resize"; sx: 1 | -1; sy: 1 | -1 };

interface Drag {
  mode: Mode;
  start: Watermark;
  box: WatermarkBox;
  /** Pointer position at the start, in output px. */
  px: number;
  py: number;
}

interface Guides {
  x: number[];
  y: number[];
}

/** Correction that puts one of `values` on one of `targets` when within SNAP_PX, else 0. */
function snapDelta(values: number[], targets: number[]): number {
  let best = 0;
  let bestAbs = SNAP_PX + 1e-9;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) < bestAbs) {
        best = d;
        bestAbs = Math.abs(d);
      }
    }
  }
  return best;
}

const normalizeDegrees = (deg: number) => {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
};

function describe(wm: Watermark): string {
  return wm.kind === "text" ? `text "${wm.text}"` : `image ${wm.file}`;
}

/**
 * Direct-manipulation layer for the watermarks: one box per overlay in output coordinates, rotated with the overlay.
 * Drag to move (snaps to the frame centre lines, Alt skips), corner handles resize (text -> size, image -> width,
 * aspect kept), the round handle rotates (Shift snaps to 15 degrees), arrow keys nudge (Shift = 10 px), Delete removes.
 */
export function WatermarkOverlay({
  watermarks,
  boxes,
  selected,
  onSelect,
  onChange,
}: {
  watermarks: Watermark[];
  boxes: Map<string, WatermarkBox>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (watermarks: Watermark[]) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  const latest = useRef(watermarks);
  // Handlers read the latest list through this ref; it is refreshed after every commit, before any event runs.
  useLayoutEffect(() => {
    latest.current = watermarks;
  });

  const replace = (next: Watermark) => onChange(latest.current.map((w) => (w.id === next.id ? next : w)));

  /** Pointer position in output px, or null when the overlay has no size. */
  const point = (e: { clientX: number; clientY: number }) => {
    const box = container.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const k = W / box.width;
    return { x: (e.clientX - box.left) * k, y: (e.clientY - box.top) * k };
  };

  const begin = (e: PointerEvent<HTMLElement>, wm: Watermark, mode: Mode) => {
    const box = boxes.get(wm.id);
    const p = point(e);
    if (!box || !p) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    container.current?.querySelector<HTMLElement>(`[data-wm="${wm.id}"]`)?.focus();
    if (selected !== wm.id) onSelect(wm.id);
    drag.current = { mode, start: wm, box, px: p.x, py: p.y };
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const p = point(e);
    if (!d || !p) return;
    const { start, box } = d;
    const r = rad(start.rotation);
    const cos = Math.cos(r);
    const sin = Math.sin(r);

    if (d.mode.kind === "move") {
      let x = start.x + p.x - d.px;
      let y = start.y + p.y - d.py;
      let next: Guides = { x: [], y: [] };
      if (!e.altKey) {
        // Edges only line up when the box is not rotated.
        const half = start.rotation === 0 ? [box.w / 2, 0, -box.w / 2] : [0];
        const halfY = start.rotation === 0 ? [box.h / 2, 0, -box.h / 2] : [0];
        x += snapDelta(
          half.map((o) => x + o),
          [0, W / 2, W],
        );
        y += snapDelta(
          halfY.map((o) => y + o),
          [0, H / 2, H],
        );
        next = {
          x: [0, W / 2, W].filter((t) => half.some((o) => Math.abs(x + o - t) < 0.5)),
          y: [0, H / 2, H].filter((t) => halfY.some((o) => Math.abs(y + o - t) < 0.5)),
        };
      }
      setGuides(next);
      replace({ ...start, x: Math.round(clamp(x, 0, W)), y: Math.round(clamp(y, 0, H)) });
      return;
    }

    setGuides(null);
    if (d.mode.kind === "rotate") {
      const angle = (Math.atan2(p.y - start.y, p.x - start.x) * 180) / Math.PI + (d.mode.flip ? -90 : 90);
      let rotation = normalizeDegrees(angle);
      if (e.shiftKey) rotation = normalizeDegrees(Math.round(rotation / 15) * 15);
      replace({ ...start, rotation: Math.round(rotation) });
      return;
    }

    // Resize from a corner: the opposite corner stays where it is, the aspect is kept.
    const { sx, sy } = d.mode;
    const ax = start.x + (-sx * box.w * cos + sy * box.h * sin) / 2;
    const ay = start.y + (-sx * box.w * sin - sy * box.h * cos) / 2;
    const vx = p.x - ax;
    const vy = p.y - ay;
    const ux = vx * cos + vy * sin;
    const uy = -vx * sin + vy * cos;
    const aspect = box.w / box.h;
    const wanted = Math.max(ux * sx, uy * sy * aspect);
    const base = start.kind === "text" ? start.size : start.width;
    const [lo, hi] = start.kind === "text" ? [WM_SIZE.min, WM_SIZE.max] : [WM_WIDTH.min, WM_WIDTH.max];
    const value = Math.round(clamp((base * wanted) / box.w, lo, hi));
    const ratio = value / base;
    const w2 = box.w * ratio;
    const h2 = box.h * ratio;
    const x = ax + (sx * w2 * cos - sy * h2 * sin) / 2;
    const y = ay + (sx * w2 * sin + sy * h2 * cos) / 2;
    const place = { x: Math.round(clamp(x, 0, W)), y: Math.round(clamp(y, 0, H)) };
    replace(start.kind === "text" ? { ...start, ...place, size: value } : { ...start, ...place, width: value });
  };

  const end = () => {
    drag.current = null;
    setGuides(null);
  };

  const key = (e: KeyboardEvent<HTMLElement>, wm: Watermark) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onChange(latest.current.filter((w) => w.id !== wm.id));
      onSelect(null);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    replace({ ...wm, x: clamp(wm.x + d[0], 0, W), y: clamp(wm.y + d[1], 0, H) });
  };

  return (
    <div ref={container} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="wm-overlay">
      {watermarks.map((wm) => {
        const box = boxes.get(wm.id);
        if (!box) return null;
        const isSelected = selected === wm.id;
        const cos = Math.cos(rad(wm.rotation));
        const flip =
          wm.y - (box.h / 2 + ROTATE_OFFSET_OUT) * cos < 24 && wm.y + (box.h / 2 + ROTATE_OFFSET_OUT) * cos > 24;
        return (
          <div
            key={wm.id}
            data-wm={wm.id}
            tabIndex={0}
            role="button"
            aria-label={`Watermark ${describe(wm)}, x ${wm.x}, y ${wm.y}, rotation ${wm.rotation} degrees. Arrow keys move it, Shift for 10 pixels, Delete removes it.`}
            aria-pressed={isSelected}
            onPointerDown={(e) => begin(e, wm, { kind: "move" })}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => key(e, wm)}
            onFocus={() => !isSelected && onSelect(wm.id)}
            className={cn(
              "pointer-events-auto absolute cursor-move border",
              isSelected ? "border-2 border-emerald-400 bg-emerald-400/10" : "border-dashed border-emerald-300/80",
            )}
            style={{
              left: pct(wm.x - box.w / 2, W),
              top: pct(wm.y - box.h / 2, H),
              width: pct(box.w, W),
              height: pct(box.h, H),
              transform: `rotate(${wm.rotation}deg)`,
              zIndex: isSelected ? 10 : undefined,
            }}
          >
            {isSelected && (
              <>
                {CORNERS.map((h) => (
                  <span
                    key={h.id}
                    data-handle={h.id}
                    onPointerDown={(e) =>
                      begin(e, wm, {
                        kind: "resize",
                        sx: h.edges.includes("e") ? 1 : -1,
                        sy: h.edges.includes("s") ? 1 : -1,
                      })
                    }
                    className={cn(
                      "absolute size-3 rounded-sm border border-zinc-900 bg-emerald-300 after:absolute after:-inset-1.5 after:content-['']",
                      h.outer,
                    )}
                    style={{ cursor: h.cursor }}
                  />
                ))}
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 w-px -translate-x-1/2 bg-emerald-400"
                  style={flip ? { top: "100%", height: ROTATE_OFFSET } : { bottom: "100%", height: ROTATE_OFFSET }}
                />
                <span
                  data-handle="rotate"
                  title="Rotate (Shift snaps to 15 degrees)"
                  onPointerDown={(e) => begin(e, wm, { kind: "rotate", flip })}
                  className="absolute left-1/2 size-3.5 -translate-x-1/2 cursor-grab rounded-full border border-zinc-900 bg-emerald-300 after:absolute after:-inset-2 after:content-['']"
                  style={
                    flip
                      ? { top: `calc(100% + ${ROTATE_OFFSET - 7}px)` }
                      : { bottom: `calc(100% + ${ROTATE_OFFSET - 7}px)` }
                  }
                />
              </>
            )}
          </div>
        );
      })}
      {guides?.x.map((x) => (
        <span
          key={`x${x}`}
          className="pointer-events-none absolute inset-y-0 w-px bg-pink-400"
          style={{ left: pct(x, W) }}
        />
      ))}
      {guides?.y.map((y) => (
        <span
          key={`y${y}`}
          className="pointer-events-none absolute inset-x-0 h-px bg-pink-400"
          style={{ top: pct(y, H) }}
        />
      ))}
    </div>
  );
}
