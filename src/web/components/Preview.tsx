import { useEffect, useMemo, useRef } from "react";
import { Download, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { buildCues, drawCaptions, type CaptionCue } from "../../shared/captions";
import { computeLayout } from "../../shared/layout";
import { OUTPUT_SIZE, type Clip, type Project, type Word } from "../../shared/types";
import { media } from "../lib/api";
import { cn, fmtTime } from "../lib/format";
import { usePlayer, type Player } from "../lib/player";
import { useToast } from "../lib/toast";
import { Button } from "./ui";

/** Same low-resolution blur the renderer uses (render.ts BLUR_DOWNSCALE / BLUR_SIGMA). */
const BLUR_DOWNSCALE = 8;
const BLUR_SIGMA = 6;

/** 9:16 canvas whose height is min(62vh, 620px). */
const PREVIEW_WIDTH = "calc(min(62vh, 620px) * 9 / 16)";

export type PreviewMode = "preview" | "rendered";

interface Props {
  project: Project;
  clip: Clip;
  words: Word[];
  player: Player;
  fontsReady: boolean;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
}

/** Everything the draw callback needs, kept in a ref so the frame loop never restarts. */
interface DrawState {
  project: Project;
  clip: Clip;
  cues: CaptionCue[];
  fontsReady: boolean;
}

export function Preview({ project, clip, words, player, fontsReady, mode, onModeChange }: Props) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blurRef = useRef<HTMLCanvasElement | null>(null);

  const cues = useMemo(
    () => buildCues(words, clip.start, clip.end, clip.settings.captionStyle),
    [words, clip.start, clip.end, clip.settings.captionStyle],
  );
  const state = useRef<DrawState>({ project, clip, cues, fontsReady });
  state.current = { project, clip, cues, fontsReady };

  const rendered = clip.render.status === "done" && clip.render.file ? clip.render.file : null;
  const showRendered = mode === "rendered" && rendered !== null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || showRendered) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available in this browser");
    const blurCanvas = (blurRef.current ??= document.createElement("canvas"));
    const blurCtx = blurCanvas.getContext("2d");
    if (!blurCtx) throw new Error("2D canvas is not available in this browser");

    player.draw = () => {
      const { project: p, clip: c, cues: cs, fontsReady: fonts } = state.current;
      const video = player.video;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, OUTPUT_SIZE.width, OUTPUT_SIZE.height);
      if (!p.source || video.readyState < 2) return;

      const layout = computeLayout({ width: p.source.width, height: p.source.height }, p.webcam.rect, c.settings, OUTPUT_SIZE);
      for (const { src, dst, blur } of layout.layers) {
        if (blur) {
          const w = Math.max(2, Math.round(dst.w / BLUR_DOWNSCALE));
          const h = Math.max(2, Math.round(dst.h / BLUR_DOWNSCALE));
          if (blurCanvas.width !== w || blurCanvas.height !== h) {
            blurCanvas.width = w;
            blurCanvas.height = h;
          }
          blurCtx.filter = `blur(${BLUR_SIGMA}px)`;
          blurCtx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, w, h);
          ctx.drawImage(blurCanvas, 0, 0, w, h, dst.x, dst.y, dst.w, dst.h);
        } else {
          ctx.drawImage(video, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
        }
      }
      if (c.settings.subtitles && fonts) {
        drawCaptions(ctx, cs, video.currentTime - c.start, c.settings.captionStyle, {
          width: OUTPUT_SIZE.width,
          height: OUTPUT_SIZE.height,
          centerY: c.settings.captionY * OUTPUT_SIZE.height,
        });
      }
    };
    player.invalidate();
    return () => {
      player.draw = null;
    };
  }, [player, showRendered]);

  // Redraw while paused whenever anything the picture depends on changes.
  useEffect(() => {
    player.invalidate();
  }, [player, project.webcam.rect, project.source, clip.settings, cues, fontsReady, showRendered]);

  useEffect(() => {
    if (showRendered) player.pause();
  }, [player, showRendered]);

  const playing = usePlayer(player, (p) => p.playing);
  const time = usePlayer(player, (p) => p.time);
  const muted = usePlayer(player, (p) => p.muted);
  const volume = usePlayer(player, (p) => p.volume);
  const error = usePlayer(player, (p) => p.error);

  const length = clip.end - clip.start;
  const local = Math.min(length, Math.max(0, time - clip.start));
  const togglePlay = () => player.toggle().catch((e: unknown) => toast.error(e));

  return (
    <div className="flex flex-none flex-col gap-2" style={{ width: PREVIEW_WIDTH }}>
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Preview mode" className="inline-flex rounded-md border border-zinc-700 p-0.5">
          {(["preview", "rendered"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={showRendered === (m === "rendered")}
              disabled={m === "rendered" && !rendered}
              title={m === "rendered" && !rendered ? "Render this clip to compare" : undefined}
              onClick={() => onModeChange(m)}
              className={cn(
                "h-6 rounded px-2.5 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                showRendered === (m === "rendered") ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {rendered && (
          <a
            href={media.clip(project.id, rendered, true)}
            download
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
          >
            <Download className="size-3.5" aria-hidden /> Download
          </a>
        )}
      </div>

      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border border-zinc-800 bg-black">
        {showRendered && rendered ? (
          <video
            key={`${rendered}-${clip.render.renderedAt ?? ""}`}
            src={media.clip(project.id, rendered)}
            controls
            playsInline
            className="size-full bg-black object-contain"
            aria-label={`Rendered short: ${clip.title}`}
          />
        ) : (
          <>
            <canvas
              ref={canvasRef}
              width={OUTPUT_SIZE.width}
              height={OUTPUT_SIZE.height}
              onClick={togglePlay}
              className="size-full cursor-pointer"
              aria-label="Vertical preview of the short"
            />
            {error && <div className="absolute inset-x-2 top-2 rounded bg-red-950/90 p-2 text-xs text-red-100">{error}</div>}
          </>
        )}
      </div>

      {!showRendered && (
        <div className="flex w-full flex-col gap-1.5">
          <input
            type="range"
            min={0}
            max={length}
            step={0.01}
            value={local}
            onChange={(e) => player.seek(clip.start + Number(e.target.value))}
            aria-label="Position in clip"
            aria-valuetext={`${fmtTime(local)} of ${fmtTime(length)}`}
            className="w-full"
          />
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title="Play / pause (space)" className="w-9 px-0">
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </Button>
            <span className="text-xs text-zinc-300 tabular-nums">
              {local.toFixed(1)}s / {length.toFixed(1)}s
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => player.toggleMute()}
              aria-label={muted ? "Unmute" : "Mute"}
              className="rounded p-1 text-zinc-300 hover:bg-zinc-800"
            >
              {muted || volume === 0 ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              aria-label="Volume"
              className="w-20"
            />
          </div>
        </div>
      )}
    </div>
  );
}
