import { Download, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { buildCues, drawCaptions, type CaptionCue } from "../../shared/captions";
import { computeLayout } from "../../shared/layout";
import { OUTPUT_SIZE, type Clip, type CustomLayout, type Project, type Word } from "../../shared/types";
import { media } from "../lib/api";
import { resolveCustom, type CustomUi } from "../lib/custom";
import { cn, fmtTime } from "../lib/format";
import { useAssetImage } from "../lib/images";
import { LayoutPainter } from "../lib/paint";
import { usePlayer, type Player } from "../lib/player";
import { useToast } from "../lib/toast";
import { CustomOverlay } from "./CustomOverlay";
import { ThumbnailCanvas } from "./ThumbnailEditor";
import { Button } from "./ui";

/** 9:16 canvas whose height is min(62vh, 620px). */
const PREVIEW_WIDTH = "calc(min(62vh, 620px) * 9 / 16)";

export type PreviewMode = "preview" | "rendered" | "thumbnail";

interface Props {
  project: Project;
  clip: Clip;
  words: Word[];
  player: Player;
  fontsReady: boolean;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  /** Source time of the cover frame; null while it is being picked. */
  thumbnailTime: number | null;
  customUi: CustomUi;
  onCustomUiChange: (ui: CustomUi) => void;
  /** Whole new free-form layout from the on-canvas boxes. */
  onCustomChange: (custom: CustomLayout) => void;
}

/** Everything the draw callback needs, kept in a ref so the frame loop never restarts. */
interface DrawState {
  project: Project;
  clip: Clip;
  cues: CaptionCue[];
  fontsReady: boolean;
  image: HTMLImageElement | null;
}

export function Preview({
  project,
  clip,
  words,
  player,
  fontsReady,
  mode,
  onModeChange,
  thumbnailTime,
  customUi,
  onCustomUiChange,
  onCustomChange,
}: Props) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painter = useRef<LayoutPainter | null>(null);
  const [hover, setHover] = useState(false);

  const cues = useMemo(
    () => buildCues(words, clip.start, clip.end, clip.settings.captionStyle),
    [words, clip.start, clip.end, clip.settings.captionStyle],
  );
  const sourceSize = project.source ? { width: project.source.width, height: project.source.height } : null;
  const custom =
    clip.settings.layout === "custom" && sourceSize
      ? resolveCustom(sourceSize, project.webcam.rect, clip.settings.custom)
      : null;
  const imageFile = custom?.background.kind === "image" ? custom.background.file : null;
  const image = useAssetImage(project.id, imageFile);
  const state = useRef<DrawState>({ project, clip, cues, fontsReady, image });
  // Refreshed at commit time, before the redraw effect below and before the next animation frame.
  useLayoutEffect(() => {
    state.current = { project, clip, cues, fontsReady, image };
  });

  const rendered = clip.render.status === "done" && clip.render.file ? clip.render.file : null;
  const shown: PreviewMode = mode === "rendered" && rendered === null ? "preview" : mode;
  const showRendered = shown === "rendered";
  /** The live canvas is only mounted in preview mode. */
  const live = shown === "preview";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !live) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available in this browser");
    const layoutPainter = (painter.current ??= new LayoutPainter());

    player.setDraw(() => {
      const { project: p, clip: c, cues: cs, fontsReady: fonts, image: background } = state.current;
      const video = player.video;
      if (!p.source || video.readyState < 2) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, OUTPUT_SIZE.width, OUTPUT_SIZE.height);
        return;
      }

      const layout = computeLayout(
        { width: p.source.width, height: p.source.height },
        p.webcam.rect,
        c.settings,
        OUTPUT_SIZE,
      );
      layoutPainter.paint(ctx, video, layout, background, OUTPUT_SIZE);
      if (c.settings.subtitles && fonts) {
        drawCaptions(ctx, cs, video.currentTime - c.start, c.settings.captionStyle, {
          width: OUTPUT_SIZE.width,
          height: OUTPUT_SIZE.height,
          centerY: c.settings.captionY * OUTPUT_SIZE.height,
        });
      }
    });
    player.invalidate();
    return () => {
      player.setDraw(null);
    };
  }, [player, live]);

  // Redraw while paused whenever anything the picture depends on changes.
  useEffect(() => {
    player.invalidate();
  }, [player, project.webcam.rect, project.source, clip.settings, cues, fontsReady, image, live]);

  useEffect(() => {
    if (!live) player.pause();
  }, [player, live]);

  const playing = usePlayer(player, (p) => p.playing);
  const time = usePlayer(player, (p) => p.time);
  const muted = usePlayer(player, (p) => p.muted);
  const volume = usePlayer(player, (p) => p.volume);
  const error = usePlayer(player, (p) => p.error);

  const length = clip.end - clip.start;
  const local = Math.min(length, Math.max(0, time - clip.start));
  const togglePlay = () => player.toggle().catch((e: unknown) => toast.error(e));

  const locked = clip.render.status === "queued" || clip.render.status === "rendering";
  const editing = live && custom !== null && !locked;
  /** Boxes only show while paused or hovered, so they never cover playback. */
  const showBoxes = editing && (!playing || hover);

  return (
    <div className="flex flex-none flex-col gap-2" style={{ width: PREVIEW_WIDTH }}>
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Preview mode" className="inline-flex rounded-md border border-zinc-700 p-0.5">
          {(["preview", "rendered", "thumbnail"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={shown === m}
              disabled={m === "rendered" && !rendered}
              title={m === "rendered" && !rendered ? "Render this clip to compare" : undefined}
              onClick={() => onModeChange(m)}
              className={cn(
                "h-6 rounded px-2.5 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                shown === m ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {shown === "thumbnail"
          ? clip.thumbnail.file && <DownloadLink href={media.clip(project.id, clip.thumbnail.file, true)} />
          : rendered && <DownloadLink href={media.clip(project.id, rendered, true)} />}
      </div>

      <div
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border border-zinc-800 bg-black"
      >
        {showRendered && rendered ? (
          // oxlint-disable-next-line jsx-a11y/media-has-caption -- captions are burned into the rendered video's picture
          <video
            key={`${rendered}-${clip.render.renderedAt ?? ""}`}
            src={media.clip(project.id, rendered)}
            controls
            playsInline
            className="size-full bg-black object-contain"
            aria-label={`Rendered short: ${clip.title}`}
          />
        ) : shown === "thumbnail" ? (
          <ThumbnailCanvas project={project} clip={clip} time={thumbnailTime} fontsReady={fontsReady} />
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
            {error && (
              <div className="absolute inset-x-2 top-2 rounded bg-red-950/90 p-2 text-xs text-red-100">{error}</div>
            )}
            {showBoxes && custom && (
              <CustomOverlay custom={custom} ui={customUi} onUiChange={onCustomUiChange} onChange={onCustomChange} />
            )}
          </>
        )}
      </div>

      {live && (
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
            <Button
              variant="secondary"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              title="Play / pause (space)"
              className="w-9 px-0"
            >
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
              {muted || volume === 0 ? (
                <VolumeX className="size-4" aria-hidden />
              ) : (
                <Volume2 className="size-4" aria-hidden />
              )}
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

function DownloadLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      download
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
    >
      <Download className="size-3.5" aria-hidden /> Download
    </a>
  );
}
