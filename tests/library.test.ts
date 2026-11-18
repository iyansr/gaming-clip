import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { createCanvas } from "@napi-rs/canvas";

import {
  addLibraryItem,
  getLibraryItem,
  libraryPath,
  listLibrary,
  removeLibraryItem,
  renameLibraryItem,
} from "../src/core/library";
import { addClip, patchClip } from "../src/core/pipeline";
import { ConflictError, createProject, updateProject, ValidationError } from "../src/core/store";
import type { SourceMeta } from "../src/shared/types";

const source: SourceMeta = {
  input: "test.mp4",
  videoId: null,
  title: "Test",
  channel: "Test",
  duration: 600,
  width: 1280,
  height: 720,
  fps: 30,
};

/** One second of 8 kHz mono 16-bit PCM. */
function wav(): Uint8Array {
  const rate = 8000;
  const samples = rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
  }
  return bytes;
}

function png(size = 24): Uint8Array {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff3366";
  ctx.fillRect(0, 0, size, size);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** Rejects with the thrown error, so an assertion can inspect it without an unawaited matcher. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject");
}

async function makeClip(): Promise<{ projectId: string; clipId: string }> {
  const created = await createProject("https://example.com/watch?v=test");
  await updateProject(created.id, (project) => {
    project.source = source;
    project.stages.download = { status: "done", progress: 1 };
  });
  const project = await addClip(created.id, 10, 40, "Test clip");
  return { projectId: created.id, clipId: project.clips[0]!.id };
}

describe("library uploads", () => {
  test("stores a sound and a sticker, newest first, with probed metadata", async () => {
    const sound = await addLibraryItem(wav(), "audio/wav", "vine boom");
    expect(sound).toMatchObject({ kind: "sound", name: "vine boom", width: null, height: null });
    expect(sound.file).toMatch(/^[0-9a-f]{32}\.wav$/);
    expect(sound.duration).toBeGreaterThan(0.9);
    expect(sound.duration).toBeLessThan(1.1);

    const sticker = await addLibraryItem(png(), "image/png", "boom sticker");
    expect(sticker).toMatchObject({ kind: "sticker", name: "boom sticker", duration: null, width: 24, height: 24 });

    const items = await listLibrary();
    expect(items[0]!.file).toBe(sticker.file);
    expect(items.some((item) => item.file === sound.file)).toBe(true);

    expect(await getLibraryItem(sound.file)).toEqual(sound);
    expect(await getLibraryItem("0".repeat(32) + ".wav")).toBeNull();
  });

  test("rejects bytes that do not match the claimed type", async () => {
    const wrong = await rejection(addLibraryItem(png(), "audio/wav", "fake"));
    expect(wrong).toBeInstanceOf(ValidationError);
    expect(wrong.message).toContain("The file is not a audio/wav file");
    expect((await rejection(addLibraryItem(wav(), "image/png", "fake"))).message).toContain("not a image/png file");
    expect((await rejection(addLibraryItem(wav(), "video/mp4", "fake"))).message).toContain("not a video/mp4 file");
    expect((await rejection(addLibraryItem(new Uint8Array(), "image/png", "empty"))).message).toContain(
      "The upload is empty",
    );
    expect((await rejection(addLibraryItem(wav(), "audio/unknown", "x"))).message).toContain(
      "Content-Type must be one of",
    );
  });

  test("a generic name is used when the upload has none", async () => {
    const item = await addLibraryItem(png(), "image/png", "   ");
    expect(item.name).toBe("Sticker");
  });

  test("renames without touching the file", async () => {
    const item = await addLibraryItem(wav(), "audio/wav", "boom");
    const renamed = await renameLibraryItem(item.file, "  bruh   sound ");
    expect(renamed.name).toBe("bruh sound");
    expect(renamed.file).toBe(item.file);
    expect(existsSync(libraryPath(item.file))).toBe(true);
    expect((await getLibraryItem(item.file))?.name).toBe("bruh sound");
    expect((await rejection(renameLibraryItem(item.file, "   "))).message).toContain("name must be 1-80 characters");
  });

  test("deletes an unused upload", async () => {
    const item = await addLibraryItem(png(), "image/png", "temporary");
    await removeLibraryItem(item.file);
    expect(await getLibraryItem(item.file)).toBeNull();
    expect(existsSync(libraryPath(item.file))).toBe(false);
  });

  test("refuses to delete a file a clip uses", async () => {
    const { projectId, clipId } = await makeClip();
    const sound = await addLibraryItem(wav(), "audio/wav", "used sound");
    await patchClip(projectId, clipId, {
      timeline: {
        items: [{ id: "s1", kind: "sound", start: 12, end: 12.5, file: sound.file, volume: 1 }],
        teaser: null,
      },
    });

    const blocked = await rejection(removeLibraryItem(sound.file));
    expect(blocked).toBeInstanceOf(ConflictError);
    expect(blocked.message).toContain("used by 1 clip");

    await patchClip(projectId, clipId, { timeline: { items: [], teaser: null } });
    await removeLibraryItem(sound.file);
    expect(await getLibraryItem(sound.file)).toBeNull();
  });
});
