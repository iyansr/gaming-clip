import { Heart } from "lucide-react";

import { DONATE_URL, SPONSOR_URL } from "../../shared/project";
import { cn } from "../lib/format";

const base = "inline-flex items-center gap-1 rounded font-medium whitespace-nowrap transition-colors";

/** The two ways to support the project; shared by the footer and the Settings "About" section. */
export function SupportLinks({ className, large = false }: { className?: string; large?: boolean }) {
  const size = large ? "h-9 gap-1.5 px-3 text-sm" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <a
        href={SPONSOR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(base, size, "bg-pink-700 text-white hover:bg-pink-600")}
      >
        <Heart className={large ? "size-4" : "size-3"} aria-hidden /> Sponsor on GitHub
      </a>
      <a
        href={DONATE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(base, size, "border border-zinc-600 bg-zinc-800 text-zinc-100 hover:bg-zinc-700")}
      >
        Tip via Yapp
      </a>
    </span>
  );
}
