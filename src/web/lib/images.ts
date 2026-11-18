import { useCallback, useEffect, useMemo, useState } from "react";

import { media } from "./api";

/** Decoded images by URL: a background is loaded once and then shared by the preview, the thumbnail canvas and the tiles. */
const loaded = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const existing = pending.get(url);
  if (existing) return existing;
  const image = new Image();
  image.src = url;
  const promise = image.decode().then(() => {
    loaded.set(url, image);
    return image;
  });
  promise.catch(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

/** The project's uploaded background image, or null while it loads / when there is none / when it fails. */
export function useAssetImage(projectId: string, file: string | null): HTMLImageElement | null {
  const url = file === null ? null : media.asset(projectId, file);
  const [image, setImage] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (url === null || loaded.has(url)) return;
    let cancelled = false;
    loadImage(url)
      .then((img) => {
        if (!cancelled) setImage({ url, image: img });
      })
      .catch((e: unknown) => console.error(e));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (url === null) return null;
  return loaded.get(url) ?? (image?.url === url ? image.image : null);
}

/** Decodes a project asset (cached), e.g. to read the natural size of a freshly uploaded image. */
export function loadAssetImage(projectId: string, file: string): Promise<HTMLImageElement> {
  return loadImage(media.asset(projectId, file));
}

/** Decoded images by file name for a set of files whose URL comes from `urlOf`; files still loading or failed are absent. */
function useImageSet(files: string[], urlOf: (file: string) => string): Map<string, HTMLImageElement> {
  const key = files.join("\n");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    for (const file of key === "" ? [] : key.split("\n")) {
      const url = urlOf(file);
      if (loaded.has(url)) continue;
      loadImage(url)
        .then(() => {
          if (!cancelled) setVersion((v) => v + 1);
        })
        .catch((e: unknown) => console.error(e));
    }
    return () => {
      cancelled = true;
    };
    // `urlOf` is a stable module-level or per-project function; the key carries the files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOf, key]);
  return useMemo(() => {
    const map = new Map<string, HTMLImageElement>();
    for (const file of key === "" ? [] : key.split("\n")) {
      const image = loaded.get(urlOf(file));
      if (image) map.set(file, image);
    }
    return map;
    // `version` bumps when a pending image finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOf, key, version]);
}

/** Decoded images of several project assets by file name; files that are still loading or failed are absent. */
export function useAssetImages(projectId: string, files: string[]): Map<string, HTMLImageElement> {
  const urlOf = useCallback((file: string) => media.asset(projectId, file), [projectId]);
  return useImageSet(files, urlOf);
}

const libraryUrl = (file: string) => media.library(file);

/** Decoded library stickers by file name (see useAssetImages). */
export function useLibraryImages(files: string[]): Map<string, HTMLImageElement> {
  return useImageSet(files, libraryUrl);
}
