// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FakeChannels } from '../testing/sound';
import { EFFECT_CHANNELS, effectPan, effectVolume, FIRST_EFFECT_CHANNEL, playEffect, SOUND_RANGE } from './effects';

describe('the battle\'s sound effects (Combat::playEffect, weapons.cpp:154-168; Plan 28)', () => {
  it('has five channels after the cues\', and a range of 8500 (weapons.cpp:62, 64, 159)', () => {
    expect([SOUND_RANGE, EFFECT_CHANNELS, FIRST_EFFECT_CHANNEL]).toEqual([8500, 5, 3]);
  });

  it('is quieter the further from the camera: (byte)(255 * (8500 - d) / 8500), and silent from 8500 (weapons.cpp:157-158, 167)', () => {
    // (0: 255. 1300: 255 * 7200 = 1836000, / 8500 = 216. 4250: 127.5, cut to 127. 1: 2167245 / 8500 = 254.97, 254.
    // 8499: 255 / 8500 = 0.03, 0: played, at nothing. 8500 and past: not played)
    expect([0, 1300, 4250, 1, 8499, 8500, 9000].map(effectVolume)).toEqual([255, 216, 127, 254, 0, null, null]);
  });

  it('plays on the first effect channel that has ended, at its volume, on the effects\' bus', () => {
    const ch = new FakeChannels();
    playEffect(ch, 1300, 'u:boom');
    playEffect(ch, 0, 'u:hit');
    ch.end(3);
    playEffect(ch, 4250, 'u:zap');
    expect(ch.log).toEqual([[3, 'u:boom', 'sfx', 216], [4, 'u:hit', 'sfx', 255], [3, 'u:zap', 'sfx', 127]]);
  });

  it('takes the first effect channel when all five play, cutting its sound short: not dropped (weapons.cpp:159-167; Plan 28 R5)', () => {
    const ch = new FakeChannels();
    for (let i = 0; i < 5; i++) playEffect(ch, 0, `u:${i}`);
    playEffect(ch, 0, 'u:sixth');
    expect([ch.log.at(-1), ch.cut]).toEqual([[3, 'u:sixth', 'sfx', 255], [3]]);
    // (and too far away, nothing: no channel is touched)
    playEffect(ch, 8500, 'u:far');
    expect([ch.log.length, ch.cut]).toEqual([6, [3]]);
  });

  it('plays nothing for a sound the game lacks, the channel it chose stopped all the same (sound.cpp:169-172)', () => {
    const ch = new FakeChannels();
    for (let i = 0; i < 5; i++) playEffect(ch, 0, `u:${i}`);
    playEffect(ch, 0, undefined);
    expect([ch.log.length, ch.cut, ch.playing(3)]).toEqual([5, [3], false]);
  });

  it('effectPan is 0 ahead, +0.6 at the right, −0.6 at the left, and never past ±0.6', () => {
    expect(effectPan(0)).toBe(0);
    expect(effectPan(Math.PI / 2)).toBeCloseTo(0.6, 12);
    expect(effectPan(-Math.PI / 2)).toBeCloseTo(-0.6, 12);
    // (0.6 sin: half way to the right is 0.6 / sqrt 2; behind is the middle again)
    expect(effectPan(Math.PI / 4)).toBeCloseTo(0.6 * Math.SQRT1_2, 12);
    expect(effectPan(Math.PI)).toBeCloseTo(0, 12);
    for (let b = -10; b <= 10; b += 0.01) expect(Math.abs(effectPan(b))).toBeLessThanOrEqual(0.6);
  });

  it('plays at a pan when asked, and without one when not', () => {
    const ch = new FakeChannels();
    playEffect(ch, 1300, 'u:boom', 0.3);
    playEffect(ch, 1300, 'u:hit');
    expect(ch.log).toEqual([[3, 'u:boom', 'sfx', 216, 0.3], [4, 'u:hit', 'sfx', 216]]);
  });
});
