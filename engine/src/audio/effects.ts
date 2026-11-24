// SPDX-License-Identifier: GPL-3.0-or-later
import type { SoundChannels } from './channels';
import { CUE_CHANNELS } from './cues';

/** kSoundRange (weapons.cpp:62): no effect is heard from this far from the camera. */
export const SOUND_RANGE = 8500;
/** kNumEffectChannels (weapons.cpp:64). */
export const EFFECT_CHANNELS = 5;
/** kFirstChannel (weapons.cpp:159): the effects' channels follow the cues'. */
export const FIRST_EFFECT_CHANNEL = CUE_CHANNELS;

/**
 * playEffect's volume (weapons.cpp:156-158, 167): (byte)(255 * (kSoundRange - distance) / kSoundRange), in floats; null
 * (not played) from kSoundRange on.
 */
export function effectVolume(distance: number): number | null {
  if (distance >= SOUND_RANGE) return null;
  return Math.trunc(Math.fround(Math.fround(255 * Math.fround(SOUND_RANGE - distance)) / SOUND_RANGE));
}

/** How far to a side the furthest effect sits (Plan 34 Task 6): never hard left or right. */
const MAX_PAN = 0.6;

/**
 * An effect's pan for 3D SOUND (the port's; the original's mix is mono): from its source's bearing, in radians from the camera's
 * forward and positive to the right, 0.6 sin(bearing), so 0 ahead or behind, 0.6 at the right and -0.6 at the left.
 */
export function effectPan(bearing: number): number {
  return Math.min(MAX_PAN, Math.max(-MAX_PAN, MAX_PAN * Math.sin(bearing)));
}

/**
 * Combat::playEffect (weapons.cpp:154-168), from the request's distance (SoundRequest.distance, taken as it was asked
 * for): the first effect channel that has ended, or the first effect channel when all five play, whose sound it cuts
 * short (Plan 28 R5: the original's, where the M8 spec said dropped); played as an effect at the distance's volume.
 * `url` undefined is a sound the game lacks: the channel is stopped and nothing plays (sound.cpp:169-172). A `pan` is 3D SOUND's
 * (effectPan); without one it plays unpanned, as the original's.
 */
export function playEffect(snd: SoundChannels, distance: number, url: string | undefined, pan?: number): void {
  const volume = effectVolume(distance);
  if (volume === null) return;
  let channel = FIRST_EFFECT_CHANNEL;
  for (let i = 0; i < EFFECT_CHANNELS; i++) {
    if (!snd.playing(FIRST_EFFECT_CHANNEL + i)) {
      channel = FIRST_EFFECT_CHANNEL + i;
      break;
    }
  }
  snd.play(channel, url, 'sfx', volume, pan);
}
