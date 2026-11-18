import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

import type { WhisperModelStatus } from "../../../core/whisper-models";
import { LANGUAGES, OTHER_LANGUAGE } from "../../lib/languages";
import { fmtBytes } from "../../lib/settings";
import { Badge, Button, ProgressBar } from "../ui";
import { envNote, Section, SelectField, TextField, type SectionProps } from "./parts";

const SIZE_WORDS: Record<string, string> = {
  tiny: "fastest, roughest",
  base: "fast, rough",
  small: "balanced",
  medium: "accurate, slower",
  "large-v3": "most accurate, slowest",
  "large-v3-turbo": "very accurate, fast",
};

/** "large-v3-turbo-q5_0" -> "very accurate, fast, compressed". */
function describe(name: string): string {
  const base = name.replace(/-q\d+_\d+$/, "");
  const words = SIZE_WORDS[base] ?? "";
  return name === base ? words : `${words}${words ? ", " : ""}compressed`;
}

interface Props extends SectionProps {
  models: WhisperModelStatus[] | null;
  onDownload: (name: string) => Promise<void>;
}

export function TranscriptionSection({ settings, draft, update, models, onDownload }: Props) {
  const [starting, setStarting] = useState(false);
  const locked = settings.sources.whisperModel === "env";
  const current = models?.find((model) => model.name === draft.whisperModel);
  const anyDownloading = models?.some((model) => model.downloading) ?? false;
  const languageKnown = LANGUAGES.some(([code]) => code === draft.defaultLanguage);
  const languageSelect = languageKnown ? draft.defaultLanguage : OTHER_LANGUAGE;

  const download = async (name: string) => {
    setStarting(true);
    try {
      await onDownload(name);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Section
      title="Transcription"
      intro="Gaming Clip writes down what is said in your video. Bigger models are more accurate but slower and need more disk space."
    >
      <div className="flex flex-col gap-2">
        <SelectField
          label="Speech model"
          value={draft.whisperModel}
          onChange={(whisperModel) => update({ whisperModel })}
          disabled={locked || models === null}
          note={envNote(settings, "whisperModel")}
          options={(
            models ?? [
              { name: draft.whisperModel, size: null, installed: true, selected: true, downloading: null, error: null },
            ]
          ).map((model) => ({
            value: model.name,
            label: `${model.name}${describe(model.name) ? ` (${describe(model.name)})` : ""} - ${model.size === null ? "size unknown" : fmtBytes(model.size)}${model.installed ? " - downloaded" : ""}`,
          }))}
        />
        {current && (
          <div
            className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs"
            aria-live="polite"
          >
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-sm font-medium text-zinc-100">{current.name}</b>
              {current.installed ? <Badge tone="good">downloaded</Badge> : <Badge tone="warn">not downloaded</Badge>}
              {current.size !== null && <span className="text-zinc-400">{fmtBytes(current.size)}</span>}
              <span className="flex-1" />
              {!current.installed && !current.downloading && (
                <Button
                  small
                  variant="primary"
                  onClick={() => void download(current.name)}
                  disabled={starting || anyDownloading || locked}
                >
                  <Download className="size-3.5" aria-hidden /> Download
                </Button>
              )}
            </div>
            {current.downloading && (
              <div className="flex flex-col gap-1">
                <ProgressBar
                  value={current.downloading.total > 0 ? current.downloading.received / current.downloading.total : 0}
                  label={`Downloading ${current.name}`}
                />
                <span className="inline-flex items-center gap-1.5 text-indigo-300">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Downloading{" "}
                  {fmtBytes(current.downloading.received)} of {fmtBytes(current.downloading.total)}
                </span>
              </div>
            )}
            {current.error && <p className="text-red-300">Download failed: {current.error}</p>}
            {!current.installed && !current.downloading && !current.error && (
              <p className="text-zinc-400">
                Download this model before you can use it. You can keep using Gaming Clip while it downloads.
              </p>
            )}
          </div>
        )}
        {anyDownloading && current && !current.downloading && (
          <p className="text-xs text-zinc-400">Another model is downloading. It will show here when it is done.</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <SelectField
          label="Language in new projects"
          value={languageSelect}
          onChange={(code) => update({ defaultLanguage: code === OTHER_LANGUAGE ? "" : code })}
          options={[
            ...LANGUAGES.map(([code, label]) => ({ value: code, label })),
            { value: OTHER_LANGUAGE, label: "Other..." },
          ]}
          help='"Auto-detect" works for most videos. Pick the language if detection guesses wrong.'
        />
        {languageSelect === OTHER_LANGUAGE && (
          <TextField
            label="Language code"
            value={draft.defaultLanguage}
            onChange={(defaultLanguage) => update({ defaultLanguage: defaultLanguage.trim().toLowerCase() })}
            placeholder="fr"
            help="Two or three letters, for example fr or de."
          />
        )}
      </div>
    </Section>
  );
}
