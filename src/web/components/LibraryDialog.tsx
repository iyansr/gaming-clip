import { FolderOpen, Loader2, Music, Pause, Play, Trash2, Upload, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { LIBRARY_LIMITS, LIBRARY_TYPES } from "../../shared/library";
import type { LibraryItem, LibraryKind } from "../../shared/types";
import {
  api,
  errorMessage,
  libraryAccept,
  libraryFileError,
  libraryNameOf,
  media,
  uploadLibraryFile,
} from "../lib/api";
import { cn } from "../lib/format";
import { Button, inputClass, ProgressBar } from "./ui";

/** What a picker wants: items of one kind, handed to `onPick` (the dialog closes) instead of just managed. */
export interface LibraryOpenOptions {
  kind?: LibraryKind;
  onPick?: (item: LibraryItem) => void;
}

interface LibraryContextValue {
  items: LibraryItem[];
  /** Items by file name. */
  byFile: Map<string, LibraryItem>;
  loaded: boolean;
  error: string | null;
  open: (options?: LibraryOpenOptions) => void;
  upsert: (item: LibraryItem) => void;
  drop: (file: string) => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary outside LibraryProvider");
  return ctx;
}

const KIND_LABEL: Record<LibraryKind, { plural: string; singular: string }> = {
  sound: { plural: "Sounds", singular: "sound" },
  sticker: { plural: "Stickers", singular: "sticker" },
  video: { plural: "Videos", singular: "video" },
};
const KINDS: LibraryKind[] = ["sound", "sticker", "video"];

/** Holds the one library dialog for the app and the shared list of library items. */
export function LibraryProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LibraryOpenOptions | null>(null);

  useEffect(() => {
    api.library().then(
      (list) => {
        setItems(list);
        setLoaded(true);
      },
      (e: unknown) => {
        setError(errorMessage(e));
        setLoaded(true);
      },
    );
  }, []);

  const open = useCallback((options: LibraryOpenOptions = {}) => setDialog(options), []);
  const upsert = useCallback(
    (item: LibraryItem) =>
      setItems((all) =>
        all.some((i) => i.file === item.file) ? all.map((i) => (i.file === item.file ? item : i)) : [item, ...all],
      ),
    [],
  );
  const drop = useCallback((file: string) => setItems((all) => all.filter((i) => i.file !== file)), []);
  const byFile = useMemo(() => new Map(items.map((i) => [i.file, i])), [items]);
  const value = useMemo(
    () => ({ items, byFile, loaded, error, open, upsert, drop }),
    [items, byFile, loaded, error, open, upsert, drop],
  );

  return (
    <LibraryContext.Provider value={value}>
      {children}
      <LibraryDialog options={dialog} onClose={() => setDialog(null)} />
    </LibraryContext.Provider>
  );
}

/** Opens the library for managing (all kinds). */
export function LibraryButton() {
  const { open, items } = useLibrary();
  return (
    <Button onClick={() => open()} aria-haspopup="dialog" title="Sounds, stickers and videos shared by all projects">
      <FolderOpen className="size-4" aria-hidden /> Library
      <span className="text-xs font-normal text-zinc-400">{items.length}</span>
    </Button>
  );
}

interface UploadState {
  id: number;
  name: string;
  fraction: number;
  error: string | null;
}

const fmtMeta = (item: LibraryItem) =>
  item.kind === "sticker"
    ? `${item.width}×${item.height}`
    : `${item.duration?.toFixed(1) ?? "?"} s${item.kind === "video" && item.width ? ` · ${item.width}×${item.height}` : ""}`;

function LibraryDialog({ options, onClose }: { options: LibraryOpenOptions | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = options !== null;
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const pick = options?.kind;
  return (
    // Backdrop click is a pointer shortcut only; Esc and the Close button are the keyboard path.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- see above
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[44rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/60 open:flex"
    >
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <h2 id={titleId} className="flex-1 text-base font-semibold">
          {pick ? `Pick a ${KIND_LABEL[pick].singular}` : "Media library"}
        </h2>
        <Button variant="ghost" small onClick={onClose} aria-label="Close library">
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      {open && options ? <LibraryBody options={options} onClose={onClose} /> : null}
    </dialog>
  );
}

function LibraryBody({ options, onClose }: { options: LibraryOpenOptions; onClose: () => void }) {
  const { items, loaded, error, upsert } = useLibrary();
  const [tab, setTab] = useState<LibraryKind>(options.kind ?? "sound");
  const kind = options.kind ?? tab;
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextUpload = useRef(1);

  const shown = items.filter((i) => i.kind === kind);

  const patchUpload = (id: number, patch: Partial<UploadState>) =>
    setUploads((all) => all.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const upload = async (files: File[]) => {
    for (const file of files) {
      const id = nextUpload.current++;
      const name = libraryNameOf(file);
      const problem =
        libraryFileError(file) ??
        (options.kind && LIBRARY_TYPES[file.type]?.kind !== options.kind
          ? `${file.name}: pick a ${KIND_LABEL[options.kind].singular} file here`
          : null);
      setUploads((all) => [...all, { id, name: file.name, fraction: 0, error: problem }]);
      if (problem) continue;
      try {
        const item = await uploadLibraryFile(file, name, (fraction) => patchUpload(id, { fraction }));
        upsert(item);
        setUploads((all) => all.filter((u) => u.id !== id));
        if (!options.kind) setTab(item.kind);
      } catch (e) {
        patchUpload(id, { error: errorMessage(e) });
      }
    }
  };

  const picked = (item: LibraryItem) => {
    options.onPick?.(item);
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!options.kind && (
        <div role="tablist" aria-label="Library kinds" className="flex border-b border-zinc-800">
          {KINDS.map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                "flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === k ? "border-indigo-400 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200",
              )}
            >
              {KIND_LABEL[k].plural} ({items.filter((i) => i.kind === k).length})
            </button>
          ))}
        </div>
      )}

      {/* The drop zone also covers the list, so a file can be dropped anywhere in the dialog. */}
      <div
        role="presentation"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload([...e.dataTransfer.files]);
        }}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4",
          dragging && "bg-indigo-950/40 outline-2 -outline-offset-8 outline-indigo-400 outline-dashed",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={libraryAccept(options.kind)}
            className="sr-only"
            tabIndex={-1}
            aria-label="Library files"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void upload(files);
            }}
          />
          <Button variant="primary" onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" aria-hidden /> Upload{" "}
            {options.kind ? KIND_LABEL[options.kind].singular : "files"}
          </Button>
          <span className="text-xs text-zinc-400">
            or drop files here.{" "}
            {kind === "sound" &&
              `Up to ${LIBRARY_LIMITS.duration.sound} s, ${LIBRARY_LIMITS.bytes.sound / 1048576} MB.`}
            {kind === "sticker" && `PNG, WebP or JPEG, up to ${LIBRARY_LIMITS.bytes.sticker / 1048576} MB.`}
            {kind === "video" &&
              `Up to ${LIBRARY_LIMITS.duration.video} s, ${LIBRARY_LIMITS.bytes.video / 1048576} MB.`}
          </span>
        </div>

        {uploads.length > 0 && (
          <ul className="flex flex-col gap-1.5" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.id} className="flex flex-col gap-1 text-xs">
                <span className="flex items-center gap-2">
                  {u.error ? null : <Loader2 className="size-3.5 animate-spin text-zinc-400" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{u.name}</span>
                  {u.error && (
                    <button
                      type="button"
                      onClick={() => setUploads((all) => all.filter((x) => x.id !== u.id))}
                      className="text-zinc-400 hover:text-zinc-100"
                      aria-label={`Dismiss ${u.name}`}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  )}
                </span>
                {u.error ? (
                  <span role="alert" className="text-red-300">
                    {u.error}
                  </span>
                ) : (
                  <ProgressBar value={u.fraction} label={`Uploading ${u.name}`} />
                )}
              </li>
            ))}
          </ul>
        )}

        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the library...
          </p>
        ) : error ? (
          <p role="alert" className="rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
            The library could not be loaded: {error}
          </p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">
            No {KIND_LABEL[kind].plural.toLowerCase()} yet. Upload one; it is shared by all your projects.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={KIND_LABEL[kind].plural}>
            {shown.map((item) => (
              <LibraryRow key={item.file} item={item} onPick={options.onPick ? () => picked(item) : null} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LibraryRow({ item, onPick }: { item: LibraryItem; onPick: (() => void) | null }) {
  const { upsert, drop } = useLibrary();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next === "" || next === item.name) return;
    setProblem(null);
    try {
      upsert(await api.renameLibraryItem(item.file, next));
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${item.name}" from the library?`)) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteLibraryItem(item.file);
      drop(item.file);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
      <div className="flex items-center gap-3">
        <LibraryPreview item={item} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            type="text"
            maxLength={LIBRARY_LIMITS.nameLength}
            value={draft ?? item.name}
            onFocus={() => setDraft(item.name)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setDraft(null);
            }}
            aria-label={`Name of ${item.name}`}
            className={cn(inputClass, "h-8")}
          />
          <span className="text-xs text-zinc-400 tabular-nums">{fmtMeta(item)}</span>
        </div>
        {onPick && (
          <Button variant="primary" small onClick={onPick}>
            Use
          </Button>
        )}
        <Button
          variant="ghost"
          small
          disabled={busy}
          onClick={() => void remove()}
          className="w-8 px-0 text-red-300 hover:text-red-200"
          aria-label={`Delete ${item.name}`}
          title="Delete"
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-red-300">
          {problem}
        </p>
      )}
    </li>
  );
}

/** Play button for a sound, image thumbnail for a sticker, poster frame (click to play) for a video. */
function LibraryPreview({ item }: { item: LibraryItem }) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const url = media.library(item.file);

  const toggle = () => {
    const el = item.kind === "sound" ? audio.current : video.current;
    if (!el) return;
    if (el.paused) el.play().catch((e: unknown) => console.error(e));
    else el.pause();
  };

  if (item.kind === "sticker") {
    return (
      <span className="grid size-14 shrink-0 place-items-center rounded bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)] bg-[length:12px_12px]">
        <img src={url} alt="" className="max-h-full max-w-full object-contain" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`${playing ? "Pause" : "Play"} ${item.name}`}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded bg-zinc-900 text-white",
        item.kind === "video" ? "h-20 w-12" : "size-14",
      )}
    >
      {item.kind === "sound" ? (
        <>
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a short user-uploaded sound effect */}
          <audio
            ref={audio}
            src={url}
            preload="none"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          <Music className="absolute size-6 text-zinc-600" aria-hidden />
        </>
      ) : (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a user-uploaded end card
        <video
          ref={video}
          src={`${url}#t=0.1`}
          preload="metadata"
          playsInline
          className="size-full object-cover"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
      <span className="absolute grid size-7 place-items-center rounded-full bg-black/60">
        {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
      </span>
    </button>
  );
}
