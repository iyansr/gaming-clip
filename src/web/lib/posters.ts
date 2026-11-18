import { useEffect, useState } from "react";

import { media } from "./api";

const POSTER_HEIGHT = 96;
const POSTER_WIDTH = 54;

/** One decoded frame per library video, as a small JPEG data URL; null when the video cannot be decoded. */
const posters = new Map<string, Promise<string | null>>();

function extractPoster(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const done = (url: string | null) => {
      video.removeAttribute("src");
      video.load();
      resolve(url);
    };
    video.addEventListener("error", () => done(null), { once: true });
    video.addEventListener(
      "loadeddata",
      () => {
        video.addEventListener(
          "seeked",
          () => {
            const canvas = document.createElement("canvas");
            canvas.width = POSTER_WIDTH;
            canvas.height = POSTER_HEIGHT;
            const ctx = canvas.getContext("2d");
            if (!ctx || video.videoWidth === 0) return done(null);
            const scale = Math.max(POSTER_WIDTH / video.videoWidth, POSTER_HEIGHT / video.videoHeight);
            const w = video.videoWidth * scale;
            const h = video.videoHeight * scale;
            ctx.drawImage(video, (POSTER_WIDTH - w) / 2, (POSTER_HEIGHT - h) / 2, w, h);
            done(canvas.toDataURL("image/jpeg", 0.7));
          },
          { once: true },
        );
        video.currentTime = Math.min(0.5, (Number.isFinite(video.duration) ? video.duration : 1) / 2);
      },
      { once: true },
    );
    video.src = media.library(file);
  });
}

/** A still of a library video for the timeline block and the inspector; null while it loads or when it fails. */
export function useVideoPoster(file: string | null): string | null {
  const [loaded, setLoaded] = useState<{ file: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let promise = posters.get(file);
    if (!promise) {
      promise = extractPoster(file);
      posters.set(file, promise);
    }
    void promise.then((url) => {
      if (!cancelled) setLoaded({ file, url });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);
  return loaded?.file === file ? loaded.url : null;
}
