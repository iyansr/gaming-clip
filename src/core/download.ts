import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { SourceMeta } from "../shared/types";
import { BIN } from "./config";
import { run } from "./exec";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

interface YtDlpInfo {
  _type?: string;
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
}

async function probeJson(file: string): Promise<ProbeResult> {
  const { stdout } = await run(BIN.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(stdout) as ProbeResult;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

export async function probeMedia(
  file: string,
): Promise<{ duration: number; width: number; height: number; fps: number; hasAudio: boolean }> {
  const json = await probeJson(file);
  const video = json.streams?.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`No video stream in ${file}`);
  const duration = Number(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Cannot read duration of ${file}`);
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  if (!fps) throw new Error(`Cannot read frame rate of ${file}`);
  const hasAudio = json.streams?.some((s) => s.codec_type === "audio") ?? false;
  return { duration, width: video.width, height: video.height, fps, hasAudio };
}

/** h264 + aac, <= 1080p: everything the rest of the pipeline (and the web player) expects. */
function needsTranscode(streams: ProbeStream[]): boolean {
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return (
    video?.codec_name !== "h264" ||
    (video.height ?? 0) > 1080 ||
    (audio !== undefined && audio.codec_name !== "aac")
  );
}

async function transcode(input: string, output: string, signal?: AbortSignal): Promise<void> {
  const tmp = `${output}.transcode.mp4`;
  try {
    await run(
      BIN.ffmpeg,
      [
        "-y",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-vf",
        "scale=-2:min(1080\\,ih)",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        tmp,
      ],
      { signal },
    );
    signal?.throwIfAborted();
    await rename(tmp, output);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const PLAYLIST_ERROR = "Playlist and channel URLs are not supported: paste the individual video URLs";

/** URL shapes yt-dlp only resolves as a playlist. */
const PLAYLIST_URL = /\/(playlist\?|@|channel\/|c\/|user\/)/i;

async function transcribeYtDlp(
  url: string,
  destDir: string,
  outPath: string,
  onProgress: (progress: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<YtDlpInfo> {
  let info: YtDlpInfo;
  try {
    info = JSON.parse(
      (await run(BIN.ytDlp, ["-J", "--no-playlist", "--no-warnings", url], { signal })).stdout,
    ) as YtDlpInfo;
  } catch (error) {
    // A playlist with unavailable entries makes `-J` exit non-zero instead of returning `_type: "playlist"`.
    if (PLAYLIST_URL.test(url)) throw new Error(PLAYLIST_ERROR);
    throw error;
  }
  // `--no-playlist` only unwraps a video's &list= parameter; a pure playlist/channel URL still resolves to a playlist.
  if (info._type === "playlist") throw new Error(PLAYLIST_ERROR);
  const title = info.title ?? url;
  const total = info.duration ? `${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, "0")}` : "?";
  onProgress(0.02, `Downloading "${title}" (${total})`);

  // The download runs one pass per selected stream (video, then audio), each reporting its own 0-100%.
  // Split the remaining range across the passes so the caller sees one monotonic 0..0.9 value.
  let passes = 2;
  let pass = 0;
  let value = 0.02;
  const emit = (next: number, message?: string) => {
    value = Math.max(value, Math.min(0.9, next));
    onProgress(value, message);
  };
  const onLine = (line: string) => {
    const formats = /Downloading \d+ format\(s\): (.+)$/.exec(line);
    if (formats?.[1]) {
      const count = formats[1].trim().split("+").length;
      if (count > 0) passes = count;
      return;
    }
    if (line.startsWith("[download] Destination:")) {
      pass++;
      return;
    }
    const pct = /^\[download\]\s+([\d.]+)%/.exec(line);
    if (pct?.[1]) emit(((pass + Number(pct[1]) / 100) / passes) * 0.9);
  };

  await run(
    BIN.ytDlp,
    [
      "-S",
      "res:1080,vcodec:h264,acodec:aac",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "-o",
      join(destDir, "source.%(ext)s"),
      url,
    ],
    { signal, onStdout: onLine, onStderr: onLine },
  );
  if (!(await Bun.file(outPath).exists())) throw new Error(`yt-dlp did not produce ${outPath}`);
  return info;
}

/** input = YouTube URL or local video file path. Produces `${destDir}/source.mp4` (h264 + aac, <=1080p). */
export async function fetchSource(
  input: string,
  destDir: string,
  onProgress: (progress: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<SourceMeta> {
  signal?.throwIfAborted();
  await mkdir(destDir, { recursive: true });
  const outPath = join(destDir, "source.mp4");

  let base: Omit<SourceMeta, "duration" | "width" | "height" | "fps">;

  if (/^https?:\/\//i.test(input)) {
    const info = await transcribeYtDlp(input, destDir, outPath, onProgress, signal);
    if (needsTranscode((await probeJson(outPath)).streams ?? [])) {
      onProgress(0.92, "Converting to h264/aac");
      await transcode(outPath, outPath, signal);
    }
    base = {
      input,
      videoId: info.id ?? null,
      title: info.title ?? input,
      channel: info.channel ?? info.uploader ?? "",
    };
  } else {
    const localPath = resolve(input);
    const isFile = await stat(localPath).then((s) => s.isFile(), () => false);
    if (!isFile) throw new Error(`Not a video file or URL: ${input}`);
    const extension = extname(localPath).toLowerCase();
    const { streams } = await probeJson(localPath);
    if (needsTranscode(streams ?? [])) {
      onProgress(0.05, "Converting to h264/aac");
      await transcode(localPath, outPath, signal);
    } else if (localPath !== resolve(outPath)) {
      onProgress(0.05, "Copying file");
      signal?.throwIfAborted();
      await copyFile(localPath, outPath).catch(async (error: unknown) => {
        await rm(outPath, { force: true }).catch(() => undefined);
        throw error;
      });
      if (signal?.aborted) {
        await rm(outPath, { force: true });
        signal.throwIfAborted();
      }
    }
    base = { input: localPath, videoId: null, title: basename(localPath, extension), channel: "" };
  }

  const { duration, width, height, fps } = await probeMedia(outPath);
  onProgress(1);
  return { ...base, duration, width, height, fps };
}
