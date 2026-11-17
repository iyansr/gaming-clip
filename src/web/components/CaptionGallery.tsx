import { useEffect, useMemo, useRef } from "react";
import { buildCues, CAPTION_STYLES, drawCaptions, type CaptionCue } from "../../shared/captions";
import type { Word } from "../../shared/types";
import { cn } from "../lib/format";

/** Tile canvas: a 540x200 slice of a 1080-wide frame, so font sizes are exactly half the output's. */
const TILE = { width: 540, height: 200 };
const SAMPLE: Word[] = [
  { text: "This", start: 0, end: 0.5 },
  { text: "is", start: 0.5, end: 0.9 },
  { text: "insane", start: 0.9, end: 1.6 },
];
/** In the middle word, past the pop animation. */
const SAMPLE_TIME = 0.8;

function Tile({ styleId, selected, fontsReady, onSelect, disabled }: { styleId: string; selected: boolean; fontsReady: boolean; onSelect: () => void; disabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cues = useMemo<CaptionCue[]>(() => buildCues(SAMPLE, 0, 2, styleId), [styleId]);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const grad = ctx.createLinearGradient(0, 0, TILE.width, TILE.height);
    grad.addColorStop(0, "#3f4a5c");
    grad.addColorStop(1, "#1f2430");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TILE.width, TILE.height);
    if (fontsReady) drawCaptions(ctx, cues, SAMPLE_TIME, styleId, { width: TILE.width, height: TILE.height, centerY: TILE.height / 2 });
  }, [cues, styleId, fontsReady]);

  const name = CAPTION_STYLES.find((s) => s.id === styleId)?.name ?? styleId;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`Caption style ${name}`}
      className={cn(
        "group relative overflow-hidden rounded-md border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-indigo-400" : "border-zinc-800 hover:border-zinc-600",
      )}
    >
      <canvas ref={ref} width={TILE.width} height={TILE.height} className="block aspect-[27/10] w-full" />
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 text-[10px] leading-4 font-medium text-zinc-100">{name}</span>
    </button>
  );
}

export function CaptionGallery({ value, onChange, fontsReady, disabled }: { value: string; onChange: (id: string) => void; fontsReady: boolean; disabled: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {CAPTION_STYLES.map((s) => (
        <Tile key={s.id} styleId={s.id} selected={s.id === value} fontsReady={fontsReady} onSelect={() => onChange(s.id)} disabled={disabled} />
      ))}
    </div>
  );
}
