// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatCue } from '../content/types';
import type { SoundChannels } from './channels';

/** kNumCueChannels (cues.h:36): the crew's cues play on Sound's first three channels. */
export const CUE_CHANNELS = 3;
/** kCueSpeakerComputer (cues.h:34): the computer, quiet without its cores. */
export const SPEAKER_COMPUTER = 7;
/** kCueSpeakerEffect (cues.h:35): "8 to 10 are sound effects", though only 8 itself plays once silenced (blocked, cues.cpp:60-61). */
export const SPEAKER_EFFECT = 8;
/** kCueGap (cues.cpp:31): 0x5af * 1000 / 291, 5000 ms before a cue may play again, its own gap on top. */
export const CUE_GAP = Math.trunc((0x5af * 1000) / 291);

/** ticksToMillis (cues.cpp:33-35): (uint32)ticks * 1000 / 291, the product wrapping mod 2^32 as in C (a gap of -1 is 14759334 ms; R1). */
const ticksToMillis = (ticks: number): number => Math.trunc((Math.imul(ticks, 1000) >>> 0) / 291);

/** Where the cues come from: combat.yaml's table, a cue file's URL (undefined: the game lacks it), and whether the computer has power. */
export interface CueSource {
  /** UnityEngine::data._cues: read when a cue is asked for, as combat.yaml loads lazily. */
  cues(): readonly CombatCue[];
  url(file: string): string | undefined;
  /** `_vm->data._ship.computerPercent()` is not 0 (cues.cpp:65), read here as R10 rules. */
  computerOn(): boolean;
}

interface Pending { time: number; id: number; important: boolean }
interface Channel { speaker: number; start: number; chain: Pending[] }

/**
 * CuePlayer (cues.h:39-75, cues.cpp:37-150): the crew's cues in space combat, on Sound's channels 0-2. A port, quirks
 * kept. `now` is g_system->getMillis(), which the port gives as the battle's clock (Plan 28 R2), so delays and gaps
 * follow the speed and stop with a pause. `silenced` is _silenced, set by the battle (damage.cpp:534) and cleared by reset.
 */
export class CuePlayer {
  /** _silenced (cues.h:51-52): nobody speaks once the Enterprise is lost. */
  silenced = false;
  private readonly channels: Channel[] = [];
  private lastChannel = -1;
  private next: number[] = [];
  private delayed: Pending[] = [];

  constructor(private readonly snd: SoundChannels, private readonly source: CueSource) {
    this.reset();
  }

  /** reset (cues.cpp:41-52): the cue channels stopped; their speakers, chains, the later cues, the gaps and the silence forgotten. */
  reset(): void {
    for (let i = 0; i < CUE_CHANNELS; i++) {
      this.snd.stop(i);
      this.channels[i] = { speaker: -1, start: 0, chain: [] };
    }
    this.lastChannel = -1;
    this.next = [];
    this.delayed = [];
    this.silenced = false;
  }

  /** play (cues.cpp:102-109): blocked, or no channel, false; else start. Important cues take a channel from the newest other cue. */
  play(id: number, now: number, important = false): boolean {
    if (this.blocked(id, now)) return false;
    const channel = this.freeChannel(important);
    if (channel === -1) return false;
    return this.start(id, channel, now);
  }

  /** playLater (cues.cpp:111-117): asked for again by update once `delay` ms have passed. */
  playLater(id: number, delay: number, now: number, important = false): void {
    this.delayed.push({ time: now + delay, id, important });
  }

  /** playAfter (cues.cpp:119-129): at once if the last cue's channel has ended, else chained to that channel. */
  playAfter(id: number, now: number, important = false): void {
    if (this.lastChannel === -1 || !this.snd.playing(this.lastChannel)) {
      this.play(id, now, important);
      return;
    }
    this.channels[this.lastChannel]!.chain.push({ time: 0, id, important });
  }

  /**
   * update (cues.cpp:131-150): nothing once silenced; each ended channel's next chained cue, unless blocked (then it is
   * dropped); then each later cue that is due, by play.
   */
  update(now: number): void {
    if (this.silenced) return;
    for (let i = 0; i < CUE_CHANNELS; i++) {
      const channel = this.channels[i]!;
      if (channel.chain.length === 0 || this.snd.playing(i)) continue;
      const next = channel.chain.shift()!;
      if (!this.blocked(next.id, now)) this.start(next.id, i, now);
    }
    for (let i = 0; i < this.delayed.length; i++) {
      if (now < this.delayed[i]!.time) continue;
      const [due] = this.delayed.splice(i--, 1);
      this.play(due!.id, now, due!.important);
    }
  }

  /** blocked (cues.cpp:54-73). */
  private blocked(id: number, now: number): boolean {
    const cues = this.source.cues();
    const cue = cues[id];
    if (!cue || !cue.file) return true;
    if (id < this.next.length && now < this.next[id]!) return true;
    const speaker = cue.speaker;
    if (speaker === SPEAKER_EFFECT) return false;
    if (this.silenced) return true;
    // (the computer is quiet without its cores)
    if (speaker === SPEAKER_COMPUTER && !this.source.computerOn()) return true;
    // (and nobody says two things at once)
    for (let i = 0; i < CUE_CHANNELS; i++) {
      if (this.channels[i]!.speaker === speaker && this.snd.playing(i)) return true;
    }
    return false;
  }

  /** freeChannel (cues.cpp:75-88): an ended channel with no chain; else, for an important cue, the newest with no chain. */
  private freeChannel(important: boolean): number {
    for (let i = 0; i < CUE_CHANNELS; i++) {
      if (!this.snd.playing(i) && this.channels[i]!.chain.length === 0) return i;
    }
    if (!important) return -1;
    let newest = -1;
    for (let i = 0; i < CUE_CHANNELS; i++) {
      if (this.channels[i]!.chain.length === 0 && (newest === -1 || this.channels[i]!.start > this.channels[newest]!.start)) newest = i;
    }
    return newest;
  }

  /**
   * start (cues.cpp:90-100): the cue's gap, its channel's speaker and start, the last channel, then playOnChannel: as
   * speech under kCueSpeakerEffect, else as an effect. A file the game lacks plays nothing, its gap and speaker set
   * all the same.
   */
  private start(id: number, channel: number, now: number): boolean {
    const cues = this.source.cues();
    const cue = cues[id]!;
    while (this.next.length < cues.length) this.next.push(0);
    this.next[id] = now + CUE_GAP + ticksToMillis(cue.gap);
    const ch = this.channels[channel]!;
    ch.speaker = cue.speaker;
    ch.start = now;
    this.lastChannel = channel;
    return this.snd.play(channel, this.source.url(cue.file!), cue.speaker < SPEAKER_EFFECT ? 'voice' : 'sfx');
  }
}
