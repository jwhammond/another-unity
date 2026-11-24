// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../../content/types';
import { TACTIC } from '../../content/tactics';
import { alive, logMessage, shipTarget } from './battle';
import { component, setComponent, speedSubject, subjectShip } from './conditions';
import { cameraEvent } from './effects';
import { engage, rebuildManeuvers } from './maneuvers';
import { AXES, clip, fr, hex, length, sub } from './math';
import { tokenArg, tokenFloat, tokenOpcode, tokenText } from './script';
import { retreat, warpAway } from './warp';
import { isEnterprise, cueId, playCue, warn, type BattleContext, type BattleState, type CombatShip, type TacticScript } from './types';

/**
 * Tactics' verbs (tactics.cpp:721-921): what a DO token does, besides the stack's own (PUSH, POP, FLUSH, CLEAR and
 * RETURN, which the VM does: tactics.ts).
 */

/** A cloak until something decloaks it: 0xffffffff (tactics.cpp:868). */
const CLOAKED_FOR_GOOD = 0xffffffff;

/** operate (tactics.cpp:721-736): 10 sets, 11 adds, 12 subtracts, 13 multiplies, 14 divides (not by 0); anything else keeps. In float. */
export function operate(op: number, current: number, value: number): number {
  switch (op) {
    case 10: return fr(value);
    case 11: return fr(current + value);
    case 12: return fr(current - value);
    case 13: return fr(current * value);
    case 14: return value !== 0 ? fr(current / value) : current;
    default: return current;
  }
}

/**
 * Combat::verb (tactics.cpp:738-921): a DO token's verb.
 * - PRINT is ScummVM's debug output only.
 * - FIRE fires phasers or photons (not the Enterprise at a friend), through the weapons' seams.
 * - HEADING, CLIMB and BANK set how fast the ship turns on that axis (not where it heads), in whole numbers, -100 to 100.
 * - SPEED sets the target speed; POS moves the ship, WAY its waypoint (and watching a waypoint in free space is
 *   worth a camera cut); SYSTEM changes a unit's target or damage.
 * - DEBUG sets the trace; MESSAGE logs; ACQUIRE targets the first ship of a kind (any but the target); CLOAK cloaks
 *   or decloaks.
 * - MENU adds a heading to the Enterprise's maneuvers or removes one; ENGAGE locks, unlocks and engages
 *   (tactics.cpp:893-904); WARP warps the Enterprise away or retreats.
 * - STORY, BEARING and OPPOSE do nothing (tactics.cpp:913-916: no-ops in the original, kept).
 */
export function verb(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip, token: number): void {
  const arg = (k: number) => tokenArg(s, token, k);
  const target = shipTarget(b, ship);
  const opcode = tokenOpcode(s, token);
  switch (opcode) {
    case TACTIC.print:
      // (debug(1, "tactic: %s"): nothing the battle keeps)
      return;
    case TACTIC.fire:
      if (isEnterprise(ship) && target && (target.flags & SHIP_FLAGS.friendly)) return;
      if (arg(0) === TACTIC.phaser) ctx.seams.firePhasers(ctx, b, ship);
      else if (arg(0) === TACTIC.photon) ctx.seams.fireTorpedoes(ctx, b, ship, 0);
      return;
    case TACTIC.heading:
    case TACTIC.climb:
    case TACTIC.bank: {
      // (these set how fast the ship turns, not where it heads)
      const op = arg(0), axis = arg(1), subject = arg(2);
      let v = arg(3);
      if (axis < TACTIC.heading || axis > TACTIC.bank) {
        warn(ctx, 'tactic: unknown axis');
        return;
      }
      const k = axis - TACTIC.heading;
      if (subject && !v) {
        const other = subjectShip(b, ship, subject);
        v = other ? other.angles[k]! : 0;
      }
      if (subject < 0) v = -v | 0;
      const key = AXES[k]!;
      // (int32 current = (int32)*inputs[k], and int32 arithmetic)
      const current = Math.trunc(ship.controls[key]) | 0;
      let result: number;
      switch (op) {
        case 10: result = v; break;
        case 11: result = (current + v) | 0; break;
        case 12: result = (current - v) | 0; break;
        case 13: result = Math.imul(current, v); break;
        case 14: result = v ? Math.trunc(current / v) | 0 : current; break;
        case 15: result = current >> (v & 31); break;
        case 16: result = current << (v & 31); break;
        default: result = current;
      }
      ship.controls[key] = clip(result, -100, 100);
      return;
    }
    case TACTIC.speed:
      ship.targetSpeed = operate(arg(2), ship.targetSpeed, fr(speedSubject(b, ship, arg(1), arg(0))));
      return;
    case TACTIC.pos:
    case TACTIC.way: {
      const way = opcode === TACTIC.way;
      const subject = arg(1);
      if (way) {
        ship.waypointActive = true;
        const a = Math.abs(subject);
        if ((a === TACTIC.foe || a === TACTIC.target) && target && target.decloakTime) {
          ship.waypointActive = false;
          return;
        }
      }
      const k = arg(0) - 1;
      if (k < 0 || k > 2) return;
      let v = tokenFloat(s, token, 2);
      if (v === 0) {
        const other = subjectShip(b, ship, subject);
        v = other ? component(other.pos, k) : 0;
      }
      if (subject < 0) v = -v;
      const vector = way ? ship.waypoint : ship.pos;
      setComponent(vector, k, operate(arg(3), component(vector, k), v));
      if (way) {
        // a waypoint in free space is worth watching
        let inside = false;
        for (const other of b.ships) {
          if (!inside && alive(other) && length(sub(other.pos, ship.waypoint)) < fr(other.radius * 2)) inside = true;
        }
        if (!inside) cameraEvent(b, ship, 4);
      }
      return;
    }
    case TACTIC.system: {
      const id = arg(0), op = arg(3), v = arg(2);
      const unit = id >= 0 ? ship.systems.units[id] : undefined;
      if (!unit) return;
      // (int &field = ...; field = (int)operate(op, field, v))
      const field = arg(1) ? 'target' : 'damage';
      unit[field] = Math.trunc(operate(op, fr(unit[field]), fr(v))) | 0;
      return;
    }
    case TACTIC.debug:
      s.trace = arg(0);
      return;
    case TACTIC.message:
      logMessage(ship, tokenText(s, token, 0));
      return;
    case TACTIC.acquire:
      // (the first ship of the kind that isn't the target: any ship, the ship itself or a destroyed one included: tactics.cpp:854-861)
      for (const other of b.ships) {
        if (other.type === arg(0) >>> 0 && other !== target) {
          ship.target = other.index;
          break;
        }
      }
      return;
    case TACTIC.cloak:
      if (!arg(0)) {
        if (ship.decloakTime) ship.decloakTime = b.now;
      } else if (!ship.decloakTime && (ship.flags & SHIP_FLAGS.canCloak)) {
        // (until something tells it to decloak)
        ship.decloakTime = CLOAKED_FOR_GOOD;
        // (the cue as a ship cloaks: tactics.cpp:869)
        playCue(b, cueId(ctx, 'cloak'));
      }
      cameraEvent(b, ship, 5);
      return;
    case TACTIC.menu: {
      const menu = b.console.menu;
      if (!arg(3)) {
        // (a heading goes by its id, the Enterprise's script's MENU argument 1, whoever's script says so)
        const id = arg(1);
        const e = b.ships[0];
        for (let i = 0; i < menu.length; i++) {
          if (menu[i]!.heading && e?.script && tokenArg(e.script, menu[i]!.payload - 12, 1) === id) {
            menu.splice(i, 1);
            break;
          }
        }
      } else if (ship === b.ships[0]) {
        menu.push({ heading: true, open: false, payload: token + 12, label: tokenText(s, token, 3), buttons: [] });
      }
      rebuildManeuvers(b);
      return;
    }
    case TACTIC.engage: {
      const mode = arg(0);
      if (mode === 2) b.console.scriptLock = true;
      if (mode === 3) {
        if (b.console.scriptLock) b.console.kernelReady = true;
        b.console.scriptLock = false;
      }
      engage(ctx, b, mode);
      return;
    }
    case TACTIC.warp:
      if (isEnterprise(ship) && alive(ship) && !b.console.selfDestructTime) {
        if (arg(0) === 2) retreat(ctx, b, ship);
        else warpAway(ctx, b, ship);
      }
      return;
    case TACTIC.story:
    case TACTIC.bearing:
    case TACTIC.oppose:
      // (no-ops in the original: tactics.cpp:913-916, kept)
      return;
    default:
      warn(ctx, `tactic: unknown verb ${hex(opcode)}`);
  }
}
