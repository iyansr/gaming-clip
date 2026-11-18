import { Download, Film, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Clip, Project } from "../../shared/types";
import { ClipList, sortClips, type ClipSort } from "../components/ClipList";
import { Preview, type PreviewMode } from "../components/Preview";
import { ProjectHeader } from "../components/ProjectHeader";
import { RenderBar } from "../components/RenderBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { resolveThumbnailTime, useThumbnailCandidates } from "../components/ThumbnailEditor";
import { Inspector } from "../components/timeline/Inspector";
import { Timeline, TEASER_ID } from "../components/timeline/Timeline";
import { Transcript } from "../components/Transcript";
import { Empty } from "../components/ui";
import { WebcamEditor } from "../components/WebcamEditor";
import { api, media } from "../lib/api";
import type { CustomUi } from "../lib/custom";
import { clamp, cn, floor1, fmtTime } from "../lib/format";
import { useCaptionFonts, useClipEdits, useProjectStream, useTranscriptWords } from "../lib/hooks";
import { Player } from "../lib/player";
import { Link } from "../lib/router";
import { useToast } from "../lib/toast";

export function ProjectPage({ id }: { id: string }) {
  const { project, online, missing, applyProject } = useProjectStream(id);
  if (missing) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-zinc-300">{missing}</p>
          <Link
            href="/"
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Back to projects
          </Link>
        </div>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="grid h-full place-items-center text-zinc-400">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading project...
        </span>
      </div>
    );
  }
  return <ProjectView project={project} online={online} applyProject={applyProject} />;
}

function ProjectView({
  project,
  online,
  applyProject,
}: {
  project: Project;
  online: boolean;
  applyProject: (p: Project) => void;
}) {
  const toast = useToast();
  const { clips, edit, flushAll, discard } = useClipEdits(project, applyProject);
  const fonts = useCaptionFonts();
  const { words, error: transcriptError } = useTranscriptWords(project.id, project.stages.transcribe.status === "done");

  const [sort, setSort] = useState<ClipSort>("time");
  const [tab, setTab] = useState<"clips" | "rendered">("clips");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<{ clipId: string; mode: PreviewMode } | null>(null);
  const [webcamOpen, setWebcamOpen] = useState(false);
  const [customUi, setCustomUi] = useState<CustomUi>({ selected: "cam", lockAspect: true });
  const [watermarkId, setSelectedWatermark] = useState<string | null>(null);
  const [itemSel, setItemSel] = useState<{ clipId: string; id: string } | null>(null);
  const configColumn = useRef<HTMLElement>(null);

  const source = project.source;
  const ready = project.stages.download.status === "done" && source !== null;

  const [player, setPlayer] = useState<Player | null>(null);
  useEffect(() => {
    if (!ready) return;
    const p = new Player(media.source(project.id));
    // oxlint-disable-next-line react/set-state-in-effect -- the Player owns a <video> and rAF loop, so it is created and torn down by the effect
    setPlayer(p);
    return () => {
      p.destroy();
      setPlayer(null);
    };
  }, [ready, project.id]);

  const sorted = useMemo(() => sortClips(clips, sort), [clips, sort]);
  const active = clips.find((c) => c.id === activeId) ?? sorted[0] ?? null;
  /** The selection only counts while the active clip still has that overlay. */
  const selectedWatermark = active?.settings.watermarks.some((w) => w.id === watermarkId) ? watermarkId : null;
  const candidates = useThumbnailCandidates(project, active?.id ?? null);

  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!player) return;
    if (!active) {
      player.setRange(0, 0);
      return;
    }
    player.setRange(active.start, active.end);
    if (synced.current !== active.id) {
      synced.current = active.id;
      player.seek(active.start);
    }
  }, [player, active?.id, active?.start, active?.end]);

  useEffect(() => {
    if (!player) return;
    /** Space toggles playback everywhere except where it already means something else. Clip cards are buttons, but Enter still activates them. */
    const isSpaceForPlayback = (e: KeyboardEvent): boolean => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return false;
      const t = e.target;
      if (!(t instanceof HTMLElement)) return true;
      if (t.closest("dialog") || t.isContentEditable) return false;
      if (t instanceof HTMLInputElement) return t.type === "range";
      if (t instanceof HTMLButtonElement) return t.closest("[data-clip-list]") !== null;
      return !["TEXTAREA", "SELECT", "A", "VIDEO", "SUMMARY"].includes(t.tagName);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isSpaceForPlayback(e)) return;
      e.preventDefault();
      if (!e.repeat) player.toggle().catch((err: unknown) => toast.error(err));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSpaceForPlayback(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [player, toast]);

  const addClip = async () => {
    if (!source) return;
    try {
      const start = floor1(clamp(player?.time ?? 0, 0, Math.max(0, source.duration - 30)));
      const end = floor1(Math.min(source.duration, start + 30));
      const known = new Set(project.clips.map((c) => c.id));
      const next = await api.addClip(project.id, start, end);
      applyProject(next);
      const created = next.clips.find((c) => !known.has(c.id));
      if (created) {
        setActiveId(created.id);
        setTab("clips");
      }
    } catch (e) {
      toast.error(e);
    }
  };

  const deleteClip = async (clip: Clip) => {
    discard(clip.id);
    try {
      applyProject(await api.deleteClip(project.id, clip.id));
    } catch (e) {
      toast.error(e);
    }
  };

  const rendered = clips.filter((c) => c.render.status === "done" && c.render.file);
  const activeView = view && active && view.clipId === active.id ? view.mode : "preview";

  /** The selection only counts while the active clip still has that item (or a teaser). */
  const selectedItem =
    active &&
    itemSel?.clipId === active.id &&
    (active.timeline.items.some((i) => i.id === itemSel.id) || (itemSel.id === TEASER_ID && active.timeline.teaser))
      ? itemSel.id
      : null;
  const selectItem = (id: string | null) => {
    setItemSel(active && id ? { clipId: active.id, id } : null);
    configColumn.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (!player) return;
    const timed = active?.timeline.items ?? [];
    player.audio.setPlan({
      sounds: timed.filter((i) => i.kind === "sound"),
      voices: timed.filter((i) => i.kind === "voice"),
      clipStart: active?.start ?? 0,
      clipEnd: active?.end ?? 0,
    });
  }, [player, active?.timeline.items, active?.start, active?.end]);

  return (
    <div className="flex h-full flex-col">
      <ProjectHeader
        project={project}
        online={online}
        applyProject={applyProject}
        onOpenWebcam={() => setWebcamOpen(true)}
      />

      {!ready || !player ? (
        <div className="grid flex-1 place-items-center p-8">
          <Empty>
            {project.stages.download.status === "error" ? (
              "The download failed. Use Retry above."
            ) : (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for the source video. The editor opens
                once the download is done.
              </span>
            )}
          </Empty>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          {/* Wide: left column (preview, timeline, highlights) + a fixed settings column, each scrolling on its own.
              Narrow: one column in the order preview, timeline, settings, highlights (the left wrapper `contents`). */}
          <div className="grid gap-4 p-3 lg:h-full lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-0 lg:p-0">
            <main className="contents lg:flex lg:min-h-0 lg:flex-col lg:gap-4 lg:overflow-y-auto lg:p-4">
              {active ? (
                <>
                  <div className="order-1 flex-none justify-self-center lg:order-none lg:self-center">
                    <Preview
                      project={project}
                      clip={active}
                      words={words}
                      player={player}
                      fontsReady={fonts.ready}
                      mode={activeView}
                      onModeChange={(mode) => setView({ clipId: active.id, mode })}
                      thumbnailTime={resolveThumbnailTime(active, candidates)}
                      customUi={customUi}
                      onCustomUiChange={setCustomUi}
                      onCustomChange={(custom) => edit(active.id, { settings: { custom } })}
                      selectedWatermark={selectedWatermark}
                      onSelectWatermark={setSelectedWatermark}
                      onWatermarksChange={(watermarks) => edit(active.id, { settings: { watermarks } })}
                      selectedItem={selectedItem}
                      onSelectItem={selectItem}
                      onTimelineChange={(timeline) => edit(active.id, { timeline })}
                    />
                  </div>
                  <div className="order-2 min-w-0 flex-none lg:order-none">
                    <Timeline
                      project={project}
                      clip={active}
                      player={player}
                      edit={edit}
                      flushAll={flushAll}
                      applyProject={applyProject}
                      selected={selectedItem}
                      onSelect={selectItem}
                      onShowPreview={() => setView({ clipId: active.id, mode: "preview" })}
                    />
                  </div>
                  {fonts.error && (
                    <p className="order-2 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200 lg:order-none">
                      {fonts.error}
                    </p>
                  )}
                </>
              ) : (
                <div className="order-1 lg:order-none">
                  <Empty>
                    <span className="flex flex-col items-center gap-2">
                      <Film className="size-8 text-zinc-600" aria-hidden />
                      {clips.length === 0 && project.stages.highlights.status !== "done"
                        ? "The preview opens once highlights are found, or add a clip by hand."
                        : "Select or add a clip to preview it."}
                    </span>
                  </Empty>
                </div>
              )}

              {/* Highlights: picking one loads it into the preview, timeline and settings. */}
              <section
                aria-label="Highlights"
                data-clip-list=""
                className="order-4 flex-none overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 lg:order-none lg:max-h-[26rem] lg:overflow-y-auto"
              >
                <div
                  role="tablist"
                  aria-label="Clip lists"
                  className="sticky top-0 z-10 flex border-b border-zinc-800 bg-zinc-950"
                >
                  {(
                    [
                      ["clips", `Highlights (${clips.length})`],
                      ["rendered", `Rendered (${rendered.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      type="button"
                      aria-selected={tab === key}
                      onClick={() => setTab(key)}
                      className={cn(
                        "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                        tab === key
                          ? "border-indigo-400 text-white"
                          : "border-transparent text-zinc-400 hover:text-zinc-200",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {tab === "clips" ? (
                  <ClipList
                    project={project}
                    clips={clips}
                    activeId={active?.id ?? null}
                    sort={sort}
                    onSortChange={setSort}
                    onActivate={setActiveId}
                    onSelect={(clipId, selected) => edit(clipId, { selected }, true)}
                    onSelectAll={(selected) => {
                      for (const c of clips) if (c.selected !== selected) edit(c.id, { selected }, true);
                    }}
                    onAdd={() => void addClip()}
                  />
                ) : (
                  <RenderedGallery
                    project={project}
                    clips={rendered}
                    onPlay={(clip) => {
                      setActiveId(clip.id);
                      setView({ clipId: clip.id, mode: "rendered" });
                    }}
                  />
                )}
              </section>
            </main>

            {active && (
              <aside
                ref={configColumn}
                aria-label="Settings"
                className="compact order-3 flex min-w-0 flex-col gap-2 lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-zinc-800 lg:bg-zinc-950 lg:p-2.5"
                data-testid="config-column"
              >
                <Inspector
                  project={project}
                  clip={active}
                  player={player}
                  edit={edit}
                  selected={selectedItem}
                  onSelect={selectItem}
                />
                <SettingsPanel
                  key={active.id}
                  project={project}
                  clip={active}
                  player={player}
                  fontsReady={fonts.ready}
                  edit={edit}
                  flushAll={flushAll}
                  applyProject={applyProject}
                  candidates={candidates}
                  onShowThumbnail={() => setView({ clipId: active.id, mode: "thumbnail" })}
                  onShowPreview={() => setView({ clipId: active.id, mode: "preview" })}
                  customUi={customUi}
                  onCustomUiChange={setCustomUi}
                  selectedWatermark={selectedWatermark}
                  onSelectWatermark={setSelectedWatermark}
                  onOpenWebcam={() => setWebcamOpen(true)}
                  onDeleteClip={(c) => void deleteClip(c)}
                />
                <Transcript
                  clip={active}
                  words={words}
                  loading={project.stages.transcribe.status !== "done"}
                  error={transcriptError}
                  player={player}
                />
              </aside>
            )}
          </div>
        </div>
      )}

      <RenderBar project={project} clips={clips} flushAll={flushAll} applyProject={applyProject} />
      {webcamOpen && source && (
        <WebcamEditor
          project={project}
          initialTime={active?.start ?? source.duration * 0.1}
          onClose={() => setWebcamOpen(false)}
          applyProject={applyProject}
        />
      )}
    </div>
  );
}

function RenderedGallery({
  project,
  clips,
  onPlay,
}: {
  project: Project;
  clips: Clip[];
  onPlay: (clip: Clip) => void;
}) {
  if (clips.length === 0) return <Empty>Finished shorts appear here.</Empty>;
  return (
    <ul
      className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-2 p-3"
      aria-label="Rendered shorts"
    >
      {clips.map((clip) => (
        <li key={clip.id} className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
          {clip.thumbnail.file && (
            <a
              href={media.clip(project.id, clip.thumbnail.file, true)}
              download
              title="Download the thumbnail"
              className="block"
            >
              <img
                src={media.thumbnailFile(project.id, clip.thumbnail.file, clip.thumbnail.generatedAt)}
                alt={`Thumbnail of ${clip.title}`}
                loading="lazy"
                className="aspect-[9/16] w-24 rounded border border-zinc-800 bg-zinc-950 object-cover"
              />
            </a>
          )}
          <span className="line-clamp-2 text-sm font-medium">{clip.title}</span>
          <span className="text-xs text-zinc-400 tabular-nums">
            {fmtTime(clip.start)} - {fmtTime(clip.end)} · {(clip.end - clip.start).toFixed(0)}s
            {clip.render.renderedAt && ` · ${new Date(clip.render.renderedAt).toLocaleTimeString()}`}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => onPlay(clip)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-indigo-600 px-2 text-xs font-medium text-white hover:bg-indigo-500"
            >
              <Play className="size-3.5" aria-hidden /> Play
            </button>
            <a
              href={media.clip(project.id, clip.render.file!, true)}
              download
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 text-xs font-medium hover:bg-zinc-700"
            >
              <Download className="size-3.5" aria-hidden /> Download
            </a>
          </span>
        </li>
      ))}
    </ul>
  );
}
