import { Loader2, Settings, X } from "lucide-react";
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

import type { WhisperModelStatus } from "../../core/whisper-models";
import { api, errorMessage } from "../lib/api";
import { buildPatch, draftFrom, type Draft, type SettingsResponse } from "../lib/settings";
import { useToast } from "../lib/toast";
import { AiSection } from "./settings/AiSection";
import { AboutSection, RenderingSection } from "./settings/OtherSections";
import { TranscriptionSection } from "./settings/TranscriptionSection";
import { Button } from "./ui";

interface SettingsContextValue {
  /** Last known settings; null until the first load finished. */
  settings: SettingsResponse | null;
  open: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}

/** Holds the one settings dialog for the whole app, so any page can open it and read the saved values. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [isOpen, setOpen] = useState(false);

  useEffect(() => {
    api.settings().then(setSettings, (error: unknown) => toast.error(error));
  }, [toast]);

  const open = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ settings, open }), [settings, open]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsDialog open={isOpen} onClose={() => setOpen(false)} onSaved={setSettings} />
    </SettingsContext.Provider>
  );
}

/** Gear button for the top bar of every page. */
export function SettingsButton() {
  const { open } = useSettings();
  return (
    <Button variant="ghost" onClick={open} aria-label="Settings" title="Settings" aria-haspopup="dialog">
      <Settings className="size-5" aria-hidden />
      <span className="max-sm:sr-only">Settings</span>
    </Button>
  );
}

function SettingsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: SettingsResponse) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const requestClose = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  return (
    // Backdrop click is a pointer shortcut only; the keyboard path (Esc -> cancel event, or the Close button) is handled above and below.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- see above
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClose={() => {
        setConfirmDiscard(false);
        onClose();
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) requestClose();
      }}
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[44rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/60 open:flex"
    >
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <h2 id={titleId} className="flex-1 text-base font-semibold">
          Settings
        </h2>
        <Button variant="ghost" small onClick={requestClose} aria-label="Close settings">
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      {open ? (
        <SettingsForm
          onDirty={setDirty}
          onSaved={onSaved}
          onClose={onClose}
          requestClose={requestClose}
          confirmDiscard={confirmDiscard}
          cancelDiscard={() => setConfirmDiscard(false)}
        />
      ) : null}
    </dialog>
  );
}

interface FormProps {
  onDirty: (dirty: boolean) => void;
  onSaved: (settings: SettingsResponse) => void;
  onClose: () => void;
  requestClose: () => void;
  confirmDiscard: boolean;
  cancelDiscard: () => void;
}

/** Mounted only while the dialog is open, so every opening starts from the saved values. */
function SettingsForm({ onDirty, onSaved, onClose, requestClose, confirmDiscard, cancelDiscard }: FormProps) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<WhisperModelStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.settings().then(
      (settings) => {
        if (cancelled) return;
        setLoaded(settings);
        setDraft(draftFrom(settings));
      },
      (error: unknown) => !cancelled && setLoadError(errorMessage(error)),
    );
    api.whisperModels().then(
      (list) => !cancelled && setModels(list),
      (error: unknown) => !cancelled && toast.error(error),
    );
    return () => {
      cancelled = true;
      onDirty(false);
    };
  }, [onDirty, toast]);

  const downloading = models?.some((model) => model.downloading) ?? false;
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => {
      api.whisperModels().then(setModels, () => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [downloading]);

  const changed = loaded && draft ? buildPatch(draft, loaded) : null;
  const dirty = changed !== null && Object.keys(changed).length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = async (): Promise<boolean> => {
    if (!loaded || !draft || !changed) return false;
    if (Object.keys(changed).length === 0) return true;
    setSaving(true);
    try {
      const next = await api.patchSettings(changed);
      setLoaded(next);
      setDraft(draftFrom(next));
      onSaved(next);
      toast.info("Settings saved");
      return true;
    } catch (error) {
      toast.error(error);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const download = async (name: string) => {
    try {
      setModels(await api.downloadWhisperModel(name));
    } catch (error) {
      toast.error(error);
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="px-5 py-8 text-sm text-red-200">
        Could not load settings: {loadError}
      </div>
    );
  }
  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-zinc-400">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading settings...
      </div>
    );
  }

  const update = (change: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...change } : current));
  const section = { settings: loaded, draft, update };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AiSection {...section} dirty={dirty} saveFirst={save} />
        <TranscriptionSection {...section} models={models} onDownload={download} />
        <RenderingSection {...section} />
        <AboutSection info={loaded.info} />
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-950 px-5 py-3">
        {confirmDiscard ? (
          <>
            <p role="alert" className="mr-auto text-sm text-amber-200">
              You have changes that are not saved.
            </p>
            <Button onClick={cancelDiscard}>Keep editing</Button>
            <Button variant="danger" onClick={onClose}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            {dirty && <span className="mr-auto text-xs text-amber-300">Unsaved changes</span>}
            <Button onClick={requestClose}>{dirty ? "Cancel" : "Close"}</Button>
            <Button
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => {
                void save().then((ok) => ok && onClose());
              }}
            >
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save
            </Button>
          </>
        )}
      </footer>
    </>
  );
}
