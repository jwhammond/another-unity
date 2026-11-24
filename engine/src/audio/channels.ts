// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bus, LoopShape, Mixer, Playing } from './mixer';

/** Sound::kNumChannels (sound.h:51): the crew's cues take the first three (kNumCueChannels, cues.h:36), the effects the next five (weapons.cpp:64, 159). */
export const NUM_CHANNELS = 8;
/** Audio::Mixer::kMaxChannelVolume: playOnChannel's default volume (sound.h:52). */
export const FULL_VOLUME = 255;

/**
 * Sound's channels for the crew's cues and space combat (sound.h:50-54): what the CuePlayer and playEffect play on.
 * - `play` is playOnChannel (sound.cpp:167-181): it stops the channel, then plays `url` there on `bus` at `volume`
 *   (0-255), true; with no file (undefined: the game lacks it) the channel stays stopped and nothing plays, false. A
 *   `pan` (-1 left to 1 right) is the port's 3D SOUND (Plan 34 Task 6); without one the sound is the original's, unpanned.
 * - `playing` is channelPlaying (:183-185), `stop` stopChannel (:187-189).
 */
export interface SoundChannels {
  play(channel: number, url: string | undefined, bus: Bus, volume?: number, pan?: number): boolean;
  playing(channel: number): boolean;
  stop(channel: number): void;
}

/**
 * The channels on the mixer (Plan 28 R12). A channel plays from the moment it is asked until its sound ends or is
 * stopped, as a ScummVM handle is active from playStream: the file may still be loading, and the channel counts as
 * busy meanwhile. A sound that cannot start (a broken file, or audio the page hasn't woken yet: Mixer.play's null)
 * frees its channel when that is known. A sound that arrives after its channel was stopped or replaced is stopped.
 */
export class MixerChannels implements SoundChannels {
  private readonly slots: ({ sound: Playing | null } | null)[] = new Array<null>(NUM_CHANNELS).fill(null);

  constructor(private readonly mixer: Pick<Mixer, 'play'>) {}

  play(channel: number, url: string | undefined, bus: Bus, volume = FULL_VOLUME, pan?: number): boolean {
    this.stop(channel);
    // (a few of the original's sounds are missing, and are skipped: sound.cpp:170-172)
    if (url === undefined) return false;
    const slot: { sound: Playing | null } = { sound: null };
    this.slots[channel] = slot;
    const free = () => {
      if (this.slots[channel] === slot) this.slots[channel] = null;
    };
    const shape: LoopShape = volume === FULL_VOLUME ? {} : { gain: volume / FULL_VOLUME };
    if (pan !== undefined) shape.pan = pan;
    this.mixer.play(url, bus, false, shape).then(sound => {
      if (!sound) return free();
      if (this.slots[channel] !== slot) {
        sound.stop();
        return;
      }
      slot.sound = sound;
      void sound.ended.then(free);
    }, free);
    return true;
  }

  playing(channel: number): boolean {
    return this.slots[channel] !== null;
  }

  stop(channel: number): void {
    const slot = this.slots[channel];
    this.slots[channel] = null;
    slot?.sound?.stop();
  }
}
