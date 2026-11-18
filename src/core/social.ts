import { hashtagLine, sanitizeHashtags, SHORTS_HASHTAG, SOCIAL_LIMITS } from "../shared/social";
import type { Clip, ClipSocial, Project, SocialPost, Transcript, YoutubeShortPost } from "../shared/types";
import { projectPaths } from "./config";
import { chatJson, type ChatMessage } from "./llm";
import { DEFAULT_SOCIAL_GUIDANCE } from "./prompts";
import { getSettings, llmConfigured } from "./settings";
import { ConflictError, getProject, markBusy, NotFoundError, updateProject, ValidationError } from "./store";

/** Most transcript characters sent to the model; a clip is at most three minutes of speech. */
const MAX_TRANSCRIPT_CHARS = 6000;
/** Languages written without spaces between words. */
const NO_SPACE_LANGUAGES = new Set(["ja", "zh", "th", "lo", "km", "my"]);
interface HashtagCount {
  min: number;
  max: number;
}

const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
const DEFAULT_LANGUAGE = "en";
const ATTEMPTS = 2;

export type SocialPosts = Pick<ClipSocial, "instagram" | "tiktok" | "youtube">;

/** The model answered, but not with usable post text. */
export class SocialFormatError extends Error {
  override name = "SocialFormatError";
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** Words whose middle lies inside [start, end], joined as plain text; segments without word timing count by overlap. */
export function clipTranscriptText(transcript: Transcript, start: number, end: number): string {
  const glue = NO_SPACE_LANGUAGES.has(transcript.language) ? "" : " ";
  const parts: string[] = [];
  for (const segment of transcript.segments) {
    if (segment.end <= start || segment.start >= end) continue;
    if (segment.words.length === 0) {
      const mid = (segment.start + segment.end) / 2;
      if (mid >= start && mid <= end) parts.push(segment.text.trim());
      continue;
    }
    for (const word of segment.words) {
      const mid = (word.start + word.end) / 2;
      if (mid >= start && mid <= end) parts.push(word.text.trim());
    }
  }
  const text = parts.filter(Boolean).join(glue).replace(/\s+/g, " ").trim();
  return clampText(text, MAX_TRANSCRIPT_CHARS);
}

/** Language of the post text: the user's choice, else what the transcript was detected as, else the default language setting. */
export function resolveLanguage(
  override: string | undefined,
  transcript: Transcript | null,
  fallback = "auto",
): string {
  const chosen = override?.trim().toLowerCase();
  if (chosen && chosen !== "auto") {
    if (!LANGUAGE_PATTERN.test(chosen)) throw new ValidationError(`language must be a language code like "en" or "id"`);
    return chosen;
  }
  const detected = transcript?.language.trim().toLowerCase();
  if (detected && LANGUAGE_PATTERN.test(detected)) return detected;
  return LANGUAGE_PATTERN.test(fallback) ? fallback : DEFAULT_LANGUAGE;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface SocialInput {
  videoTitle: string;
  /** Channel of the source video; usually the streamer in the clip. Empty for local files. */
  channel: string;
  clipTitle: string;
  reason: string;
  /** Clip length in seconds. */
  duration: number;
  language: string;
  /** Spoken words inside the clip; empty when there is no speech. */
  transcript: string;
}

const SOCIAL_SYSTEM: ChatMessage = {
  role: "system",
  content:
    "You write post text for vertical gaming shorts on Instagram, TikTok and YouTube Shorts. Reply with one JSON object only, no prose.",
};

/**
 * The structural part: output schema and platform limits. Always the last thing in the prompt, after the editable
 * guidance, so a custom guidance can change tone and style but not the format the parser relies on.
 */
function socialFormat(): string {
  const { instagram, tiktok, youtube } = SOCIAL_LIMITS;
  return [
    "Output format. These rules always apply and override anything above:",
    "Reply with exactly one JSON object and nothing else: no prose, no code fence, no comments. Use this shape:",
    '{"instagram":{"caption":string,"hashtags":string[]},"tiktok":{"caption":string,"hashtags":string[]},"youtube":{"title":string,"description":string,"hashtags":string[]}}',
    'Hashtags are plain words without "#" and without spaces (letters, digits, underscore), most relevant first. Never put hashtags inside a caption or description; only the youtube title may end with a few.',
    `instagram: caption at most ${instagram.total - 300} characters, ${instagram.hashtags.min} to ${instagram.hashtags.max} hashtags.`,
    `tiktok: caption at most ${tiktok.total - 300} characters (aim for under ${tiktok.aim}), ${tiktok.hashtags.min} to ${tiktok.hashtags.max} hashtags.`,
    `youtube: title at most ${youtube.title} characters on a single line, description at most ${youtube.description - 500} characters, exactly ${youtube.hashtags.max} hashtags and one of them is "${SHORTS_HASHTAG}".`,
    "Escape quotes and line breaks inside JSON strings.",
  ].join("\n");
}

/** Messages for one generation: facts, then the editable guidance, then the fixed output format. */
export function socialMessages(input: SocialInput, guidance: string): ChatMessage[] {
  const name = languageName(input.language);
  const facts = [
    `Video title: ${input.videoTitle || "(unknown)"}`,
    `Channel (usually the streamer): ${input.channel || "(unknown)"}`,
    `Clip title: ${input.clipTitle || "(none)"}`,
    `Why it was picked: ${input.reason || "(not given)"}`,
    `Clip length: ${Math.round(input.duration)} seconds`,
    `Language: write every caption, title and description in ${name} (${input.language}). Hashtags may mix ${name} with the common English gaming hashtags.`,
    "",
    "What is said in the clip (speech recognition, may contain mistakes; use it only to learn what happens):",
    input.transcript || "(no speech in this clip)",
  ];
  return [
    SOCIAL_SYSTEM,
    {
      role: "user",
      content: [
        ...facts,
        "",
        "Guidance from the creator (it decides tone, style, audience and hashtag choice only):",
        guidance.trim() || DEFAULT_SOCIAL_GUIDANCE,
        "",
        socialFormat(),
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cuts at a word boundary and ends with an ellipsis; text that fits is returned unchanged. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.search(/\s\S*$/);
  const base = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.trimEnd().replace(/[,;:\-–—]$/, "")}…`;
}

const TRAILING_HASHTAGS = /(?:[ \t]*#[\p{L}\p{M}\p{N}_]+)+[ \t]*$/u;

/** Models like to repeat the hashtags at the end of the caption; they are kept as a separate list. */
function withoutTrailingHashtags(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(TRAILING_HASHTAGS, ""))
    .join("\n");
}

/** Source credit line added to the YouTube description; only for videos that came from a URL. */
export function sourceCredit(input: string | undefined): string {
  return input && /^https?:\/\//i.test(input) ? `SC: ${input}` : "";
}

function field(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new SocialFormatError(`${what} is missing "${key}"`);
  return value;
}

/** Multi-line text: unified line breaks, no outer blanks, at most one empty line in a row. */
function cleanBody(text: string): string {
  return withoutTrailingHashtags(text.replace(/\r\n?/g, "\n"))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hashtags are appended to the text on paste, so the text budget is what the limit leaves after them. */
function clampWithHashtags(text: string, hashtags: string[], limit: number): string {
  const tail = hashtags.length ? hashtagLine(hashtags).length + 2 : 0;
  return clampText(text, limit - tail);
}

function pickHashtags(own: string[], pool: string[], limits: HashtagCount): string[] {
  const seen = new Set(own.map((tag) => tag.toLocaleLowerCase()));
  const tags = own.slice(0, limits.max);
  for (const tag of pool) {
    if (tags.length >= limits.min) break;
    if (seen.has(tag.toLocaleLowerCase())) continue;
    seen.add(tag.toLocaleLowerCase());
    tags.push(tag);
  }
  if (tags.length < limits.min)
    throw new SocialFormatError(`only ${tags.length} usable hashtags, at least ${limits.min} needed`);
  return tags;
}

const isShorts = (tag: string) => tag.toLocaleLowerCase() === SHORTS_HASHTAG.toLocaleLowerCase();

/** `Shorts` once, last; the other tags fill the remaining places. */
function youtubeHashtags(own: string[], pool: string[]): string[] {
  const { max } = SOCIAL_LIMITS.youtube.hashtags;
  const others = pickHashtags(
    own.filter((tag) => !isShorts(tag)),
    pool.filter((tag) => !isShorts(tag)),
    { min: max - 1, max: max - 1 },
  );
  return [...others, SHORTS_HASHTAG];
}

/**
 * Validates and clamps the model's JSON: required strings, limits per platform (text + hashtags within the
 * platform's total), 3-8 / 3-6 / 3 hashtags (short lists are topped up from the other platforms' tags),
 * hashtags sanitised and de-duplicated, `Shorts` always on YouTube, `credit` (when given) as the last line of the
 * YouTube description. Throws SocialFormatError for unusable answers.
 */
export function parseSocial(raw: unknown, credit = ""): SocialPosts {
  if (!isRecord(raw)) throw new SocialFormatError("the answer is not a JSON object");
  const parts = (["instagram", "tiktok", "youtube"] as const).map((key) => {
    const value = raw[key];
    if (!isRecord(value)) throw new SocialFormatError(`the answer has no "${key}" object`);
    return value;
  });
  const [instagram, tiktok, youtube] = parts as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  const own = {
    instagram: sanitizeHashtags(instagram.hashtags),
    tiktok: sanitizeHashtags(tiktok.hashtags),
    youtube: sanitizeHashtags(youtube.hashtags),
  };
  const pool = sanitizeHashtags([...own.instagram, ...own.tiktok, ...own.youtube]);

  const post = (record: Record<string, unknown>, what: string, tags: string[], total: number): SocialPost => {
    const caption = clampWithHashtags(cleanBody(field(record, "caption", what)), tags, total);
    if (caption === "") throw new SocialFormatError(`${what} caption is empty`);
    return { caption, hashtags: tags };
  };
  const instagramTags = pickHashtags(own.instagram, pool, SOCIAL_LIMITS.instagram.hashtags);
  const tiktokTags = pickHashtags(own.tiktok, pool, SOCIAL_LIMITS.tiktok.hashtags);
  const youtubeTags = youtubeHashtags(own.youtube, pool);

  // Clip channels end the title with the streamer's hashtags; keep them, on one line.
  const title = clampText(field(youtube, "title", "youtube").replace(/\s+/g, " ").trim(), SOCIAL_LIMITS.youtube.title);
  // The credit is appended after clamping so a long description can never cut it off.
  const reserved = credit ? credit.length + 2 : 0;
  const body = clampWithHashtags(
    cleanBody(field(youtube, "description", "youtube")),
    youtubeTags,
    SOCIAL_LIMITS.youtube.description - reserved,
  );
  const description = credit ? (body ? `${body}\n\n${credit}` : credit) : body;
  if (title === "") throw new SocialFormatError("youtube title is empty");
  const youtubePost: YoutubeShortPost = { title, description, hashtags: youtubeTags };
  return {
    instagram: post(instagram, "instagram", instagramTags, SOCIAL_LIMITS.instagram.total),
    tiktok: post(tiktok, "tiktok", tiktokTags, SOCIAL_LIMITS.tiktok.total),
    youtube: youtubePost,
  };
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/** `project:clip` of generations in flight in this process. */
const generating = new Set<string>();

async function readTranscript(id: string): Promise<Transcript | null> {
  const file = Bun.file(projectPaths(id).transcript);
  return (await file.exists()) ? ((await file.json()) as Transcript) : null;
}

function findClip(project: Project, clipId: string): Clip {
  const clip = project.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new NotFoundError(`Clip not found: ${clipId}`);
  return clip;
}

/**
 * Writes the Instagram / TikTok / YouTube Shorts post text of one clip with the highlight AI and stores it on
 * `clip.social`. The text is written for the clip's range at the time of the call (kept in `social.start/end`).
 */
export async function generateSocial(
  projectId: string,
  clipId: string,
  options: { language?: string } = {},
  signal?: AbortSignal,
): Promise<Project> {
  const project = await getProject(projectId);
  const clip = findClip(project, clipId);
  if (!llmConfigured()) throw new ConflictError("Set up Highlight AI in Settings first");
  const key = `${projectId}:${clipId}`;
  if (generating.has(key)) throw new ConflictError("The post text of this clip is already being written");
  generating.add(key);
  const release = await markBusy(projectId).catch((error: unknown) => {
    generating.delete(key);
    throw error;
  });
  try {
    const transcript = await readTranscript(projectId);
    const { start, end } = clip;
    const { values } = getSettings();
    const language = resolveLanguage(options.language, transcript, values.defaultLanguage);
    const messages = socialMessages(
      {
        videoTitle: project.source?.title ?? "",
        channel: project.source?.channel ?? "",
        clipTitle: clip.title,
        reason: clip.reason,
        duration: end - start,
        language,
        transcript: transcript ? clipTranscriptText(transcript, start, end) : "",
      },
      values.socialPrompt || DEFAULT_SOCIAL_GUIDANCE,
    );

    let posts: SocialPosts | null = null;
    let failure = "";
    for (let attempt = 0; attempt < ATTEMPTS && !posts; attempt++) {
      signal?.throwIfAborted();
      try {
        posts = parseSocial(await chatJson(messages, signal), sourceCredit(project.source?.input));
      } catch (error) {
        if (!(error instanceof SocialFormatError)) throw error;
        failure = error.message;
      }
    }
    if (!posts) throw new Error(`The AI did not return usable post text (${failure})`);
    signal?.throwIfAborted();

    const social: ClipSocial = { language, ...posts, generatedAt: new Date().toISOString(), start, end };
    return await updateProject(projectId, (p) => {
      const target = p.clips.find((candidate) => candidate.id === clipId);
      if (target) target.social = social;
    });
  } finally {
    generating.delete(key);
    await release();
  }
}
