import { BIN } from "./config";
import { run } from "./exec";

/** Quality arguments per H.264 encoder; the hardware / OS encoders only take a bitrate. */
const ENCODER_ARGS: Record<string, string[]> = {
  libx264: ["-preset", "veryfast", "-crf", "20"],
  h264_videotoolbox: ["-b:v", "12M"],
  libopenh264: ["-b:v", "12M"],
  h264_mf: ["-b:v", "12M"],
};

/** First match wins. libx264 is GPL, so LGPL ffmpeg builds only have the platform encoders. */
const PREFERENCE = ["libx264", "h264_videotoolbox", "libopenh264", "h264_mf"];

const probed = new Map<string, Promise<string[]>>();

async function probe(ffmpeg: string): Promise<string[]> {
  const forced = Bun.env.GCLIP_VIDEO_ENCODER;
  const available = (await run(ffmpeg, ["-hide_banner", "-encoders"])).stdout;
  const has = (name: string) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(available);
  if (forced) {
    if (!(forced in ENCODER_ARGS))
      throw new Error(`GCLIP_VIDEO_ENCODER=${forced} is not supported (use ${Object.keys(ENCODER_ARGS).join(", ")})`);
    if (!has(forced)) throw new Error(`GCLIP_VIDEO_ENCODER=${forced}, but ${ffmpeg} has no such encoder`);
    return ["-c:v", forced, ...ENCODER_ARGS[forced]!];
  }
  const name = PREFERENCE.find(has);
  if (!name) {
    throw new Error(
      `${ffmpeg} has no H.264 encoder (looked for ${PREFERENCE.join(", ")}). Run \`bun run setup\` to install a suitable ffmpeg.`,
    );
  }
  return ["-c:v", name, ...ENCODER_ARGS[name]!];
}

/**
 * `-c:v <encoder> ...` for the ffmpeg in use: libx264 when it has it, else the platform's H.264 encoder
 * (VideoToolbox on macOS, OpenH264 / Media Foundation on Windows). `GCLIP_VIDEO_ENCODER` forces one.
 * Probed once per ffmpeg binary.
 */
export function videoEncoderArgs(): Promise<string[]> {
  const ffmpeg = BIN.ffmpeg;
  let result = probed.get(ffmpeg);
  if (!result) {
    result = probe(ffmpeg);
    probed.set(ffmpeg, result);
    // A failed probe (ffmpeg missing) must not stick: the next call, after `setup`, probes again.
    result.catch(() => probed.delete(ffmpeg));
  }
  return result;
}
