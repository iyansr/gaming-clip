import { ChevronRight } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600",
  secondary: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:hover:bg-zinc-800 border border-zinc-700",
  ghost: "text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:hover:bg-transparent",
  danger: "bg-red-700 text-white hover:bg-red-600 disabled:hover:bg-red-700",
};

export function Button({
  variant = "secondary",
  small = false,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        small ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function ProgressBar({ value, className, label }: { value: number; className?: string; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      className={cn("h-1.5 overflow-hidden rounded-full bg-zinc-800", className)}
    >
      <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Titled box. With `collapsible` the title becomes a toggle; the body stays mounted while collapsed (hidden), so
 * the fields inside keep their state.
 */
export function Panel({
  title,
  actions,
  children,
  className,
  collapsible = false,
  defaultOpen = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !collapsible || open;
  return (
    <section className={cn("rounded-lg border border-zinc-800 bg-zinc-900", className)}>
      {title && (
        <header
          className={cn("flex items-center justify-between gap-2 px-3 py-2", expanded && "border-b border-zinc-800")}
        >
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded text-left text-xs font-semibold tracking-wide text-zinc-400 uppercase hover:text-zinc-200"
            >
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
              {title}
            </button>
          ) : (
            <h2 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">{title}</h2>
          )}
          {actions}
        </header>
      )}
      <div hidden={!expanded}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center px-4 py-8 text-center text-sm text-zinc-400">{children}</div>;
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  title?: string;
}) {
  const tones = {
    neutral: "bg-zinc-800 text-zinc-300",
    good: "bg-emerald-950 text-emerald-300",
    warn: "bg-amber-950 text-amber-300",
    bad: "bg-red-950 text-red-300",
    info: "bg-indigo-950 text-indigo-300",
  };
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] leading-4 font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400 disabled:opacity-50";
