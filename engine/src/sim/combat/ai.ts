// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../../content/types';
import { UNIT_ALL, setUnitsDamage } from '../shipSystems';
import { facing } from './aim';
import { alive, battleTarget, distance, liveShips, logMessage, setView, shipTarget, VIEW } from './battle';
import { setTarget } from './commands';
import { roll } from './effects';
import { kernelJump } from './maneuvers';
import { clip, sub, v3 } from './math';
import { avoidCollision, directionTo, filterInputs, steerTowards } from './steering';
import { runScript } from './tactics';
import { combatTicks } from './time';
import { warpAway } from './warp';
import {
  isEnterprise, KIND, cueId, playCue, playCueAfter, SHIP_STATE, unitDefs,
  type BattleContext, type BattleState, type CombatSeams, type CombatShip,
} from './types';

/**
 * The AI (ai.cpp:133-502): how every ship but the Enterprise fights, and how Worf fights for it under Delegate;
 * targets, ramming and evading, a crippled ship's self-destruct, the starbase's repairs, and Delegate itself. How it
 * flies is steering.ts's; the Enterprise's ways out by warp, warp.ts's.
 */

/** kScriptPeriod (ai.cpp:33): 0x12 * 1000 / 291, 61 ms between a ship's tactics. */
export const SCRIPT_PERIOD = Math.trunc((0x12 * 1000) / 291);
/** The ranges the ships fight at (ai.cpp:37-46; kCollisionRange is steering.ts's). */
export const AI_RANGE = {
  phaserFire: 6500, standDown: 58000, chase: 40000, flee: 50000, close: 15000, ram: 3500, autoTarget: 18000, starbaseRepair: 5000,
} as const;
/** Combat::_screenNumber 0x43 (ai.cpp:332): in that battle the ships only run their tactics. */
const TACTICS_ONLY_BATTLE = 0x43;

/** Combat::aiTarget (ai.cpp:133-140): the Enterprise's new target, not cloaked and not the one it has, which the computer names (kCues, lifted as each kind's targetCue). */
export function aiTarget(ctx: BattleContext, b: BattleState, _ship: CombatShip, target: CombatShip | null): void {
  if (!target || target.decloakTime || target.index === b.target) return;
  setTarget(b, target.index);
  // the computer says what it is (kCues, ai.cpp:138: every kind has one, so no -1 to skip)
  playCueAfter(b, ctx.combat.kinds[target.type]!.targetCue);
}

/**
 * Combat::autoTarget (ai.cpp:142-165): once the Enterprise has fired, the nearest enemy within 18000 that isn't the
 * target, isn't a friend and isn't cloaked, and with a target, only one over 40 points stronger; with none nearer,
 * the last of those seen, if any ship but the Enterprise is left.
 */
export function autoTarget(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  let found: CombatShip | null = null, candidate: CombatShip | null = null;
  let best: number = AI_RANGE.autoTarget;
  const current = battleTarget(b);
  for (let i = 1; i < b.ships.length; i++) {
    const s = b.ships[i]!;
    if (!alive(s) || s === current || (s.flags & SHIP_FLAGS.friendly) || !(ship.flags & SHIP_STATE.hasFired) || s.decloakTime) continue;
    const d = distance(ship, s);
    if (d > AI_RANGE.autoTarget) continue;
    if (current && s.condition - current.condition <= 40) continue;
    candidate = s;
    if (d <= best) {
      best = d;
      found = s;
    }
  }
  if (!found && liveShips(b) > 1) found = candidate;
  if (found) aiTarget(ctx, b, ship, found);
}

/** Combat::ram (ai.cpp:167-184): make for the target; close in, stop and fire everything (not at a friend); further off, at 500, firing torpedoes. */
export function ram(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const target = shipTarget(b, ship);
  if (!alive(target)) return;
  logMessage(ship, 'Performing sudden impact.');
  // (a copy: the waypoint is the ship's own, which WAY changes)
  ship.waypoint = { ...target.pos };
  ship.waypointActive = true;
  if (distance(ship, target) <= AI_RANGE.ram) {
    ship.targetSpeed = 0;
    if (!(target.flags & SHIP_FLAGS.friendly)) {
      ctx.seams.fireTorpedoes(ctx, b, ship, 0);
      ctx.seams.firePhasers(ctx, b, ship);
    }
  } else {
    ship.targetSpeed = 500;
    ctx.seams.fireTorpedoes(ctx, b, ship, 0);
  }
}

/** Combat::evade (ai.cpp:186-203): turn by the bits of the strongest shield (of 8, or 2 for other ships) mixed with the target's facing, as the original. */
export function evade(_ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const target = shipTarget(b, ship);
  if (!alive(target)) return;
  let strongest = 0, best = 0;
  const count = isEnterprise(ship) ? 8 : 2;
  const units = ship.systems.units;
  for (let i = 0; i < count && i < units.length; i++) {
    if (units[i]!.current > best) {
      best = units[i]!.current;
      strongest = i;
    }
  }
  const x = strongest ^ facing(ship, target.pos);
  ship.controls.pitch = x & 1 ? 75 : 0;
  ship.controls.roll = x & 2 ? 75 : 0;
  ship.controls.yaw = x & 4 ? 75 : 0;
}

/** Combat::enemySystemsCheck (ai.cpp:302-311): a crippled enemy (no speed, under 20%) would rather blow itself up, in 20 s. */
export function enemySystemsCheck(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (isEnterprise(ship) || ship.selfDestructTime || ship.removeTime || ship.maxSpeed > 0 || ship.condition >= 20 || ship.type === KIND.starbase) return;
  logMessage(ship, 'Engaging self-destruct mechanism.');
  ship.selfDestructTime = b.now + combatTicks(0x16bc);
  // (twice: ai.cpp:309-310)
  playCue(b, cueId(ctx, 'enemySelfDestruct'), combatTicks(0x246));
  playCue(b, cueId(ctx, 'enemySelfDestruct'), combatTicks(0x5af));
}

/** Combat::starbase (ai.cpp:313-326): it turns, slowly, and within 5000 repairs the Enterprise, which it moves 24000 off and shows in the chase view. */
export function starbase(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (b.now < ship.scriptTime) return;
  ship.scriptTime = b.now + SCRIPT_PERIOD;
  ship.angles[0] = (ship.angles[0] + 0x10) & 0x3fff;
  const e = b.ships[0];
  if (alive(e) && distance(ship, e) < AI_RANGE.starbaseRepair) {
    // (setDamage(kUnitAll, 1): every unit off and its damage repaired)
    setUnitsDamage(unitDefs(ctx, e), e.systems, UNIT_ALL, 1);
    e.pos = sub(ship.pos, v3(24000, 0, 0));
    e.waypointActive = false;
    setView(b, e.index, VIEW.chase);
  }
}

/**
 * Combat::runAI (ai.cpp:328-466): a ship's AI, or Worf's for the Enterprise under Delegate.
 * - With no live target (or in battle 0x43), only its tactics, every SCRIPT_PERIOD.
 * - Frozen (avoiding a collision), nothing.
 * - Worf takes a target over 40 points stronger, or the nearest.
 * - Every 5 s it fires: phasers within 6500, torpedoes when the target is fore or aft and level. On Ensign, other
 *   ships fire each only on a roll of 1 in rnd(3) (ai.cpp:367, 380).
 * - The range decides red alert, and beyond 40000 a chase at 999.
 * - Every 5 s, what to do: flee when much weaker, ram or flee a ship about to blow itself up, evade when it can't
 *   move, ram a target that can't, else its tactics (or, for Worf not engaged, the kernel), closing in beyond 15000.
 * - Between those, its tactics, every SCRIPT_PERIOD once a hold is over.
 */
export function runAI(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (ship.type === KIND.starbase) return;
  let target = shipTarget(b, ship);
  if (!alive(target) || b.scenario === TACTICS_ONLY_BATTLE) {
    if (ship.engaged && ship.script && ship.scriptTime < b.now) {
      runScript(ctx, b, ship);
      ship.scriptTime = b.now + SCRIPT_PERIOD;
    }
    return;
  }
  if (ship.freezeTime > b.now) return;

  const enterprise = isEnterprise(ship);
  if (enterprise) {
    // Worf looks for the strongest enemy
    for (const s of b.ships) {
      if (s === target || s === ship || !alive(s) || (s.flags & SHIP_FLAGS.friendly) || s.decloakTime) continue;
      if (s.condition - target.condition > 40) {
        aiTarget(ctx, b, ship, s);
        break;
      }
    }
    if (ship.target === null) autoTarget(ctx, b, ship);
  }
  target = shipTarget(b, ship);
  if (!alive(target)) return;
  const friendlyTarget = enterprise && (target.flags & SHIP_FLAGS.friendly) !== 0;
  const d = distance(ship, target);
  const difficulty = b.difficulty;

  // weapons, every 5 s
  if (ship.fireTime < b.now && !friendlyTarget) {
    ship.fireTime = b.now + combatTicks(0x5af);
    if (d < AI_RANGE.phaserFire && (enterprise || difficulty || roll(ctx, b, 3, 'ai.cpp:367') === 1)) ctx.seams.firePhasers(ctx, b, ship);
    const [yaw, pitch] = directionTo(ship, target.pos);
    const level = pitch < 0x200 || pitch > 0x3e00;
    const fore = (yaw > 0x3e00 || yaw < 0x200) && level;
    const aft = yaw > 0x1e00 && yaw < 0x2200 && level;
    if (fore || aft) {
      // (sic) (ai.cpp:375, so marked in ScummVM: the yaw and the pitch averaged)
      let spread = (yaw + pitch) >> 1;
      if (spread > 0x2000) spread = 0x4000 - spread;
      spread = Math.min(spread, 0x800);
      if (enterprise || difficulty || roll(ctx, b, 3, 'ai.cpp:380') === 1) ctx.seams.fireTorpedoes(ctx, b, ship, spread);
      if (enterprise) {
        let cell = Math.trunc(spread / 0xe6);
        if (cell) cell++;
        cell = clip(cell, 0, 9);
        b.console.spread = cell * 0xe6;
        b.console.spreadDegrees = cell * 5;
      }
    }
  }

  // the range decides the alert, and whether to chase
  if (d > AI_RANGE.standDown && b.console.redAlert) {
    b.console.redAlert = false;
  } else if (d >= AI_RANGE.chase || friendlyTarget) {
    ship.holdTime = b.now + combatTicks(0x16bc);
    if (!target.decloakTime && !friendlyTarget) {
      ship.waypoint = { ...target.pos };
      ship.waypointActive = true;
    }
    ship.targetSpeed = 999;
  } else if (!b.console.redAlert) {
    b.console.redAlert = true;
  }

  // what to do, every 5 s
  if (ship.strategyTime < b.now) {
    ship.strategyTime = b.now + combatTicks(0x5af);
    if (3 * ship.condition < target.condition && ship.condition <= 40 && d < AI_RANGE.flee) {
      if (enterprise && !friendlyTarget) {
        if (alive(target)) warpAway(ctx, b, ship);
      } else {
        // (an enemy flees only by saying so, ai.cpp:416)
        logMessage(ship, 'Get me outa here.');
      }
      ship.holdTime = b.now + combatTicks(0x2223);
      return;
    }
    if (target.selfDestructTime) {
      ship.holdTime = b.now + combatTicks(0xb5e);
      if (!friendlyTarget && target.selfDestructTime > b.now + combatTicks(0x5af)) {
        ram(ctx, b, ship);
        ctx.seams.fireTorpedoes(ctx, b, ship, 0x38e);
      } else if (enterprise) {
        if (alive(target)) warpAway(ctx, b, ship);
      } else {
        // (and here, ai.cpp:429)
        logMessage(ship, 'Get me outa here.');
      }
      return;
    }
    if (ship.maxSpeed <= 0 && !friendlyTarget) {
      logMessage(ship, `${ctx.combat.kinds[ship.type]!.base} is gonna be nuked.`);
      evade(ctx, b, ship);
      ship.holdTime = b.now + combatTicks(0xb5e);
      return;
    }
    if (target.maxSpeed <= 0 && target.type !== KIND.starbase && !friendlyTarget) {
      logMessage(ship, `${ctx.combat.kinds[target.type]!.base} is lame.`);
      ram(ctx, b, ship);
      ship.holdTime = b.now + combatTicks(0xb5e);
      return;
    }
    if (ship.engaged) {
      if (ship.script && ship.holdTime < b.now && ship.scriptTime < b.now) {
        ship.scriptTime = b.now + SCRIPT_PERIOD;
        runScript(ctx, b, ship);
      }
    } else if (enterprise && ship.script && b.console.kernelReady) {
      // (as the original, ai.cpp:450-451: Worf, not engaged, only goes back to the kernel, each strategy)
      kernelJump(ctx, ship.script);
    }
    if (d > AI_RANGE.close) {
      // close in; nearer, the tactics take over
      ship.holdTime = b.now + combatTicks(0xb5e);
      if (!target.decloakTime && !friendlyTarget) {
        ship.waypoint = { ...target.pos };
        ship.waypointActive = true;
      }
      ship.targetSpeed = 700;
    }
  } else if (ship.engaged && ship.script && ship.holdTime < b.now && ship.scriptTime < b.now) {
    ship.scriptTime = b.now + SCRIPT_PERIOD;
    runScript(ctx, b, ship);
  }
}

/**
 * Combat::setDelegate (ai.cpp:468-502): Delegate on or off. Off, the Enterprise's tactics stop and its controls
 * centre. On, with an enemy about, Worf locks weapons, sets every bank to 100 and both salvos to 10, starts at the
 * kernel (when asked with cues and the kernel is ready) and goes to full power; the Enterprise is engaged. The lock and
 * the power go through the weapons' seams (Plan 20's R1).
 */
export function setDelegate(ctx: BattleContext, b: BattleState, on: boolean, cues: boolean): void {
  const ship = b.ships[0];
  b.console.delegate = on;
  if (!ship) return;
  if (!on) {
    ship.engaged = false;
    ship.waypointActive = false;
    ship.waypoint = v3();
    ship.controls.yaw = ship.controls.pitch = ship.controls.roll = 0;
    return;
  }
  if (cues) {
    playCue(b, cueId(ctx, 'delegateOn'));
    playCueAfter(b, cueId(ctx, 'delegateOnAfter'));
  }
  // Worf gets ready, if there's an enemy
  let hostile = false;
  for (let i = 1; i < b.ships.length; i++) {
    if (alive(b.ships[i]) && !(b.ships[i]!.flags & SHIP_FLAGS.friendly)) hostile = true;
  }
  if (hostile) {
    if (!b.console.weaponsLock) ctx.seams.setWeaponsLock(ctx, b, true);
    for (const bank of ship.banks) bank.setting = 100;
    b.console.salvo[0].setting = b.console.salvo[1].setting = 10;
    // (only when asked with cues, ai.cpp:496-497)
    if (cues && b.console.kernelReady) kernelJump(ctx, ship.script);
    if (b.console.powerLevel !== 4) ctx.seams.setPowerLevel(ctx, b, 4, true);
  }
  ship.engaged = true;
}

/** ai.cpp's seams (types.ts CombatSeams), for a context: `{ ...NO_SEAMS, ...AI_SEAMS }`, or SIM_SEAMS for them all. */
export const AI_SEAMS: Pick<CombatSeams,
  'enemySystemsCheck' | 'runAI' | 'autoTarget' | 'starbase' | 'avoidCollision' | 'steerTowards' | 'filterInputs' | 'setDelegate'> = Object.freeze({
  enemySystemsCheck, runAI, autoTarget, starbase, avoidCollision, steerTowards, filterInputs, setDelegate,
});
