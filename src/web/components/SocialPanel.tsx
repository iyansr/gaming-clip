import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { hashtagLine, postText, SOCIAL_LIMITS, youtubeDescriptionText } from "../../shared/social";
import type { Clip, Project } from "../../shared/types";
import { api, errorMessage } from "../lib/api";
import { cn, fmtTime } from "../lib/format";
import { LANGUAGES } from "../lib/languages";
import { Badge, Button, inputClass, Panel } from "./ui";

type Platform = "instagram" | "tiktok" | "youtube";

const TABS: { id: Platform; label: string }[] = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube Shorts" },
];

/** "Same as the video" lets the server use the transcript's language. */
const LANGUAGE_OPTIONS: [string, string][] = [
  ["auto", "Same as the video"],
  ...LANGUAGES.filter(([code]) => code !== "auto"),
];

const COPIED_MS = 1500;

function Counter({ value, limit, label }: { value: number; limit: number; label?: string }) {
  const over = value > limit;
  return (
    <span className={cn("tabular-nums", over ? "text-red-300" : "text-zinc-400")} aria-label={label}>
      {value}/{limit}
    </span>
  );
}

function CopyButton({
  label,
  text,
  copied,
  onCopy,
}: {
  label: string;
  text: string;
  copied: string | null;
  onCopy: (label: string, text: string) => void;
}) {
  const done = copied === label;
  return (
    <Button small onClick={() => onCopy(label, text)} aria-label={done ? `${label}: copied` : label}>
      {done ? <Check className="size-3.5 text-emerald-300" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {done ? "Copied" : label}
    </Button>
  );
}

function Chips({ tags }: { tags: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Hashtags">
      {tags.map((tag) => (
        <li key={tag} className="rounded-full bg-indigo-950 px-2 py-0.5 text-xs text-indigo-200">
          #{tag}
        </li>
      ))}
    </ul>
  );
}

function ReadOnlyText({
  label,
  value,
  rows,
  counter,
}: {
  label: string;
  value: string;
  rows: number;
  counter: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-zinc-400">
        <label htmlFor={id}>{label}</label>
        {counter}
      </div>
      <textarea
        id={id}
        readOnly
        rows={rows}
        value={value}
        className={cn(inputClass, "h-auto resize-y py-1.5 leading-snug")}
      />
    </div>
  );
}

interface SocialPanelProps {
  project: Project;
  clip: Clip;
  applyProject: (p: Project) => void;
}

function SocialPanelBody({ project, clip, applyProject }: SocialPanelProps) {
  const [tab, setTab] = useState<Platform>("instagram");
  const [language, setLanguage] = useState("auto");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const languageId = useId();
  const social = clip.social;

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      applyProject(await api.generateSocial(project.id, clip.id, language === "auto" ? undefined : language));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Could not copy: the browser blocked clipboard access");
      return;
    }
    setCopied(label);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };

  const stale = social !== null && (social.start !== clip.start || social.end !== clip.end);
  const { instagram, tiktok, youtube } = SOCIAL_LIMITS;

  return (
    <Panel
      title="Post text"
      actions={
        social ? <Badge tone="good">Written in {social.language}</Badge> : <Badge tone="warn">Not written</Badge>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-36 flex-1 flex-col gap-1">
            <label htmlFor={languageId} className="text-xs font-medium text-zinc-300">
              Language
            </label>
            <select
              id={languageId}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={generating}
              className={inputClass}
            >
              {LANGUAGE_OPTIONS.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <Button variant="primary" onClick={() => void generate()} disabled={generating}>
            {generating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {generating ? "Writing..." : social ? "Regenerate" : "Generate"}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}

        {!social && !error && (
          <p className="text-xs text-zinc-400">
            Writes a caption, title and hashtags for Instagram, TikTok and YouTube Shorts with your Highlight AI. Change
            the tone under Settings &gt; Prompts.
          </p>
        )}

        {social && (
          <>
            {stale && (
              <p className="rounded-md bg-amber-950 px-2.5 py-1.5 text-xs text-amber-200">
                Written for an earlier trim ({fmtTime(social.start)} to {fmtTime(social.end)}). Regenerate to match the
                current clip.
              </p>
            )}
            <div role="tablist" aria-label="Platform" className="flex gap-1 border-b border-zinc-800">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`social-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`social-panel-${id}`}
                  onClick={() => {
                    setTab(id);
                    setCopied(null);
                  }}
                  className={cn(
                    "-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                    tab === id
                      ? "border-indigo-400 text-white"
                      : "border-transparent text-zinc-400 hover:text-zinc-100",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab !== "youtube" && (
              <div
                role="tabpanel"
                id={`social-panel-${tab}`}
                aria-labelledby={`social-tab-${tab}`}
                className="flex flex-col gap-2.5"
              >
                {(() => {
                  const post = social[tab];
                  const limit = tab === "instagram" ? instagram.total : tiktok.total;
                  return (
                    <>
                      <ReadOnlyText
                        label="Caption"
                        value={post.caption}
                        rows={tab === "instagram" ? 6 : 3}
                        counter={
                          <span className="flex gap-2">
                            {tab === "tiktok" && (
                              <span
                                className={cn(post.caption.length > tiktok.aim ? "text-amber-300" : "text-zinc-400")}
                                title={`Short captions work best on TikTok (aim for under ${tiktok.aim} characters)`}
                              >
                                {post.caption.length} chars, aim &lt; {tiktok.aim}
                              </span>
                            )}
                            <Counter value={postText(post).length} limit={limit} label="Characters with hashtags" />
                          </span>
                        }
                      />
                      <Chips tags={post.hashtags} />
                      <div className="flex flex-wrap gap-1.5">
                        <CopyButton label="Copy caption" text={post.caption} copied={copied} onCopy={copy} />
                        <CopyButton
                          label="Copy hashtags"
                          text={hashtagLine(post.hashtags)}
                          copied={copied}
                          onCopy={copy}
                        />
                        <CopyButton label="Copy all" text={postText(post)} copied={copied} onCopy={copy} />
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {tab === "youtube" && (
              <div
                role="tabpanel"
                id="social-panel-youtube"
                aria-labelledby="social-tab-youtube"
                className="flex flex-col gap-2.5"
              >
                <ReadOnlyText
                  label="Title"
                  value={social.youtube.title}
                  rows={2}
                  counter={<Counter value={social.youtube.title.length} limit={youtube.title} />}
                />
                <ReadOnlyText
                  label="Description"
                  value={social.youtube.description}
                  rows={4}
                  counter={
                    <Counter
                      value={youtubeDescriptionText(social.youtube).length}
                      limit={youtube.description}
                      label="Characters with hashtags"
                    />
                  }
                />
                <Chips tags={social.youtube.hashtags} />
                <div className="flex flex-wrap gap-1.5">
                  <CopyButton label="Copy title" text={social.youtube.title} copied={copied} onCopy={copy} />
                  <CopyButton
                    label="Copy description"
                    text={social.youtube.description}
                    copied={copied}
                    onCopy={copy}
                  />
                  <CopyButton
                    label="Copy hashtags"
                    text={hashtagLine(social.youtube.hashtags)}
                    copied={copied}
                    onCopy={copy}
                  />
                  <CopyButton
                    label="Copy all"
                    text={`${social.youtube.title}\n\n${youtubeDescriptionText(social.youtube)}`}
                    copied={copied}
                    onCopy={copy}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/** One post per clip: another clip starts again with its own tab, language, error and copy state. */
export function SocialPanel(props: SocialPanelProps) {
  return <SocialPanelBody key={props.clip.id} {...props} />;
}
