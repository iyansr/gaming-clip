import { useSyncExternalStore } from "react";

import { PlayerAudio } from "./audio";

/** Which video the preview is showing: the source clip or the intro/outro library video. */
export type Segment = "intro" | "clip" | "outro";

/** Hidden `<video>` for a library bookend, kept loaded so playback can chain into it without a stall. */
function bookendVideo(src: string, like: HTMLVideoElement): HTMLVideoElement {
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
  v.volume = like.volume;
  v.muted = like.muted;
  v.src = src;
  document.body.appendChild(v);
  return v;
}

/** Seconds before a bookend's end at which playback hands over, so the last frame never freezes on screen. */
const HANDOVER = 0.04;

/**
 * Owns the hidden source `<video>`, loops playback inside the active clip range and runs the single
 * animation-frame loop that tells the preview canvas when to redraw. Lives outside React so the
 * transcript, scrubber and settings can all read the same playhead.
 *
 * An intro and an outro (library videos) play in their own hidden elements: playback runs intro -> clip -> outro and
 * then loops back to the intro start (or the clip start without an intro). While one of them is the active
 * `segment`, `time` stays where the clip was and `offset` is the position inside the bookend.
 */
export class Player {
  readonly video: HTMLVideoElement;
  /** Library sounds and voice effects, in step with `video`. */
  readonly audio: PlayerAudio;
  time = 0;
  /** What the preview shows now, and the position (seconds) inside the intro/outro while it shows one. */
  segment: Segment = "clip";
  offset = 0;
  playing = false;
  volume = 1;
  muted = false;
  error: string | null = null;
  /** Called from the frame loop when something changed (playing, seeked, invalidated). Set with `setDraw`. */
  private draw: (() => void) | null = null;

  private range = { start: 0, end: 0 };
  private bookends: Record<"intro" | "outro", { src: string; video: HTMLVideoElement } | null> = {
    intro: null,
    outro: null,
  };
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
      const active = this.activeVideo;
      this.playing = !active.paused && !active.ended;
      this.volume = v.volume;
      this.muted = v.muted;
      for (const b of Object.values(this.bookends)) {
        if (!b) continue;
        b.video.volume = v.volume;
        b.video.muted = v.muted;
      }
      this.emit();
    };
    this.sync = sync;
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    v.addEventListener("volumechange", sync);
    v.addEventListener("seeked", () => this.invalidate());
    v.addEventListener("loadeddata", () => this.invalidate());
    v.addEventListener("ended", () => {
      if (this.segment === "clip") this.next("clip");
    });
    v.addEventListener("error", () => {
      this.error = v.error?.message || "The source video could not be loaded";
      this.emit();
    });
    this.audio = new PlayerAudio(v);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Recomputes `playing` and the volume from the elements; set by the constructor. */
  private sync: () => void;

  /** The element of the active segment. */
  private get activeVideo(): HTMLVideoElement {
    return this.segment === "clip" ? this.video : (this.bookends[this.segment]?.video ?? this.video);
  }

  /** The intro/outro element while the preview shows one, else null. */
  get bookend(): HTMLVideoElement | null {
    return this.segment === "clip" ? null : (this.bookends[this.segment]?.video ?? null);
  }

  /**
   * Sets the intro and outro videos (URLs, null for none). Unchanged ones keep their element; if the active segment
   * goes away the preview returns to the clip.
   */
  setBookends(urls: { intro: string | null; outro: string | null }) {
    for (const slot of ["intro", "outro"] as const) {
      const current = this.bookends[slot];
      const src = urls[slot];
      if (current?.src === src) continue;
      if (current) {
        current.video.pause();
        current.video.removeAttribute("src");
        current.video.load();
        current.video.remove();
      }
      this.bookends[slot] = src ? { src, video: this.attach(slot, bookendVideo(src, this.video)) } : null;
      if (this.segment === slot) {
        this.segment = "clip";
        this.offset = 0;
        this.sync();
      }
    }
    this.invalidate();
  }

  private attach(slot: "intro" | "outro", v: HTMLVideoElement): HTMLVideoElement {
    const sync = () => this.sync();
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    v.addEventListener("seeked", () => this.invalidate());
    v.addEventListener("loadeddata", () => this.invalidate());
    // The frame loop normally hands over just before the end; this covers a throttled tab.
    v.addEventListener("ended", () => {
      if (this.segment === slot) this.next(slot);
    });
    return v;
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
    const resume = this.segment !== "clip" && this.playing;
    this.leaveBookend();
    this.video.currentTime = target;
    this.time = target;
    if (resume) void this.video.play().catch(this.playFailed);
    this.emit();
    this.invalidate();
  }

  /** Shows the intro or outro at `t` seconds into it; keeps playing when the preview was playing. */
  seekBookend(slot: "intro" | "outro", t: number) {
    const b = this.bookends[slot];
    if (!b) return;
    const v = b.video;
    const resume = this.playing;
    const length = Number.isFinite(v.duration) ? v.duration : Infinity;
    if (this.segment !== slot) {
      this.activeVideo.pause();
      this.segment = slot;
    }
    this.offset = Math.min(Math.max(0, t), Math.max(0, length - 0.05));
    v.currentTime = this.offset;
    if (resume) void v.play().catch(this.playFailed);
    this.emit();
    this.invalidate();
  }

  /** Back to the clip segment (pausing the bookend that was showing). */
  private leaveBookend() {
    if (this.segment === "clip") return;
    this.bookends[this.segment]?.video.pause();
    this.segment = "clip";
    this.offset = 0;
  }

  private playFailed = (e: unknown) => {
    if (e instanceof DOMException && e.name === "AbortError") return;
    this.error = e instanceof Error ? e.message : String(e);
    this.emit();
  };

  /** Hands playback over after `from`: intro -> clip -> outro -> intro (or the clip start without those). */
  private next(from: Segment) {
    const { intro, outro } = this.bookends;
    const target: Segment =
      from === "intro"
        ? "clip"
        : from === "clip"
          ? outro
            ? "outro"
            : intro
              ? "intro"
              : "clip"
          : intro
            ? "intro"
            : "clip";
    const previous = this.activeVideo;
    this.segment = target;
    const v = this.activeVideo;
    if (target === "clip") {
      v.currentTime = this.range.start;
      this.time = this.range.start;
    } else {
      v.currentTime = 0;
      this.offset = 0;
    }
    void v.play().catch(this.playFailed);
    if (previous !== v) previous.pause();
    this.emit();
    this.invalidate();
  }

  toggle(): Promise<void> {
    const v = this.activeVideo;
    if (!v.paused) {
      v.pause();
      return Promise.resolve();
    }
    if (this.segment !== "clip") {
      if (v.ended || (Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.05)) v.currentTime = 0;
      return v.play();
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
    this.activeVideo.pause();
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    let moved = false;
    if (this.segment === "clip") {
      const { start, end } = this.range;
      if (end > start && v.readyState >= 1 && !v.seeking) {
        const t = v.currentTime;
        if (this.playing && t >= end) this.next("clip");
        else if (t < start - 0.05 || t > end + 0.05) v.currentTime = Math.min(end, Math.max(start, t));
      }
      if (v.currentTime !== this.time) {
        this.time = v.currentTime;
        moved = true;
      }
    } else {
      const b = this.activeVideo;
      if (this.playing && Number.isFinite(b.duration) && b.currentTime >= b.duration - HANDOVER)
        this.next(this.segment);
      // `next` may just have switched segment; the offset then restarts with the new video.
      if (this.activeVideo === b && b.currentTime !== this.offset) {
        this.offset = b.currentTime;
        moved = true;
      }
    }
    if (moved) this.emit();
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
    this.setBookends({ intro: null, outro: null });
    this.listeners.clear();
  }
}

export function usePlayer<T>(player: Player, select: (p: Player) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player));
}
