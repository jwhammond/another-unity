// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { v3 } from '../sim/combat/math';
import { miniBattle } from '../testing/combat';
import { combatScene } from './combatScene';

describe('combatScene (the top-down debug view)', () => {
  it('fits the ships, at least 2000 units each way and a tenth more, x to the right and forward up', () => {
    const { b } = miniBattle();
    const scene = combatScene(b, 440, 440);
    expect(scene.scale).toBeCloseTo(0.1, 9);
    const [e, chodak] = scene.ships;
    expect([e!.x, e!.y, chodak!.x, chodak!.y]).toEqual([170, 220, 270, 220]);
    // (heading 0 points up the canvas; the chodak's 180 degrees, down)
    expect([e!.hx, e!.hy]).toEqual([0, -1]);
    expect(chodak!.hx).toBeCloseTo(0, 6);
    expect(chodak!.hy).toBeCloseTo(1, 6);
    expect([e!.colour, chodak!.colour, chodak!.target, e!.target]).toEqual(['#6cf', '#f66', true, false]);
    expect(scene.range).toEqual({ x: 170, y: 220, r: 11000 });
  });

  it('draws torpedoes in flight and active beams to the target, and leaves out removed ships', () => {
    const { b } = miniBattle();
    Object.assign(b.torpedoes[0]!, { active: true, pos: v3(500, 1000, 0) });
    const bank = { unit: 8, offset: v3(), active: true, miss: false, missOffset: v3(), endTime: 0, lastUpdate: 0, beam: { frames: null, frame: 0, frameTime: 0, lastFrame: 0 }, charge: 0, setting: 100, savedSetting: 0, tip: v3() };
    b.ships[1]!.banks = [bank, { ...bank, active: false }];
    const scene = combatScene(b, 440, 440);
    expect(scene.torpedoes).toEqual([{ x: 220, y: 170, enterprise: false }]);
    expect(scene.beams).toEqual([{ from: { x: 270, y: 270 }, to: { x: 170, y: 270 }, miss: false }]);
    b.ships[1]!.removed = true;
    expect(combatScene(b, 440, 440).ships.map(s => s.index)).toEqual([0]);
  });

  it('draws a beam to its tip, explosions growing by frame, shield flashes with their impact, and fading debris', () => {
    const { b } = miniBattle();
    const [e, chodak] = b.ships;
    // (the tip, in the model's axes, is (end - start): 1000 right and 0 forward of the Enterprise is (1000, 0, 0))
    e!.banks = [{ unit: 13, offset: v3(), active: true, miss: true, missOffset: v3(), endTime: 0, lastUpdate: 0, beam: { frames: null, frame: 0, frameTime: 0, lastFrame: 0 }, charge: 0, setting: 100, savedSetting: 0, tip: v3(1000, 0, 0) }];
    chodak!.explosion = { frames: '1_boom.spr', frame: 3, frameTime: 103, lastFrame: 0 };
    Object.assign(chodak!, { shieldFlash: { frames: '__shield.spr', frame: 0, frameTime: 247, lastFrame: 0 }, shieldImpact: v3(1000, -200, 0) });
    b.debris.push({ ship: 1, scale: 1, alpha: 0x2000, fadeTime: 0, removeTime: 0, pieces: [{
      model: null, pos: v3(500, 0, 0), velocity: v3(), angles: [0, 0, 0], rates: [0, 0, 0], boom: { frames: '2_boom.spr', frame: 2, frameTime: 103, lastFrame: 0 }, boomTime: 0, boomStarted: true,
    }] });
    const scene = combatScene(b, 440, 440);
    // (scale 0.1, the centre (500, 0))
    expect(scene.beams).toEqual([{ from: { x: 170, y: 220 }, to: { x: 270, y: 220 }, miss: true }]);
    expect(scene.explosions).toEqual([{ x: 270, y: 220, r: 12 }, { x: 220, y: 220, r: 5 }]);
    expect(scene.shields).toEqual([{ x: 270, y: 220, r: 20, impact: { x: 270, y: 240 } }]);
    expect(scene.debris).toEqual([{ x: 220, y: 220, alpha: 0.5 }]);
  });
});
