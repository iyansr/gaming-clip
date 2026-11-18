import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Segment, Transcript, Word } from "../shared/types";
import { loudnessEnvelope } from "./audio";
import { BIN, whisperModelFile } from "./config";
import { run } from "./exec";
import { getSettings } from "./settings";

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

/**
 * A multi-hour stream in one whisper run shows no progress for minutes, loses everything on a crash and only
 * detects a decoder collapse after the whole file. Longer audio is therefore cut into chunks of about this long.
 */
const CHUNK_SECONDS = 600;
/** Each cut is searched this far before its nominal boundary. */
const CUT_SEARCH_SECONDS = 30;
/** The quietest window of this length wins, so the cut falls in a pause instead of mid-word. */
const CUT_WINDOW_SECONDS = 0.5;
/** Per-chunk resume cache inside the project directory. */
const CHUNK_DIR = ".transcribe";

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
      `No whisper.cpp DTW alignment preset for model "${model}" (word timestamps need one of: ${DTW_PRESETS.join(", ")}). Choose a supported model in Settings.`,
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
  return words.map((word) => ({ ...word, text: word.text.trim() })).filter((word) => word.text.length > 0);
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
      // Code points (not UTF-16 units): one emoji or accented glyph is one character of speaking time.
      const longest = WORD_BASE_SECONDS + WORD_PER_CHAR_SECONDS * Array.from(word.text).length;
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
  await run(BIN.ffmpeg, ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath], {
    signal,
  });
}

// ---------------------------------------------------------------------------------------------
// Chunked transcription
// ---------------------------------------------------------------------------------------------

interface WavLayout {
  dataOffset: number;
  dataLength: number;
  sampleRate: number;
  blockAlign: number;
}

interface ChunkRange {
  start: number;
  end: number;
}

interface ChunkNote {
  start: number;
  end: number;
  text: string;
}

/** A decoded file (the whole audio or one chunk); all times are relative to that file. */
interface DecodedChunk {
  language: string;
  words: Word[];
  notes: ChunkNote[];
  /** Sentences and non-speech annotations exactly as the single-run path emits them. */
  segments: Segment[];
}

const wavSeconds = (layout: WavLayout) => layout.dataLength / layout.blockAlign / layout.sampleRate;

/** `3725.4` -> `1:02:05`. */
function fmtTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = whole % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function wavLayout(wavPath: string): Promise<WavLayout> {
  const file = Bun.file(wavPath);
  const header = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...header.subarray(offset, offset + 4));
  if (header.byteLength < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new Error(`Not a WAV file: ${wavPath}`);
  }
  let sampleRate = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= header.byteLength;) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= header.byteLength) {
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, file.size - body);
      break;
    }
    if (size === 0) break;
    offset = body + size + (size % 2);
  }
  if (!sampleRate || !blockAlign || dataOffset < 0 || dataLength <= 0) {
    throw new Error(`Malformed WAV (missing fmt or data chunk): ${wavPath}`);
  }
  return { dataOffset, dataLength, sampleRate, blockAlign };
}

/** Time of the quietest 0.5 s window in [from, to], measured from the raw PCM. Returns `to` when unsure. */
async function quietestCut(wavPath: string, layout: WavLayout, from: number, to: number): Promise<number> {
  const windowFrames = Math.max(1, Math.round(CUT_WINDOW_SECONDS * layout.sampleRate));
  const totalFrames = Math.floor(layout.dataLength / layout.blockAlign);
  const firstFrame = Math.max(0, Math.min(Math.floor(from * layout.sampleRate), totalFrames - windowFrames));
  const lastFrame = Math.min(Math.floor(to * layout.sampleRate), totalFrames);
  if (lastFrame - firstFrame < windowFrames) return to;
  const bytes = new Uint8Array(
    await Bun.file(wavPath)
      .slice(layout.dataOffset + firstFrame * layout.blockAlign, layout.dataOffset + lastFrame * layout.blockAlign)
      .arrayBuffer(),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / layout.blockAlign);
  const channels = Math.max(1, layout.blockAlign / 2);
  let quietest = Infinity;
  let quietestOffset = 0;
  for (let offset = 0; offset + windowFrames <= frames; offset += windowFrames) {
    let sum = 0;
    for (let frame = offset; frame < offset + windowFrames; frame++) {
      const base = frame * layout.blockAlign;
      let sample = 0;
      for (let channel = 0; channel < channels; channel++) sample += view.getInt16(base + channel * 2, true);
      sample /= channels * 32768;
      sum += sample * sample;
    }
    const db = 10 * Math.log10(sum / windowFrames);
    if (db < quietest) {
      quietest = db;
      quietestOffset = offset;
    }
  }
  if (!Number.isFinite(quietest)) return to;
  return (firstFrame + quietestOffset + windowFrames / 2) / layout.sampleRate;
}

/** Chunks of about CHUNK_SECONDS whose cuts sit in the quietest window before each nominal boundary. */
async function planChunks(wavPath: string, layout: WavLayout): Promise<ChunkRange[]> {
  const total = wavSeconds(layout);
  const chunks: ChunkRange[] = [];
  let start = 0;
  while (total - start > CHUNK_SECONDS) {
    const boundary = start + CHUNK_SECONDS;
    const cut = await quietestCut(wavPath, layout, Math.max(start + 1, boundary - CUT_SEARCH_SECONDS), boundary);
    const end = cut > start + 1 && cut <= boundary ? cut : boundary;
    chunks.push({ start, end });
    start = end;
  }
  chunks.push({ start, end: total });
  return chunks;
}

/**
 * One whisper run over one file (the whole audio or one chunk): whisper args, DTW word times, collapse detection
 * with a `-mc 0` retry, word placement and sentence splitting.
 */
async function decodeChunk(
  wavPath: string,
  opts: { language: string; duration: number; model: string },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<DecodedChunk> {
  const whisperBase = join(dirname(wavPath), `.decode-${basename(wavPath, ".wav")}`);
  const jsonPath = `${whisperBase}.json`;
  // DTW word alignment needs flash attention off.
  const args = [
    "-m",
    whisperModelFile(opts.model).path,
    "-f",
    wavPath,
    "-l",
    opts.language,
    "-ojf",
    "-of",
    whisperBase,
    "-pp",
    "-nfa",
    "-dtw",
    dtwPreset(opts.model),
    "--prompt",
    STYLE_PROMPT,
    "--carry-initial-prompt",
  ];

  let progress = -1;
  const emit = (fraction: number) => {
    const next = Math.min(1, fraction);
    if (next <= progress) return;
    progress = next;
    onProgress(next);
  };
  /** Runs whisper once; its own 0-100 % is mapped onto [from, to] so progress never moves backwards. */
  const decode = async (extraArgs: string[], from: number, to: number): Promise<RawTranscript> => {
    const onLine = (line: string) => {
      const match = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
      if (!match?.[1]) return;
      emit(from + (to - from) * Math.min(1, Number(match[1]) / 100));
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
          "whisper produced a degenerate transcript (repeated one-second segments). Try another model in Settings.",
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
    const notes: ChunkNote[] = [];
    const segments = parsed.flatMap((entry, index): Segment[] => {
      const words = placed[index] ?? [];
      if (words.length > 0) return sentenceSegments(words, noSpaces);
      const start = Math.min(Math.max(Number(entry.segment.offsets?.from ?? 0) / 1000, 0), latestStart);
      const end = Math.min(
        Math.max(Number(entry.segment.offsets?.to ?? 0) / 1000, start + MIN_WORD_SECONDS),
        opts.duration,
      );
      notes.push({ start, end, text: entry.text });
      return [{ start, end, text: entry.text, words: [] }];
    });
    segments.sort((a, b) => a.start - b.start);
    return { language, words: placed.flat(), notes, segments };
  } finally {
    await rm(jsonPath, { force: true });
  }
}

interface ChunkCacheFile {
  key: string;
  language: string;
  words: Word[];
  notes: ChunkNote[];
}

async function readChunkCache(path: string, key: string): Promise<ChunkCacheFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as ChunkCacheFile;
    if (data?.key !== key || !Array.isArray(data.words) || !Array.isArray(data.notes)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Splits long audio into chunks cut in pauses, transcribes them one by one and caches each finished chunk so a
 * restart resumes instead of starting over. Progress is reported over the whole audio with an ETA.
 */
async function transcribeChunked(
  wavPath: string,
  opts: { language: string; duration: number },
  model: string,
  layout: WavLayout,
  onProgress: (progress: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const total = wavSeconds(layout);
  const modelPath = whisperModelFile(model).path;
  const chunks = await planChunks(wavPath, layout);
  const cacheDir = join(dirname(wavPath), CHUNK_DIR);
  await mkdir(cacheDir, { recursive: true });
  const info = await stat(wavPath);
  const wavKey = `${info.size}:${Math.round(info.mtimeMs)}`;

  const words: Word[] = [];
  const notes: ChunkNote[] = [];
  let language = opts.language;
  let finished = 0;
  /** Only chunks actually decoded count towards the ETA rate; resumed chunks are instant. */
  let decodedSeconds = 0;
  let decodedElapsed = 0;
  let lastProgress = -1;

  for (const [index, chunk] of chunks.entries()) {
    const length = chunk.end - chunk.start;
    const name = `chunk-${String(index + 1).padStart(3, "0")}`;
    const cachePath = join(cacheDir, `${name}.json`);
    const key = JSON.stringify({
      wav: wavKey,
      model,
      language: opts.language,
      start: Number(chunk.start.toFixed(3)),
      end: Number(chunk.end.toFixed(3)),
    });
    const describe = (fraction: number) => {
      const position = finished + fraction * length;
      const base = `Transcribing ${index + 1}/${chunks.length} (${fmtTime(position)} of ${fmtTime(total)})`;
      if (decodedElapsed <= 0) return base;
      const remaining = (total - position) / (decodedSeconds / decodedElapsed);
      return `${base}, about ${Math.max(1, Math.round(remaining / 60))} min left`;
    };
    const emit = (fraction: number) => {
      const next = (finished + Math.min(1, fraction) * length) / total;
      if (next <= lastProgress) return;
      lastProgress = next;
      onProgress(next, describe(fraction));
    };

    emit(0);
    const cached = await readChunkCache(cachePath, key);
    if (cached) {
      language = cached.language;
      words.push(...cached.words);
      notes.push(...cached.notes);
    } else {
      const chunkWav = join(cacheDir, `${name}.wav`);
      const wavArgs = [
        "-y",
        "-ss",
        chunk.start.toFixed(3),
        "-t",
        length.toFixed(3),
        "-i",
        wavPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        chunkWav,
      ];
      await run(BIN.ffmpeg, wavArgs, { signal });
      const started = performance.now();
      let decoded: DecodedChunk;
      try {
        decoded = await decodeChunk(chunkWav, { language, duration: length, model }, emit, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(
          `Transcribing ${fmtTime(chunk.start)}-${fmtTime(chunk.end)} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // Chunk 1 detects the language once, so later chunks cannot flip languages.
      language = decoded.language;
      decodedSeconds += length;
      decodedElapsed += (performance.now() - started) / 1000;
      const shiftedWords = decoded.words
        .map((word) => ({ text: word.text, start: word.start + chunk.start, end: word.end + chunk.start }))
        .filter((word) => word.start >= chunk.start);
      const shiftedNotes = decoded.notes
        .map((note) => ({ start: note.start + chunk.start, end: note.end + chunk.start, text: note.text }))
        .filter((note) => note.start >= chunk.start);
      await Bun.write(
        cachePath,
        JSON.stringify({ key, language, words: shiftedWords, notes: shiftedNotes } satisfies ChunkCacheFile),
      );
      words.push(...shiftedWords);
      notes.push(...shiftedNotes);
      await rm(chunkWav, { force: true });
    }
    emit(1);
    finished += length;
  }

  // Normalisation on the concatenation keeps every invariant valid across chunk joins.
  fitToTimeline(words, opts.duration);
  const noSpaces = NO_SPACE_LANGUAGES[language] === true;
  const latestStart = Math.max(0, opts.duration - MIN_WORD_SECONDS);
  const segments = [
    ...sentenceSegments(words, noSpaces),
    ...notes.map((note): Segment => {
      const start = Math.min(note.start, latestStart);
      return {
        start,
        end: Math.min(Math.max(note.end, start + MIN_WORD_SECONDS), opts.duration),
        text: note.text,
        words: [],
      };
    }),
  ].sort((a, b) => a.start - b.start);

  await rm(cacheDir, { recursive: true, force: true });
  if (lastProgress < 1) onProgress(1);
  return { language, model: basename(modelPath), segments };
}

export async function transcribe(
  wavPath: string,
  opts: { language: string; duration: number },
  onProgress: (progress: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const model = getSettings().values.whisperModel;
  const modelPath = whisperModelFile(model).path;
  if (!(await Bun.file(modelPath).exists())) {
    throw new Error(
      `whisper model not found: ${modelPath}. Download it in Settings (gear icon) or run \`bun run setup\`.`,
    );
  }
  const layout = await wavLayout(wavPath);
  if (wavSeconds(layout) <= CHUNK_SECONDS) {
    let decoded: DecodedChunk;
    try {
      decoded = await decodeChunk(
        wavPath,
        { language: opts.language, duration: opts.duration, model },
        onProgress,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    onProgress(1);
    return { language: decoded.language, model: basename(modelPath), segments: decoded.segments };
  }
  return transcribeChunked(wavPath, opts, model, layout, onProgress, signal);
}
