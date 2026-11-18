import { useState } from "react";

import { cn } from "../../lib/format";
import { round3 } from "../../lib/timeline";
import { inputClass } from "../ui";

/** Seconds field that commits a valid value on Enter or blur; `onCommit` returns why a value is refused. */
export function SecondsField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (seconds: number) => string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    const parsed = draft === null || draft.trim() === "" ? Number.NaN : Number(draft);
    setDraft(null);
    if (draft === null) return;
    if (!Number.isFinite(parsed)) return setProblem("Enter a number of seconds");
    const rounded = round3(parsed);
    setProblem(rounded === round3(value) ? null : onCommit(rounded));
  };
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-400">
      {label} (s)
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? String(round3(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            setProblem(null);
          }
        }}
        aria-invalid={problem !== null}
        className={cn(inputClass, "tabular-nums")}
      />
      {problem && (
        <span role="alert" className="text-red-300">
          {problem}
        </span>
      )}
    </label>
  );
}

/** Range slider with a decimal value (the shared Slider only does whole numbers). */
export function DecimalSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-zinc-200 tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={inputClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
