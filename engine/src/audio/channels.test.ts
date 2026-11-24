// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FakeChannels } from '../testing/sound';
import { MixerChannels, NUM_CHANNELS } from './channels';
import type { Bus, LoopShape, Mixer, Playing } from './mixer';

/** Mixer.play as a stand-in: each call waits for the test to give its sound (or null), and says what was asked. */
class SlowMixer {
  readonly asked: [string, Bus, boolean, LoopShape][] = [];
  readonly stopped: string[] = [];
  private readonly waiting: ((p: Playing | null) => void)[] = [];
  private readonly enders = new Map<string, () => void>();
  play(url: string, bus: Bus, loop = false, shape: LoopShape = {}): Promise<Playing | null> {
    this.asked.push([url, bus, loop, shape]);
    return new Promise(resolve => this.waiting.push(resolve));
  }
  /** Gives the oldest waiting play (or the `which`th, 0 the oldest) its sound, `url`'s, which plays until end(url); or null (no file, or no running audio). */
  give(url: string | null, which = 0): void {
    const resolve = this.waiting.splice(which, 1)[0]!;
    if (url === null) { resolve(null); return; }
    const ended = new Promise<void>(r => this.enders.set(url, r));
    resolve({ ended, duration: 1, stop: () => { this.stopped.push(url); this.enders.get(url)?.(); } });
  }
  end(url: string): void {
    this.enders.get(url)?.();
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Sound's channels (sound.cpp:167-189; Plan 28 R12)", () => {
  it('has eight: three for the crew\'s cues, five for the effects (sound.h:51, cues.h:36, weapons.cpp:64)', () => {
    expect(NUM_CHANNELS).toBe(8);
  });

  it('plays on the mixer at the volume asked (255 the mixer\'s own), a channel playing from the moment it is asked until its sound ends', async () => {
    const mixer = new SlowMixer();
    const ch = new MixerChannels(mixer as unknown as Mixer);
    expect(ch.play(3, 'u:boom', 'sfx', 216)).toBe(true);
    expect(ch.play(0, 'u:line', 'voice')).toBe(true);
    // (playing at once, as playOnChannel's handle is, though the file is still loading)
    expect([ch.playing(3), ch.playing(0), ch.playing(1)]).toEqual([true, true, false]);
    // (216 / 255 of the bus: the mixer's volume byte, Audio::Mixer::kMaxChannelVolume 255)
    expect(mixer.asked).toEqual([['u:boom', 'sfx', false, { gain: 216 / 255 }], ['u:line', 'voice', false, {}]]);
    mixer.give('u:boom');
    mixer.give('u:line');
    await flush();
    expect([ch.playing(3), ch.playing(0)]).toEqual([true, true]);
    mixer.end('u:boom');
    await flush();
    expect([ch.playing(3), ch.playing(0)]).toEqual([false, true]);
  });

  it('stops what a channel plays before it plays again, and stops a sound that arrives after its channel was stopped (stopChannel, sound.cpp:169, 187-189)', async () => {
    const mixer = new SlowMixer();
    const ch = new MixerChannels(mixer as unknown as Mixer);
    ch.play(4, 'u:first', 'sfx');
    mixer.give('u:first');
    await flush();
    ch.play(4, 'u:second', 'sfx');
    expect([mixer.stopped, ch.playing(4)]).toEqual([['u:first'], true]);
    // (the first's end, as stopping it ends it, frees nothing: the channel is the second's)
    await flush();
    expect(ch.playing(4)).toBe(true);
    ch.stop(4);
    expect(ch.playing(4)).toBe(false);
    mixer.give('u:second');
    await flush();
    expect([mixer.stopped, ch.playing(4)]).toEqual([['u:first', 'u:second'], false]);
  });

  it('plays nothing for a file the game lacks, the channel stopped all the same; and frees a channel whose sound could not start (sound.cpp:170-175)', async () => {
    const mixer = new SlowMixer();
    const ch = new MixerChannels(mixer as unknown as Mixer);
    ch.play(5, 'u:ringing', 'sfx');
    mixer.give('u:ringing');
    await flush();
    expect(ch.play(5, undefined, 'sfx')).toBe(false);
    expect([mixer.stopped, ch.playing(5), mixer.asked.length]).toEqual([['u:ringing'], false, 1]);
    // (a broken file, or audio the page hasn't woken yet: Mixer.play's null)
    ch.play(6, 'u:broken', 'sfx');
    mixer.give(null);
    await flush();
    expect(ch.playing(6)).toBe(false);
  });
});

describe("Sound's channels: a sound replaced while it loads (Plan 28 R12)", () => {
  it('stops the first sound when it arrives late, and keeps the second on the channel, in either arrival order', async () => {
    for (const firstArrivesFirst of [true, false]) {
      const mixer = new SlowMixer();
      const ch = new MixerChannels(mixer as unknown as Mixer);
      ch.play(2, 'u:old', 'sfx');
      ch.play(2, 'u:new', 'sfx');
      if (firstArrivesFirst) { mixer.give('u:old'); mixer.give('u:new'); } else { mixer.give('u:new', 1); mixer.give('u:old'); }
      await flush();
      expect([mixer.stopped, ch.playing(2)]).toEqual([['u:old'], true]);
      // (the stale sound's end, from its being stopped, frees nothing; the channel is the second's until it ends)
      mixer.end('u:old');
      await flush();
      expect(ch.playing(2)).toBe(true);
      mixer.end('u:new');
      await flush();
      expect(ch.playing(2)).toBe(false);
    }
  });

  it('keeps the second sound\'s channel when the first, replaced, turns out not to have started', async () => {
    const mixer = new SlowMixer();
    const ch = new MixerChannels(mixer as unknown as Mixer);
    ch.play(2, 'u:old', 'sfx');
    ch.play(2, 'u:new', 'sfx');
    mixer.give(null);
    await flush();
    expect(ch.playing(2)).toBe(true);
    mixer.give('u:new');
    await flush();
    expect([mixer.stopped, ch.playing(2)]).toEqual([[], true]);
  });
});

describe("Sound's channels: 3D SOUND's pan (Plan 34 Task 6)", () => {
  it('hands a pan to the mixer with the volume, and no pan key at all without one', () => {
    const mixer = new SlowMixer();
    const ch = new MixerChannels(mixer as unknown as Mixer);
    ch.play(3, 'u:boom', 'sfx', 216, -0.5);
    ch.play(4, 'u:hit', 'sfx', 255, 0.25);
    ch.play(5, 'u:zap', 'sfx', 216);
    expect(mixer.asked.map(a => a[3])).toEqual([{ gain: 216 / 255, pan: -0.5 }, { pan: 0.25 }, { gain: 216 / 255 }]);
    expect('pan' in mixer.asked[2]![3]).toBe(false);
  });
});

describe('FakeChannels (the tests\' channels)', () => {
  it('plays until a test ends it, logs each play with its channel, file, bus and volume, and each sound cut short', () => {
    const ch = new FakeChannels();
    expect(ch.play(0, 'u:a', 'voice')).toBe(true);
    expect(ch.play(1, undefined, 'voice')).toBe(false);
    expect([ch.playing(0), ch.playing(1)]).toEqual([true, false]);
    ch.end(0);
    expect(ch.playing(0)).toBe(false);
    ch.play(3, 'u:b', 'sfx', 100);
    ch.play(3, 'u:c', 'sfx', 90);
    ch.stop(3);
    ch.stop(4);
    expect([ch.playing(3), ch.log, ch.cut]).toEqual([false, [[0, 'u:a', 'voice', 255], [3, 'u:b', 'sfx', 100], [3, 'u:c', 'sfx', 90]], [3, 3]]);
  });
});
