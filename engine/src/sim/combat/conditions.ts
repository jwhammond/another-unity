// SPDX-License-Identifier: GPL-3.0-or-later
import { TACTIC } from '../../content/tactics';
import { distance, shipTarget } from './battle';
import { roll } from './effects';
import { fr, length, sub, type V3 } from './math';
import { setTokenArg, tokenArg, tokenFloat, tokenOpcode } from './script';
import { SHIP_STATE, type BattleContext, type BattleState, type CombatShip, type TacticScript } from './types';

/**
 * Tactics' conditions (tactics.cpp:558-719): what a WHEN tests, and the helpers the verbs share with them.
 */

/**
 * compare (tactics.cpp:558-575): 1 >, 2 >=, 3 ==, 4 <, 5 <=, 6 !=; any other relation is false.
 * It takes floats, so an int argument (SYSTEM's, SPEED's literal) is rounded to float first: 2^24 + 1 == 2^24.
 */
export function compareRelation(relation: number, a: number, b: number): boolean {
  a = fr(a);
  b = fr(b);
  switch (relation) {
    case 1: return a > b;
    case 2: return a >= b;
    case 3: return a === b;
    case 4: return a < b;
    case 5: return a <= b;
    case 6: return a !== b;
    default: return false;
  }
}

/** subjectShip (tactics.cpp:577-585): FRIEND is the ship itself, FOE or TARGET its target (either sign); anything else, none. */
export function subjectShip(b: BattleState, ship: CombatShip, subject: number): CombatShip | null {
  const a = Math.abs(subject);
  if (a === TACTIC.friend) return ship;
  if (a === TACTIC.foe || a === TACTIC.target) return shipTarget(b, ship);
  return null;
}

/** component and setComponent (tactics.cpp:587-598): x, y, or anything else z. */
export function component(v: V3, k: number): number {
  return k === 0 ? v.x : k === 1 ? v.y : v.z;
}
export function setComponent(v: V3, k: number, value: number): void {
  if (k === 0) v.x = value;
  else if (k === 1) v.y = value;
  else v.z = value;
}

/** speedSubject (tactics.cpp:600-610): the literal, or a subject's target speed truncated; negated for a negative subject. An int. */
export function speedSubject(b: BattleState, ship: CombatShip, subject: number, literal: number): number {
  let v: number;
  if (subject === 0) {
    v = literal;
  } else {
    const other = subjectShip(b, ship, subject);
    v = other ? Math.trunc(other.targetSpeed) | 0 : 0;
  }
  // (int: never -0)
  return subject < 0 ? -v | 0 : v;
}

/** (float)0.0005, WAY's tolerance for == and != (tactics.cpp:669-672). */
const TOLERANCE = fr(0.0005);

/**
 * Combat::condition (tactics.cpp:612-719): whether a WHEN token's condition holds now.
 * - FIRED: the ship has been fired on.
 * - DELTA: a timer, its deadline kept in the token itself (the ship's own copy), in the original's 291 ticks a second.
 * - PROXIMITY: the distance to the target (with none, infinitely far).
 * - SPEED: the target speed against a literal or a subject's.
 * - WAY: the distance to the waypoint, by an axis, the largest or smallest, or all (X compares garbage in the original: false).
 * - HEADING, CLIMB and BANK: an angle against a literal or a subject's.
 * - POS: a coordinate against a literal or a subject's.
 * - SYSTEM: a unit's target or damage.
 * - RANDOM: a roll of 1 in rnd(n), which draws whether or not it holds (tactics.cpp:715).
 */
export function condition(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip, when: number): boolean {
  const arg = (k: number) => tokenArg(s, when, k);
  switch (tokenOpcode(s, when)) {
    case TACTIC.fired:
      return (ship.flags & SHIP_STATE.firedUpon) !== 0;
    case TACTIC.delta: {
      // (the deadline is kept in the token: (uint32)((uint64)_now * 291 / 1000))
      const now = Math.trunc((b.now * 291) / 1000) >>> 0;
      if (!arg(1)) setTokenArg(s, when, 1, now + arg(0));
      if (arg(1) >>> 0 <= now) {
        setTokenArg(s, when, 1, 0);
        return true;
      }
      return false;
    }
    case TACTIC.proximity: {
      const relation = arg(0);
      if (relation < 1 || relation > 5) return false;
      // (with no target, it's infinitely far away)
      const target = shipTarget(b, ship);
      if (!target) return relation === 1 || relation === 2;
      return compareRelation(relation, distance(ship, target), tokenFloat(s, when, 1));
    }
    case TACTIC.speed: {
      const relation = arg(2);
      if (relation < 1 || relation > 5) return false;
      return compareRelation(relation, ship.targetSpeed, speedSubject(b, ship, arg(1), arg(0)));
    }
    case TACTIC.way: {
      if (!ship.waypointActive) return false;
      const d = sub(ship.pos, ship.waypoint);
      const dx = Math.abs(d.x), dy = Math.abs(d.y), dz = Math.abs(d.z);
      const value = tokenFloat(s, when, 2);
      let measured: number;
      switch (arg(0)) {
        case 2: measured = dy; break;
        case 3: measured = dz; break;
        case 4: measured = Math.max(dx, dy, dz); break;
        case 5: measured = Math.min(dx, dy, dz); break;
        case 6: measured = length(d); break;
        // (X compares garbage in the original: tactics.cpp:664-666, kept as ScummVM has it)
        default: return false;
      }
      const relation = arg(3);
      if (relation === 3) return fr(value - TOLERANCE) < measured && measured < fr(value + TOLERANCE);
      if (relation === 6) return measured <= fr(value - TOLERANCE) || measured >= fr(value + TOLERANCE);
      return compareRelation(relation, measured, value);
    }
    case TACTIC.heading:
    case TACTIC.climb:
    case TACTIC.bank: {
      const axis = arg(1);
      if (axis < TACTIC.heading || axis > TACTIC.bank) return false;
      const k = axis - TACTIC.heading;
      const subject = arg(2);
      let v = arg(3);
      if (subject && !v) {
        const other = subjectShip(b, ship, subject);
        v = other ? other.angles[k]! : 0;
      }
      if (subject < 0) v = -v | 0;
      const relation = arg(0);
      return relation >= 1 && relation <= 5 && compareRelation(relation, ship.angles[k]!, v);
    }
    case TACTIC.pos: {
      const k = arg(0) - 1;
      if (k < 0 || k > 2) return false;
      const subject = arg(1);
      let v = tokenFloat(s, when, 2);
      if (v === 0) {
        const other = subjectShip(b, ship, subject);
        v = other ? component(other.pos, k) : 0;
      }
      if (subject < 0) v = -v;
      return compareRelation(arg(3), component(ship.pos, k), v);
    }
    case TACTIC.system: {
      const id = arg(0);
      const unit = id >= 0 ? ship.systems.units[id] : undefined;
      if (!unit) return false;
      return compareRelation(arg(3), arg(1) ? unit.target : unit.damage, arg(2));
    }
    case TACTIC.random:
      return roll(ctx, b, arg(0), 'tactics.cpp:715') === 1;
    default:
      return false;
  }
}
