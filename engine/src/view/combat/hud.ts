// SPDX-License-Identifier: GPL-3.0-or-later
import { facing } from '../../sim/combat/aim';
import type { BattleSpeed } from '../../sim/combat/assists';
import { distance } from '../../sim/combat/battle';
import { bindLibm, fr, MATH_LIBM } from '../../sim/combat/math';
import { trigTables } from '../../sim/combat/libm';
import { KIND } from '../../sim/combat/types';
import { cFormat, PAGE, selfDestructText, type ConsoleArt } from './console';
import { FACING_SHIELDS, scannerBlank, type ScannerSource } from './scanner';

/**
 * The wide view's slim HUD (M8 spec §5.2; Plan 27 R10): what it shows, read from the battle as the console reads it. The modern
 * view's own, not the original's (its Full keeps the console's lower half under a 640 x 276 band): the Enterprise's shields by
 * facing and its hull, its speed and the battle's pace, the target (its class, range and the shield it turns to us), the log's
 * last three lines, the lamps, and the self-destruct's count when armed. Pure.
 */

export interface HudTarget {
  /** Its class (combat.yaml's className), or the console's word for an unknown chodak or probe (drawScanner's rule, tactical.cpp:1206-1208). */
  name: string;
  /** As the scanner's range field: the distance x 27, whole. */
  range: number;
  /** The shield it turns to the Enterprise, and that shield's power in the scanner's unit (units / 1.334, two places). */
  shield: { name: string; power: string } | null;
}

export interface HudModel {
  /** The Enterprise's condition, percent. */
  hull: number;
  /** Its eight shields by facing: the console's names (combat.yaml's shieldNames) and each one's power over its most, 0 to 1. */
  shields: { name: string; level: number }[];
  /** Its speed as the status field writes it (`%.2f` of speed / 1000). */
  speed: string;
  /** The battle's pace: paused, or its speed (spec §5's fast-forward). */
  pace: 'paused' | BattleSpeed;
  target: HudTarget | null;
  /** There is a target, but the sensors read nothing (console.sensorsBlank, tactical.cpp:1166-1167): the HUD says so where the target goes (Plan 29 R13). */
  sensorsBlank: boolean;
  /** The Enterprise's log's last three lines, the newest last. */
  log: string[];
  /** updateLamps' eight: 0 bears on the target, 1 damaged, 2 doesn't bear (weapons.cpp:731-750). */
  lamps: number[];
  /** The self-destruct's count as CONN's digits show it, or null when it isn't armed. */
  selfDestruct: string | null;
}

/** The HUD for the battle now (the target's facing read with the battle's trig table, bound and put back). */
export function hudModel(s: ScannerSource, art: Pick<ConsoleArt, 'text'> | null, pace: HudModel['pace']): HudModel {
  const { b, combat } = s;
  const e = b.ships[0];
  const units = e?.systems.units ?? [];
  const shields = combat.shieldNames.map((name, i) => {
    const u = units[i];
    return { name, level: u && u.max ? Math.min(1, Math.max(0, u.current / u.max)) : 0 };
  });
  const t = b.target === null ? null : b.ships[b.target] ?? null;
  let target: HudTarget | null = null;
  // (as the sensors page shows it: nothing when it's blank, so no target while the sensors read nothing, tactical.cpp:1166-1167)
  if (e && t && !scannerBlank(b, PAGE.sensors)) {
    const trig = trigTables(combat);
    const was = bindLibm(trig ? { sin: trig.sin, cos: trig.cos, angle: null } : MATH_LIBM);
    try {
      const unknown = !b.contactCues && (t.type === KIND.chodak || t.type === KIND.probe);
      const shield = FACING_SHIELDS[facing(t, e.pos)]!;
      const unit = t.systems.units[shield];
      target = {
        name: unknown ? art?.text?.alien ?? '' : combat.kinds[t.type]?.className ?? '',
        range: Math.trunc(fr(distance(t, e) * 27)),
        shield: unit ? { name: combat.enemyUnits[shield]?.name ?? '', power: cFormat('%.2f', unit.current / 1.334) } : null,
      };
    } finally {
      bindLibm(was);
    }
  }
  return {
    hull: e?.condition ?? 0,
    shields,
    speed: cFormat('%.2f', e ? e.speed / 1000 : 0),
    pace,
    target,
    sensorsBlank: b.target !== null && b.console.sensorsBlank,
    log: (e?.log ?? []).slice(-3),
    lamps: [...b.console.lamps],
    selfDestruct: b.console.selfDestructTime ? selfDestructText(b.console.selfDestructTime, b.now) : null,
  };
}

/** Under this height (CSS px) a battle opens wide, with the console as a drawer (M8 spec Decision 16). */
export const PHONE_HEIGHT = 560;
