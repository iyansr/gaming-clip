import { Lock } from "lucide-react";
import { useId, type ReactNode } from "react";

import type { SettingField } from "../../../core/settings";
import { cn } from "../../lib/format";
import type { Draft, SettingsResponse } from "../../lib/settings";
import { inputClass } from "../ui";

export interface SectionProps {
  settings: SettingsResponse;
  draft: Draft;
  update: (change: Partial<Draft>) => void;
}

export function Section({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-zinc-800 px-5 py-5 first:border-t-0">
      <div>
        <h3 id={id} className="text-sm font-semibold text-zinc-100">
          {title}
        </h3>
        {intro && <p className="mt-1 text-xs text-zinc-400">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** "Set by LLM_MODEL in .env" when an environment variable decides the field, else nothing. */
export function envNote(settings: SettingsResponse, field: SettingField): ReactNode {
  if (settings.sources[field] !== "env") return null;
  return (
    <span className="inline-flex items-center gap-1 text-amber-300">
      <Lock className="size-3" aria-hidden /> Set by{" "}
      <code className="rounded bg-zinc-800 px-1">{settings.envVars[field]}</code> in .env. Remove it there to change it
      here.
    </span>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: ReactNode;
  note?: ReactNode;
  disabled?: boolean;
  type?: "text" | "password";
  placeholder?: string;
}

export function TextField({
  label,
  value,
  onChange,
  help,
  note,
  disabled,
  type = "text",
  placeholder,
}: TextFieldProps) {
  const inputId = useId();
  const describedBy = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-zinc-300">
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={help || note ? describedBy : undefined}
        className={inputClass}
      />
      {(help || note) && (
        <p id={describedBy} className="flex flex-col gap-0.5 text-xs text-zinc-400">
          {note}
          {help}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  help,
  note,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  help?: ReactNode;
  note?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const inputId = useId();
  const describedBy = useId();
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={inputId} className="text-xs font-medium text-zinc-300">
        {label}
      </label>
      <select
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={help || note ? describedBy : undefined}
        className={inputClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {(help || note) && (
        <p id={describedBy} className="flex flex-col gap-0.5 text-xs text-zinc-400">
          {note}
          {help}
        </p>
      )}
    </div>
  );
}
