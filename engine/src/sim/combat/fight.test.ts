// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
// (through the barrel, as the game and the tools take them)
import {
  applyCommand, DAMAGE_SEAMS, firePhasers, fireTorpedoes, NO_SEAMS, STEP_TIME, updateBattle, WEAPON_SEAMS,
  type BattleContext, type BattleState, type CombatCommand,
} from './index';

/**
 * A whole battle with weapons and damage (Plans 19 and 20), scripted on miniCombat: the chodak 4000 ahead, facing
 * the Enterprise. There's no AI yet (Plan 21), so the script fires the chodak's weapons too. The pinned numbers are
 * this port's own (no ScummVM trace of a synthetic battle exists yet: Plan 22 makes the traces): a change to any
 * roll, its order or the maths moves them. Plan 22's parity suite compares real battles with ScummVM's traces.
 */
type Order = CombatCommand | 'chodak phasers' | 'chodak torpedoes';
const SCRIPT: Record<number, Order[]> = {
  1: [{ type: 'powerLevel', level: 4 }, { type: 'weaponsLock', on: true }],
  5: [{ type: 'fire', weapon: 'phasers' }],
  20: ['chodak phasers'],
  30: [{ type: 'fire', weapon: 'torpedoes' }],
  45: ['chodak torpedoes'],
  90: [{ type: 'fire', weapon: 'both' }, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 }],
  120: [{ type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 }, 'chodak phasers'],
  150: [{ type: 'fire', weapon: 'both' }],
  210: [{ type: 'fire', weapon: 'both' }, 'chodak torpedoes'],
  270: [{ type: 'fire', weapon: 'both' }],
  330: [{ type: 'fire', weapon: 'both' }, 'chodak phasers'],
};
const STEPS = 600;

function fight(): { ctx: BattleContext; b: BattleState } {
  const combat = miniCombat();
  combat.battles[3]!.ships[1]!.position = [0, 4000, 0];
  const ctx = miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }, combat);
  return miniBattle({ ctx });
}
function play(ctx: BattleContext, b: BattleState, from: number, to: number): void {
  for (let step = from; step < to; step++) {
    for (const order of SCRIPT[step] ?? []) {
      if (order === 'chodak phasers') firePhasers(ctx, b, b.ships[1]!);
      else if (order === 'chodak torpedoes') fireTorpedoes(ctx, b, b.ships[1]!, 0);
      else applyCommand(ctx, b, order);
    }
    updateBattle(ctx, b, b.lastStep + STEP_TIME);
  }
}

describe('a scripted battle with weapons and damage', () => {
  it('fights in a context whose seams are a fresh object over NO_SEAMS, WEAPON_SEAMS and DAMAGE_SEAMS, which stay frozen', () => {
    const { ctx, b } = fight();
    for (const input of [NO_SEAMS, WEAPON_SEAMS, DAMAGE_SEAMS]) {
      expect(ctx.seams).not.toBe(input);
      expect(Object.isFrozen(input)).toBe(true);
    }
    expect(ctx.seams).toEqual({ ...NO_SEAMS, ...WEAPON_SEAMS, ...DAMAGE_SEAMS });
    expect([ctx.seams.fireTorpedoes, ctx.seams.destroy]).toEqual([fireTorpedoes, DAMAGE_SEAMS.destroy]);
    play(ctx, b, 0, STEPS);
    expect(Object.isFrozen(ctx.seams)).toBe(false);
  });

  it('ends as it always has: the chodak destroyed and gone, by these rolls', () => {
    const { ctx, b } = fight();
    const sites: Record<string, number> = {};
    ctx.onDraw = site => { sites[site] = (sites[site] ?? 0) + 1; };
    play(ctx, b, 0, STEPS);
    const [e, chodak] = b.ships;
    expect([b.random.draws, b.exitCode, chodak!.destroyed, chodak!.removed, e!.destroyed, b.target, b.debris.length]).toEqual([324, 0xffff, true, true, false, null, 0]);
    expect(e!.log).toEqual([
      'Shields raised to 100%', 'Shield S1 holding at 74.21', 'Unit -Unit 21- damaged by concussion.', 'Shield S1 holding at 74.21',
      'Photon torpedo repelled by S1',
    ]);
    expect(chodak!.log).toEqual([
      'Shield -Unit 1- holding at 67.47', 'Unit -Unit 9- damaged by concussion.', 'Unit -Unit 6- damaged by concussion.', 'Unit -Unit 18- damaged by concussion.',
      'Unit -Unit 12- damaged by concussion.', 'Shield -Unit 1- holding at 23.99', 'Photon torpedo repelled by -Unit 1-', 'Photon penetration of deck 6.',
      'Unit -Unit 14- damaged by concussion.', 'Unit -Unit 17- damaged by photon blast.', 'Photon penetration of deck 2.', 'Unit -Unit 16- damaged by concussion.',
      'Unit -Unit 13- damaged by photon blast.', 'Photon penetration of ship core.', 'SHIP DESTROYED',
    ]);
    expect(e!.systems.units.map(u => u.damage).filter(d => d > 0)).toEqual([5]);
    expect(chodak!.systems.units.map(u => u.damage)).toEqual([0, 0, 0, 0, 0, 0, 4, 0, 0, 3, 0, 0, 3, 33, 4, 0, 3, 37, 3, 0]);
    // (how often each of ScummVM's call sites rolled)
    expect(sites).toEqual({
      'weapons.cpp:277': 1, 'weapons.cpp:283': 3, 'weapons.cpp:360': 101, 'weapons.cpp:408': 1, 'weapons.cpp:453': 39, 'weapons.cpp:459': 13,
      'weapons.cpp:460': 11, 'weapons.cpp:464': 13,
      'damage.cpp:109': 12, 'damage.cpp:128': 7, 'damage.cpp:175': 4, 'damage.cpp:207': 50, 'damage.cpp:280': 3, 'damage.cpp:295': 2, 'damage.cpp:324': 2,
      'damage.cpp:345': 1, 'damage.cpp:356': 1, 'damage.cpp:368': 1, 'damage.cpp:397': 2, 'damage.cpp:408': 1, 'damage.cpp:417': 2, 'damage.cpp:418': 2,
      'damage.cpp:431': 4, 'damage.cpp:505': 18, 'damage.cpp:507': 12, 'damage.cpp:508': 6, 'damage.cpp:509': 6, 'damage.cpp:576': 6,
    });
  });

  it('is the same battle run twice, and a copy taken midway goes on as the original does', () => {
    const one = fight(), two = fight();
    play(one.ctx, one.b, 0, STEPS);
    play(two.ctx, two.b, 0, 300);
    // (still fighting at the copy: the battle has not ended, so the steps after it do something)
    expect(two.b.exitCode).toBe(0xffff);
    const copy = structuredClone(two.b);
    play(two.ctx, two.b, 300, STEPS);
    play(two.ctx, copy, 300, STEPS);
    expect(two.b).toEqual(one.b);
    expect(copy).toEqual(one.b);
  });
});
