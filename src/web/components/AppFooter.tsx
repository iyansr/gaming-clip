import { ExternalLink } from "lucide-react";

import { REPO_URL } from "../../shared/project";
import { useSettings } from "./SettingsDialog";
import { SupportLinks } from "./SupportLinks";

/** Slim credits bar at the bottom of the app shell: always visible, never over page content. */
export function AppFooter() {
  const { settings } = useSettings();
  return (
    <footer className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-zinc-800 bg-zinc-950 px-4 py-1 text-[11px] text-zinc-400">
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded hover:text-zinc-100 hover:underline"
      >
        gaming-clip{settings ? ` v${settings.info.version}` : ""} &middot; Free &amp; open source (AGPL-3.0){" "}
        <ExternalLink className="size-3" aria-hidden />
      </a>
      <SupportLinks />
    </footer>
  );
}
