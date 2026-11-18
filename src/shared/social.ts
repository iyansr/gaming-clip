import type { SocialPost, YoutubeShortPost } from "./types";

/**
 * Platform limits for the generated post text. Shared by the generator (clamping) and the web panel (counters).
 * Lengths are UTF-16 code units (`string.length`): an emoji counts as 2, which errs on the safe side.
 */
export const SOCIAL_LIMITS = {
  instagram: { total: 2200, hashtags: { min: 3, max: 8 } },
  /** `aim`: caption length (before the hashtags) the prompt asks for; only `total` is enforced. */
  tiktok: { total: 2200, aim: 150, hashtags: { min: 3, max: 6 } },
  youtube: { title: 100, description: 5000, hashtags: { min: 3, max: 3 } },
} as const;

/** Every YouTube Shorts post carries this hashtag so the platform files it as a Short. */
export const SHORTS_HASHTAG = "Shorts";

const MAX_HASHTAG_LENGTH = 60;

/** `Elden Ring` -> `EldenRing`: keeps unicode letters, combining marks, digits and `_`; null when nothing usable is left. */
export function sanitizeHashtag(raw: string): string | null {
  const tag = raw
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}_]/gu, "")
    .slice(0, MAX_HASHTAG_LENGTH);
  // Platforms do not link a tag made only of digits or underscores.
  if (tag === "" || /^[\p{N}_]+$/u.test(tag)) return null;
  return tag;
}

/**
 * Hashtags from a model answer: an array of strings or one string. `#` starts a new tag ("#a #b" is two tags);
 * inside a tag whitespace is dropped. De-duplicated case-insensitively, first spelling wins.
 */
export function sanitizeHashtags(raw: unknown): string[] {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const pieces = list
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => item.split("#"))
    // A single string answer ("gaming fyp, clutch") lists its tags separated by spaces or commas.
    .flatMap((piece) => (typeof raw === "string" ? piece.split(/[\s,]+/) : [piece]));
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of pieces) {
    const tag = sanitizeHashtag(piece);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** `gaming fyp` -> `#gaming #fyp` */
export function hashtagLine(hashtags: string[]): string {
  return hashtags.map((tag) => `#${tag}`).join(" ");
}

/** Caption followed by its hashtags, the way the text is pasted into Instagram or TikTok. */
export function postText(post: SocialPost): string {
  const line = hashtagLine(post.hashtags);
  return line ? `${post.caption}\n\n${line}` : post.caption;
}

/** YouTube description followed by its hashtags (the title is a separate field). */
export function youtubeDescriptionText(post: YoutubeShortPost): string {
  const line = hashtagLine(post.hashtags);
  return line ? `${post.description}\n\n${line}` : post.description;
}
