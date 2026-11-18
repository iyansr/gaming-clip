import { Download, ImageIcon, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { computeLayout } from "../../shared/layout";
import { drawThumbnail, THUMBNAIL_STYLES, type ThumbnailContext } from "../../shared/thumbnail";
import { OUTPUT_SIZE, type Clip, type Project } from "../../shared/types";
import { api, errorMessage, media, type ThumbnailCandidate } from "../lib/api";
import { clamp, cn, fmtTime, round2 } from "../lib/format";
import type { ClipEdit } from "../lib/hooks";
import { useAssetImage } from "../lib/images";
import type { Player } from "../lib/player";
import { useToast } from "../lib/toast";
import { Badge, Button, inputClass, Panel } from "./ui";

const MAX_HEADLINE = 120;

export interface CandidateState {
  /** null while loading. */
  list: ThumbnailCandidate[] | null;
  error: string | null;
}

const LOADING: CandidateState = { list: null, error: null };

/** Suggested cover frames of one clip; refetched when the saved range or the webcam rectangle changes. */
export function useThumbnailCandidates(project: Project, clipId: string | null): CandidateState {
  const saved = project.clips.find((c) => c.id === clipId);
  const key =
    saved && project.source ? `${saved.id}|${saved.start}|${saved.end}|${JSON.stringify(project.webcam.rect)}` : null;
  const request = key && clipId ? `${project.id}|${key}` : null;
  // The result remembers which request produced it, so a changed request reads as "loading" without a reset effect.
  const [result, setResult] = useState<{ request: string; state: CandidateState } | null>(null);
  useEffect(() => {
    if (!request || !clipId) return;
    let cancelled = false;
    api
      .thumbnailCandidates(project.id, clipId)
      .then((list) => {
        if (!cancelled) setResult({ request, state: { list, error: null } });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ request, state: { list: [], error: errorMessage(e) } });
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, clipId, request]);
  return request !== null && result?.request === request ? result.state : LOADING;
}

/** Source time the cover shows: the chosen one, else the best suggestion; null until suggestions arrive. */
export function resolveThumbnailTime(clip: Clip, candidates: CandidateState): number | null {
  if (clip.thumbnail.time !== null) return clip.thumbnail.time;
  if (candidates.list === null) return null;
  return candidates.list[0]?.time ?? round2((clip.start + clip.end) / 2);
}

function useFrameImage(url: string | null): { image: HTMLImageElement | null; loading: boolean; error: boolean } {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    const image = new Image();
    image.onload = () => setLoaded({ url, image });
    image.onerror = () => setLoaded({ url, image: null });
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);
  const current = loaded && loaded.url === url ? loaded : null;
  // Keep showing the previous frame while the next one loads, so scrubbing does not flash.
  return {
    image: current?.image ?? loaded?.image ?? null,
    loading: url !== null && current === null,
    error: current !== null && current.image === null,
  };
}

function headlineOf(clip: Clip): string {
  return clip.thumbnail.text ?? clip.title;
}

/** Uploaded background image file of a clip in the custom layout, if any. */
function backgroundFileOf(clip: Clip): string | null {
  const { layout, custom } = clip.settings;
  return layout === "custom" && custom?.background.kind === "image" ? custom.background.file : null;
}

/** Offscreen scratch canvas for drawThumbnail (webcam masks), returned as its context. */
function createCanvas(width: number, height: number): ThumbnailContext {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available in this browser");
  return ctx;
}

function backgroundOpt(
  image: HTMLImageElement | null,
): { image: unknown; size: { width: number; height: number } } | undefined {
  return image ? { image, size: { width: image.naturalWidth, height: image.naturalHeight } } : undefined;
}

/** The cover exactly as the generator will write it: same layout geometry, same drawing code. */
export function ThumbnailCanvas({
  project,
  clip,
  time,
  fontsReady,
}: {
  project: Project;
  clip: Clip;
  time: number | null;
  fontsReady: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const source = project.source;
  const url = source && time !== null ? media.frame(project.id, time, source.width) : null;
  const { image, loading, error } = useFrameImage(url);
  const { layout: mode, focusX, custom } = clip.settings;
  const { style, textY } = clip.thumbnail;
  const text = headlineOf(clip);
  const webcam = project.webcam.rect;
  const background = useAssetImage(project.id, backgroundFileOf(clip));

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx || !source) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, OUTPUT_SIZE.width, OUTPUT_SIZE.height);
    if (!image) return;
    const sourceSize = { width: source.width, height: source.height };
    const layout = computeLayout(sourceSize, webcam, { layout: mode, focusX, custom }, OUTPUT_SIZE);
    drawThumbnail(
      ctx,
      image,
      { width: image.naturalWidth, height: image.naturalHeight },
      layout,
      {
        text: fontsReady ? text : "",
        styleId: style,
        textY,
        sourceSize,
        backgroundImage: backgroundOpt(background),
        createCanvas,
      },
      OUTPUT_SIZE,
    );
  }, [image, background, source, webcam, mode, focusX, custom, text, style, textY, fontsReady]);

  return (
    <>
      <canvas
        ref={ref}
        width={OUTPUT_SIZE.width}
        height={OUTPUT_SIZE.height}
        className="size-full"
        aria-label={`Thumbnail preview: ${text || "no headline"}`}
      />
      {(loading || time === null) && (
        <div
          className="absolute top-2 right-2 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-xs text-zinc-200"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden />{" "}
          {time === null ? "Finding a frame" : "Loading frame"}
        </div>
      )}
      {error && (
        <div className="absolute inset-x-2 top-2 rounded bg-red-950/90 p-2 text-xs text-red-100">
          Could not load the frame at {time?.toFixed(2)}s.
        </div>
      )}
    </>
  );
}

/** Style tile: the top slice of the real cover at one third of its size, headline centred in the slice. */
const TILE = { width: 360, height: 220 };

function StyleTile({
  styleId,
  name,
  selected,
  image,
  background,
  project,
  clip,
  fontsReady,
  onSelect,
}: {
  styleId: string;
  name: string;
  selected: boolean;
  image: HTMLImageElement | null;
  /** The custom layout's uploaded background, when it has one. */
  background: HTMLImageElement | null;
  project: Project;
  clip: Clip;
  fontsReady: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const source = project.source;
  const webcam = project.webcam.rect;
  const { layout: mode, focusX, custom } = clip.settings;
  const text = headlineOf(clip) || "Your *headline*";

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#1f2430";
    ctx.fillRect(0, 0, TILE.width, TILE.height);
    if (!image || !source || !fontsReady) return;
    const sourceSize = { width: source.width, height: source.height };
    drawThumbnail(
      ctx,
      image,
      { width: image.naturalWidth, height: image.naturalHeight },
      computeLayout(sourceSize, webcam, { layout: mode, focusX, custom }, OUTPUT_SIZE),
      { text, styleId, textY: 0.5, sourceSize, backgroundImage: backgroundOpt(background), createCanvas },
      TILE,
    );
  }, [image, background, source, webcam, mode, focusX, custom, text, styleId, fontsReady]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Thumbnail style ${name}`}
      className={cn(
        "relative overflow-hidden rounded-md border-2 transition-colors",
        selected ? "border-indigo-400" : "border-zinc-800 hover:border-zinc-600",
      )}
    >
      <canvas ref={ref} width={TILE.width} height={TILE.height} className="block aspect-[18/11] w-full" />
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 text-[10px] leading-4 font-medium text-zinc-100">
        {name}
      </span>
    </button>
  );
}

interface PanelProps {
  project: Project;
  clip: Clip;
  player: Player;
  fontsReady: boolean;
  candidates: CandidateState;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  flushAll: () => Promise<void>;
  applyProject: (p: Project) => void;
  /** Switch the preview column to the thumbnail. */
  onShow: () => void;
}

export function ThumbnailPanel({
  project,
  clip,
  player,
  fontsReady,
  candidates,
  edit,
  flushAll,
  applyProject,
  onShow,
}: PanelProps) {
  const toast = useToast();
  const thumb = clip.thumbnail;
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [scrubDraft, setScrubDraft] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  const time = resolveThumbnailTime(clip, candidates);
  const source = project.source;
  // Small copy of the chosen frame for the style tiles; the big canvas loads its own full-size one.
  const tileUrl = source && time !== null ? media.frame(project.id, time, 480) : null;
  const tileImage = useFrameImage(tileUrl).image;
  const tileBackground = useAssetImage(project.id, backgroundFileOf(clip));

  const set = (thumbnail: NonNullable<ClipEdit["thumbnail"]>, immediate = false) => {
    edit(clip.id, { thumbnail }, immediate);
    onShow();
  };
  const noText = thumb.text === "";
  const strip = useMemo(() => candidates.list ?? [], [candidates.list]);

  const generate = async () => {
    setGenerating(true);
    try {
      await flushAll();
      applyProject(await api.generateThumbnail(project.id, clip.id));
      onShow();
    } catch (e) {
      toast.error(e);
    } finally {
      setGenerating(false);
    }
  };

  const commitScrub = () => {
    if (scrubDraft === null) return;
    set({ time: round2(scrubDraft) }, true);
    setScrubDraft(null);
  };

  return (
    <Panel
      title="Thumbnail"
      actions={
        thumb.file ? (
          <Badge tone="good">Generated</Badge>
        ) : (
          <Badge tone="warn" title="Generate to write the image file">
            Not generated
          </Badge>
        )
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          <span className="flex justify-between">
            <span>Headline</span>
            <span className="tabular-nums">
              {(textDraft ?? thumb.text ?? "").length}/{MAX_HEADLINE}
            </span>
          </span>
          <textarea
            rows={2}
            maxLength={MAX_HEADLINE}
            disabled={noText}
            value={textDraft ?? thumb.text ?? ""}
            placeholder={clip.title}
            onFocus={() => {
              setTextDraft(thumb.text ?? "");
              onShow();
            }}
            onChange={(e) => {
              const value = e.target.value.replace(/\n/g, " ");
              setTextDraft(value);
              // Live preview; a blank field means "use the clip title".
              edit(clip.id, { thumbnail: { text: value.trim() === "" ? null : value } });
            }}
            onBlur={() => setTextDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className={cn(inputClass, "h-auto resize-none py-1.5 leading-snug")}
          />
          <span className="text-zinc-500">
            Empty uses the clip title. Wrap words in <code className="text-zinc-300">*stars*</code> to colour them.
          </span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            aria-checked={noText}
            checked={noText}
            onChange={(e) => set({ text: e.target.checked ? "" : null }, true)}
            className="size-4"
          />
          No text, frame only
        </label>

        <div
          className={cn("grid grid-cols-3 gap-2", noText && "pointer-events-none opacity-40")}
          aria-disabled={noText}
        >
          {THUMBNAIL_STYLES.map((s) => (
            <StyleTile
              key={s.id}
              styleId={s.id}
              name={s.name}
              selected={s.id === thumb.style}
              image={tileImage}
              background={tileBackground}
              project={project}
              clip={clip}
              fontsReady={fontsReady}
              onSelect={() => set({ style: s.id }, true)}
            />
          ))}
        </div>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          <span className="flex justify-between">
            <span>Headline vertical position</span>
            <span className="text-zinc-200 tabular-nums">{Math.round(thumb.textY * 100)}%</span>
          </span>
          <input
            type="range"
            min={0.05}
            max={0.95}
            step={0.005}
            value={thumb.textY}
            disabled={noText}
            onChange={(e) => set({ textY: Number(e.target.value) })}
          />
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
            <span>
              Frame{" "}
              <span className="text-zinc-200 tabular-nums">
                {time === null ? "..." : fmtTime(time)}
                {thumb.time === null && " (auto)"}
              </span>
            </span>
            <span className="flex gap-1.5">
              <Button
                small
                variant={thumb.time === null ? "primary" : "secondary"}
                aria-pressed={thumb.time === null}
                onClick={() => set({ time: null }, true)}
              >
                <Sparkles className="size-3.5" aria-hidden /> Auto
              </Button>
              <Button
                small
                onClick={() => set({ time: round2(clamp(player.time, clip.start, clip.end)) }, true)}
                title="Use the frame under the preview playhead"
              >
                Use playhead
              </Button>
            </span>
          </div>
          {candidates.error && <p className="text-xs text-red-300">Could not suggest frames: {candidates.error}</p>}
          {candidates.list === null ? (
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Looking for sharp frames near the loudest
              moments
            </p>
          ) : (
            strip.length > 0 && (
              <ul className="grid grid-cols-3 gap-1.5" aria-label="Suggested frames">
                {strip.map((candidate) => {
                  const chosen = time !== null && Math.abs(candidate.time - time) < 0.005;
                  return (
                    <li key={candidate.time}>
                      <button
                        type="button"
                        onClick={() => set({ time: candidate.time }, true)}
                        aria-pressed={chosen}
                        aria-label={`Use the frame at ${fmtTime(candidate.time)}, score ${Math.round(candidate.score * 100)}`}
                        className={cn(
                          "relative block w-full overflow-hidden rounded border-2",
                          chosen ? "border-indigo-400" : "border-zinc-800 hover:border-zinc-600",
                        )}
                      >
                        <img
                          src={media.frame(project.id, candidate.time, 240)}
                          alt=""
                          loading="lazy"
                          className="block aspect-video w-full bg-zinc-950 object-cover"
                        />
                        <span className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 text-[10px] leading-4 text-zinc-100 tabular-nums">
                          {fmtTime(candidate.time)} · {Math.round(candidate.score * 100)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          )}
          <input
            type="range"
            min={clip.start}
            max={clip.end}
            step={0.05}
            value={scrubDraft ?? time ?? clip.start}
            onChange={(e) => setScrubDraft(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
            aria-label="Thumbnail frame time"
            aria-valuetext={fmtTime(scrubDraft ?? time ?? clip.start)}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void generate()} disabled={generating || !source} className="flex-1">
            {generating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ImageIcon className="size-4" aria-hidden />
            )}
            {thumb.file ? "Regenerate thumbnail" : "Generate thumbnail"}
          </Button>
          {thumb.file && (
            <a
              href={media.clip(project.id, thumb.file, true)}
              download
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
            >
              <Download className="size-4" aria-hidden /> Download
            </a>
          )}
        </div>
        {!thumb.file && <p className="text-xs text-zinc-500">Rendering the clip also writes its thumbnail.</p>}
      </div>
    </Panel>
  );
}
