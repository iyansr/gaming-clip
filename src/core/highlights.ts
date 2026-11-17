import type { HighlightEngine, LoudnessEnvelope, ProjectOptions, Segment, Transcript } from "../shared/types";
import { llmConfigured } from "./config";
import { chatJson, type ChatMessage } from "./llm";

export interface HighlightCandidate {
  start: number;
  end: number;
  title: string;
  reason: string;
  /** 0..100 */
  score: number;
}

export interface HighlightInput {
  transcript: Transcript;
  loudness: LoudnessEnvelope;
  duration: number;
  title: string;
  options: ProjectOptions;
}

export interface HighlightResult {
  engine: HighlightEngine;
  candidates: HighlightCandidate[];
  warnings: string[];
  /** The requested target, or null when the engine decided the count from the content. */
  requestedClips: number | null;
}

const AUDIBLE_DB = -60;
const SILENCE_DB = -90;
const SNAP_SECONDS = 3;
const NMS_OVERLAP = 0.3;
const LOUD_MARKER_DB = 9;
const MAX_TRANSCRIPT_CHUNK = 12_000;
const MAX_TITLE = 60;
const FALLBACK_SCORE_SCALE = 4.9;
const INTRO_SECONDS = 10;
/**
 * Auto mode: at most one clip per four minutes of video, and never more than this. Measured on real
 * streams, one per two minutes let the heuristic fill the cap with near-threshold windows.
 */
const AUTO_CLIP_SECONDS = 240;
const AUTO_MAX_CLIPS = 40;
/** Auto mode keeps windows at least this strong (0..100) relative to the best one. */
const AUTO_HEURISTIC_MIN_SCORE = 45;
const AUTO_LLM_MIN_SCORE = 50;
/**
 * Auto mode's absolute bar on the raw excitement score (0..5). Quiet noise and generic
 * chatter stay below it even when they are the loudest thing in a dull video.
 */
const AUTO_MIN_EXCITE = 1;
/** Auto mode only considers peaks this many standard deviations above the timeline mean. */
const AUTO_PEAK_SIGMA = 0.5;
const LLM_CONCURRENCY = 3;
const AUTO_CHUNK_SECONDS_PER_CLIP = 180;

const HYPE_PHRASES = [
  "oh my god",
  "oh my gosh",
  "oh god",
  "no way",
  "what the",
  "holy shit",
  "holy",
  "let's go",
  "wtf",
  "omg",
  "insane",
  "crazy",
  "clutch",
  "oh no",
  "are you kidding",
  "jesus",
  "run",
  "shit",
  "fuck",
  "fucking",
  "damn",
  "crap",
  "bitch",
  "anjir",
  "anjay",
  "njir",
  "gila",
  "buset",
  "astaga",
  "mantap",
  "parah",
  "waduh",
  "kok bisa",
];

const PHRASE_PATTERNS = HYPE_PHRASES.map((phrase) => ({
  phrase,
  re: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}\\b`),
}));

const LAUGH_RE = /\b(?:ha(?:ha)+h?|he(?:he)+h?|hi(?:hi)+h?|lol|lmao|rofl|wkwk(?:wk)*)\b/;
const ANNOTATION_RE = /\[[^\]]{0,80}\]|\([^)]{0,80}\)|\*[^*\n]{0,80}\*/g;
const LAUGH_ANNOTATION_RE = /(?:\[[^\]]{0,80}\]|\([^)]{0,80}\)|\*[^*\n]{0,80}\*)/g;
const LAUGH_WORD_RE = /\b(?:laugh|scream|gasp|yell|cheer)\w*/i;

interface Timeline {
  duration: number;
  /** Number of 1-second bins. */
  n: number;
  db: number[];
  baseline: number | null;
  loudAt: number[];
  burstAt: number[];
  punctAt: number[];
  laughAt: number[];
  rateAt: number[];
  phraseAt: (string | null)[];
  excite: number[];
  medianWps: number;
  segments: Segment[];
}

interface Window {
  start: number;
  end: number;
  peakIndex: number;
  peak: number;
  raw: number;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length;
}

function keywordHits(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'");
  const hits: string[] = [];
  for (const { phrase, re } of PHRASE_PATTERNS) if (re.test(normalized)) hits.push(phrase);
  return hits;
}

function hasLaugh(text: string): boolean {
  if (LAUGH_RE.test(text.toLowerCase())) return true;
  for (const match of text.matchAll(LAUGH_ANNOTATION_RE)) {
    if (LAUGH_WORD_RE.test(match[0])) return true;
  }
  return false;
}

function punctuationScore(text: string): number {
  const exclamations = (text.match(/!/g) ?? []).length;
  const capsWords = (text.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  return clamp(exclamations * 0.5 + capsWords * 0.5, 0, 1);
}

interface SegmentFeatures {
  keyword: number;
  laugh: number;
  punct: number;
  rate: number;
  phrase: string | null;
  richness: number;
}

function analyseSegment(segment: Segment, medianWps: number): SegmentFeatures {
  const hits = keywordHits(segment.text);
  const keyword = hits.length ? 1 : 0;
  const laugh = hasLaugh(segment.text) ? 1 : 0;
  const punct = punctuationScore(segment.text);
  const seconds = Math.max(0.1, segment.end - segment.start);
  const wps = wordCount(segment.text) / seconds;
  const rate = medianWps > 0 && wps > medianWps ? clamp(wps / medianWps - 1, 0, 1) : 0;
  return {
    keyword,
    laugh,
    punct,
    rate,
    phrase: hits[0] ?? null,
    richness: 0.9 * keyword + laugh + 0.4 * punct + 0.3 * rate,
  };
}

function buildTimeline(transcript: Transcript, loudness: LoudnessEnvelope, duration: number): Timeline {
  const n = Math.max(1, Math.ceil(duration));
  const db = new Array<number>(n).fill(SILENCE_DB);
  const step = loudness.step > 0 ? loudness.step : 0.5;
  for (let i = 0; i < loudness.rms.length; i++) {
    const second = Math.floor(i * step);
    if (second >= n) break;
    const value = loudness.rms[i]!;
    if (value > db[second]!) db[second] = value;
  }

  const audible = db.filter((value) => value > AUDIBLE_DB);
  const baseline = audible.length ? median(audible) : null;
  const loudAt = new Array<number>(n).fill(0);
  const burstAt = new Array<number>(n).fill(0);
  if (baseline !== null) {
    for (let t = 0; t < n; t++) {
      const value = db[t]!;
      loudAt[t] = clamp((value - baseline) / 12, 0, 1.5);
      // A burst needs a full 3 s of history; the fade-in at the start of a video is not a volume jump.
      if (t >= 3) burstAt[t] = clamp((value - (db[t - 3]! + db[t - 2]! + db[t - 1]!) / 3) / 15, 0, 1);
    }
  }

  const medianWps = median(transcript.segments.map((segment) => wordCount(segment.text) / Math.max(0.1, segment.end - segment.start)));
  const keywordAt = new Array<number>(n).fill(0);
  const punctAt = new Array<number>(n).fill(0);
  const laughAt = new Array<number>(n).fill(0);
  const rateAt = new Array<number>(n).fill(0);
  const phraseAt = new Array<string | null>(n).fill(null);
  for (const segment of transcript.segments) {
    const features = analyseSegment(segment, medianWps);
    const from = clamp(Math.floor(segment.start), 0, n - 1);
    const to = clamp(Math.ceil(segment.end) - 1, from, n - 1);
    for (let t = from; t <= to; t++) {
      keywordAt[t] = Math.max(keywordAt[t]!, features.keyword);
      punctAt[t] = Math.max(punctAt[t]!, features.punct);
      laughAt[t] = Math.max(laughAt[t]!, features.laugh);
      rateAt[t] = Math.max(rateAt[t]!, features.rate);
      if (features.phrase && !phraseAt[t]) phraseAt[t] = features.phrase;
    }
  }

  const raw = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    // Channel intros ("hi guys, it's me...") are loud and fast but generic: damp the first seconds.
    const intro = duration > 4 * INTRO_SECONDS ? clamp(t / INTRO_SECONDS, 0.3, 1) : 1;
    raw[t] =
      intro *
      (1.0 * loudAt[t]! +
        0.8 * burstAt[t]! +
        0.9 * keywordAt[t]! +
        1.0 * laughAt[t]! +
        0.4 * punctAt[t]! +
        0.3 * rateAt[t]!);
  }
  const excite = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    const from = Math.max(0, t - 1);
    const to = Math.min(n - 1, t + 1);
    let sum = 0;
    for (let k = from; k <= to; k++) sum += raw[k]!;
    excite[t] = sum / (to - from + 1);
  }

  return { duration, n, db, baseline, loudAt, burstAt, punctAt, laughAt, rateAt, phraseAt, excite, medianWps, segments: transcript.segments };
}

function meanExcite(timeline: Timeline, start: number, end: number): number {
  const from = clamp(Math.floor(start), 0, timeline.n - 1);
  const to = clamp(Math.ceil(end) - 1, from, timeline.n - 1);
  let sum = 0;
  for (let t = from; t <= to; t++) sum += timeline.excite[t]!;
  return sum / (to - from + 1);
}

function peakExcite(timeline: Timeline, start: number, end: number): number {
  const from = clamp(Math.floor(start), 0, timeline.n - 1);
  const to = clamp(Math.ceil(end) - 1, from, timeline.n - 1);
  let peak = 0;
  for (let t = from; t <= to; t++) peak = Math.max(peak, timeline.excite[t]!);
  return peak;
}

function findPeaks(timeline: Timeline, sigma = 0.5): { index: number; value: number }[] {
  const { excite, n } = timeline;
  let sum = 0;
  for (let t = 0; t < n; t++) sum += excite[t]!;
  const mean = sum / n;
  let variance = 0;
  for (let t = 0; t < n; t++) {
    const delta = excite[t]! - mean;
    variance += delta * delta;
  }
  const threshold = mean + sigma * Math.sqrt(variance / n);
  const peaks: { index: number; value: number }[] = [];
  for (let t = 0; t < n; t++) {
    const value = excite[t]!;
    if (value <= threshold) continue;
    const leftOk = t === 0 || value > excite[t - 1]!;
    const rightOk = t === n - 1 || value >= excite[t + 1]!;
    if (leftOk && rightOk) peaks.push({ index: t, value });
  }
  return peaks.sort((a, b) => b.value - a.value);
}

/** Grow a window around a peak until excitement drops below 40% of it, then honour min/max. */
function rawWindow(peakIndex: number, timeline: Timeline, options: ProjectOptions): { start: number; end: number } {
  const { excite, n, duration } = timeline;
  const threshold = 0.4 * excite[peakIndex]!;
  let a = peakIndex;
  while (a > 0 && excite[a - 1]! >= threshold) a--;
  let b = peakIndex;
  while (b < n - 1 && excite[b + 1]! >= threshold) b++;
  let start = a;
  let end = Math.min(duration, b + 1);

  const min = Math.min(options.minDuration, duration);
  const max = Math.max(min, Math.min(options.maxDuration, duration));
  if (end - start < min) {
    let need = min - (end - start);
    const back = Math.min(need, start);
    start -= back;
    need -= back;
    if (need > 0) end = Math.min(duration, end + need);
    if (end - start < min) start = Math.max(0, end - min);
  }
  if (end - start > max) {
    start = clamp(peakIndex - 0.65 * max, 0, end - max);
    end = Math.min(duration, start + max);
  }
  return { start, end };
}

/** Snap to nearby segment boundaries, then clamp to the video and re-enforce min/max length. */
function snapWindow(start: number, end: number, segments: Segment[], duration: number, options: ProjectOptions): { start: number; end: number } {
  let s = start;
  let e = end;
  let snappedStart: number | null = null;
  let snappedEnd: number | null = null;
  for (const segment of segments) {
    if (Math.abs(segment.start - start) <= SNAP_SECONDS && (snappedStart === null || segment.start < snappedStart)) {
      snappedStart = segment.start;
    }
    if (Math.abs(segment.end - end) <= SNAP_SECONDS && (snappedEnd === null || segment.end > snappedEnd)) {
      snappedEnd = segment.end;
    }
  }
  if (snappedStart !== null) s = snappedStart;
  if (snappedEnd !== null) e = snappedEnd;

  s = clamp(s, 0, duration);
  e = clamp(e, 0, duration);
  const min = Math.min(options.minDuration, duration);
  const max = Math.max(min, Math.min(options.maxDuration, duration));
  if (e - s < min) {
    let need = min - (e - s);
    const back = Math.min(need, s);
    s -= back;
    need -= back;
    if (need > 0) e = Math.min(duration, e + need);
    if (e - s < min) s = Math.max(0, e - min);
  }
  if (e - s > max) {
    e = s + max;
    if (e > duration) {
      e = duration;
      s = Math.max(0, e - max);
    }
  }
  if (e <= s) e = Math.min(duration, s + min);
  return { start: s, end: e };
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? overlap / shorter : 0;
}

function selectNonOverlapping<T extends { start: number; end: number; score: number }>(items: T[], count: number): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const item of sorted) {
    if (item.end <= item.start) continue;
    if (kept.some((winner) => overlapRatio(winner, item) > NMS_OVERLAP)) continue;
    kept.push(item);
    if (kept.length >= count) break;
  }
  return kept;
}

function windowsForPeaks(peaks: { index: number; value: number }[], timeline: Timeline, options: ProjectOptions, segments: Segment[]): Window[] {
  const windows: Window[] = [];
  for (const peak of peaks) {
    const base = rawWindow(peak.index, timeline, options);
    const snapped = snapWindow(base.start, base.end, segments, timeline.duration, options);
    if (snapped.end <= snapped.start) continue;
    const raw = 0.6 * peak.value + 0.4 * meanExcite(timeline, snapped.start, snapped.end);
    windows.push({
      start: snapped.start,
      end: snapped.end,
      peakIndex: peak.index,
      peak: peak.value,
      raw,
      score: raw,
    });
  }
  return windows;
}

function cleanTranscriptText(text: string): string {
  return text.replace(ANNOTATION_RE, " ").replace(/\s+/g, " ").trim();
}

function fallbackTitle(time: number): string {
  const minutes = Math.floor(Math.max(0, time) / 60);
  const seconds = Math.floor(Math.max(0, time) % 60);
  return `Moment at ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function makeTitle(text: string, time: number): string {
  const cleaned = cleanTranscriptText(text).replace(/^[-–—\s]+/, "");
  if (!cleaned) return fallbackTitle(time);
  const capitalised = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (capitalised.length <= MAX_TITLE) return capitalised;
  const cut = capitalised.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(" ");
  const body = (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "");
  return `${body}…`;
}

function distanceToSegment(segment: Segment, time: number): number {
  if (time < segment.start) return segment.start - time;
  if (time > segment.end) return time - segment.end;
  return 0;
}

function pickSegmentText(segments: Segment[], start: number, end: number, peakTime: number, medianWps: number): string | null {
  let best: Segment | null = null;
  let bestRichness = -1;
  let bestDistance = Infinity;
  for (const segment of segments) {
    if (segment.end < start - SNAP_SECONDS || segment.start > end + SNAP_SECONDS) continue;
    const richness = analyseSegment(segment, medianWps).richness;
    const distance = distanceToSegment(segment, peakTime);
    if (richness > bestRichness + 1e-9 || (Math.abs(richness - bestRichness) < 1e-9 && distance < bestDistance)) {
      best = segment;
      bestRichness = richness;
      bestDistance = distance;
    }
  }
  return best ? best.text : null;
}

function nearestPhrase(timeline: Timeline, peakIndex: number): string | null {
  for (let offset = 0; offset <= 2; offset++) {
    for (const index of [peakIndex - offset, peakIndex + offset]) {
      const phrase = timeline.phraseAt[index];
      if (phrase) return phrase;
    }
  }
  return null;
}

function buildReason(timeline: Timeline, peakIndex: number): string {
  const parts: string[] = [];
  if (timeline.baseline !== null) {
    const diff = timeline.db[peakIndex]! - timeline.baseline;
    if (diff >= 6) parts.push(`Loud spike (+${Math.round(diff)} dB)`);
    else if (timeline.burstAt[peakIndex]! > 0.5) parts.push("Sudden volume jump");
  }
  const phrase = nearestPhrase(timeline, peakIndex);
  if (phrase) parts.push(`"${phrase}"`);
  if (timeline.laughAt[peakIndex]! > 0) parts.push("laughter");
  if (timeline.punctAt[peakIndex]! > 0) parts.push("shouting");
  if (timeline.rateAt[peakIndex]! > 0) parts.push("fast talking");
  if (!parts.length) parts.push("Sustained excitement");
  return parts.slice(0, 4).join(", ");
}

function autoClipCap(duration: number): number {
  return Math.max(1, Math.min(AUTO_MAX_CLIPS, Math.ceil(duration / AUTO_CLIP_SECONDS)));
}

/** Auto mode: every window that clears `minScore`, best first, until the cap. */
function selectQuality<T extends { start: number; end: number; score: number }>(items: T[], cap: number, minScore: number): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const item of sorted) {
    if (item.score < minScore) continue;
    if (kept.some((winner) => overlapRatio(winner, item) > NMS_OVERLAP)) continue;
    kept.push(item);
    if (kept.length >= cap) break;
  }
  return kept;
}

function heuristicCandidates(timeline: Timeline, options: ProjectOptions): HighlightCandidate[] {
  const auto = options.clipCount === null;
  if (!auto && options.clipCount! <= 0) return [];
  const peaks = findPeaks(timeline, auto ? AUTO_PEAK_SIGMA : 0.5);
  if (!peaks.length) return [];
  const windows = windowsForPeaks(peaks, timeline, options, timeline.segments);
  if (!windows.length) return [];
  const bestRaw = Math.max(...windows.map((window) => window.raw));
  const scored = windows.map((window) => {
    const text = pickSegmentText(timeline.segments, window.start, window.end, window.peakIndex, timeline.medianWps);
    return {
      start: window.start,
      end: window.end,
      title: text ? makeTitle(text, window.start) : fallbackTitle(window.start),
      reason: buildReason(timeline, window.peakIndex),
      score: clamp(Math.round((window.raw / (bestRaw > 0 ? bestRaw : 1)) * 95), 1, 100),
      raw: window.raw,
    };
  });
  const cap = auto ? autoClipCap(timeline.duration) : options.clipCount!;
  if (!auto) return selectNonOverlapping(scored, cap);
  const eligible = scored.filter((item) => item.raw >= AUTO_MIN_EXCITE);
  // A video with any peak at all deserves at least its best moment, even below the bar.
  const kept = selectQuality(eligible, cap, AUTO_HEURISTIC_MIN_SCORE);
  return kept.length ? kept : scored.slice(0, 1);
}

function heuristicResult(timeline: Timeline, options: ProjectOptions): HighlightResult {
  const candidates = heuristicCandidates(timeline, options);
  if (!candidates.length) {
    return {
      engine: "heuristic",
      candidates,
      warnings: ["No highlight moments found: no loud audio spikes or excited speech stood out."],
      requestedClips: options.clipCount,
    };
  }
  return { engine: "heuristic", candidates, warnings: [], requestedClips: options.clipCount };
}

export function formatTranscript(
  transcript: Transcript,
  loudness: LoudnessEnvelope | null,
  range?: { from: number; to: number },
): string {
  const segments = transcript.segments
    .filter((segment) => !range || (segment.end > range.from && segment.start < range.to))
    .sort((a, b) => a.start - b.start);

  let baseline: number | null = null;
  let envelopeEnd = 0;
  let step = 0.5;
  if (loudness) {
    step = loudness.step > 0 ? loudness.step : 0.5;
    envelopeEnd = loudness.rms.length * step;
    const audible = loudness.rms.filter((value) => value > AUDIBLE_DB);
    baseline = audible.length ? median(audible) : null;
  }
  const lastSegmentEnd = segments.reduce((max, segment) => Math.max(max, segment.end), 0);
  const videoEnd = Math.max(range?.to ?? 0, envelopeEnd, lastSegmentEnd);
  const withHours = videoEnd >= 3600;

  const peakDb = (from: number, to: number): number => {
    if (!loudness) return -Infinity;
    let peak = -Infinity;
    for (let i = 0; i < loudness.rms.length; i++) {
      const time = i * step;
      if (time < from) continue;
      if (time >= to) break;
      peak = Math.max(peak, loudness.rms[i]!);
    }
    return peak;
  };
  const loudLabel = (from: number, to: number): string | null => {
    if (baseline === null) return null;
    const peak = peakDb(from, to);
    if (!Number.isFinite(peak)) return null;
    const diff = peak - baseline;
    if (diff < LOUD_MARKER_DB) return null;
    return `LOUD +${Math.round(diff)}dB`;
  };
  const formatTime = (seconds: number): string => {
    const tenths = Math.max(0, Math.round(seconds * 10));
    const hours = Math.floor(tenths / 36_000);
    const minutes = Math.floor((tenths % 36_000) / 600);
    const secs = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
    return withHours
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs}`
      : `${String(Math.floor(tenths / 600)).padStart(2, "0")}:${secs}`;
  };

  const lines: string[] = [];
  let cursor = range ? Math.max(0, range.from) : 0;
  const endBound = range ? range.to : videoEnd;
  for (const segment of segments) {
    if (segment.start - cursor > 5) {
      const label = loudLabel(cursor, segment.start);
      if (label) lines.push(`[${formatTime(cursor)} -> ${formatTime(segment.start)}] (no speech, ${label})`);
    }
    const label = loudLabel(segment.start, segment.end);
    lines.push(`[${formatTime(segment.start)} -> ${formatTime(segment.end)}] ${segment.text.trim()}${label ? ` (${label})` : ""}`);
    cursor = Math.max(cursor, segment.end);
  }
  if (endBound - cursor > 5) {
    const label = loudLabel(cursor, endBound);
    if (label) lines.push(`[${formatTime(cursor)} -> ${formatTime(endBound)}] (no speech, ${label})`);
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Seconds from a JSON number, a numeric string, or an `MM:SS(.s)` / `H:MM:SS(.s)` timestamp.
 * Returns null for anything malformed so the caller can drop the entry.
 */
function parseTimeValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parts = text.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const secondsPart = parts[parts.length - 1]!;
  if (!/^\d{1,2}(?:\.\d+)?$/.test(secondsPart)) return null;
  const seconds = Number(secondsPart);
  if (seconds >= 60) return null;
  if (parts.length === 3) {
    const minutesPart = parts[1]!;
    if (!/^\d{1,2}$/.test(minutesPart) || Number(minutesPart) >= 60) return null;
    if (!/^\d+$/.test(parts[0]!)) return null;
    return Number(parts[0]) * 3600 + Number(minutesPart) * 60 + seconds;
  }
  if (!/^\d+$/.test(parts[0]!)) return null;
  return Number(parts[0]) * 60 + seconds;
}

/**
 * Validate raw JSON from the LLM: finite times inside the video, sane lengths, trimmed strings.
 * Invalid entries are dropped instead of throwing.
 */
export function parseLlmClips(raw: unknown, ctx: { duration: number; options: ProjectOptions; transcript: Transcript }): HighlightCandidate[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.clips) ? raw.clips : [];
  const candidates: HighlightCandidate[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const start = parseTimeValue(entry.start);
    const end = parseTimeValue(entry.end);
    if (start === null || end === null) continue;
    if (start < 0 || end > ctx.duration || start >= end) continue;

    const min = Math.min(ctx.options.minDuration, ctx.duration);
    const max = Math.max(min, Math.min(ctx.options.maxDuration, ctx.duration));
    let trimmedStart = start;
    let trimmedEnd = end;
    if (trimmedEnd - trimmedStart < min) {
      trimmedEnd = Math.min(ctx.duration, trimmedStart + min);
      if (trimmedEnd - trimmedStart < min) trimmedStart = Math.max(0, trimmedEnd - min);
    }
    if (trimmedEnd - trimmedStart > max) {
      trimmedEnd = trimmedStart + max;
      if (trimmedEnd > ctx.duration) {
        trimmedEnd = ctx.duration;
        trimmedStart = Math.max(0, trimmedEnd - max);
      }
    }

    const snapped = snapWindow(trimmedStart, trimmedEnd, ctx.transcript.segments, ctx.duration, ctx.options);
    if (snapped.end <= snapped.start) continue;

    const rawScore = typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : 0;
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 80) : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    candidates.push({
      start: snapped.start,
      end: snapped.end,
      title: title || fallbackTitle(snapped.start),
      reason,
      score: clamp(Math.round(rawScore), 0, 100),
    });
  }
  return candidates;
}

interface TranscriptChunk {
  text: string;
  /** Seconds on the source timeline. */
  start: number;
  end: number;
}

/** `[MM:SS.s -> MM:SS.s]` or `[H:MM:SS.s -> H:MM:SS.s]`, as written by formatTranscript. */
function lineTimes(line: string): { start: number; end: number } | null {
  const match = /^\[([\d:.]+) -> ([\d:.]+)\]/.exec(line);
  if (!match) return null;
  const start = parseTimeValue(match[1]);
  const end = parseTimeValue(match[2]);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function chunkTranscript(text: string, limit: number): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let lines: string[] = [];
  let length = 0;
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!lines.length) return;
    chunks.push({ text: lines.join("\n"), start, end });
    lines = [];
    length = 0;
  };
  for (const line of text.split("\n")) {
    if (lines.length && length + line.length + 1 > limit) flush();
    const times = lineTimes(line);
    if (!lines.length) {
      start = times?.start ?? 0;
      end = times?.end ?? 0;
    } else if (times) {
      end = Math.max(end, times.end);
    }
    lines.push(line);
    length += line.length + 1;
  }
  flush();
  return chunks;
}

/** Spread a target count across chunks by duration; every chunk gets one when the budget allows. */
function allocateCounts(chunks: TranscriptChunk[], count: number): number[] {
  if (!chunks.length) return [];
  const weights = chunks.map((chunk) => Math.max(1, chunk.end - chunk.start));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (count * weight) / total);
  const counts = exact.map(Math.floor);
  let remaining = count - counts.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || weights[b.index]! - weights[a.index]!);
  for (let i = 0; remaining > 0 && byFraction.length > 0; i++, remaining--) {
    counts[byFraction[i % byFraction.length]!.index]! += 1;
  }
  if (count >= chunks.length) {
    for (let i = 0; i < counts.length; i++) {
      if (counts[i]! > 0) continue;
      const donor = counts.indexOf(Math.max(...counts));
      counts[donor]! -= 1;
      counts[i] = 1;
    }
  }
  return counts;
}

const LLM_SYSTEM: ChatMessage = {
  role: "system",
  content:
    "You are an expert short-form video editor working on gaming videos. You pick moments for vertical 1080x1920 shorts. Reply with one JSON object only, no prose.",
};

function llmPrompt(title: string, transcript: Transcript, options: ProjectOptions, chunk: TranscriptChunk, target: number | null): string {
  const countLine =
    target === null
      ? [
          "Pick every moment in this chunk that would make a good short; return an empty list if none is good enough. Quality over quantity.",
          `Pick at most ${Math.max(1, Math.ceil((chunk.end - chunk.start) / AUTO_CHUNK_SECONDS_PER_CLIP))} moments from this chunk.`,
        ]
      : [
          target === 0
            ? "Pick a moment from this transcript chunk only if it is exceptionally good; usually none is."
            : `Pick about ${target} moment${target === 1 ? "" : "s"} from this transcript chunk.`,
        ];
  return [
    `Video title: ${title}`,
    `Transcript language: ${transcript.language || "unknown"}. Write every title in that language.`,
    "This is gaming content. A good short is funny, shocking, a clutch play, rage or a jump scare. It must be self-contained with setup and payoff, and must grab attention in the first 2 seconds.",
    ...countLine,
    `Each clip must be between ${options.minDuration} and ${options.maxDuration} seconds long.`,
    "All times are seconds from the start of the video and must come from the transcript timestamps below. start must be less than end.",
    "Transcript lines show timestamps as [MM:SS.s -> MM:SS.s] (H:MM:SS.s on videos an hour or longer). Give start/end either as plain seconds or in that same MM:SS.s / H:MM:SS.s format.",
    'Reply with JSON: {"clips":[{"start":number,"end":number,"title":string,"reason":string,"score":number}]} where score is 0-100.',
    "",
    "Transcript chunk:",
    chunk.text,
  ].join("\n");
}

async function llmHighlights(
  input: HighlightInput,
  timeline: Timeline,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<HighlightResult> {
  const auto = input.options.clipCount === null;
  const text = formatTranscript(input.transcript, input.loudness);
  const chunks = chunkTranscript(text, MAX_TRANSCRIPT_CHUNK);
  if (!chunks.length) chunks.push({ text: "(no transcript)", start: 0, end: input.duration });
  const targets = auto ? null : allocateCounts(chunks, input.options.clipCount!);

  const answers: HighlightCandidate[][] = chunks.map(() => []);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= chunks.length) return;
      const raw = await chatJson(
        [LLM_SYSTEM, { role: "user", content: llmPrompt(input.title, input.transcript, input.options, chunks[index]!, targets?.[index] ?? null) }],
        signal,
      );
      answers[index] = parseLlmClips(raw, { duration: input.duration, options: input.options, transcript: input.transcript });
      done += 1;
      onProgress((done / chunks.length) * 0.9);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LLM_CONCURRENCY, chunks.length) }, worker));
  signal?.throwIfAborted();
  const parsed = answers.flat();
  if (!parsed.length) {
    if (!auto) throw new Error("no valid clips in the LLM response");
    onProgress(1);
    return { engine: "llm", candidates: [], warnings: ["No moment was good enough to post."], requestedClips: null };
  }

  const heuristicWindows = windowsForPeaks(findPeaks(timeline), timeline, input.options, input.transcript.segments);
  const bestRaw = heuristicWindows.reduce((max, window) => Math.max(max, window.raw), 0);
  const scored = parsed.map((candidate) => {
    const raw = 0.6 * peakExcite(timeline, candidate.start, candidate.end) + 0.4 * meanExcite(timeline, candidate.start, candidate.end);
    const heuristicScore =
      bestRaw > 0
        ? clamp(Math.round((raw / bestRaw) * 95), 0, 100)
        : clamp(Math.round((raw / FALLBACK_SCORE_SCALE) * 100), 0, 100);
    return { ...candidate, score: clamp(Math.round(0.7 * candidate.score + 0.3 * heuristicScore), 0, 100) };
  });

  let candidates: HighlightCandidate[];
  if (auto) {
    candidates = selectQuality(scored, autoClipCap(input.duration), AUTO_LLM_MIN_SCORE);
    if (!candidates.length) {
      onProgress(1);
      return {
        engine: "llm",
        candidates,
        warnings: ["No moment was good enough to post."],
        requestedClips: null,
      };
    }
  } else {
    candidates = selectNonOverlapping(scored, Math.max(1, input.options.clipCount!));
  }
  onProgress(1);
  return { engine: "llm", candidates, warnings: [], requestedClips: input.options.clipCount };
}

export async function findHighlights(
  input: HighlightInput,
  onProgress: (progress: number) => void = () => {},
  signal?: AbortSignal,
): Promise<HighlightResult> {
  signal?.throwIfAborted();
  const duration = Math.max(0, input.duration);
  if (duration <= 0) {
    return {
      engine: "heuristic",
      candidates: [],
      warnings: ["No highlight moments found: the video has no duration."],
      requestedClips: input.options.clipCount,
    };
  }
  const timeline = buildTimeline(input.transcript, input.loudness, duration);

  if (llmConfigured()) {
    try {
      return await llmHighlights(input, timeline, onProgress, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const fallback = heuristicResult(timeline, input.options);
      fallback.warnings.unshift(`LLM highlight selection failed (${message}); used heuristics`);
      return fallback;
    }
  }

  const result = heuristicResult(timeline, input.options);
  onProgress(1);
  return result;
}
