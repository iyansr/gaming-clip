import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { CAPTION_FONTS } from "../../shared/captions";
import type { Clip, ClipSettings, ClipThumbnail, ClipTimeline, Project, Transcript, Word } from "../../shared/types";
import { api, errorMessage, type ClipPatch } from "./api";
import { useToast } from "./toast";

/** Live project state from the SSE stream, with reconnect + backoff. */
export function useProjectStream(id: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [online, setOnline] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);

  /** Never go back in time: SSE snapshots and PATCH responses can arrive out of order. */
  const applyProject = useCallback((next: Project) => {
    setProject((cur) => (cur && cur.id === next.id && cur.updatedAt > next.updatedAt ? cur : next));
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      source = new EventSource(`/api/projects/${id}/events`);
      source.addEventListener("project", (event) => {
        attempt = 0;
        setOnline(true);
        applyProject(JSON.parse((event as MessageEvent<string>).data) as Project);
      });
      source.onopen = () => setOnline(true);
      source.onerror = () => {
        source?.close();
        setOnline(false);
        void (async () => {
          try {
            const res = await fetch(`/api/projects/${id}`);
            if (res.status === 404) {
              if (!stopped) setMissing("This project no longer exists.");
              return;
            }
          } catch {
            // server unreachable: fall through to the retry
          }
          if (stopped) return;
          timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
        })();
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      window.clearTimeout(timer);
    };
  }, [id, applyProject]);

  return { project, online, missing, applyProject };
}

const NO_WORDS = { words: [] as Word[], error: null };

export function useTranscriptWords(projectId: string, transcribed: boolean): { words: Word[]; error: string | null } {
  // The result remembers its project, so switching project reads as "empty" until the new transcript arrives.
  const [result, setResult] = useState<{ projectId: string; words: Word[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!transcribed) return;
    let cancelled = false;
    api
      .transcript(projectId)
      .then((t: Transcript) => {
        if (!cancelled) setResult({ projectId, words: t.segments.flatMap((s) => s.words), error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ projectId, words: [], error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, transcribed]);
  return transcribed && result?.projectId === projectId ? result : NO_WORDS;
}

let fontsPromise: Promise<void> | null = null;

function loadCaptionFonts(): Promise<void> {
  fontsPromise ??= Promise.all(
    CAPTION_FONTS.map(async (f) => {
      const face = new FontFace(f.family, `url(/fonts/${f.file})`, { weight: String(f.weight) });
      document.fonts.add(face);
      await face.load();
    }),
  ).then(() => undefined);
  return fontsPromise;
}

/** True once every caption font is loaded. Throws into the error state when one fails. */
export function useCaptionFonts(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  useEffect(() => {
    let cancelled = false;
    loadCaptionFonts().then(
      () => !cancelled && setState({ ready: true, error: null }),
      (e: unknown) => {
        fontsPromise = null;
        if (!cancelled) setState({ ready: false, error: `Caption fonts failed to load: ${errorMessage(e)}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export interface ClipEdit {
  start?: number;
  end?: number;
  title?: string;
  selected?: boolean;
  settings?: Partial<ClipSettings>;
  thumbnail?: ClipPatch["thumbnail"];
  /** Whole replacement of the editor timeline; it is its own patch group. */
  timeline?: ClipTimeline;
}

function mergeEdit(a: ClipEdit | undefined, b: ClipEdit): ClipEdit {
  if (!a) return b;
  const merged: ClipEdit = { ...a, ...b };
  if (a.settings || b.settings) merged.settings = { ...a.settings, ...b.settings };
  if (a.thumbnail || b.thumbnail) merged.thumbnail = { ...a.thumbnail, ...b.thumbnail };
  return merged;
}

/** Mirrors the server: anything that changes what the cover shows drops the generated file. */
function invalidatesThumbnail(clip: Clip, edit: ClipEdit): boolean {
  return (
    edit.thumbnail !== undefined ||
    edit.start !== undefined ||
    edit.end !== undefined ||
    edit.settings?.layout !== undefined ||
    edit.settings?.focusX !== undefined ||
    edit.settings?.custom !== undefined ||
    (edit.settings?.watermarks !== undefined &&
      (edit.settings.watermarks.some((w) => w.onThumbnail) || clip.settings.watermarks.some((w) => w.onThumbnail))) ||
    (edit.title !== undefined && edit.title !== clip.title && clip.thumbnail.text === null)
  );
}

function applyEdit(clip: Clip, edit: ClipEdit | undefined): Clip {
  if (!edit) return clip;
  let thumbnail: ClipThumbnail = clip.thumbnail;
  if (edit.thumbnail) thumbnail = { ...thumbnail, ...edit.thumbnail };
  if (invalidatesThumbnail(clip, edit)) {
    const { file: _file, generatedAt: _at, usedTime: _used, ...rest } = thumbnail;
    thumbnail = rest;
  }
  return {
    ...clip,
    ...(edit.start !== undefined && { start: edit.start }),
    ...(edit.end !== undefined && { end: edit.end }),
    ...(edit.title !== undefined && { title: edit.title }),
    ...(edit.selected !== undefined && { selected: edit.selected }),
    ...(edit.timeline !== undefined && { timeline: edit.timeline }),
    settings: edit.settings ? { ...clip.settings, ...edit.settings } : clip.settings,
    thumbnail,
  };
}

const DEBOUNCE_MS = 300;

/** Independent field groups of a clip patch: the server validates each on its own. */
function splitEdit(edit: ClipEdit): ClipEdit[] {
  const groups: ClipEdit[] = [];
  if (edit.start !== undefined || edit.end !== undefined) groups.push({ start: edit.start, end: edit.end });
  if (edit.title !== undefined) groups.push({ title: edit.title });
  if (edit.selected !== undefined) groups.push({ selected: edit.selected });
  if (edit.settings) groups.push({ settings: edit.settings });
  if (edit.thumbnail) groups.push({ thumbnail: edit.thumbnail });
  if (edit.timeline) groups.push({ timeline: edit.timeline });
  return groups;
}

/**
 * Sends the whole patch in one request. When the server rejects it, retries each field group on its
 * own so one invalid field cannot take the others down; every rejection is reported.
 */
async function patchGroups(
  projectId: string,
  clipId: string,
  patch: ClipEdit,
  report: (e: unknown) => void,
): Promise<Project> {
  try {
    return await api.patchClip(projectId, clipId, patch);
  } catch (first) {
    const groups = splitEdit(patch);
    if (groups.length < 2) {
      report(first);
      return api.getProject(projectId);
    }
    for (const group of groups) {
      try {
        await api.patchClip(projectId, clipId, group);
      } catch (e) {
        report(e);
      }
    }
    return api.getProject(projectId);
  }
}

/**
 * Optimistic clip edits. Display = server clip + in-flight patch + unsent patch, so a snapshot that
 * arrives from the SSE stream never overwrites a field the user has touched but the server has not
 * confirmed yet. PATCHes are debounced per clip and serialised.
 */
export function useClipEdits(project: Project, applyProject: (p: Project) => void) {
  const toast = useToast();
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const dirty = useRef(new Map<string, ClipEdit>());
  const inflight = useRef(new Map<string, ClipEdit>());
  const timers = useRef(new Map<string, number>());
  const chains = useRef(new Map<string, Promise<void>>());
  const projectId = project.id;

  const send = useCallback(
    async (clipId: string) => {
      const patch = dirty.current.get(clipId);
      if (!patch) return;
      dirty.current.delete(clipId);
      inflight.current.set(clipId, patch);
      bump();
      try {
        applyProject(await patchGroups(projectId, clipId, patch, toast.error));
      } catch (e) {
        toast.error(e);
      } finally {
        inflight.current.delete(clipId);
        bump();
      }
    },
    [projectId, applyProject, toast],
  );

  const flush = useCallback(
    (clipId: string): Promise<void> => {
      window.clearTimeout(timers.current.get(clipId));
      timers.current.delete(clipId);
      const next = (chains.current.get(clipId) ?? Promise.resolve()).then(() => send(clipId));
      chains.current.set(clipId, next);
      return next;
    },
    [send],
  );

  const flushAll = useCallback(
    () =>
      Promise.all([...new Set([...dirty.current.keys(), ...inflight.current.keys()])].map((id) => flush(id))).then(
        () => undefined,
      ),
    [flush],
  );

  const edit = useCallback(
    (clipId: string, patch: ClipEdit, immediate = false) => {
      dirty.current.set(clipId, mergeEdit(dirty.current.get(clipId), patch));
      bump();
      window.clearTimeout(timers.current.get(clipId));
      if (immediate) void flush(clipId);
      else
        timers.current.set(
          clipId,
          window.setTimeout(() => void flush(clipId), DEBOUNCE_MS),
        );
    },
    [flush],
  );

  const discard = useCallback((clipId: string) => {
    window.clearTimeout(timers.current.get(clipId));
    timers.current.delete(clipId);
    dirty.current.delete(clipId);
    bump();
  }, []);

  useEffect(
    () => () => {
      for (const id of dirty.current.keys()) void flush(id);
    },
    [flush],
  );

  // `version` changes on every edit-state change; the maps are read inside the memo.
  const clips = useMemo(
    () => project.clips.map((c) => applyEdit(applyEdit(c, inflight.current.get(c.id)), dirty.current.get(c.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.clips, version],
  );

  return { clips, edit, flush, flushAll, discard };
}
