// SPDX-License-Identifier: GPL-3.0-or-later
export type Bus = 'voice' | 'sfx' | 'ambience' | 'music';
export const BUSES: readonly Bus[] = ['voice', 'sfx', 'ambience', 'music'];
/** How loud the other buses are, relative to their level, while someone speaks. */
export const DUCK = 0.35;
/** Every bus at full level: ScummVM mixes its sound, music and speech at kMaxChannelVolume (the player's sliders only lower them). */
export const DEFAULT_LEVELS: Readonly<Record<Bus, number>> = { voice: 1, sfx: 1, ambience: 1, music: 1 };
/** The master level at the start, leaving headroom over the buses so the mix doesn't clip. */
export const DEFAULT_MASTER = 0.5;
/** The time constant of a level change, in seconds. */
const RAMP = 0.08;

/**
 * How a sound plays: its gain over the bus level, the second a loop goes back to (Sound::updateMusic's loop point), and
 * where it sits from left (-1) to right (1). Without a pan there is no panner: the original's mono mix (Plan 34 Task 6).
 */
export interface LoopShape {
  gain?: number;
  loopStart?: number;
  pan?: number;
}

export interface Playing {
  readonly ended: Promise<void>;
  /** In seconds. */
  readonly duration: number;
  stop(): void;
}

export type Fetcher = (url: string) => Promise<ArrayBuffer>;

const fetchBytes: Fetcher = async url => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
};

/** Web Audio buses for voice, effects, ambience and music; a voice ducks the rest (spec §7.3). */
export class Mixer {
  private readonly masterGain: GainNode;
  private masterSet = DEFAULT_MASTER;
  private muted = false;
  /** While the settings console is open the music and ambience loops are stopped (what they want is kept). */
  private paused = false;
  private readonly gains = new Map<Bus, GainNode>();
  private readonly levels: Record<Bus, number> = { ...DEFAULT_LEVELS };
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** Files a screen wants to stay decoded (the ship screens' cues, shared with the bridge): release leaves them. */
  private readonly kept = new Set<string>();
  /** How many sources of each file are playing (loops too): release leaves those. */
  private readonly sounding = new Map<string, number>();
  private readonly loops = new Map<Bus, { url: string; playing: Playing }>();
  /** The loop each bus should have, kept so a context that was suspended can start them later. */
  private readonly wanted = new Map<'ambience' | 'music', { url: string | undefined; shape: LoopShape }>();
  private readonly tokens = new Map<Bus, number>();
  private speaking = 0;
  /** What has started, oldest first (the last 500): for a test, or the dev tools, to see what played. */
  readonly started: { bus: Bus; url: string; loop: boolean }[] = [];
  /** Sounds started and not yet ended, per bus (loops left out). */
  private readonly active = new Map<Bus, number>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly fetcher: Fetcher = fetchBytes,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = DEFAULT_MASTER;
    this.masterGain.connect(ctx.destination);
    for (const bus of BUSES) {
      const gain = ctx.createGain();
      gain.gain.value = this.levels[bus];
      gain.connect(this.masterGain);
      this.gains.set(bus, gain);
    }
  }

  /** How many sounds (not loops) are playing on a bus. */
  playing(bus: Bus): number {
    return this.active.get(bus) ?? 0;
  }

  /** The level a bus is heading for (ducked while someone speaks), not where its gain has got to yet. */
  level(bus: Bus): number {
    return this.target(bus);
  }

  /** The gain the master is at: the level set, or 0 while muted. */
  get masterLevel(): number {
    return this.masterGain.gain.value;
  }

  /** The master level that was set, whether or not it is muted. */
  get master(): number {
    return this.masterSet;
  }

  setMaster(level: number): void {
    this.masterSet = Math.min(1, Math.max(0, level));
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  /** Stops the music and ambience loops (effects and voices play on), and restarts the wanted ones when unpaused. */
  pauseLoops(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const [bus, { url, shape }] of this.wanted) void this.startLoop(bus, paused ? undefined : url, shape);
  }

  setLevel(bus: Bus, level: number): void {
    this.levels[bus] = level;
    this.applyLevels();
  }

  /** Browsers start audio suspended until the player does something; the loops wait for this. */
  async resume(): Promise<void> {
    try {
      // (Safari reports 'interrupted' after a call or a lock, and resumes from it the same way)
      const state: string = this.ctx.state;
      if (state === 'suspended' || state === 'interrupted') await this.ctx.resume();
      // (paused is checked at each bus: the console can open while one loop is loading)
      for (const [bus, { url, shape }] of this.wanted) if (!this.paused) await this.startLoop(bus, url, shape);
    } catch (err) {
      this.warn(`could not resume audio: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fetches and decodes a file once; a missing or broken one is null (with one warning). */
  load(url: string): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(url);
    if (!buffer) {
      buffer = Promise.resolve()
        .then(() => this.fetcher(url))
        .then(data => this.ctx.decodeAudioData(data))
        .catch((err: unknown) => {
          this.warn(`could not play ${url}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
      this.buffers.set(url, buffer);
    }
    return buffer;
  }

  /** Holds these files decoded: `release` leaves them, as the ship screens' sounds are wanted again at the next screen. */
  keep(urls: Iterable<string>): void {
    for (const url of urls) this.kept.add(url);
  }

  /** Drops the decoded files, so the next play fetches and decodes again; not one that is playing or held by `keep`. */
  release(urls: Iterable<string>): void {
    for (const url of urls) if (!this.kept.has(url) && !this.sounding.has(url)) this.buffers.delete(url);
  }

  async preload(urls: string[]): Promise<void> {
    await Promise.all(urls.map(url => this.load(url)));
  }

  /** Plays a file on a bus; null (nothing plays) without a URL, a working file or a running context. */
  async play(url: string | undefined, bus: Bus, loop = false, shape: LoopShape = {}): Promise<Playing | null> {
    if (url === undefined || this.ctx.state !== 'running') return null;
    const buffer = await this.load(url);
    if (!buffer) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    // (a loop point past the end would loop nothing: the whole file loops instead)
    if (loop && shape.loopStart !== undefined && shape.loopStart < buffer.duration) {
      source.loopStart = shape.loopStart;
      source.loopEnd = buffer.duration;
    }
    let out: AudioNode = this.gain(bus);
    // (a StereoPannerNode spreads a mono sound by equal power, cos(pi/4) a side at the centre: √2 keeps its power at every pan,
    // the level unpanned at the centre. A stereo sound passes through at the centre already)
    const level = (shape.gain ?? 1) * (shape.pan !== undefined && buffer.numberOfChannels === 1 ? Math.SQRT2 : 1);
    if (level !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = level;
      gain.connect(out);
      out = gain;
    }
    if (shape.pan !== undefined) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.min(1, Math.max(-1, shape.pan));
      panner.connect(out);
      out = panner;
    }
    source.connect(out);
    const ended = new Promise<void>(resolve => {
      source.onended = () => resolve();
    });
    try {
      source.start();
    } catch (err) {
      this.warn(`could not play ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    this.sounding.set(url, (this.sounding.get(url) ?? 0) + 1);
    void ended.then(() => {
      const left = (this.sounding.get(url) ?? 1) - 1;
      if (left > 0) this.sounding.set(url, left);
      else this.sounding.delete(url);
    });
    this.started.push({ bus, url, loop });
    if (this.started.length > 500) this.started.shift();
    // (counted only once it has started, so a failed start can't leave the others ducked)
    if (bus === 'voice') {
      this.speaking++;
      this.applyLevels();
      void ended.then(() => {
        this.speaking--;
        this.applyLevels();
      });
    }
    if (!loop) {
      this.active.set(bus, this.playing(bus) + 1);
      void ended.then(() => this.active.set(bus, this.playing(bus) - 1));
    }
    let stopped = false;
    return {
      ended,
      duration: buffer.duration,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          source.stop();
        } catch {
          // (it had already ended)
        }
      },
    };
  }

  /** The loop on a bus: a new one replaces the old, the same one carries on, undefined stops it. */
  async setLoop(bus: 'ambience' | 'music', url: string | undefined, shape: LoopShape = {}): Promise<void> {
    this.wanted.set(bus, { url, shape });
    if (this.paused) return;
    await this.startLoop(bus, url, shape);
  }

  private async startLoop(bus: Bus, url: string | undefined, shape: LoopShape = {}): Promise<void> {
    const current = this.loops.get(bus);
    if (current && current.url === url) return;
    const token = (this.tokens.get(bus) ?? 0) + 1;
    this.tokens.set(bus, token);
    current?.playing.stop();
    this.loops.delete(bus);
    if (url === undefined) return;
    const playing = await this.play(url, bus, true, shape);
    // (a newer setLoop took over while this one loaded)
    if (this.tokens.get(bus) !== token) {
      playing?.stop();
      return;
    }
    if (playing) this.loops.set(bus, { url, playing });
  }

  private gain(bus: Bus): GainNode {
    const gain = this.gains.get(bus);
    if (!gain) throw new Error(`no bus ${bus}`);
    return gain;
  }

  /** The level a bus is heading for: its own, less the duck while someone speaks. */
  private target(bus: Bus): number {
    return this.levels[bus] * (bus !== 'voice' && this.speaking > 0 ? DUCK : 1);
  }

  private applyMaster(): void {
    this.masterGain.gain.value = this.muted ? 0 : this.masterSet;
  }

  private applyLevels(): void {
    const now = this.ctx.currentTime;
    for (const bus of BUSES) this.gain(bus).gain.setTargetAtTime(this.target(bus), now, RAMP);
  }
}
