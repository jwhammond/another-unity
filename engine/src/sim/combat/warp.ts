// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipUnit } from '../../content/types';
import { UNIT_FUSION, UNIT_IMPULSE, UNIT_MATTER_ANTIMATTER, UNIT_POWER_GRID, UNIT_WARP, type UnitState } from '../shipSystems';
import { forward } from './aim';
import { alive, distance, logMessage } from './battle';
import { add, fr } from './math';
import { combatTicks } from './time';
import { isEnterprise, MAX_RANGE, cueId, playCue, unitDefs, type BattleContext, type BattleState, type CombatShip } from './types';

/**
 * The Enterprise's two ways out by warp (ai.cpp:205-300), which tactics' WARP and Worf's AI take: a jump across the
 * battle (warpAway), and back to astrogation for the nearer starbase (retreat).
 */

/** UnityEngine::kShipAstrogation (unity.h:328): the exit code retreat leaves by. */
export const ASTROGATION_EXIT = 4;
/** kDriveTypes and kReactorTypes (ai.cpp:219-220). */
const DRIVE_TYPES = [UNIT_WARP, UNIT_IMPULSE];
const REACTOR_TYPES = [UNIT_POWER_GRID, UNIT_FUSION, UNIT_MATTER_ANTIMATTER];
/** retreat's starbases, in astrogation's coordinates (ai.cpp:294-295), and the scripted warps to them, at warp speed 0x2da (ai.cpp:296). */
const STARBASES = [[38, 63, 25], [3, 90, 110]] as const;
const RETREAT_SPEED = 0x2da;

/** C's roundf: halves away from zero. */
const roundf = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** outputPercent (ai.cpp:205-217): the current of the units of these types, as a percentage of their max, rounded; 0 when either is 0. */
export function outputPercent(defs: readonly ShipUnit[], units: readonly UnitState[], types: readonly number[]): number {
  let current = 0, max = 0;
  units.forEach((u, i) => {
    const type = defs[i]?.type;
    if (type === undefined || !types.includes(type)) return;
    current += u.current;
    max += u.max;
  });
  // ((int)roundf(current * 100.0f / max))
  return current && max ? roundf(fr(fr(fr(current) * 100) / fr(max))) : 0;
}

/** unitsPercent (ai.cpp:269-277): the same over units first to last (those the ship has). */
export function unitsPercent(units: readonly UnitState[], first: number, last: number): number {
  let current = 0, max = 0;
  for (let i = first; i <= last && i < units.length; i++) {
    current += units[i]!.current;
    max += units[i]!.max;
  }
  return current && max ? roundf(fr(fr(fr(current) * 100) / fr(max))) : 0;
}

/** The cues as a warp fails (ai.cpp:235-236, 288-289): the second interrupts. */
function warpFailed(ctx: BattleContext, b: BattleState): void {
  playCue(b, cueId(ctx, 'warpFailed'), combatTicks(0x123));
  playCue(b, cueId(ctx, 'warpFailedAfter'), combatTicks(0x246), true);
}

/**
 * Combat::warpAway (ai.cpp:222-267): the Enterprise jumps ahead, if its engines and reactors are up to it (a quarter
 * of each, and both warp engines at 200): as far as they give, which drains the warp engines and the reactors. Far
 * enough from every enemy, red alert is over. Other ships don't.
 */
export function warpAway(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (!isEnterprise(ship)) return;
  const defs = unitDefs(ctx, ship);
  const units = ship.systems.units;
  const reactors = outputPercent(defs, units, REACTOR_TYPES);
  const drives = outputPercent(defs, units, DRIVE_TYPES);
  const warp = [0, 0];
  for (let i = 0, engines = 0; i < units.length && engines < 2; i++) {
    if (defs[i]?.type === UNIT_WARP) warp[engines++] = units[i]!.current;
  }
  if (reactors < 25 || drives < 25 || warp[0]! < 200 || warp[1]! < 200) {
    warpFailed(ctx, b);
    logMessage(ship, 'Warp engage failed.');
    if (reactors < 50) logMessage(ship, 'Combined reactor output inadequate.');
    if (drives < 50) logMessage(ship, 'Combined drive output inadequate.');
    return;
  }

  // (the cue as the Enterprise warps away: ai.cpp:245)
  playCue(b, cueId(ctx, 'warp'));
  ctx.seams.showWarp(ctx, b);
  const s = warp[0]! * 30 + warp[1]! * 30 + drives * 100 + reactors * 300;
  const d = fr(s + (s >> 2));
  // (pos + Vector3(sinf(a0) * cosf(a1), cosf(a0) * cosf(a1), sinf(a1)) * d, the angles as radians: aim.ts's forward,
  // rounded the same way; Vector3's operators are functions, so nothing is fused)
  // (forward masks the angles with & 0x3fff and ai.cpp:249-250 doesn't; moot, since every writer of a ship's angles
  // masks them (flight.ts, setup.ts, weapons.ts), so here they are always 0..0x3fff)
  ship.pos = add(ship.pos, forward(d, ship.angles[0], ship.angles[1]));
  // it takes everything the engines and reactors have
  units.forEach((u, i) => {
    const type = defs[i]?.type;
    if (type === UNIT_WARP || type === UNIT_POWER_GRID || type === UNIT_FUSION || type === UNIT_MATTER_ANTIMATTER) u.current = 0;
  });
  b.console.warped = true;
  // far enough away, the battle is over (110000.0f, kMaxRange written out: ai.cpp:262)
  let alone = true;
  for (let i = 1; i < b.ships.length; i++) {
    if (alive(b.ships[i]) && distance(ship, b.ships[i]!) <= MAX_RANGE) alone = false;
  }
  if (alone) b.console.redAlert = false;
}

/**
 * Combat::retreat (ai.cpp:279-300): the Enterprise leaves for astrogation, on course for the nearer of two starbases,
 * if it is not at red alert and its engines are up to it. The battle ends there (ASTROGATION_EXIT).
 */
export function retreat(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const units = ship.systems.units;
  // (the original checks units 15-19 and 27-28 as it does for other ships, which on the Enterprise are phasers, a
  // torpedo tube and the warp engines: ai.cpp:281-286. A quirk, kept; red alert refuses too, :285.)
  if (!isEnterprise(ship) || b.console.redAlert || unitsPercent(units, 17, 19) < 75 || unitsPercent(units, 15, 16) < 50 ||
      units.length < 29 || units[27]!.current < 750 || units[28]!.current < 750) {
    logMessage(ship, 'Warp engage failed.');
    warpFailed(ctx, b);
    return;
  }
  const [x, y, z] = ctx.seams.astrogationPosition(ctx, b);
  const [first, second] = STARBASES.map(([sx, sy, sz]) => (x - sx) * (x - sx) + (y - sy) * (y - sy) + (z - sz) * (z - sz));
  ctx.seams.scriptedWarp(ctx, b, first! > second! ? 1 : 0, RETREAT_SPEED);
  b.console.warped = true;
  b.console.redAlert = false;
  b.exitCode = ASTROGATION_EXIT;
}
