import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useId, useState } from "react";

import { api, errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import type { AiMode } from "../../lib/settings";
import { Badge, Button } from "../ui";
import { envNote, Section, TextField, type SectionProps } from "./parts";

const MODES: { id: AiMode; title: string; text: string }[] = [
  {
    id: "off",
    title: "Off",
    text: "Pick highlights from loudness and what is said. Free, works offline, nothing to set up.",
  },
  {
    id: "command",
    title: "An AI app on this computer",
    text: "Use an app you are already signed in to, such as Claude Code. No API key needed.",
  },
  {
    id: "openai",
    title: "OpenAI-compatible service",
    text: "OpenAI, OpenRouter, Groq, or a program on your own computer such as Ollama or LM Studio.",
  },
  {
    id: "anthropic",
    title: "Claude-compatible service",
    text: "Anthropic's Claude, or another service that uses the same format.",
  },
];

interface TestResult {
  ok: boolean;
  ms: number;
  error?: string;
}

interface Props extends SectionProps {
  /** Saves pending changes first, so the test runs against what the form shows. */
  saveFirst: () => Promise<boolean>;
  dirty: boolean;
}

export function AiSection({ settings, draft, update, saveFirst, dirty }: Props) {
  const name = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const modeLocked = settings.sources.aiMode === "env";
  const presetLocked = settings.sources.llmCommandPreset === "env";
  const usesApi = draft.aiMode === "openai" || draft.aiMode === "anthropic";
  const keyLocked = settings.sources.llmApiKey === "env";
  const keySaved = (settings.llmApiKeySet && !draft.clearApiKey) || draft.apiKey !== "";

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      if (dirty && !(await saveFirst())) return;
      setResult(await api.testAi());
    } catch (error) {
      setResult({ ok: false, ms: 0, error: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section
      title="Highlight AI"
      intro="Gaming Clip finds the best moments of a video. An AI can choose them more cleverly than the built-in method, but it is optional."
    >
      <fieldset className="flex flex-col gap-2" disabled={modeLocked}>
        <legend className="sr-only">How highlights are chosen</legend>
        {modeLocked && <p className="text-xs">{envNote(settings, "aiMode")}</p>}
        {MODES.map((mode) => (
          <label
            key={mode.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-950 p-3 has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-950/40 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-400",
              modeLocked && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name={name}
              value={mode.id}
              checked={draft.aiMode === mode.id}
              onChange={() =>
                update({
                  aiMode: mode.id,
                  ...(mode.id === "command" && draft.llmCommandPreset === null
                    ? {
                        llmCommandPreset:
                          (settings.aiCommandPresets.find((preset) => preset.found) ?? settings.aiCommandPresets[0])
                            ?.id ?? null,
                      }
                    : {}),
                })
              }
              className="mt-0.5 size-4 shrink-0 outline-none"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-zinc-100">{mode.title}</span>
              <span className="text-xs text-zinc-400">{mode.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {draft.aiMode === "command" && (
        <fieldset className="flex flex-col gap-2" disabled={presetLocked}>
          <legend className="mb-1 text-xs font-medium text-zinc-300">Which app?</legend>
          {presetLocked ? (
            <p className="text-xs">{envNote(settings, "llmCommandPreset")}</p>
          ) : (
            settings.aiCommandPresets.map((preset) => (
              <label
                key={preset.id}
                className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-800 px-3 py-2 has-[:checked]:border-indigo-500 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-indigo-400"
              >
                <input
                  type="radio"
                  name={`${name}-preset`}
                  value={preset.id}
                  checked={draft.llmCommandPreset === preset.id}
                  onChange={() => update({ llmCommandPreset: preset.id })}
                  className="size-4 outline-none"
                />
                <span className="text-sm text-zinc-100">{preset.label}</span>
                <Badge tone={preset.found ? "good" : "warn"}>
                  {preset.found ? "found on this computer" : "not found on this computer"}
                </Badge>
                <code className="basis-full pl-7 text-[11px] text-zinc-500">{preset.command}</code>
              </label>
            ))
          )}
          {!presetLocked &&
            draft.llmCommandPreset !== null &&
            !settings.aiCommandPresets.find((preset) => preset.id === draft.llmCommandPreset)?.found && (
              <p className="text-xs text-amber-300">
                This app is not installed here yet. Install it and sign in, then press Test.
              </p>
            )}
        </fieldset>
      )}

      {usesApi && (
        <div className="flex flex-col gap-3">
          <TextField
            label="Model name"
            value={draft.llmModel}
            onChange={(llmModel) => update({ llmModel })}
            disabled={settings.sources.llmModel === "env"}
            note={envNote(settings, "llmModel")}
            placeholder={draft.aiMode === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini"}
            help="The exact model to ask, as your service names it."
          />
          <TextField
            label="Web address (optional)"
            value={draft.llmBaseUrl}
            onChange={(llmBaseUrl) => update({ llmBaseUrl })}
            disabled={settings.sources.llmBaseUrl === "env"}
            note={envNote(settings, "llmBaseUrl")}
            placeholder={
              draft.aiMode === "anthropic" ? "https://your-gateway.example.com" : "https://api.openai.com/v1"
            }
            help={
              draft.aiMode === "anthropic"
                ? "Leave empty to use Anthropic directly. For another service, give its address without /v1."
                : "Leave empty to use OpenAI directly. For another service, give its address ending in /v1, for example http://localhost:11434/v1 for Ollama."
            }
          />
          <div className="flex flex-col gap-1">
            <TextField
              label="API key"
              type="password"
              value={draft.apiKey}
              onChange={(apiKey) => update({ apiKey, clearApiKey: false })}
              disabled={keyLocked}
              note={envNote(settings, "llmApiKey")}
              placeholder={keySaved ? "saved, type to replace it" : "Paste your key here"}
              help="Like a password for the service. It is kept on this computer only and is never shown again."
            />
            {keySaved && !keyLocked && (
              <div className="flex items-center gap-2 text-xs">
                <Badge tone={draft.apiKey !== "" ? "info" : "good"}>
                  {draft.apiKey !== "" ? "new key, not saved yet" : "saved"}
                </Badge>
                {settings.llmApiKeySet && draft.apiKey === "" && (
                  <button
                    type="button"
                    onClick={() => update({ clearApiKey: !draft.clearApiKey })}
                    className="rounded text-indigo-300 underline hover:text-indigo-200"
                  >
                    Remove saved key
                  </button>
                )}
              </div>
            )}
            {draft.clearApiKey && (
              <p className="text-xs text-amber-300">The saved key will be removed when you save.</p>
            )}
          </div>
        </div>
      )}

      {draft.aiMode !== "off" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void test()} disabled={testing}>
            {testing && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {testing ? "Testing..." : dirty ? "Save and test" : "Test"}
          </Button>
          <div role="status" aria-live="polite" className="min-w-0 flex-1 text-xs">
            {result?.ok && (
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden /> It works. The AI answered in{" "}
                {result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}.
              </span>
            )}
            {result && !result.ok && (
              <span className="flex items-start gap-1.5 text-red-300">
                <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{" "}
                <span className="break-words">{result.error}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
