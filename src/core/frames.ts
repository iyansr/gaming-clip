import { BIN } from "./config";

async function ffmpegStdout(args: string[], signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const proc = Bun.spawn([BIN.ffmpeg, "-v", "error", "-nostdin", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${err.trim().split("\n").slice(-4).join("\n")}`);
    return out;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** One decoded frame at time t (seconds), scaled to exactly width x height. rgb24 = 3 bytes/px, gray = 1 byte/px. */
export async function grabFrame(
  videoPath: string,
  t: number,
  opts: { width: number; height: number; format: "rgb24" | "gray" },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { width, height, format } = opts;
  const out = await ffmpegStdout(
    [
      "-ss", t.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale=${width}:${height}`,
      "-f", "rawvideo",
      "-pix_fmt", format,
      "-",
    ],
    signal,
  );
  const expected = width * height * (format === "rgb24" ? 3 : 1);
  if (out.length !== expected) {
    throw new Error(`No frame at t=${t.toFixed(2)}s in ${videoPath}: got ${out.length} bytes, expected ${expected}`);
  }
  return out;
}

/** JPEG bytes of the frame at t, scaled down to maxWidth (never up) keeping aspect, with even dimensions. */
export async function grabJpeg(videoPath: string, t: number, maxWidth = 960): Promise<Uint8Array> {
  const out = await ffmpegStdout([
    "-ss", t.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale='min(${Math.max(2, Math.floor(maxWidth / 2) * 2)},trunc(iw/2)*2)':-2`,
    "-f", "image2pipe",
    "-c:v", "mjpeg",
    "-q:v", "4",
    "-",
  ]);
  if (out.length === 0) throw new Error(`No frame at t=${t.toFixed(2)}s in ${videoPath}`);
  return out;
}
