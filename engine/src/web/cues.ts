// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent } from '../content/types';
import type { SimEvent } from '../sim/events';

/**
 * The original hard-codes a chirp at the end of a condition check while the tricorder is the action's
 * other object (object.cpp:1277-1279; carry note 35). Reachable in Horst III: o_070103's use group 0.
 */
export function tricorderCue(e: SimEvent, content: GameContent): boolean {
  return e.type === 'conditionPassed' && e.other !== null && e.other === content.rules.items.tricorder;
}
