import { useEffect, useState } from "react";
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
