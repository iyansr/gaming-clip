import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Film, Loader2, Play } from "lucide-react";
import type { Clip, Project } from "../../shared/types";
import { api, media } from "../lib/api";
import { clamp, cn, floor1, fmtTime } from "../lib/format";
import type { CustomUi } from "../lib/custom";
import { useCaptionFonts, useClipEdits, useProjectStream, useTranscriptWords } from "../lib/hooks";
import { Player } from "../lib/player";
import { Link } from "../lib/router";
import { useToast } from "../lib/toast";
import { ClipList, sortClips, type ClipSort } from "../components/ClipList";
import { Preview, type PreviewMode } from "../components/Preview";
import { ProjectHeader } from "../components/ProjectHeader";
import { RenderBar } from "../components/RenderBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { resolveThumbnailTime, useThumbnailCandidates } from "../components/ThumbnailEditor";
import { Transcript } from "../components/Transcript";
import { WebcamEditor } from "../components/WebcamEditor";
import { Empty } from "../components/ui";

export function ProjectPage({ id }: { id: string }) {
  const { project, online, missing, applyProject } = useProjectStream(id);
  if (missing) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-zinc-300">{missing}</p>
          <Link href="/" className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">
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

function ProjectView({ project, online, applyProject }: { project: Project; online: boolean; applyProject: (p: Project) => void }) {
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

  const source = project.source;
  const ready = project.stages.download.status === "done" && source !== null;

  const [player, setPlayer] = useState<Player | null>(null);
  useEffect(() => {
    if (!ready) return;
    const p = new Player(media.source(project.id));
    setPlayer(p);
    return () => {
      p.destroy();
      setPlayer(null);
    };
  }, [ready, project.id]);

  const sorted = useMemo(() => sortClips(clips, sort), [clips, sort]);
  const active = clips.find((c) => c.id === activeId) ?? sorted[0] ?? null;
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
      if (t instanceof HTMLButtonElement) return t.closest("aside") !== null;
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

  return (
    <div className="flex h-full flex-col">
      <ProjectHeader project={project} online={online} applyProject={applyProject} onOpenWebcam={() => setWebcamOpen(true)} />

      {!ready || !player ? (
        <div className="grid flex-1 place-items-center p-8">
          <Empty>
            {project.stages.download.status === "error" ? (
              "The download failed. Use Retry above."
            ) : (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for the source video. The editor opens once the download is done.
              </span>
            )}
          </Empty>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,320px)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
            <div role="tablist" aria-label="Clip lists" className="flex border-b border-zinc-800">
              {(
                [
                  ["clips", `Clips (${clips.length})`],
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
                    "flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                    tab === key ? "border-indigo-400 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200",
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
          </aside>

          <main className="min-h-0 overflow-y-auto p-4">
            {active ? (
              <div className="mx-auto flex w-full flex-col gap-4" style={{ maxWidth: "calc(min(62vh, 620px) * 9 / 16 + 520px)" }}>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-5">
                  <div className="sticky top-0 flex-none">
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
                    />
                  </div>
                  <div className="min-w-0">
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
                      onOpenWebcam={() => setWebcamOpen(true)}
                      onDeleteClip={(c) => void deleteClip(c)}
                    />
                  </div>
                </div>
                {fonts.error && <p className="rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">{fonts.error}</p>}
                <Transcript clip={active} words={words} loading={project.stages.transcribe.status !== "done"} error={transcriptError} player={player} />
              </div>
            ) : (
              <Empty>
                <span className="flex flex-col items-center gap-2">
                  <Film className="size-8 text-zinc-600" aria-hidden />
                  {clips.length === 0 && project.stages.highlights.status !== "done" ? "The preview opens once highlights are found, or add a clip by hand." : "Select or add a clip to preview it."}
                </span>
              </Empty>
            )}
          </main>
        </div>
      )}

      <RenderBar project={project} clips={clips} flushAll={flushAll} applyProject={applyProject} />
      {webcamOpen && source && (
        <WebcamEditor project={project} initialTime={active?.start ?? source.duration * 0.1} onClose={() => setWebcamOpen(false)} applyProject={applyProject} />
      )}
    </div>
  );
}

function RenderedGallery({ project, clips, onPlay }: { project: Project; clips: Clip[]; onPlay: (clip: Clip) => void }) {
  if (clips.length === 0) return <Empty>Finished shorts appear here.</Empty>;
  return (
    <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" aria-label="Rendered shorts">
      {clips.map((clip) => (
        <li key={clip.id} className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
          {clip.thumbnail.file && (
            <a href={media.clip(project.id, clip.thumbnail.file, true)} download title="Download the thumbnail" className="block">
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
