// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CombatCue } from '../content/types';
import { FakeChannels } from '../testing/sound';
import { AssetIndex } from '../view/assets';
import { effectPan } from '../audio/effects';
import { audioUrl, BattleSound } from './battleSound';

/** Made-up cues: 0 speaker 4's line, 1 an effect's (speaker 8), 2 speaker 2's line. */
const CUES: CombatCue[] = [{ speaker: 4, file: 'a.vac', gap: 0 }, { speaker: 8, file: 'b.mac', gap: 0 }, { speaker: 2, file: 'c.vac', gap: 0 }];

function setup(threeD = true) {
  const ch = new FakeChannels();
  const preloaded: string[][] = [];
  const sound = new BattleSound(ch, {
    threeD: () => threeD,
    cues: () => CUES,
    sounds: () => ['boom.mac', 'gone.mac'],
    url: file => (file.startsWith('gone') ? undefined : `u:${file}`),
    computerOn: () => true,
    preload: urls => preloaded.push(urls),
  });
  return { ch, sound, preloaded };
}
const frame = (now: number, o: Partial<Parameters<BattleSound['frame']>[0]> = {}) => ({ now, silenced: false, cues: [], sounds: [], ...o });

describe('the battle\'s sound in the game (Plan 28)', () => {
  it('finds a cue\'s or an effect\'s file in the game\'s audio: a .vac a voice line, the rest effects; none for a file the game lacks', () => {
    const assets = new AssetIndex([['audio/voice/line1.opus', 'u:line1'], ['audio/sfx/boom.opus', 'u:boom']]);
    expect([audioUrl(assets, 'LINE1.VAC'), audioUrl(assets, 'boom.mac'), audioUrl(assets, 'gone.mac'), audioUrl(assets, 'boom.vac')]).toEqual(['u:line1', 'u:boom', undefined, undefined]);
  });

  it('takes a frame\'s cues and effects in order, then runs the cues\' update at the frame\'s clock (tactical.cpp:474)', () => {
    const { ch, sound } = setup();
    sound.frame(frame(1000, {
      cues: [{ cue: 0, delay: 0, interrupt: false }, { cue: 2, delay: 498, interrupt: false }, { cue: 1, delay: 0, interrupt: false, after: true }],
      sounds: [{ sound: 'boom.mac', ship: 1, distance: 1300 }, { sound: 'gone.mac', ship: null, distance: 0 }],
    }));
    // (cue 0 now; cue 2 at 1498; cue 1 chained to channel 0. The boom at 1300 from the camera, 216; the sound the game lacks plays nothing)
    expect(ch.log).toEqual([[0, 'u:a.vac', 'voice', 255], [3, 'u:boom.mac', 'sfx', 216]]);
    sound.frame(frame(1497));
    expect(ch.log).toHaveLength(2);
    sound.frame(frame(1498));
    expect(ch.log.at(-1)).toEqual([1, 'u:c.vac', 'voice', 255]);
    ch.end(0);
    sound.frame(frame(1564));
    expect(ch.log.at(-1)).toEqual([0, 'u:b.mac', 'sfx', 255]);
    expect(sound.state()).toEqual({ channels: [true, true, false, true, false, false, false, false], silenced: false });
  });

  it('falls silent at the first request made after the Enterprise is lost, in the frame\'s order, and from a frame that says so (damage.cpp:534; cues.cpp:60-63, 132-133)', () => {
    const { ch, sound } = setup();
    sound.frame(frame(1000, { cues: [{ cue: 0, delay: 0, interrupt: false }, { cue: 2, delay: 0, interrupt: false, silenced: true }, { cue: 1, delay: 0, interrupt: false, silenced: true }] }));
    // (cue 0 was asked for before the loss, and plays; cue 2 after, and doesn't; cue 1 is speaker 8's, which still plays)
    expect(ch.log.map(([c, url]) => [c, url])).toEqual([[0, 'u:a.vac'], [1, 'u:b.mac']]);
    expect(sound.state().silenced).toBe(true);
    // (a later cue asked for before a loss in a frame with no request after it: the frame's flag silences the update)
    const quiet = setup();
    quiet.sound.frame(frame(1000, { cues: [{ cue: 2, delay: 100, interrupt: false }] }));
    quiet.sound.frame(frame(1200, { silenced: true }));
    expect(quiet.ch.log).toEqual([]);
  });

  it('starts the crew afresh as a battle starts, loading its effect sounds, and stops the cue channels as it ends, the effects ringing on (tactical.cpp:302, 361; cues.cpp:41-52)', () => {
    const { ch, sound, preloaded } = setup();
    sound.combat(true);
    expect(preloaded).toEqual([['u:boom.mac']]);
    sound.frame(frame(1000, { silenced: true, cues: [{ cue: 1, delay: 0, interrupt: false }], sounds: [{ sound: 'boom.mac', ship: 0, distance: 0 }] }));
    sound.frame(frame(1000, { cues: [{ cue: 0, delay: 0, interrupt: false, silenced: true }] }));
    expect(sound.state()).toEqual({ channels: [true, false, false, true, false, false, false, false], silenced: true });
    sound.combat(false);
    expect([ch.cut, sound.state()]).toEqual([[0], { channels: [false, false, false, true, false, false, false, false], silenced: false }]);
    expect(preloaded).toHaveLength(1);
  });

  it('starts the crew afresh after auto-resolve: the later cues forgotten, the cue channels stopped, the effects ringing on (Plan 28 final review; §6.3)', () => {
    const { ch, sound } = setup();
    sound.frame(frame(1000, { cues: [{ cue: 0, delay: 0, interrupt: false }, { cue: 2, delay: 100, interrupt: false }], sounds: [{ sound: 'boom.mac', ship: 0, distance: 0 }] }));
    sound.autoResolved();
    expect(sound.state()).toEqual({ channels: [false, false, false, true, false, false, false, false], silenced: false });
    // (the battle's clock well past the later cue's 1100: nothing plays)
    const heard = ch.log.length;
    sound.frame(frame(90000));
    expect(ch.log).toHaveLength(heard);
  });

  it('lists the effect and cue files it preloaded or played, none the game lacks (Plan 34)', () => {
    const { sound } = setup();
    expect(sound.urls()).toEqual([]);
    sound.combat(true);
    sound.frame(frame(1000, { cues: [{ cue: 0, delay: 0, interrupt: false }], sounds: [{ sound: 'boom.mac', ship: 0, distance: 0 }] }));
    expect(sound.urls().sort()).toEqual(['u:a.vac', 'u:boom.mac']);
  });

  it('with 3D sound off a combat effect plays through no panner, at the original\'s distance volume', () => {
    const { ch, sound } = setup(false);
    sound.frame(frame(1000, { sounds: [{ sound: 'boom.mac', ship: 1, distance: 1300, bearing: Math.PI / 2 }, { sound: 'boom.mac', ship: null, distance: 0 }] }));
    // (no pan handed on, so MixerChannels asks the mixer for none: Mixer.play makes a panner only for a pan)
    expect(ch.log).toEqual([[3, 'u:boom.mac', 'sfx', 216], [4, 'u:boom.mac', 'sfx', 255]]);
  });

  it('with 3D sound on, an effect is panned by its source\'s bearing; one at the camera, and the crew\'s cues, are not', () => {
    const { ch, sound } = setup(true);
    sound.frame(frame(1000, {
      cues: [{ cue: 0, delay: 0, interrupt: false }],
      sounds: [
        { sound: 'boom.mac', ship: 1, distance: 1300, bearing: Math.PI / 2 },
        { sound: 'boom.mac', ship: 2, distance: 1300, bearing: -Math.PI / 6 },
        { sound: 'boom.mac', ship: 0, distance: 0, bearing: 0 },
        { sound: 'boom.mac', ship: null, distance: 0 },
      ],
    }));
    expect(ch.log).toEqual([
      [0, 'u:a.vac', 'voice', 255],
      [3, 'u:boom.mac', 'sfx', 216, effectPan(Math.PI / 2)],
      [4, 'u:boom.mac', 'sfx', 216, effectPan(-Math.PI / 6)],
      [5, 'u:boom.mac', 'sfx', 255, 0],
      [6, 'u:boom.mac', 'sfx', 255],
    ]);
    expect(effectPan(-Math.PI / 6)).toBeCloseTo(-0.3, 12);
  });
});
