// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SIM_SEAMS } from '../../sim/combat/seams';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { cameraPose, stepFraction } from './draw';
import { PREVIEW_TURN_MS, previewBattle, turnPreview } from './optionsPreview';

describe('the Combat Options\' preview battle (Plan 32 Task 11)', () => {
  it('is the Enterprise alone, at the origin, no beams, shield or explosion, no target, at the step\'s end, before a still camera; the battle is untouched', () => {
    const { b } = miniBattle({ ctx: miniBattleContext({ ...SIM_SEAMS }) });
    const e = b.ships[0]!;
    e.banks[0]!.active = true;
    const before = JSON.stringify(b);
    const p = previewBattle(b, miniCombat())!;
    expect(JSON.stringify(b)).toBe(before);
    expect(p.ships.length).toBe(1);
    expect(p.ships[0]!.models).toBe(e.models);
    expect(p.ships[0]!.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.ships[0]!.banks.some(bank => bank.active)).toBe(false);
    expect([p.ships[0]!.shieldFlash.frames, p.ships[0]!.explosion.frames, p.ships[0]!.target, p.target]).toEqual([null, null, null, null]);
    expect([p.torpedoes, p.debris]).toEqual([[], []]);
    expect(stepFraction(p, false)).toBe(1);
    const cam = cameraPose(p, 1);
    expect(cam.pos.x).toBe(0);
    expect(cam.pos.z).toBeLessThan(0);
  });

  it('turns once in PREVIEW_TURN_MS, or holds still', () => {
    const { b } = miniBattle();
    const p = previewBattle(b, miniCombat())!;
    turnPreview(p, 0);
    const a = p.ships[0]!.angles[0];
    turnPreview(p, PREVIEW_TURN_MS / 4);
    expect(p.ships[0]!.angles[0] - a).toBe(4096);
    turnPreview(p, PREVIEW_TURN_MS);
    expect(p.ships[0]!.angles[0]).toBe(a);
    turnPreview(p, 1234, true);
    const still = p.ships[0]!.angles[0];
    turnPreview(p, 5678, true);
    expect(p.ships[0]!.angles[0]).toBe(still);
  });
});
