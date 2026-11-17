import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { OUTPUT_SIZE, type CustomLayout, type Rect } from "../../shared/types";
import { clampDst, moveRect, resizeRect, snapTargets, withElement, type CustomUi, type ElementRole, type Guides } from "../lib/custom";
import { cn } from "../lib/format";
import { HANDLES, type Edge } from "./RectEditor";

const ROLES: { role: ElementRole; label: string; tone: string; selected: string; handle: string }[] = [
  { role: "game", label: "Game", tone: "border-indigo-300/80", selected: "border-indigo-400 bg-indigo-400/10", handle: "bg-indigo-300" },
  { role: "cam", label: "Webcam", tone: "border-amber-300/80", selected: "border-amber-400 bg-amber-400/10", handle: "bg-amber-300" },
];

interface Drag {
  role: ElementRole;
  edges: Edge[] | null;
  startX: number;
  startY: number;
  rect: Rect;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/**
 * Direct-manipulation layer over the preview canvas: one box per visible element in output coordinates.
 * Drag to move, handles to resize (aspect locked to the crop unless Shift / the lock is off), Alt disables snapping,
 * arrow keys nudge the focused box (Shift = 10 px). Everything outside the boxes stays click-through to the canvas.
 */
export function CustomOverlay({ custom, ui, onUiChange, onChange }: { custom: CustomLayout; ui: CustomUi; onUiChange: (ui: CustomUi) => void; onChange: (custom: CustomLayout) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  const latest = useRef(custom);
  latest.current = custom;
  const { width: W, height: H } = OUTPUT_SIZE;

  const commit = (role: ElementRole, dst: Rect) => {
    const element = latest.current[role];
    if (element) onChange(withElement(latest.current, role, { ...element, dst }));
  };

  const begin = (e: PointerEvent<HTMLElement>, role: ElementRole, edges: Edge[] | null) => {
    const element = latest.current[role];
    if (!element) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    container.current?.querySelector<HTMLElement>(`[data-box=${role}]`)?.focus();
    if (ui.selected !== role) onUiChange({ ...ui, selected: role });
    drag.current = { role, edges, startX: e.clientX, startY: e.clientY, rect: element.dst };
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const box = container.current?.getBoundingClientRect();
    const element = d && latest.current[d.role];
    if (!d || !box || !element) return;
    const k = W / box.width;
    const dx = (e.clientX - d.startX) * k;
    const dy = (e.clientY - d.startY) * k;
    const other = ROLES.find((r) => r.role !== d.role)!.role;
    const otherElement = latest.current[other];
    const options = { targets: snapTargets(OUTPUT_SIZE, otherElement ? [otherElement.dst] : []), snap: !e.altKey };
    const aspect = ui.lockAspect && !e.shiftKey ? element.src.w / element.src.h : null;
    const result = d.edges ? resizeRect(d.rect, d.edges, dx, dy, aspect, options) : moveRect(d.rect, dx, dy, options);
    setGuides(result.guides);
    commit(d.role, d.edges ? clampDst(result.rect) : result.rect);
  };

  const end = () => {
    drag.current = null;
    setGuides(null);
  };

  const nudge = (e: KeyboardEvent<HTMLElement>, role: ElementRole) => {
    const element = latest.current[role];
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!element || !d) return;
    e.preventDefault();
    commit(role, clampDst({ ...element.dst, x: element.dst.x + d[0], y: element.dst.y + d[1] }));
  };

  const active = ROLES.find((r) => r.role === ui.selected)!;
  const activeElement = custom[ui.selected];

  return (
    <div ref={container} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="custom-overlay">
      {ROLES.map(({ role, label, tone, selected, handle }) => {
        const element = custom[role];
        if (!element) return null;
        const { dst } = element;
        const isSelected = ui.selected === role;
        return (
          <div
            key={role}
            data-box={role}
            tabIndex={0}
            role="group"
            aria-label={`${label} box x ${dst.x}, y ${dst.y}, ${dst.w} by ${dst.h}. Arrow keys move it, Shift for 10 pixels.`}
            onPointerDown={(e) => begin(e, role, null)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => nudge(e, role)}
            onFocus={() => !isSelected && onUiChange({ ...ui, selected: role })}
            className={cn("pointer-events-auto absolute cursor-move border", isSelected ? cn("border-2", selected) : cn("border-dashed", tone))}
            style={{ left: pct(dst.x, W), top: pct(dst.y, H), width: pct(dst.w, W), height: pct(dst.h, H) }}
          >
            <span
              className={cn("pointer-events-none absolute max-w-[calc(100%-1.75rem)] truncate rounded-b px-1 text-[10px] leading-4 font-medium text-zinc-950", handle)}
              style={{ left: `calc(${pct(Math.max(0, -dst.x), dst.w)} + 0.875rem)`, top: pct(Math.max(0, -dst.y), dst.h) }}
            >
              {label}
              {isSelected && ` ${dst.w}×${dst.h}`}
            </span>
          </div>
        );
      })}
      {/* Handles sit above every box body, so an overlapping box never swallows the selected box's handles. */}
      {activeElement && (
        <div
          className="pointer-events-none absolute"
          style={{ left: pct(activeElement.dst.x, W), top: pct(activeElement.dst.y, H), width: pct(activeElement.dst.w, W), height: pct(activeElement.dst.h, H) }}
        >
          {HANDLES.map((h) => (
            <span
              key={h.id}
              data-handle={h.id}
              onPointerDown={(e) => begin(e, ui.selected, h.edges)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              className={cn("pointer-events-auto absolute size-3 rounded-sm border border-zinc-900 after:absolute after:-inset-1.5 after:content-['']", active.handle, h.inner)}
              style={{ cursor: h.cursor }}
            />
          ))}
        </div>
      )}
      {guides?.x.map((x) => <span key={`x${x}`} className="pointer-events-none absolute inset-y-0 w-px bg-pink-400" style={{ left: pct(x, W) }} />)}
      {guides?.y.map((y) => <span key={`y${y}`} className="pointer-events-none absolute inset-x-0 h-px bg-pink-400" style={{ top: pct(y, H) }} />)}
    </div>
  );
}
