import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { BIN, MODELS } from "./config";
import { run } from "./exec";

export interface DepStatus {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export const BINARY_FORMULAS: Record<string, string> = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffmpeg",
  "yt-dlp": "yt-dlp",
  "whisper-cli": "whisper-cpp",
};

const BINARIES: { name: string; binary: string; versionArgs: string[] }[] = [
  { name: "ffmpeg", binary: BIN.ffmpeg, versionArgs: ["-version"] },
  { name: "ffprobe", binary: BIN.ffprobe, versionArgs: ["-version"] },
  { name: "yt-dlp", binary: BIN.ytDlp, versionArgs: ["--version"] },
  { name: "whisper-cli", binary: BIN.whisper, versionArgs: ["--version"] },
];

async function binaryStatus(name: string, binary: string, versionArgs: string[]): Promise<DepStatus> {
  try {
    const { stdout, stderr } = await run(binary, versionArgs);
    const detail = `${stdout}${stderr}`.trim().split("\n")[0]?.trim() || "installed";
    return { name, ok: true, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { name, ok: false, detail: detail ?? "not found", fix: `brew install ${BINARY_FORMULAS[name] ?? name}` };
  }
}

/** ffmpeg, ffprobe, yt-dlp, whisper-cli + the model files. Never throws. */
export async function checkDeps(): Promise<DepStatus[]> {
  const binaries = await Promise.all(BINARIES.map((bin) => binaryStatus(bin.name, bin.binary, bin.versionArgs)));
  const models = await Promise.all(
    Object.values(MODELS).map(async (model): Promise<DepStatus> => {
      const name = basename(model.path);
      const info = await stat(model.path).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        return { name, ok: false, detail: "missing", fix: "bun run setup" };
      }
      return { name, ok: true, detail: `${(info.size / 1024 / 1024).toFixed(1)} MB` };
    }),
  );
  return [...binaries, ...models];
}
