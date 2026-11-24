// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipUnit } from '../../content/types';
import type { BattleContext } from './types';

/** The unit fields weapons and damage read that a lift before Plan 20 (depth) or Plan 18 (efficiency, hitWeight) lacks. */
const UNIT_FIELDS = ['depth', 'hitWeight', 'efficiency'] as const;

/**
 * What weapons.cpp's and damage.cpp's ports need from the lift that an older lift may lack (Plan 18's and Plan 19's
 * follow-ups): each unit's depth, hit weight and efficiency (pickUnit, damage.cpp:93-122; tickReactors,
 * ship.cpp:142), the effects' frame counts, the damage materials, the models' vertex counts (updateBeams' tip,
 * weapons.cpp:378-379), and ScummVM's tables at full length (six Enterprise phaser banks and two for the others,
 * weapons.cpp:51-54, 112; eight Enterprise hit lists and six for the others, damage.cpp:36-53). Empty when the
 * battle can be fought; setupWeapons refuses a battle otherwise.
 */
export function combatDataProblems(ctx: BattleContext): string[] {
  const problems: string[] = [];
  const units = (who: string, defs: readonly ShipUnit[], where: string) => {
    for (const field of UNIT_FIELDS) {
      const missing = defs.flatMap((u, i) => (typeof u[field] === 'number' ? [] : [i]));
      if (missing.length > 0) problems.push(`${who}'s units ${missing.join(', ')} have no ${field} (${where} from an older lift)`);
    }
  };
  units('the Enterprise', ctx.enterpriseUnits, 'ship.yaml');
  units('the enemy template', ctx.combat.enemyUnits, 'combat.yaml');
  const c = ctx.combat;
  if (!c.animations) problems.push('combat.yaml has no animations (lift with --images)');
  if (!c.damageMaterials) problems.push('combat.yaml has no damage materials (an older lift)');
  if (c.phasers.enterprise.length < 6 || c.phasers.other.length < 2) problems.push('combat.yaml has too few phaser banks (weapons.cpp:51-54)');
  if (c.hitLists.enterprise.length < 8 || c.hitLists.other.length < 6) problems.push('combat.yaml has too few hit lists (damage.cpp:36-53)');
  const uncounted = Object.keys(c.models).filter(key => !c.models[key]!.vertices);
  if (uncounted.length > 0) problems.push(`combat.yaml's models ${uncounted.join(', ')} have no vertex counts (an older lift)`);
  return problems;
}
