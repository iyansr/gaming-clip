import { stat } from "node:fs/promises";

import { whisperModelFile } from "./config";
import { getSettings, WHISPER_MODELS, whisperModelInstalled } from "./settings";
import { downloadFile } from "./setup";
import { ConflictError, listProjects, ValidationError } from "./store";

export interface WhisperModelStatus {
  name: string;
  /** Bytes: the catalog size, or the file size for an installed model outside the catalog; null when unknown. */
  size: number | null;
  installed: boolean;
  selected: boolean;
  downloading: { received: number; total: number } | null;
  /** Why the last download of this model failed, until the next attempt. */
  error: string | null;
}

/** Models being downloaded right now; the bytes received are the size of the `.part` file `downloadFile` streams into. */
const downloads = new Set<string>();
const failures = new Map<string, string>();

async function fileSize(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? info.size : null;
}

export async function listWhisperModels(): Promise<WhisperModelStatus[]> {
  const selected = getSettings().values.whisperModel;
  const names = WHISPER_MODELS.map((model) => model.name);
  // A model chosen through WHISPER_MODEL can be any name whisper.cpp ships, not only the catalog.
  if (!names.includes(selected)) names.push(selected);
  return Promise.all(
    names.map(async (name): Promise<WhisperModelStatus> => {
      const { path } = whisperModelFile(name);
      const size = await fileSize(path);
      const catalogSize = WHISPER_MODELS.find((model) => model.name === name)?.size ?? null;
      return {
        name,
        size: catalogSize ?? size,
        installed: size !== null && size > 0,
        selected: name === selected,
        downloading: downloads.has(name)
          ? { received: (await fileSize(`${path}.part`)) ?? 0, total: catalogSize ?? 0 }
          : null,
        error: failures.get(name) ?? null,
      };
    }),
  );
}

/** Starts a background download of a catalog model; progress shows in `listWhisperModels`. */
export async function startWhisperDownload(name: string): Promise<void> {
  if (!WHISPER_MODELS.some((model) => model.name === name))
    throw new ValidationError(`Unknown whisper model "${name}"`);
  if (downloads.size > 0) throw new ConflictError("Another model is already downloading. Wait for it to finish.");
  if (await whisperModelInstalled(name)) throw new ConflictError(`The "${name}" model is already downloaded`);
  const running = (await listProjects()).filter((project) => project.stages.transcribe.status === "running");
  if (running.length > 0)
    throw new ConflictError("A transcription is running. Wait for it to finish before downloading a model.");

  const { path, url } = whisperModelFile(name);
  failures.delete(name);
  downloads.add(name);
  downloadFile(url, path, `ggml-${name}.bin`)
    .catch((error: unknown) => failures.set(name, error instanceof Error ? error.message : String(error)))
    .finally(() => downloads.delete(name));
}
