import { useSyncExternalStore } from "react";

import { PlayerAudio } from "./audio";

/**
 * Owns the hidden source `<video>`, loops playback inside the active clip range and runs the single
 * animation-frame loop that tells the preview canvas when to redraw. Lives outside React so the
 * transcript, scrubber and settings can all read the same playhead.
 */
export class Player {
  readonly video: HTMLVideoElement;
  /** Library sounds and voice effects, in step with `video`. */
  readonly audio: PlayerAudio;
  time = 0;
  playing = false;
  volume = 1;
  muted = false;
  error: string | null = null;
  /** Called from the frame loop when something changed (playing, seeked, invalidated). Set with `setDraw`. */
  private draw: (() => void) | null = null;

  private range = { start: 0, end: 0 };
  private listeners = new Set<() => void>();
  private dirty = true;
  private raf = 0;

  constructor(src: string) {
    const v = document.createElement("video");
    v.preload = "auto";
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    v.setAttribute("aria-hidden", "true");
    Object.assign(v.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
    });
    v.src = src;
    document.body.appendChild(v);
    this.video = v;

    const sync = () => {
      this.playing = !v.paused && !v.ended;
      this.volume = v.volume;
      this.muted = v.muted;
      this.emit();
    };
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    v.addEventListener("volumechange", sync);
    v.addEventListener("seeked", () => this.invalidate());
    v.addEventListener("loadeddata", () => this.invalidate());
    v.addEventListener("ended", () => {
      v.currentTime = this.range.start;
      void v.play();
    });
    v.addEventListener("error", () => {
      this.error = v.error?.message || "The source video could not be loaded";
      this.emit();
    });
    this.audio = new PlayerAudio(v);
    this.raf = requestAnimationFrame(this.tick);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  invalidate() {
    this.dirty = true;
  }

  setRange(start: number, end: number) {
    this.range = { start, end };
    this.invalidate();
  }

  seek(t: number) {
    const { start, end } = this.range;
    const target = end > start ? Math.min(end, Math.max(start, t)) : Math.max(0, t);
    this.video.currentTime = target;
    this.time = target;
    this.emit();
    this.invalidate();
  }

  toggle(): Promise<void> {
    const v = this.video;
    if (!v.paused) {
      v.pause();
      return Promise.resolve();
    }
    const { start, end } = this.range;
    if (end > start && (v.currentTime >= end - 0.05 || v.currentTime < start)) v.currentTime = start;
    return v.play();
  }

  setVolume(volume: number) {
    this.video.volume = volume;
    this.video.muted = volume === 0;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  pause() {
    this.video.pause();
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    const { start, end } = this.range;
    if (end > start && v.readyState >= 1 && !v.seeking) {
      const t = v.currentTime;
      if (this.playing && t >= end) v.currentTime = start;
      else if (t < start - 0.05 || t > end + 0.05) v.currentTime = Math.min(end, Math.max(start, t));
    }
    const moved = v.currentTime !== this.time;
    if (moved) {
      this.time = v.currentTime;
      this.emit();
    }
    if (this.playing || this.dirty || moved) {
      this.dirty = false;
      this.draw?.();
    }
  };

  /** Registers (or clears) the callback the frame loop uses to repaint the preview. */
  setDraw(draw: (() => void) | null) {
    this.draw = draw;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.audio.destroy();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
    this.listeners.clear();
  }
}

export function usePlayer<T>(player: Player, select: (p: Player) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player));
}
