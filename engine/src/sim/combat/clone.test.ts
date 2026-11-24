// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, miniEnterpriseSystems, miniTacticsCombat } from '../../testing/combat';
import { newSystems } from '../shipSystems';
import { updateBattle } from './battle';
import { cloneBattle, copyBattle, restoreBattle } from './clone';
import { applyCommand } from './commands';
import { SIM_SEAMS } from './seams';
import { STEP_TIME } from './time';
import type { BattleContext, BattleState } from './types';

function run(ctx: BattleContext, b: BattleState, steps: number): void {
  for (let i = 0; i < steps; i++) updateBattle(ctx, b, b.lastStep + STEP_TIME);
}

describe('copying a battle and putting it back (Plan 23 R7)', () => {
  it('puts a copy back in place, keeping the world\'s systems object, so the battle runs on as it ran the first time', () => {
    const ctx = miniBattleContext({ ...SIM_SEAMS }, miniTacticsCombat());
    const systems = miniEnterpriseSystems();
    const { b } = miniBattle({ ctx });
    b.ships[0]!.systems = systems;
    applyCommand(ctx, b, { type: 'delegate', on: true });
    run(ctx, b, 30);
    const copy = copyBattle(b);
    run(ctx, b, 200);
    const first = structuredClone(b);
    expect(first).not.toEqual(copy);
    restoreBattle(b, copy);
    expect(b).toEqual(copy);
    expect(b.ships[0]!.systems).toBe(systems);
    expect(systems).toEqual(copy.ships[0]!.systems);
    run(ctx, b, 200);
    expect(b).toEqual(first);
    expect(b.ships[0]!.systems).toBe(systems);
  });

  it('drops a key the battle gained since the copy, so a restore leaves nothing stale', () => {
    const { b } = miniBattle();
    const copy = copyBattle(b);
    (b as unknown as Record<string, unknown>).stale = 1;
    restoreBattle(b, copy);
    expect('stale' in b).toBe(false);
    expect(b).toEqual(copy);
  });

  it('links a clone to the systems it is given, and leaves the original\'s alone', () => {
    const { b } = miniBattle();
    const original = b.ships[0]!.systems;
    const mine = newSystems(undefined);
    const clone = cloneBattle(b, mine);
    expect(clone.ships[0]!.systems).toBe(mine);
    expect(mine).toEqual(original);
    clone.ships[0]!.systems.units[0]!.current = -5;
    expect(original.units[0]!.current).not.toBe(-5);
  });
});
