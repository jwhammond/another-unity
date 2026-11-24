// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattleContext, miniCombat, miniEnterpriseUnits } from '../../testing/combat';
import { combatDataProblems } from './data';

describe('combatDataProblems (what weapons and damage need from the lift)', () => {
  it('has none for a full lift', () => {
    expect(combatDataProblems(miniBattleContext())).toEqual([]);
  });

  it('lists the units without a depth, hit weight or efficiency, and the tables an older lift lacks', () => {
    const combat = miniCombat();
    delete combat.animations;
    delete combat.damageMaterials;
    delete combat.enemyUnits[4]!.depth;
    combat.phasers.enterprise.pop();
    combat.hitLists.other.pop();
    delete combat.models['phaser.3dv']!.vertices;
    const ctx = miniBattleContext({}, combat);
    const units = miniEnterpriseUnits();
    delete units[2]!.hitWeight;
    delete units[7]!.hitWeight;
    // (a malformed ship.yaml: the content schema refuses one without, Plan 23; the guard stays)
    delete (units[30] as { efficiency?: number }).efficiency;
    ctx.enterpriseUnits = units;
    expect(combatDataProblems(ctx)).toEqual([
      "the Enterprise's units 2, 7 have no hitWeight (ship.yaml from an older lift)",
      "the Enterprise's units 30 have no efficiency (ship.yaml from an older lift)",
      "the enemy template's units 4 have no depth (combat.yaml from an older lift)",
      'combat.yaml has no animations (lift with --images)',
      'combat.yaml has no damage materials (an older lift)',
      'combat.yaml has too few phaser banks (weapons.cpp:51-54)',
      'combat.yaml has too few hit lists (damage.cpp:36-53)',
      "combat.yaml's models phaser.3dv have no vertex counts (an older lift)",
    ]);
  });
});
