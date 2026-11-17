import type { LoudnessEnvelope } from "../shared/types";

const FLOOR_DB = -90;
const PCM_FORMAT = 0x0001;
const EXTENSIBLE_FORMAT = 0xfffe;

interface WavInfo {
  channels: number;
  sampleRate: number;
  blockAlign: number;
  dataOffset: number;
  dataLength: number;
}

/** Walk the RIFF chunks; ffmpeg and others add LIST/fact chunks, so the data offset is not fixed. */
function readWavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if ((format !== PCM_FORMAT && format !== EXTENSIBLE_FORMAT) || bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit); expected 16-bit PCM`);
      }
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, bytes.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (!channels || !sampleRate || !blockAlign || dataOffset < 0) {
    throw new Error("Malformed WAV: missing fmt or data chunk");
  }
  return { channels, sampleRate, blockAlign, dataOffset, dataLength };
}

export async function loudnessEnvelope(wavPath: string, step = 0.5): Promise<LoudnessEnvelope> {
  if (!(step > 0)) throw new Error(`step must be positive, got ${step}`);
  const bytes = new Uint8Array(await Bun.file(wavPath).arrayBuffer());
  const { channels, sampleRate, blockAlign, dataOffset, dataLength } = readWavInfo(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(dataLength / blockAlign);
  const windowFrames = Math.max(1, Math.round(step * sampleRate));
  const rms: number[] = [];

  for (let windowStart = 0; windowStart < frames; windowStart += windowFrames) {
    const windowEnd = Math.min(windowStart + windowFrames, frames);
    let sum = 0;
    for (let frame = windowStart; frame < windowEnd; frame++) {
      const base = dataOffset + frame * blockAlign;
      let sample = 0;
      for (let channel = 0; channel < channels; channel++) sample += view.getInt16(base + channel * 2, true);
      sample /= channels * 32768;
      sum += sample * sample;
    }
    const mean = sum / Math.max(1, windowEnd - windowStart);
    const db = 20 * Math.log10(Math.sqrt(mean));
    rms.push(Number.isFinite(db) ? Math.max(FLOOR_DB, db) : FLOOR_DB);
  }

  return { step, rms };
}
