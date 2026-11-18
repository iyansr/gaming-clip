import { useEffect, useMemo, useRef } from "react";

import type { Clip, Word } from "../../shared/types";
import { cn } from "../lib/format";
import { usePlayer, type Player } from "../lib/player";
import { Empty, Panel } from "./ui";

export function Transcript({
  clip,
  words,
  loading,
  error,
  player,
}: {
  clip: Clip;
  words: Word[];
  loading: boolean;
  error: string | null;
  player: Player;
}) {
  const inClip = useMemo(
    () => words.filter((w) => w.end > clip.start && w.start < clip.end && w.text.trim() !== ""),
    [words, clip.start, clip.end],
  );

  /** Index of the last word that has started at the playhead; -1 before the first. */
  const active = usePlayer(player, (p) => {
    let idx = -1;
    for (let i = 0; i < inClip.length; i++) {
      if (inClip[i]!.start <= p.time) idx = i;
      else break;
    }
    return idx;
  });

  const container = useRef<HTMLDivElement>(null);
  const activeEl = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const box = container.current;
    const el = activeEl.current;
    if (!box || !el || !player.playing) return;
    if (el.offsetTop < box.scrollTop || el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: "smooth" });
    }
  }, [active, player]);

  return (
    <Panel title="Transcript" collapsible defaultOpen={false}>
      {loading ? (
        <Empty>Loading transcript...</Empty>
      ) : error ? (
        <Empty>
          <span className="text-red-300">{error}</span>
        </Empty>
      ) : inClip.length === 0 ? (
        <Empty>No speech recognised in this clip.</Empty>
      ) : (
        <div ref={container} className="relative max-h-44 overflow-y-auto p-3 leading-8">
          {inClip.map((w, i) => (
            <button
              key={`${w.start}-${i}`}
              ref={i === active ? activeEl : undefined}
              type="button"
              onClick={() => player.seek(w.start)}
              title={`Seek to ${w.start.toFixed(1)} s`}
              className={cn(
                "mr-1 rounded px-1 text-sm transition-colors",
                i === active
                  ? "bg-yellow-300 font-semibold text-black"
                  : i < active
                    ? "text-zinc-400 hover:bg-zinc-800"
                    : "text-zinc-100 hover:bg-zinc-800",
              )}
            >
              {w.text.trim()}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
