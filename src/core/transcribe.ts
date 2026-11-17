import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Segment, Transcript, Word } from "../shared/types";
import { loudnessEnvelope } from "./audio";
import { BIN, MODELS, WHISPER_MODEL } from "./config";
import { run } from "./exec";

const MIN_WORD_SECONDS = 0.05;
/** `[_BEG_]`, `[_TT_123]`, ... — decoder control tokens, not words. */
const SPECIAL_TOKEN = /^\[_/;
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;
/** `[MUSIC]`, `(laughs)`, `*screams*`, `[BLANK_AUDIO]` (possibly several in one segment) — annotations, never captions. */
const ANNOTATION = /^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)(\s+(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*))*$/;
/** A word that closes a sentence: . ! ? and their CJK forms, optionally followed by closing quotes/brackets. */
const SENTENCE_END = /[.!?。！？｡][)\]"'”’」』»]*$/u;

/**
 * whisper's DTW token times (`t_dtw`) sit about this long before the true end of the token, on voices,
 * speeds and noise levels alike (measured against synthetic speech with known word times).
 */
const DTW_LAG_SECONDS = 0.1;
/** DTW ends are reliable, DTW starts are not: a word cannot be longer than this, so its start is pulled up to its end. */
const WORD_BASE_SECONDS = 0.4;
const WORD_PER_CHAR_SECONDS = 0.1;
/** Loudness resolution used to find acoustic word onsets; `rms` index = centiseconds. */
const ENVELOPE_STEP = 0.01;
/** Onset = first frame within this many dB of the word's peak and above the midpoint between its noise floor and peak. */
const ONSET_DROP_DB = 18;
const ONSET_FLOOR_FRACTION = 0.5;
const ONSET_HOLD_FRAMES = 10;
const ONSET_HOLD_RATIO = 0.7;
const NOISE_CONTEXT_FRAMES = 50;
const NOISE_FLOOR_QUANTILE = 0.1;

/**
 * Decoding with flash attention off (required by DTW) derails on long game recordings: after one
 * hallucinated segment whisper stops emitting timestamps and loops, producing 1 s segments and repeated
 * sentences. Re-injecting a short punctuated, language-neutral prompt in every window keeps the decoder
 * on track and keeps its punctuation, which sentence splitting relies on.
 */
const STYLE_PROMPT = "Okay. Hmm... What? Oh no! Wow, alright, let's go.";

const COLLAPSE_MIN_SEGMENTS = 20;
const COLLAPSE_ONE_SECOND_RATIO = 0.2;

/** Presets accepted by `whisper-cli -dtw`. */
const DTW_PRESETS = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large.v1",
  "large.v2",
  "large.v3",
  "large.v3.turbo",
];

/** Languages written without word-separating spaces; one whisper token is one word there. */
const NO_SPACE_LANGUAGES: Record<string, true> = {
  ja: true,
  zh: true,
  yue: true,
  th: true,
  lo: true,
  km: true,
  my: true,
};

interface RawToken {
  text?: string;
  /** DTW-aligned token time in centiseconds; -1 for control tokens. */
  t_dtw?: number;
}

interface RawSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: RawToken[];
}

interface RawTranscript {
  result?: { language?: string };
  transcription?: RawSegment[];
}

/** A word whose end is known from DTW; `end` is undefined when whisper gave none. */
interface TimedWord {
  text: string;
  end?: number;
}

/**
 * whisper with flash attention off can derail into a run of segments that are all exactly 1.00 s long
 * (healthy output has few). Measured: derailed runs have 29-61 % such segments, healthy real recordings 0-8 %.
 */
function isCollapsed(segments: RawSegment[]): boolean {
  if (segments.length < COLLAPSE_MIN_SEGMENTS) return false;
  const oneSecond = segments.filter((segment) => (segment.offsets?.to ?? 0) - (segment.offsets?.from ?? 0) === 1000);
  return oneSecond.length >= segments.length * COLLAPSE_ONE_SECOND_RATIO;
}

/** `ggml-large-v3-turbo-q5_0` -> `large.v3.turbo`. */
function dtwPreset(model: string): string {
  const name = model.replace(/-q\d+(_\d+)?$/, "");
  const preset = name.startsWith("large") ? name.replaceAll("-", ".") : name;
  if (!DTW_PRESETS.includes(preset)) {
    throw new Error(
      `No whisper.cpp DTW alignment preset for model "${model}" (word timestamps need one of: ${DTW_PRESETS.join(", ")}). Set WHISPER_MODEL to a supported model.`,
    );
  }
  return preset;
}

/**
 * Merge whisper tokens into words. Space-delimited languages: a leading space starts a word and other
 * tokens extend the current one. No-space languages (ja/zh/th/...): one word per token, because a whole
 * segment otherwise collapses into one unbreakable caption line.
 * A word ends where its last real token's DTW time says; punctuation only adds text, its DTW time is junk.
 */
function wordsFromTokens(tokens: RawToken[], noSpaces: boolean): TimedWord[] {
  const words: TimedWord[] = [];
  let current: TimedWord | null = null;
  let prefix = "";
  for (const token of tokens) {
    const text = token.text ?? "";
    if (SPECIAL_TOKEN.test(text)) continue;
    if (PUNCTUATION_ONLY.test(text)) {
      if (current) current.text += text;
      else prefix += text.trim();
      continue;
    }
    const end = token.t_dtw !== undefined && token.t_dtw >= 0 ? token.t_dtw / 100 + DTW_LAG_SECONDS : undefined;
    // BPE sometimes splits one multi-byte character across tokens; a replacement char marks such a fragment.
    const fragment = noSpaces && text.includes("\uFFFD");
    if (current && (fragment || (!noSpaces && !text.startsWith(" ")))) {
      current.text += text;
      current.end = end ?? current.end;
      continue;
    }
    if (current) words.push(current);
    current = { text: prefix + text.trimStart(), end };
    prefix = "";
  }
  if (current) words.push(current);
  return words
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text.length > 0);
}

/**
 * Where speech starts in [start, end]: the first 10 ms frame that is both close to the word's peak level
 * and well above the noise floor measured just before it. Returns `start` when the word already begins loud.
 */
function acousticOnset(rms: number[], start: number, end: number): number {
  const first = Math.max(0, Math.floor(start / ENVELOPE_STEP));
  const last = Math.min(rms.length - 1, Math.ceil(end / ENVELOPE_STEP));
  if (last <= first) return start;
  let peak = -Infinity;
  for (let frame = first; frame <= last; frame++) peak = Math.max(peak, rms[frame] ?? -Infinity);
  const context = rms.slice(Math.max(0, first - NOISE_CONTEXT_FRAMES), last + 1).sort((a, b) => a - b);
  const floor = context[Math.floor(context.length * NOISE_FLOOR_QUANTILE)] ?? peak;
  const threshold = Math.max(peak - ONSET_DROP_DB, floor + ONSET_FLOOR_FRACTION * (peak - floor));
  const loud = (frame: number) => (rms[frame] ?? -Infinity) >= threshold;
  let frame = first;
  while (frame < last) {
    if (loud(frame)) {
      // A click or noise burst is not speech: the onset must be followed by sustained loudness.
      const hold = Math.min(ONSET_HOLD_FRAMES, last - frame + 1);
      let above = 0;
      for (let ahead = frame; ahead < frame + hold; ahead++) if (loud(ahead)) above++;
      if (above >= hold * ONSET_HOLD_RATIO) break;
    }
    frame++;
  }
  return Math.max(start, frame * ENVELOPE_STEP);
}

/**
 * Give every word a start. whisper stretches the first word after a pause back over the silence, so a word
 * starts where the previous one ended, is then limited to a plausible duration for its length, and finally
 * moves forward to the acoustic onset. The end (DTW) is never moved here.
 */
function placeWords(timed: TimedWord[][], rms: number[]): Word[][] {
  let previousEnd = 0;
  return timed.map((segment) =>
    segment.map((word) => {
      const end = Math.max(word.end ?? previousEnd, previousEnd + MIN_WORD_SECONDS);
      const longest = WORD_BASE_SECONDS + WORD_PER_CHAR_SECONDS * [...word.text].length;
      const capped = Math.max(previousEnd, end - longest);
      const start = Math.min(acousticOnset(rms, capped, end), end - MIN_WORD_SECONDS);
      previousEnd = end;
      return { text: word.text, start, end };
    }),
  );
}

/** Force the Word invariants whisper does not guarantee: sorted, start < end, >= 50 ms long, inside [0, duration]. */
function fitToTimeline(words: Word[], duration: number): void {
  const latestStart = Math.max(0, duration - MIN_WORD_SECONDS);
  let previousStart = 0;
  for (const word of words) {
    const start = Math.min(Math.max(word.start, previousStart), latestStart);
    word.start = start;
    word.end = Math.min(Math.max(word.end, start + MIN_WORD_SECONDS), duration);
    previousStart = start;
  }
}

/** One Segment per sentence: cut after every word that ends in sentence punctuation. */
function sentenceSegments(words: Word[], noSpaces: boolean): Segment[] {
  const segments: Segment[] = [];
  let sentence: Word[] = [];
  const flush = () => {
    const first = sentence[0];
    const last = sentence.at(-1);
    if (!first || !last) return;
    segments.push({
      start: first.start,
      end: last.end,
      text: sentence.map((word) => word.text).join(noSpaces ? "" : " "),
      words: sentence,
    });
    sentence = [];
  };
  for (const word of words) {
    sentence.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  return segments;
}

/** 16 kHz mono s16le WAV. */
export async function extractAudio(videoPath: string, wavPath: string, signal?: AbortSignal): Promise<void> {
  await run(
    BIN.ffmpeg,
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
    { signal },
  );
}

export async function transcribe(
  wavPath: string,
  opts: { language: string; duration: number },
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const modelPath = MODELS.whisper.path;
  if (!(await Bun.file(modelPath).exists())) {
    throw new Error(`whisper model not found: ${modelPath}. Run \`bun run setup\` to download it.`);
  }
  const base = join(dirname(wavPath), `.transcribe-${basename(wavPath)}`);
  const jsonPath = `${base}.json`;
  // DTW word alignment needs flash attention off.
  const args = [
    "-m", modelPath, "-f", wavPath, "-l", opts.language, "-ojf", "-of", base, "-pp",
    "-nfa", "-dtw", dtwPreset(WHISPER_MODEL), "--prompt", STYLE_PROMPT, "--carry-initial-prompt",
  ];

  let progress = 0;
  /** Runs whisper once; its own 0-100 % is mapped onto [from, to] so progress never moves backwards. */
  const decode = async (extraArgs: string[], from: number, to: number): Promise<RawTranscript> => {
    const onLine = (line: string) => {
      const match = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
      if (!match?.[1]) return;
      const next = from + (to - from) * Math.min(1, Number(match[1]) / 100);
      if (next <= progress) return;
      progress = next;
      onProgress(next);
    };
    await run(BIN.whisper, [...args, ...extraArgs], { signal, onStdout: onLine, onStderr: onLine });
    return JSON.parse(await Bun.file(jsonPath).text()) as RawTranscript;
  };

  try {
    let raw = await decode([], 0, 0.9);
    if (isCollapsed(raw.transcription ?? [])) {
      // Dropping the text context is what stops the collapse, at the price of whisper's sentence punctuation.
      raw = await decode(["-mc", "0"], 0.9, 0.99);
      if (isCollapsed(raw.transcription ?? [])) {
        throw new Error(
          "Transcription failed: whisper produced a degenerate transcript (repeated one-second segments). Try another WHISPER_MODEL.",
        );
      }
    }
    const language = raw.result?.language ?? opts.language;
    const noSpaces = NO_SPACE_LANGUAGES[language] === true;

    const parsed = (raw.transcription ?? []).flatMap((segment) => {
      const text = (segment.text ?? "").trim();
      if (!text) return [];
      const timed = ANNOTATION.test(text) ? [] : wordsFromTokens(segment.tokens ?? [], noSpaces);
      return [{ segment, text, timed }];
    });
    const timedWords = parsed.flatMap((entry) => entry.timed);
    if (timedWords.length > 0 && timedWords.every((word) => word.end === undefined)) {
      throw new Error("whisper-cli returned no DTW token timestamps; is whisper.cpp built without -dtw support?");
    }

    const rms = timedWords.length > 0 ? (await loudnessEnvelope(wavPath, ENVELOPE_STEP)).rms : [];
    const placed = placeWords(
      parsed.map((entry) => entry.timed),
      rms,
    );
    fitToTimeline(placed.flat(), opts.duration);

    const latestStart = Math.max(0, opts.duration - MIN_WORD_SECONDS);
    const segments = parsed.flatMap((entry, index): Segment[] => {
      const words = placed[index] ?? [];
      if (words.length > 0) return sentenceSegments(words, noSpaces);
      const start = Math.min(Math.max(Number(entry.segment.offsets?.from ?? 0) / 1000, 0), latestStart);
      const end = Math.min(Math.max(Number(entry.segment.offsets?.to ?? 0) / 1000, start + MIN_WORD_SECONDS), opts.duration);
      return [{ start, end, text: entry.text, words: [] }];
    });
    segments.sort((a, b) => a.start - b.start);

    onProgress(1);
    return { language, model: basename(modelPath), segments };
  } finally {
    await rm(jsonPath, { force: true });
  }
}
