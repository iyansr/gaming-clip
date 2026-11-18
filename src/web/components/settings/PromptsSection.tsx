import { RotateCcw } from "lucide-react";
import { useId } from "react";

import { MAX_PROMPT_CHARS } from "../../../shared/settings";
import { cn } from "../../lib/format";
import { Button, inputClass } from "../ui";
import { Section, type SectionProps } from "./parts";

interface PromptEditorProps {
  label: string;
  help: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}

function PromptEditor({ label, help, value, fallback, onChange }: PromptEditorProps) {
  const id = useId();
  const describedBy = useId();
  const isDefault = value.trim() === fallback.trim();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-zinc-300">
          {label}
        </label>
        <Button small variant="ghost" disabled={isDefault} onClick={() => onChange(fallback)}>
          <RotateCcw className="size-3.5" aria-hidden /> Reset to default
        </Button>
      </div>
      <textarea
        id={id}
        rows={9}
        maxLength={MAX_PROMPT_CHARS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-describedby={describedBy}
        className={cn(inputClass, "h-auto resize-y py-2 font-mono text-xs leading-relaxed")}
      />
      <p id={describedBy} className="flex justify-between gap-3 text-xs text-zinc-400">
        <span>{help}</span>
        <span className="shrink-0 tabular-nums">
          {isDefault ? "Built-in default · " : ""}
          {value.length}/{MAX_PROMPT_CHARS}
        </span>
      </p>
    </div>
  );
}

export function PromptsSection({ settings, draft, update }: SectionProps) {
  return (
    <Section
      title="Prompts"
      intro="What you tell the AI. You change the guidance only: the answer format, the time format, the clip length limits, the language and the platform limits are added after your text automatically, so a prompt cannot break parsing. Needs Highlight AI to be on."
    >
      <PromptEditor
        label="Highlights: what makes a good moment"
        help="Used when the AI picks clips from the transcript. Describe the moments you want, or what to skip."
        value={draft.highlightPrompt}
        fallback={settings.defaults.highlightPrompt}
        onChange={(highlightPrompt) => update({ highlightPrompt })}
      />
      <PromptEditor
        label="Post text: tone, style and hashtags"
        help="Used for the Instagram, TikTok and YouTube Shorts text of a clip. Describe your voice, audience and hashtag taste."
        value={draft.socialPrompt}
        fallback={settings.defaults.socialPrompt}
        onChange={(socialPrompt) => update({ socialPrompt })}
      />
      <p className="text-xs text-zinc-400">
        Saving the built-in text unchanged keeps following the default. Changes apply to the next AI run.
      </p>
    </Section>
  );
}
