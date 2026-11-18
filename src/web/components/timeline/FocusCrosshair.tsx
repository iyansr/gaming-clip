import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { clamp } from "../../lib/format";

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Draggable crosshair for the zoom focus point, in 0..1 of the preview frame. Arrow keys nudge it by 1%
 * (Shift: 10%).
 */
export function FocusCrosshair({ x, y, onChange }: { x: number; y: number; onChange: (x: number, y: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const at = (e: { clientX: number; clientY: number }) => {
    const box = container.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    onChange(
      round3(clamp((e.clientX - box.left) / box.width, 0, 1)),
      round3(clamp((e.clientY - box.top) / box.height, 0, 1)),
    );
  };

  const key = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    onChange(round3(clamp(x + d[0], 0, 1)), round3(clamp(y + d[1], 0, 1)));
  };

  const down = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    e.currentTarget.focus();
  };

  return (
    <div ref={container} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="focus-overlay">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Zoom focus point. Arrow keys move it, Shift for 10 percent."
        aria-valuetext={`${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`}
        aria-valuenow={Math.round(x * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={down}
        onPointerMove={(e) => dragging.current && at(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={key}
        className="pointer-events-auto absolute size-12 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none rounded-full border-2 border-indigo-300 bg-indigo-400/15 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] focus-visible:outline-2 focus-visible:outline-white"
        style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
        data-testid="focus-crosshair"
      >
        <span className="absolute top-1/2 left-0 h-px w-full bg-indigo-200" />
        <span className="absolute top-0 left-1/2 h-full w-px bg-indigo-200" />
      </div>
    </div>
  );
}
