import { ExternalLink } from "lucide-react";

import { REPO_URL } from "../../../shared/project";
import { MAX_RENDER_JOBS } from "../../../shared/settings";
import type { SettingsResponse } from "../../lib/settings";
import { SupportLinks } from "../SupportLinks";
import { envNote, Section, SelectField, type SectionProps } from "./parts";

export function RenderingSection({ settings, draft, update }: SectionProps) {
  return (
    <Section title="Rendering">
      <SelectField
        label="Videos made at the same time"
        value={String(draft.renderJobs)}
        onChange={(value) => update({ renderJobs: Number(value) })}
        disabled={settings.sources.renderJobs === "env"}
        note={envNote(settings, "renderJobs")}
        options={Array.from({ length: MAX_RENDER_JOBS }, (_, index) => ({
          value: String(index + 1),
          label: index === 0 ? "1 (one after another)" : String(index + 1),
        }))}
        className="max-w-xs"
        help="More is faster on a powerful computer but uses more memory. 2 is a good start. Applies to the next videos you render."
      />
    </Section>
  );
}

function Path({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all text-zinc-200">{value}</dd>
    </>
  );
}

export function AboutSection({ info }: { info: SettingsResponse["info"] }) {
  return (
    <Section title="About">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm max-sm:grid-cols-1 max-sm:gap-y-0.5">
        <Path label="Version" value={info.version} />
        <Path label="Address" value={`http://${info.host === "127.0.0.1" ? "localhost" : info.host}:${info.port}`} />
        <Path label="Projects folder" value={info.workspace} />
        <Path label="Models folder" value={info.models} />
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm font-medium whitespace-nowrap text-zinc-100 transition-colors hover:bg-zinc-700"
        >
          Source code and help <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <SupportLinks large />
      </div>
      <p className="text-xs text-zinc-400">
        Gaming Clip is free and open source (AGPL-3.0). If it saves you time, a small tip helps keep it going.
      </p>
    </Section>
  );
}
