// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { COMBAT_CUE_NAMES, type CombatData } from '../../content/types';
import { CUE_IDS, miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { facing } from './aim';
import { applyCommand, updateLamps, DAMAGE_SEAMS, firePhasers, fireTorpedoes, phaserHit, STEP_TIME, updateBattle, WEAPON_SEAMS, type CombatCommand } from './index';

/**
 * kBearing, kShieldNames and the cue ids are read from combat.yaml (Plan 23 R1), not written in the code: a battle
 * fought over combat data with other values plays those values. The battle is fight.test.ts's scripted one.
 */
type Order = CombatCommand | 'chodak phasers' | 'chodak torpedoes';
const SCRIPT: Record<number, Order[]> = {
  1: [{ type: 'powerLevel', level: 4 }, { type: 'weaponsLock', on: true }, { type: 'spread', cell: 9 }],
  5: [{ type: 'fire', weapon: 'phasers' }],
  20: ['chodak phasers'],
  30: [{ type: 'fire', weapon: 'torpedoes' }, { type: 'allStop' }],
  45: ['chodak torpedoes'],
  90: [{ type: 'fire', weapon: 'both' }, { type: 'selfDestruct' }],
  150: [{ type: 'fire', weapon: 'both' }, { type: 'selfDestruct' }, 'chodak phasers'],
};

function fight(combat: CombatData): { cues: number[]; log: string[]; lamps: number[][] } {
  combat.battles[3]!.ships[1]!.position = [0, 4000, 0];
  const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }, combat) });
  const lamps: number[][] = [];
  for (let step = 0; step < 300; step++) {
    for (const order of SCRIPT[step] ?? []) {
      if (order === 'chodak phasers') firePhasers(ctx, b, b.ships[1]!);
      else if (order === 'chodak torpedoes') fireTorpedoes(ctx, b, b.ships[1]!, 0);
      else applyCommand(ctx, b, order);
    }
    updateBattle(ctx, b, b.lastStep + STEP_TIME);
    lamps.push([...b.console.lamps]);
  }
  return { cues: b.cues.map(c => c.cue), log: [...b.ships[0]!.log], lamps };
}

describe('the constants combat.yaml lifts (Plan 23 R1)', () => {
  it('plays each cue by its lifted id: ids moved by 0x300 move every cue the battle plays by 0x300', () => {
    const plain = fight(miniCombat());
    const moved = miniCombat();
    moved.cueIds = Object.fromEntries(COMBAT_CUE_NAMES.map(n => [n, CUE_IDS[n] + 0x300])) as CombatData['cueIds'];
    // (miniCombat's kinds have no contact or destroyed cue, and no AI names a target: every cue is a lifted id)
    expect(plain.cues.length).toBeGreaterThan(10);
    expect(fight(moved).cues).toEqual(plain.cues.map(c => c + 0x300));
  });

  it('names the Enterprise\'s shields by the lifted names, and lights the lamps by the lifted bearing', () => {
    const renamed = miniCombat();
    renamed.shieldNames = renamed.shieldNames.map(n => `${n}x`);
    const plain = fight(miniCombat());
    expect(plain.log.some(l => /^Shield S\d /.test(l))).toBe(true);
    expect(fight(renamed).log).toEqual(plain.log.map(l => l.replace(/^Shield (S\d) /, 'Shield $1x ').replace(/repelled by (S\d)$/, 'repelled by $1x')));
    expect(plain.lamps.some(row => row.includes(0))).toBe(true);
    const blind = miniCombat();
    blind.bearing = blind.bearing.map(() => [-1, -1, -1]);
    expect(fight(blind).lamps.some(row => row.includes(0))).toBe(false);
  });

  it('lights, for each facing of the target, exactly the lamps kBearing names (weapons.cpp:738-740), the rest not bearing', () => {
    // each row's lit lamps (the table's -1s are no lamp), by hand from kBearing
    const LIT = [[0, 2, 6], [1, 2, 6], [4], [1, 3, 7], [5], [1, 3, 7], [0, 3, 7], [1, 3, 7]];
    const { ctx, b } = miniBattle();
    const seen = new Set<number>();
    for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) for (let z = -4; z <= 4; z++) {
      const at = b.ships[0]!.pos;
      b.ships[1]!.pos = { x: at.x + x * 700 + 1, y: at.y + y * 700 + 2, z: at.z + z * 700 + 3 };
      const f = facing(b.ships[0]!, b.ships[1]!.pos);
      if (seen.has(f)) continue;
      seen.add(f);
      updateLamps(ctx, b);
      expect(b.console.targetFacing).toBe(f);
      expect(b.console.lamps.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => (LIT[f]!.includes(i) ? 0 : 2)));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('fails loudly, naming it, when the combat data lacks a cue id, a shield name or a bearing row', () => {
    const noCue = miniCombat();
    delete (noCue.cueIds as Partial<CombatData['cueIds']>).lockOn;
    const run = (combat: CombatData): void => {
      const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }, combat) });
      applyCommand(ctx, b, { type: 'weaponsLock', on: true });
      updateLamps(ctx, b);
      phaserHit(ctx, b, b.ships[0]!, 0, 100);
    };
    expect(() => run(noCue)).toThrow(/no cue id 'lockOn'/);
    const noName = miniCombat();
    noName.shieldNames = [];
    expect(() => run(noName)).toThrow(/no shield name 0/);
    const noRow = miniCombat();
    noRow.bearing = [];
    expect(() => run(noRow)).toThrow(/no bearing row \d/);
  });
});
