import type { SoundItem, VoiceFx, VoiceItem } from "../../shared/types";
import { media } from "./api";

/** Sounds and voice effects of the active clip, in source time (the video's own clock). */
export interface AudioPlan {
  sounds: SoundItem[];
  voices: VoiceItem[];
  clipStart: number;
  clipEnd: number;
}

const EMPTY_PLAN: AudioPlan = { sounds: [], voices: [], clipStart: 0, clipEnd: 0 };

/** Soft-clipping curve for the earrape preset: k = how hard the signal is driven into the clip. */
function clipCurve(k: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

/**
 * Approximation of the renderer's voice filters on the video element's own audio. Presets that need a pitch change
 * (chipmunk, deep) are tonal stand-ins: the preview never changes the playback rate. The render is exact.
 * All nodes stay in the graph; a preset only moves their parameters, so switching is click-free and a clip without
 * voice items sounds like the plain element.
 */
class VoiceChain {
  private readonly pre: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly low: BiquadFilterNode;
  private readonly high: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly ring: GainNode;
  private readonly ringDepth: GainNode;
  private readonly echoSend: GainNode;
  private readonly feedback: GainNode;
  private current: VoiceFx | null | undefined;

  constructor(
    private readonly ctx: AudioContext,
    source: AudioNode,
    destination: AudioNode,
  ) {
    this.pre = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.low = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 150 });
    this.high = new BiquadFilterNode(ctx, { type: "highshelf", frequency: 2500 });
    this.highpass = new BiquadFilterNode(ctx, { type: "highpass", frequency: 10 });
    this.lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000 });
    this.ring = ctx.createGain();
    this.ringDepth = ctx.createGain();
    this.ringDepth.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 55;
    carrier.connect(this.ringDepth).connect(this.ring.gain);
    carrier.start();
    const out = ctx.createGain();
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.28;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.45;

    source.connect(this.pre);
    this.pre.connect(this.shaper);
    this.shaper.connect(this.low);
    this.low.connect(this.high);
    this.high.connect(this.highpass);
    this.highpass.connect(this.lowpass);
    this.lowpass.connect(this.ring);
    this.ring.connect(out);
    this.ring.connect(this.echoSend);
    this.echoSend.connect(delay);
    delay.connect(this.feedback);
    this.feedback.connect(delay);
    delay.connect(out);
    out.connect(destination);
    this.apply(null);
  }

  private set(param: AudioParam, value: number) {
    param.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  apply(preset: VoiceFx | null) {
    if (preset === this.current) return;
    this.current = preset;
    this.set(this.pre.gain, preset === "earrape" ? 10 : 1);
    this.shaper.curve = preset === "earrape" ? clipCurve(3) : null;
    this.set(this.low.gain, preset === "earrape" ? 14 : preset === "bass" ? 15 : preset === "deep" ? 10 : 0);
    this.set(this.high.gain, preset === "chipmunk" ? 10 : preset === "earrape" ? 6 : 0);
    this.set(this.highpass.frequency, preset === "chipmunk" ? 350 : 10);
    this.set(this.lowpass.frequency, preset === "deep" ? 1800 : 20000);
    this.set(this.ring.gain, preset === "robot" ? 0 : 1);
    this.set(this.ringDepth.gain, preset === "robot" ? 1 : 0);
    this.set(this.echoSend.gain, preset === "echo" ? 0.55 : 0);
    this.set(this.feedback.gain, preset === "echo" ? 0.45 : 0);
  }
}

/**
 * Editor audio next to the player: library sounds are decoded once and scheduled against the video clock on play,
 * seek and loop; voice items run the video's own audio through a VoiceChain while the playhead is inside them.
 * The video is only routed through WebAudio once a voice item exists, so a plain clip plays exactly as before, and
 * the element's volume and mute still apply (they act before the graph), so nothing doubles.
 */
export class PlayerAudio {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private voice: VoiceChain | null = null;
  private plan: AudioPlan = EMPTY_PLAN;
  private readonly bytes = new Map<string, Promise<ArrayBuffer>>();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private live = new Set<AudioBufferSourceNode>();
  private preview: AudioBufferSourceNode | null = null;
  /** Bumped by every reschedule and stop, so a decode that finishes late cannot start a stale sound. */
  private generation = 0;
  private raf = 0;
  private readonly listeners: [string, () => void][];

  constructor(private readonly video: HTMLVideoElement) {
    const reschedule = () => {
      if (!this.video.paused) void this.reschedule();
    };
    this.listeners = [
      ["play", reschedule],
      ["playing", reschedule],
      ["seeked", reschedule],
      ["pause", () => this.stop()],
      ["ended", () => this.stop()],
      ["waiting", () => this.stopSounds()],
      ["volumechange", () => this.syncVolume()],
    ];
    for (const [name, fn] of this.listeners) video.addEventListener(name, fn);
  }

  /** Replaces the sounds and voice items; takes effect at once while playing. */
  setPlan(plan: AudioPlan) {
    this.plan = plan;
    for (const sound of plan.sounds) this.fetchBytes(sound.file).catch((e: unknown) => console.error(e));
    if (plan.voices.length > 0 && this.ctx) this.ensureVoice(this.ctx);
    if (!this.video.paused) void this.reschedule();
    else this.voice?.apply(this.voiceAt(this.video.currentTime));
  }

  /** Plays a library sound once, for the inspector and the library; `onEnded` fires when it stops for any reason. */
  async previewSound(file: string, volume: number, onEnded: () => void): Promise<void> {
    this.stopPreview();
    const ctx = await this.running();
    const buffer = await this.decode(ctx, file);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain).connect(ctx.destination);
    node.onended = () => {
      if (this.preview === node) this.preview = null;
      gain.disconnect();
      onEnded();
    };
    this.preview = node;
    node.start();
  }

  stopPreview() {
    this.preview?.stop();
    this.preview = null;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const [name, fn] of this.listeners) this.video.removeEventListener(name, fn);
    this.stop();
    this.stopPreview();
    void this.ctx?.close();
    this.ctx = null;
  }

  private fetchBytes(file: string): Promise<ArrayBuffer> {
    let promise = this.bytes.get(file);
    if (!promise) {
      promise = fetch(media.library(file)).then((res) => {
        if (!res.ok) throw new Error(`Sound ${file} could not be loaded (${res.status})`);
        return res.arrayBuffer();
      });
      promise.catch(() => this.bytes.delete(file));
      this.bytes.set(file, promise);
    }
    return promise;
  }

  private decode(ctx: AudioContext, file: string): Promise<AudioBuffer> {
    let promise = this.buffers.get(file);
    if (!promise) {
      promise = this.fetchBytes(file).then((data) => ctx.decodeAudioData(data.slice(0)));
      promise.catch(() => this.buffers.delete(file));
      this.buffers.set(file, promise);
    }
    return promise;
  }

  /** The context, created on first use (after a user gesture) and resumed. */
  private async running(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.bus = ctx.createGain();
      this.bus.connect(ctx.destination);
      this.syncVolume();
      if (this.plan.voices.length > 0) this.ensureVoice(ctx);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  /** Routes the video through the voice chain; done at most once, since an element can only have one source node. */
  private ensureVoice(ctx: AudioContext) {
    if (this.voice) return;
    this.voice = new VoiceChain(ctx, ctx.createMediaElementSource(this.video), ctx.destination);
  }

  private syncVolume() {
    if (this.bus) this.bus.gain.value = this.video.muted ? 0 : this.video.volume;
  }

  private voiceAt(t: number): VoiceFx | null {
    return this.plan.voices.find((v) => t >= v.start && t < v.end)?.preset ?? null;
  }

  private stopSounds() {
    this.generation++;
    for (const node of this.live) node.stop();
    this.live = new Set();
  }

  private stop() {
    this.stopSounds();
    cancelAnimationFrame(this.raf);
    this.voice?.apply(null);
  }

  private async reschedule() {
    this.stopSounds();
    const generation = this.generation;
    let ctx: AudioContext;
    try {
      ctx = await this.running();
    } catch (e) {
      console.error(e);
      return;
    }
    if (generation !== this.generation || this.video.paused) return;
    cancelAnimationFrame(this.raf);
    if (this.voice) this.raf = requestAnimationFrame(this.tickVoice);
    for (const sound of this.plan.sounds) {
      this.startSound(ctx, sound, generation).catch((e: unknown) => console.error(e));
    }
  }

  private tickVoice = () => {
    this.voice?.apply(this.voiceAt(this.video.currentTime));
    if (!this.video.paused) this.raf = requestAnimationFrame(this.tickVoice);
  };

  private async startSound(ctx: AudioContext, item: SoundItem, generation: number) {
    const buffer = await this.decode(ctx, item.file);
    if (generation !== this.generation || this.video.paused || !this.bus) return;
    // Measured now, after the decode, so a late decode still lands on the video's clock.
    const t = this.video.currentTime;
    const end = Math.min(item.end, this.plan.clipEnd);
    if (end <= t) return;
    const offset = Math.max(0, t - item.start);
    const length = Math.min(end - Math.max(item.start, t), buffer.duration - offset);
    if (length <= 0) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = item.volume;
    node.connect(gain).connect(this.bus);
    node.onended = () => {
      this.live.delete(node);
      gain.disconnect();
    };
    this.live.add(node);
    node.start(ctx.currentTime + Math.max(0, item.start - t), offset, length);
  }
}
