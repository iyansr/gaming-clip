import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { MODELS, PLATFORM, TOOLS_DIR, type PlatformId } from "./config";
import { BINARY_FORMULAS, checkDeps, type DepStatus } from "./doctor";
import { run } from "./exec";

const MB = 1024 * 1024;

/**
 * Downloads `url` to `dest` (streamed to `<dest>.part`, size and optional SHA-256 checked, then renamed).
 * Without `onProgress` it prints a progress line; with it, nothing is printed. `file://` URLs are copied,
 * for offline installs and tests.
 */
export async function downloadFile(
  url: string,
  dest: string,
  label: string,
  onProgress?: (received: number, total: number) => void,
  opts: { sha256?: string } = {},
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    if (url.startsWith("file://")) {
      await copyFile(new URL(url), part);
    } else {
      await streamTo(url, part, label, onProgress, opts.sha256);
    }
    const info = await stat(part).catch(() => null);
    if (!info || info.size === 0) throw new Error(`Download of ${label} produced no data`);
    await rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

async function streamTo(
  url: string,
  part: string,
  label: string,
  onProgress: ((received: number, total: number) => void) | undefined,
  sha256: string | undefined,
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const hasher = sha256 ? new Bun.CryptoHasher("sha256") : null;
  const interactive = process.stdout.isTTY;
  let received = 0;
  let reported = -1;
  const writer = Bun.file(part).writer();
  try {
    for await (const chunk of response.body) {
      await writer.write(chunk);
      hasher?.update(chunk);
      received += chunk.byteLength;
      if (onProgress) {
        onProgress(received, total);
        continue;
      }
      if (total <= 0) continue;
      const percent = Math.floor((received / total) * 100);
      // A terminal gets a live line; a log gets one line per 10 %.
      if (percent === reported || (!interactive && percent % 10 !== 0)) continue;
      reported = percent;
      process.stdout.write(
        `${interactive ? "\r" : ""}${label}: ${percent}% (${(received / MB).toFixed(1)}/${(total / MB).toFixed(1)} MB)${interactive ? "" : "\n"}`,
      );
    }
  } finally {
    await writer.end();
  }
  if (interactive && !onProgress) process.stdout.write("\n");
  if (total > 0 && received !== total) throw new Error(`Download of ${label} incomplete (${received}/${total} bytes)`);
  const actual = hasher?.digest("hex");
  if (sha256 && actual !== sha256) throw new Error(`Checksum mismatch for ${label}: expected ${sha256}, got ${actual}`);
}

/** The SHA-256 a `sha256sum`-style file lists for `name` (lines: `<hash>  <name>` or `<hash> *<name>`). */
async function checksumFor(sumsUrl: string, name: string): Promise<string> {
  const response = await fetch(sumsUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${sumsUrl}`);
  for (const line of (await response.text()).split("\n")) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash) return hash.toLowerCase();
  }
  throw new Error(`${sumsUrl} has no checksum for ${name}`);
}

interface ToolSource {
  url: string;
  /** Pinned SHA-256, or a checksum file to read it from. */
  sha256?: string;
  sums?: { url: string; name: string };
  /** `file`: the download is the executable itself. Archives are extracted with the system `tar` (bsdtar reads zip and tar.xz). */
  kind: "file" | "archive";
  /** Leading folders removed when extracting. */
  strip?: number;
}

interface Tool {
  /** Folder (or, for a single file, file stem) inside TOOLS_DIR. */
  id: string;
  /** Doctor names this tool satisfies. */
  provides: string[];
  /** Files that must exist after install, relative to TOOLS_DIR. */
  files: (exe: string) => string[];
  sources: Partial<Record<PlatformId, ToolSource>>;
}

const YT_DLP = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const YT_DLP_SUMS = { url: `${YT_DLP}/SHA2-256SUMS` };
// LGPL builds (no libx264): rendering falls back to the platform H.264 encoder, see encoder.ts.
const FFMPEG_MAC = "https://github.com/dfloresc/ffmpeg-macos-builds/releases/download/v9.0.1-1";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
// whisper.cpp publishes its Windows binaries on the `b<N>` build tags, not on the `v<X.Y.Z>` ones.
const WHISPER_WIN = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";

export const TOOLS: Tool[] = [
  {
    id: "ffmpeg",
    provides: ["ffmpeg", "ffprobe"],
    files: (exe) => [`ffmpeg/bin/ffmpeg${exe}`, `ffmpeg/bin/ffprobe${exe}`],
    sources: {
      "darwin-arm64": {
        url: `${FFMPEG_MAC}/ffmpeg-9.0.1-1-lgpl-macos-arm64.tar.xz`,
        sha256: "d0ea5ea43a5adfa5d01d4137c9e5a61728b800a812f12917a26fd7af0c14c03a",
        kind: "archive",
        strip: 1,
      },
      "darwin-x64": {
        url: `${FFMPEG_MAC}/ffmpeg-9.0.1-1-lgpl-macos-x86_64.tar.xz`,
        sha256: "d63ad731cbf1eb71c2055130fedfbd7e49edd60a9815ab763e72ba802c1ac666",
        kind: "archive",
        strip: 1,
      },
      "windows-x64": {
        url: `${BTBN}/ffmpeg-master-latest-win64-lgpl.zip`,
        sums: { url: `${BTBN}/checksums.sha256`, name: "ffmpeg-master-latest-win64-lgpl.zip" },
        kind: "archive",
        strip: 1,
      },
    },
  },
  {
    id: "yt-dlp",
    provides: ["yt-dlp"],
    files: (exe) => [`yt-dlp${exe}`],
    sources: {
      "darwin-arm64": { url: `${YT_DLP}/yt-dlp_macos`, sums: { ...YT_DLP_SUMS, name: "yt-dlp_macos" }, kind: "file" },
      "darwin-x64": { url: `${YT_DLP}/yt-dlp_macos`, sums: { ...YT_DLP_SUMS, name: "yt-dlp_macos" }, kind: "file" },
      "windows-x64": { url: `${YT_DLP}/yt-dlp.exe`, sums: { ...YT_DLP_SUMS, name: "yt-dlp.exe" }, kind: "file" },
    },
  },
  {
    // whisper.cpp publishes no macOS CLI binary (use Homebrew there). The Windows download is the CPU build;
    // the BLAS and CUDA builds on the same release page are faster on some machines.
    id: "whisper",
    provides: ["whisper-cli"],
    files: (exe) => [`whisper/whisper-cli${exe}`],
    sources: {
      "windows-x64": {
        url: WHISPER_WIN,
        sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
        kind: "archive",
        strip: 1,
      },
    },
  },
];

async function installTool(tool: Tool, platform: PlatformId): Promise<void> {
  const source = tool.sources[platform];
  if (!source) throw new Error(`No ${tool.id} download exists for ${platform}`);
  const exe = platform === "windows-x64" ? ".exe" : "";
  const sha256 = source.sha256 ?? (source.sums ? await checksumFor(source.sums.url, source.sums.name) : undefined);
  const staging = join(TOOLS_DIR, `.${tool.id}.staging`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const download = join(staging, basename(new URL(source.url).pathname));
    await downloadFile(source.url, download, tool.id, undefined, { sha256 });
    if (source.kind === "file") {
      await rename(download, join(staging, `${tool.id}${exe}`));
    } else {
      const unpacked = join(staging, "unpacked");
      await mkdir(unpacked);
      await run("tar", [
        "-xf",
        download,
        "-C",
        unpacked,
        ...(source.strip ? ["--strip-components", String(source.strip)] : []),
      ]);
      await rm(download);
      // macOS ffmpeg archives carry headers and C libraries only needed for linking.
      await rm(join(unpacked, "include"), { recursive: true, force: true });
      await rename(unpacked, join(staging, tool.id));
    }
    const final = source.kind === "file" ? join(TOOLS_DIR, `${tool.id}${exe}`) : join(TOOLS_DIR, tool.id);
    await rm(final, { recursive: true, force: true });
    await rename(source.kind === "file" ? join(staging, `${tool.id}${exe}`) : join(staging, tool.id), final);
    await markExecutable(tool, exe);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  for (const file of tool.files(exe)) {
    if (!(await stat(join(TOOLS_DIR, file)).catch(() => null))?.isFile()) {
      throw new Error(`${tool.id} download did not contain ${file}`);
    }
  }
}

async function markExecutable(tool: Tool, exe: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const file of tool.files(exe)) await chmod(join(TOOLS_DIR, file), 0o755);
}

function printReport(statuses: DepStatus[]): void {
  for (const status of statuses) {
    const mark = status.ok ? "OK  " : "MISS";
    const hint = status.ok || !status.fix ? "" : `  -> ${status.fix}`;
    console.log(`${mark} ${status.name.padEnd(36)} ${status.detail}${hint}`);
  }
}

/**
 * Installs the missing binaries: with Homebrew on macOS when it is installed (the Homebrew ffmpeg has libx264,
 * whisper-cpp uses the GPU), otherwise by downloading them into tools/.
 */
async function installBinaries(missing: string[]): Promise<void> {
  const brew = process.platform === "darwin" ? Bun.which("brew") : null;
  if (brew) {
    const formulas = [...new Set(missing.map((name) => BINARY_FORMULAS[name]).filter((f): f is string => Boolean(f)))];
    console.log(`\nInstalling with Homebrew: ${formulas.join(" ")}`);
    await run(brew, ["install", ...formulas]);
    return;
  }
  if (!PLATFORM) {
    throw new Error(
      `Automatic tool downloads support macOS (arm64, x64) and Windows (x64), not ${process.platform}-${process.arch}. Install ffmpeg, yt-dlp and whisper-cli yourself and put them on PATH.`,
    );
  }
  for (const tool of TOOLS.filter((t) => t.provides.some((name) => missing.includes(name)))) {
    if (!tool.sources[PLATFORM]) {
      console.error(
        `\n${tool.id} has no download for ${PLATFORM}: install Homebrew (https://brew.sh) and run \`brew install ${BINARY_FORMULAS[tool.provides[0]!]}\`.`,
      );
      continue;
    }
    console.log(`\nInstalling ${tool.id}`);
    await installTool(tool, PLATFORM);
  }
}

/** `bun run setup` / `clip setup`: returns the process exit code. */
export async function runSetup(): Promise<number> {
  let statuses = await checkDeps();
  printReport(statuses);

  const missingBins = [...new Set(statuses.filter((s) => !s.ok && s.name in BINARY_FORMULAS).map((s) => s.name))];
  if (missingBins.length > 0) await installBinaries(missingBins);

  for (const model of Object.values(MODELS)) {
    const name = basename(model.path);
    if (statuses.find((status) => status.name === name)?.ok) continue;
    console.log(`\nDownloading ${name}`);
    await downloadFile(model.url, model.path, name);
  }

  statuses = await checkDeps();
  const failed = statuses.filter((status) => !status.ok);
  if (failed.length > 0) {
    console.log();
    printReport(statuses);
    console.error(`\n${failed.length} dependency check(s) failed. Fix them and run setup again.`);
    return 1;
  }
  console.log("\nAll dependencies ready.");
  return 0;
}
