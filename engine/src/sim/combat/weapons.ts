// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../../content/types';
import { sensorOutput, UNIT_PHASER, UNIT_SHIELD, UNIT_TORPEDO } from '../shipSystems';
import { anglesTo, facing, foreFacing, forward, fromInternal, hitShield, orientation, PHASER_RANGE, phaserEnergy, toInternal } from './aim';
import { storyHit, storyHitChance, storyTorpedoLost } from './assists';
import { alive, battleTarget, distance, liveShips, logMessage, shipTarget } from './battle';
import { destroy, explode, flashShield, phaserHit, runEventHook, torpedoHit } from './damage';
import { combatDataProblems } from './data';
import { advanceAnimation, animationActive, animationFrames, cameraEvent, playEffect, roll, startAnimation, stopAnimation } from './effects';
import { STEP_SECONDS } from './flight';
import { add, apply, fma32, fr, length, sub, v3 } from './math';
import { combatTicks } from './time';
import {
  anim, isEnterprise, KIND, NO_EXIT, bearingRow, cueId, playCue, playCueAfter, SHIP_STATE, unitDefs,
  type BattleContext, type BattleState, type CombatSeams, type CombatShip,
} from './types';

/**
 * weapons.cpp: the phaser banks, torpedoes (a pool of 99), salvos and the spread, the weapons lock, the shields and
 * the power levels, the sensors, self-destruct and the lamps. Every roll is at ScummVM's call site, in its order.
 */

/** kPhaserFrame (weapons.cpp:61): a beam's frame time, 0x1e of the original's ticks. */
const PHASER_FRAME = 0x1e;
/** A volley's drain and a hit's power, a tick's worth (weapons.cpp:330, 361): 0.057214f. */
const DRAIN = fr(0.057214);

/** millisToTicks (weapons.cpp:66-68): millis * 291.0f / 1000.0f, from a uint32. */
export function millisToTicks(millis: number): number {
  return fr(fr(fr(millis >>> 0) * 291) / 1000);
}

/**
 * Combat::setupWeapons (weapons.cpp:101-152): the phaser banks (six for the Enterprise, two for others), each
 * charged as its unit is. The sprites, sounds, shield model and billboard are found by kind when they're used (the
 * shield's and explosion's scale is the presentation's). Refuses a battle the lifted data can't fight
 * (combatDataProblems).
 */
export function setupWeapons(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const problems = combatDataProblems(ctx);
  if (problems.length > 0) throw new Error(`the combat data can't fight a battle: ${problems.join('; ')}`);
  ship.banks = [];
  ship.activeBeams = 0;
  ship.shieldAttacker = null;
  if (!(ship.flags & SHIP_FLAGS.phasers)) return;
  const enterprise = isEnterprise(ship);
  const p = ctx.combat.phasers;
  const count = enterprise ? 6 : 2;
  for (let i = 0; i < count; i++) {
    const unit = (enterprise ? p.units.enterprisePhaser : p.units.otherPhaser) + i;
    const [x, y, z] = (enterprise ? p.enterprise : p.other)[i]!;
    const u = ship.systems.units[unit]!;
    const charge = u.max ? Math.trunc((u.current * 100) / u.max) : 0;
    ship.banks.push({
      unit, offset: v3(x, y, z), active: false, miss: false, missOffset: v3(), endTime: 0, lastUpdate: 0, beam: anim(),
      charge, setting: charge, savedSetting: charge, tip: v3(),
    });
  }
}

/** Combat::firedOn (weapons.cpp:197-212): each ship's first shot has a hook; a ship that fires is no longer friendly; red alert. */
export function firedOn(ctx: BattleContext, b: BattleState, shooter: CombatShip, target: CombatShip): void {
  if (!(shooter.flags & SHIP_STATE.hasFired)) {
    const hook = isEnterprise(shooter) ? 2 : 3;
    runEventHook(ctx, b, shooter, hook);
    runEventHook(ctx, b, target, hook);
    shooter.flags |= SHIP_STATE.hasFired;
  }
  shooter.flags &= ~SHIP_FLAGS.friendly;
  if (!(target.flags & SHIP_STATE.firedUpon)) target.flags |= SHIP_STATE.firedUpon | SHIP_STATE.firedUponNew;
  else target.flags &= ~SHIP_STATE.firedUponNew;
  if (!b.console.redAlert) b.console.redAlert = true;
}

/** Combat::phaserHitChance (weapons.cpp:214-221): worse against a fast or small target, and a little worse far off. */
export function phaserHitChance(b: BattleState, ship: CombatShip): number {
  const target = shipTarget(b, ship)!;
  const d = distance(ship, target);
  const s = fr(target.speed / 1000);
  // (target->radius / 2460.0f * 0.3f + 0.7f and (11255.0f - d) / 11255.0f * 0.1f + 0.9f: each a fused multiply-add)
  const fz = fma32(fr(target.radius / 2460), fr(0.3), fr(0.7));
  const fd = fma32(fr(fr(11255 - d) / 11255), fr(0.1), fr(0.9));
  // ((int)(fabsf(1.0f - fabsf(s) * fabsf(1.0f - fz * fd)) * 100.0f): 1.0f - a * b is fma(-a, b, 1.0f))
  return Math.trunc(fr(Math.abs(fma32(-Math.abs(s), Math.abs(fma32(-fz, fd, 1)), 1)) * 100));
}

/**
 * Combat::firePhasers (weapons.cpp:223-299): each ready bank fires on the target. The Enterprise's banks fire as
 * the lamps allow; another ship's fore bank fires on a target ahead and its aft bank on one behind. Each beam may
 * miss, by the hit chance.
 */
export function firePhasers(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (!alive(ship) || (ship.flags & SHIP_STATE.dying) || !(ship.flags & SHIP_FLAGS.phasers) || ship.activeBeams) return;
  const target = shipTarget(b, ship);
  if (!alive(target) || target.decloakTime || ship.decloakTime) return;
  const enterprise = isEnterprise(ship);
  const kind = ctx.combat.kinds[ship.type]!;

  // firing on the starbase is unwise: the Enterprise is blown up in 5 to 8 s (weapons.cpp:231-235, a quirk kept)
  if (enterprise && target.type === KIND.starbase) {
    if (!ship.removeTime) ship.removeTime = b.now + combatTicks(0x5af + roll(ctx, b, 0x369, 'weapons.cpp:234'));
  }
  if (!enterprise) {
    if (ship.type === KIND.starbase) logMessage(ship, 'Engaging auto-defenses.');
    // Worf is ready for them
    if (b.console.delegate && (b.console.powerLevel !== 4 || !b.console.weaponsLock)) {
      setWeaponsLock(ctx, b, true);
      for (const bank of b.ships[0]?.banks ?? []) bank.setting = 100;
      b.console.salvo[0].setting = b.console.salvo[1].setting = 10;
      if (b.console.powerLevel !== 4) setPowerLevel(ctx, b, 4, true);
    }
  }

  // (Story halves an enemy's: assists.ts)
  const chance = storyHitChance(ctx, ship, target, phaserHitChance(b, ship));
  b.console.redAlert = true;
  const d = distance(ship, target);
  if (d > PHASER_RANGE) {
    if (enterprise) playCue(b, cueId(ctx, 'phasersOutOfRange'));
    if (ship.type !== KIND.starbase) return;
  }

  let fired = false, missed = false;
  const code = facing(ship, target.pos);
  ship.banks.forEach((bank, i) => {
    if (bank.active) return;
    bank.lastUpdate = b.now;
    const unit = ship.systems.units[bank.unit]!;
    if (enterprise) {
      if (bank.charge <= 0 || bank.setting <= 0 || b.console.lamps[i] !== 0) return;
      bank.savedSetting = bank.setting;
    } else {
      if (foreFacing(code) !== (i === 0) || unit.current <= 25) return;
      // (on Ensign, difficulty 0, this is rnd(0): always 0, but a draw all the same (weapons.cpp:277, kept))
      bank.endTime = b.now + combatTicks(0x369 + roll(ctx, b, b.difficulty * 0x246, 'weapons.cpp:277'));
    }
    bank.active = true;
    startAnimation(ctx, bank.beam, kind.effects.phaserSprite, combatTicks(PHASER_FRAME), b.now);
    ship.activeBeams++;
    fired = true;
    bank.miss = roll(ctx, b, 100, 'weapons.cpp:283') >= chance;
    if (bank.miss) {
      missed = true;
      // (forward(radius * 0.75f, 0x564 - rnd(0xa80), 0x2b2 - rnd(0x564)): the yaw's roll first)
      const yaw = 0x564 - roll(ctx, b, 0xa80, 'weapons.cpp:286');
      const pitch = 0x2b2 - roll(ctx, b, 0x564, 'weapons.cpp:286');
      bank.missOffset = toInternal(forward(fr(target.radius * 0.75), yaw, pitch));
      bank.endTime = b.now + combatTicks(0x123);
    }
  });
  if (missed && enterprise) playCue(b, cueId(ctx, 'phasersMissed'), combatTicks(0x91));
  if (!fired) return;

  firedOn(ctx, b, ship, target);
  playCue(b, enterprise ? cueId(ctx, 'phasersFired') : cueId(ctx, 'enemyFired'));
  playEffect(b, ship, kind.effects.phaserSound!);
  cameraEvent(b, ship, 0);
}

/**
 * Whether a beam's model has a tip to move: `!bank.beamModel._parts.empty() && !_parts[0].vertices.empty()`
 * (weapons.cpp:379). Every bank's beamModel is a copy of _phaserModel (weapons.cpp:117-118), none without it.
 */
function beamHasTip(ctx: BattleContext): boolean {
  const key = ctx.combat.effects.phaser;
  const model = key === null ? undefined : ctx.combat.models[key];
  // (vertices has an entry for each part: none for no parts)
  return (model?.vertices?.[0] ?? 0) > 0;
}

/**
 * Combat::updateBeams (weapons.cpp:301-383): a volley drains the Enterprise's bank (or ends at its time for
 * others); from its fourth frame a beam that hasn't missed may hit, by distance and the target's speed.
 */
export function updateBeams(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const target = shipTarget(b, ship);
  const enterprise = isEnterprise(ship);
  const stopAll = !alive(target) || !!target.decloakTime || !!ship.decloakTime;
  const dying = (ship.flags & SHIP_STATE.dying) !== 0 || (target !== null && (target.flags & SHIP_STATE.dying) !== 0);
  if (stopAll || dying) {
    for (const bank of ship.banks) {
      if (!bank.active) continue;
      bank.active = false;
      stopAnimation(bank.beam);
      if (enterprise) bank.setting = bank.savedSetting;
    }
    ship.activeBeams = 0;
    return;
  }

  const defs = unitDefs(ctx, ship);
  const tipped = beamHasTip(ctx);
  const d = fr(Math.trunc(distance(ship, target)));
  for (const bank of ship.banks) {
    if (!bank.active) continue;
    const unit = ship.systems.units[bank.unit]!;
    const elapsed = millisToTicks(b.now - bank.lastUpdate);

    // a volley drains the bank
    let ended: boolean;
    if (enterprise) {
      const k = Math.max(Math.trunc(fr(elapsed * DRAIN)), 1);
      bank.charge = Math.max(bank.charge - k, 0);
      bank.setting = Math.max(bank.setting - k, 0);
      unit.current = unit.current < 1 ? 0 : Math.trunc(fr(fr(bank.charge / 100) * unit.max));
      ended = !bank.charge || !bank.setting || (bank.miss && b.now > bank.endTime);
      if (ended) bank.setting = bank.savedSetting;
    } else {
      ended = b.now > bank.endTime;
      if (ended) unit.current = 0;
    }
    if (ended) {
      bank.active = false;
      stopAnimation(bank.beam);
      ship.activeBeams--;
      continue;
    }

    // the beam reaches the target (or misses it)
    advanceAnimation(ctx, bank.beam, b.now);
    const start = add(ship.pos, fromInternal(apply(orientation(ship), bank.offset)));
    let end = target.pos;
    if (bank.miss) end = add(end, fromInternal(bank.missOffset));

    if (bank.beam.frame >= 4 && !bank.miss) {
      // ((int)((18000.0f - d) / 18000.0f * (6000.0f - (int)target->speed) / 6000.0f * 100.0f): products and quotients, nothing fused)
      const chance = Math.trunc(fr(fr(fr(fr(fr(18000 - d) / 18000) * fr(6000 - Math.trunc(target.speed))) / 6000) * 100));
      if (roll(ctx, b, 100, 'weapons.cpp:360') < chance) {
        const raw = Math.trunc(Math.min(fr(fr(defs[bank.unit]!.dischargeTicks * elapsed) * DRAIN), unit.current));
        const energy = phaserEnergy(d, raw);
        const shield = hitShield(ship, target);
        if (bank.beam.frame === 4) flashShield(ctx, b, target, ship, ship.pos, shield);
        // (shieldImpact is placed by updateEffects, after this step's beams: on the flash's first hit the tip runs
        // to the impact the last flash left, (0, 0, 0) for a ship's first (weapons.cpp:370-371, a quirk kept))
        if (animationActive(target.shieldFlash)) end = target.shieldImpact;
        // (Story quarters what an enemy's does to the Enterprise: assists.ts)
        storyHit(ctx, ship, target, () => phaserHit(ctx, b, target, shield, energy));
        if (b.exitCode !== NO_EXIT) return;
      }
    }

    // the beam's tip is moved onto what it hits
    if (tipped) bank.tip = toInternal(sub(end, start));
    bank.lastUpdate = b.now;
  }
}

/**
 * Combat::fireTorpedoes (weapons.cpp:385-472): a salvo from the tube that faces the target, spread across `spread`
 * (or the Enterprise's own setting), each torpedo from the pool of 99 in turn, a moment apart.
 */
export function fireTorpedoes(ctx: BattleContext, b: BattleState, ship: CombatShip, spread: number): void {
  if (!alive(ship) || (ship.flags & SHIP_STATE.dying) || !(ship.flags & SHIP_FLAGS.torpedoes)) return;
  const target = shipTarget(b, ship);
  if (!alive(target) || ship.decloakTime) return;
  const enterprise = isEnterprise(ship);
  const kind = ctx.combat.kinds[ship.type]!;
  const p = ctx.combat.phasers.units;
  b.console.redAlert = true;
  if (enterprise && target.type === KIND.starbase && !ship.removeTime) ship.removeTime = b.now + combatTicks(0x5af + roll(ctx, b, 0x369, 'weapons.cpp:394'));

  const code = facing(ship, target.pos);
  const tube = foreFacing(code) ? 0 : 1;
  let count: number;
  const systems = ship.systems;
  if (enterprise) {
    const salvo = b.console.salvo[tube];
    count = Math.min(salvo.loaded, salvo.setting);
    salvo.loaded -= count;
    systems.units[p.enterpriseTube + tube]!.current -= count;
  } else {
    if (!systems.units[p.otherTube + tube]!.current) return;
    count = Math.min(roll(ctx, b, 2 * b.difficulty, 'weapons.cpp:408') + 2, systems.torpedoes);
    if (count) {
      systems.torpedoes -= count;
      playCue(b, cueId(ctx, 'enemyTorpedoes'));
    }
  }
  if (count < 1) {
    if (enterprise && !b.console.delegate && !b.console.salvo[0].loaded && !b.console.salvo[1].loaded) playCue(b, cueId(ctx, 'torpedoesUnloaded'));
    return;
  }
  const d = distance(ship, target);
  if (d < 1000) {
    if (enterprise && !b.console.delegate) playCue(b, cueId(ctx, 'torpedoesTooClose'));
    return;
  }

  // a spread of them
  let start = 0, step = 0;
  const angle = enterprise && b.console.spread > 0 ? b.console.spread : spread;
  if (count > 1 && angle > 0) {
    start = -Math.trunc(angle / 2);
    step = Math.trunc(angle / (count - 1));
  }
  const lock = !target.decloakTime;
  if (!lock) logMessage(ship, 'Target cloaked - no weapons lock.');

  const s = Math.trunc(ship.speed);
  // (weapons.cpp:458: `photonFrames ? size() : 1`. ScummVM's photonFrames is null only for a missing file; an
  // existing sprite with no se_Sprite entries would give 0 and crash ScummVM (rnd(0xffffffff) here, `% 0` at
  // :520). `|| 1` maps both to 1; the second is unreachable with the real data, every photon sprite having frames.)
  const frames = animationFrames(ctx, kind.effects.photonSprite) || 1;
  for (let k = 0; k < count; k++) {
    // (weapons.cpp:439-443: the first free slot, searched from slot 0 each time)
    const torpedo = b.torpedoes.find(t => !t.active);
    if (!torpedo) break;
    torpedo.active = true;
    torpedo.shooter = ship.index;
    torpedo.target = target.index;
    if (tube === 0) torpedo.speed = s >= 0 ? Math.abs(s) + 525 : Math.max(Math.abs(s) - 525, 525);
    else torpedo.speed = s > 0 ? Math.max(Math.abs(s) - 525, 525) : Math.abs(s) + 525;
    torpedo.homingDistance = Math.trunc(fr(d * 0.5));
    // (ship->pos + Vector3(rnd(3), rnd(3), rnd(3)): left to right)
    const x = roll(ctx, b, 3, 'weapons.cpp:453'), y = roll(ctx, b, 3, 'weapons.cpp:453'), z = roll(ctx, b, 3, 'weapons.cpp:453');
    torpedo.pos = add(ship.pos, v3(x, y, z));
    torpedo.angles = [(ship.angles[0] + start) & 0x3fff, (ship.angles[1] + (tube ? 0x2000 : 0)) & 0x3fff, ship.angles[2]];
    start += step;
    const first = roll(ctx, b, frames - 1, 'weapons.cpp:459');
    torpedo.frame = first >= 1 ? roll(ctx, b, frames - 1, 'weapons.cpp:460') : 0;
    torpedo.lock = lock && (enterprise ? b.console.weaponsLock : true);
    torpedo.expiry = b.now + combatTicks(0x2d81);
    torpedo.homingTime = b.now + (torpedo.lock ? combatTicks(0x246) : combatTicks(400));
    torpedo.launchTime = b.now + k * combatTicks(roll(ctx, b, 0x1e, 'weapons.cpp:464') + 0x28);
  }

  firedOn(ctx, b, ship, target);
  if (enterprise) playCue(b, cueId(ctx, 'torpedoesAway'), combatTicks(0x91));
  playEffect(b, ship, kind.effects.photonSound!);
  cameraEvent(b, ship, 0);
}

/** torpedoTurn (weapons.cpp:474-481): how far a torpedo turns towards its target in a step. */
export function torpedoTurn(delta: number): number {
  const x = delta <= 0x2000 ? delta : delta - 0x4000;
  if (Math.abs(x) < 0x170) return x;
  const turn = Math.abs(x) <= 0x1000 ? 0x2b2 : 0x422;
  return x < 0 ? -turn : turn;
}

/**
 * Combat::updateTorpedoes (weapons.cpp:483-577; torpedoTurn, above, is :474-481): each torpedo flies; it hits a live
 * target it reaches; it expires; a locked one homes in, faster, and one well off course looks for something else to
 * hit. Quirks of that search (weapons.cpp:554-575), kept: it runs by the Enterprise's weapons lock, whoever fired
 * the torpedo; and it looks at every live ship but the Enterprise (from j = 1), so an enemy's torpedo can pick its
 * own shooter.
 */
export function updateTorpedoes(ctx: BattleContext, b: BattleState): void {
  for (const torpedo of b.torpedoes) {
    if (!torpedo.active || torpedo.launchTime > b.now) continue;
    const target = b.ships[torpedo.target!]!;
    const shooter = b.ships[torpedo.shooter!]!;
    const byEnterprise = isEnterprise(shooter);

    const step = forward(fr(torpedo.speed * STEP_SECONDS), torpedo.angles[0], torpedo.angles[1]);
    torpedo.pos = add(torpedo.pos, step);
    const dist = fr(Math.trunc(length(sub(torpedo.pos, target.pos))));

    // a hit
    if (alive(target) && dist < torpedo.speed && length(sub(step, target.velocity)) > fr(dist - target.radius)) {
      // (Story loses an enemy's torpedo on a coin flip as it reaches the Enterprise: assists.ts)
      if (storyTorpedoLost(ctx, b, shooter, target)) {
        torpedo.active = false;
        continue;
      }
      if (!animationActive(target.explosion)) explode(ctx, b, target);
      if (byEnterprise) playCue(b, cueId(ctx, 'torpedoHit'));
      const shield = hitShield(shooter, target);
      if (!animationActive(target.shieldFlash)) flashShield(ctx, b, target, null, torpedo.pos, shield);
      torpedo.active = false;
      // (Story quarters what an enemy's does to the Enterprise: assists.ts)
      storyHit(ctx, shooter, target, () => torpedoHit(ctx, b, target, shield));
      if (b.exitCode !== NO_EXIT) return;
      continue;
    }
    if (b.now > torpedo.expiry || !alive(target)) {
      torpedo.active = false;
      if (byEnterprise) playCue(b, cueId(ctx, 'torpedoLost'));
      continue;
    }

    // (weapons.cpp:519: `|| 1` as in fireTorpedoes, above)
    const frames = animationFrames(ctx, ctx.combat.kinds[shooter.type]!.effects.photonSprite) || 1;
    torpedo.frame = (torpedo.frame + 1) % frames;
    if (!torpedo.lock || (target.flags & SHIP_STATE.dying)) continue;

    // it homes in on the target
    if (torpedo.speed < 900) torpedo.speed += 15;
    if (dist >= torpedo.homingDistance && b.now <= torpedo.homingTime) continue;
    const pitch = torpedo.angles[1];
    if (pitch > 0x1000 && pitch < 0x3000) {
      // (over the top)
      torpedo.angles[0] = (torpedo.angles[0] + 0x2000) & 0x3fff;
      torpedo.angles[2] = (torpedo.angles[2] + 0x2000) & 0x3fff;
      torpedo.angles[1] = (pitch < 0x2000 ? 0x2000 - pitch : 0x6000 - pitch) & 0x3fff;
    }
    const [ty, tp] = anglesTo(target.pos, torpedo.pos);
    const dy = (ty - torpedo.angles[0]) & 0x3fff;
    const dp = (tp - torpedo.angles[1]) & 0x3fff;
    if (torpedo.speed < 1750) torpedo.speed += 30;
    if (byEnterprise) playCue(b, cueId(ctx, 'torpedoHoming'));
    if ((dy || dp) && !target.decloakTime) {
      if (dist < 800) {
        torpedo.angles[0] = (torpedo.angles[0] + dy) & 0x3fff;
        torpedo.angles[1] = (torpedo.angles[1] + dp) & 0x3fff;
      } else {
        torpedo.angles[0] = (torpedo.angles[0] + torpedoTurn(dy)) & 0x3fff;
        torpedo.angles[1] = (torpedo.angles[1] + torpedoTurn(dp)) & 0x3fff;
      }
    }

    // one which is well off course looks for something else to hit
    const offCourse = (dy > 0x564 && dy < 0x3b4c) || (dp > 0x564 && dp < 0x3b4c);
    if (dist > fr(target.radius * 2) && b.console.weaponsLock && offCourse) {
      let found: CombatShip | null = null;
      // (weapons.cpp:558: from 1, every live ship, the shooter too: a quirk, kept)
      for (let j = 1; j < b.ships.length && !found; j++) {
        const ship = b.ships[j]!;
        if (!alive(ship)) continue;
        const [sy, sp] = anglesTo(ship.pos, torpedo.pos);
        const ay = (sy - torpedo.angles[0]) & 0x3fff, ap = (sp - torpedo.angles[1]) & 0x3fff;
        if ((ay <= 0x564 || ay >= 0x4000 - 0x564) && (ap <= 0x564 || ap >= 0x4000 - 0x564)) found = ship;
      }
      if (found) {
        torpedo.target = found.index;
        if (byEnterprise) playCue(b, cueId(ctx, 'torpedoRetargeted'));
      } else {
        torpedo.lock = false;
      }
    }
  }
}

/**
 * Combat::checkSensors (weapons.cpp:579-603): every 10 s, the sensors' quality; below 40% the radar shows the ships
 * only on a roll. The tactical screen's radar asks it each time it draws (tactical.cpp:1111-1113), once a frame before
 * the update; the sim asks it before each step while the radar shows (battle.ts' updateBattle, Plan 23 R10).
 */
export function checkSensors(ctx: BattleContext, b: BattleState): boolean {
  const ship = b.ships[0];
  const c = b.console;
  if (alive(ship) && b.now >= c.sensorCheckTime) {
    c.sensorCheckTime = b.now + combatTicks(0xb5e);
    let quality = sensorOutput(unitDefs(ctx, ship), ship.systems);
    if (quality >= 76) quality = 100;
    else if (quality < 15) quality = 0;
    c.sensorQuality = quality;
    c.sensorsReliable = quality >= 40;
    if (c.sensorsReliable) {
      c.sensorsBlank = c.sensorsDamaged = false;
    } else {
      // too poor to aim by
      if (quality < 30 && c.weaponsLock) setWeaponsLock(ctx, b, false);
      if (quality === 0) c.sensorsBlank = true;
      else c.sensorsDamaged = true;
    }
  }
  return c.sensorsReliable || roll(ctx, b, 100, 'weapons.cpp:602') < c.sensorQuality;
}

/** Combat::setWeaponsLock (weapons.cpp:605-626): the weapons charge in full, and the target's hook 0 runs. */
export function setWeaponsLock(ctx: BattleContext, b: BattleState, on: boolean): void {
  const ship = b.ships[0];
  if (!on) {
    b.console.weaponsLock = false;
    return;
  }
  if (!alive(ship) || liveShips(b) < 2) {
    playCue(b, cueId(ctx, 'lockRefused'));
    b.console.weaponsLock = false;
    return;
  }
  b.console.weaponsLock = true;
  // the weapons charge
  const defs = unitDefs(ctx, ship);
  ship.systems.units.forEach((u, i) => {
    const type = defs[i]!.type;
    if ((type === UNIT_PHASER || type === UNIT_TORPEDO) && !u.damage) u.target = u.aiTarget = u.aiCap = u.max;
  });
  playCueAfter(b, cueId(ctx, 'lockOn'));
  const target = battleTarget(b);
  if (alive(target)) runEventHook(ctx, b, target, 0);
}

/** Combat::raiseShields (weapons.cpp:628-645): up charges every whole shield in full; "down" only says so (weapons.cpp:632: it doesn't lower them, a quirk kept). */
export function raiseShields(ctx: BattleContext, b: BattleState, on: boolean): void {
  const ship = b.ships[0];
  b.console.shieldsRaised = on;
  if (!on) {
    // (which doesn't actually lower them)
    playCue(b, cueId(ctx, 'shieldsLowered'));
    return;
  }
  playCue(b, cueId(ctx, 'shieldsRaising'));
  if (ship) {
    logMessage(ship, 'Shields raised to 100%');
    const defs = unitDefs(ctx, ship);
    ship.systems.units.forEach((u, i) => {
      if (defs[i]!.type === UNIT_SHIELD && !u.damage) u.target = u.aiTarget = u.aiCap = u.max;
    });
  }
  playCueAfter(b, cueId(ctx, 'shieldsRaised'));
}

/**
 * Combat::setPowerLevel (weapons.cpp:647-687): the CONN page's preset (level%d.dat, CombatData.powerLevels) gives
 * each unit Delegate's power; level 4 is battle stations, shields up (filled at once the first time).
 */
export function setPowerLevel(ctx: BattleContext, b: BattleState, level: number, force: boolean): void {
  const c = b.console;
  if (level === c.powerLevel && !force) return;
  const preset = ctx.combat.powerLevels[level];
  const ship = b.ships[0];
  if (preset && ship) {
    // (ScummVM reads until eos(), which a short file only sets after one read past its end (weapons.cpp:653-656):
    // the lifted presets have a value for every unit, so stopping at the preset's length is the same)
    for (let i = 0; i < ship.systems.units.length && i < preset.length; i++) {
      const u = ship.systems.units[i]!;
      u.aiTarget = u.aiCap = preset[i]!;
    }
  }

  if (level === 4) {
    // battle stations: shields up, at once the first time
    if (ship) {
      logMessage(ship, 'Shields raised to 100%');
      const defs = unitDefs(ctx, ship);
      ship.systems.units.forEach((u, i) => {
        if (defs[i]!.type !== UNIT_SHIELD || u.damage) return;
        // (only the first time: once filled, battle stations leaves the shields' charge as it is, weapons.cpp:668-669)
        if (!c.shieldsFilled) u.current = u.max;
        u.target = u.aiTarget = u.max;
        u.aiCap = 0;
      });
    }
    if (!c.shieldsRaised) {
      // (raiseShields' cues, weapons.cpp:636, 644: again at weapons.cpp:675-676)
      playCue(b, cueId(ctx, 'shieldsRaising'), combatTicks(0x1b4));
      playCue(b, cueId(ctx, 'shieldsRaised'), combatTicks(0x2d7));
    }
    c.shieldsRaised = c.shieldsFilled = true;
    if (!force) playCue(b, cueId(ctx, 'powerLevelFull'));
  } else {
    // (the level's cue is the level itself: play(level), weapons.cpp:683)
    if (!force) playCue(b, level);
    c.shieldsRaised = false;
  }
  c.powerLevel = level;
}

/** Combat::setSpread (weapons.cpp:689-696): a cell of 5 degrees, 0x2e units each. */
export function setSpread(ctx: BattleContext, b: BattleState, cell: number): void {
  b.console.spreadDegrees = cell * 5;
  b.console.spread = b.console.spreadDegrees * 0x2e;
  if (cell === 0) playCue(b, cueId(ctx, 'spreadNarrow'));
  else if (cell === 9) playCue(b, cueId(ctx, 'spreadWide'));
}

/** Combat::armSelfDestruct (weapons.cpp:698-706): 20 s (0x16bc ticks), or disarmed. */
export function armSelfDestruct(ctx: BattleContext, b: BattleState): void {
  if (!b.console.selfDestructTime) {
    b.console.selfDestructTime = b.now + combatTicks(0x16bc);
    playCue(b, cueId(ctx, 'selfDestructArmed'), combatTicks(0x246), true);
  } else {
    b.console.selfDestructTime = 0;
    playCue(b, cueId(ctx, 'selfDestructDisarmed'), combatTicks(0x246), true);
  }
}

/**
 * Combat::updateSelfDestruct (weapons.cpp:708-729): the computer counts down; at zero the Enterprise is destroyed,
 * and only the CONN page's countdown takes the target with it (weapons.cpp:723-727). Off the CONN page the time
 * stays set and destroy is asked again each step (it does nothing to a dying ship): kept.
 */
export function updateSelfDestruct(ctx: BattleContext, b: BattleState): void {
  const c = b.console;
  if (!c.selfDestructTime) return;
  const ship = b.ships[0]!;
  if (b.now < c.selfDestructTime) {
    // the computer counts down ((_selfDestructTime - _now) / 1000.0f, from a uint32)
    const left = fr(fr((c.selfDestructTime - b.now) >>> 0) / 1000);
    if (left > 14 && left < 16) playCue(b, cueId(ctx, 'selfDestruct15'), combatTicks(0x123));
    else if (left > 10 && left < 11) playCue(b, cueId(ctx, 'selfDestruct10'));
    else if (left > 4 && left < 6) playCue(b, cueId(ctx, 'selfDestruct5'));
    return;
  }
  if (c.connPage) {
    ship.flags |= SHIP_FLAGS.blast;
    c.selfDestructTime = 0;
  }
  destroy(ctx, b, ship);
}

/** Combat::updateLamps (weapons.cpp:731-750): which of the Enterprise's weapons bear on the target (0), are damaged (1), or don't bear (2). */
export function updateLamps(ctx: BattleContext, b: BattleState): void {
  const lamps = b.console.lamps;
  for (let i = 0; i < 8; i++) lamps[i] = 2;
  const ship = b.ships[0];
  const target = battleTarget(b);
  if (!alive(ship) || !alive(target)) return;
  b.console.targetFacing = facing(ship, target.pos);
  // (kBearing, weapons.cpp:738-740: by the target's facing, the lamps that bear on it, lifted as combat.yaml's `bearing`)
  for (const lamp of bearingRow(ctx, b.console.targetFacing)) if (lamp !== -1) lamps[lamp] = 0;
  const first = ctx.combat.phasers.units.enterprisePhaser;
  for (let i = 0; i < 8; i++) if (ship.systems.units[first + i]!.damage) lamps[i] = 1;
}

/** weapons.cpp's seams (types.ts CombatSeams), for a context: `{ ...NO_SEAMS, ...WEAPON_SEAMS, ...DAMAGE_SEAMS }`. */
export const WEAPON_SEAMS: Pick<CombatSeams,
  'setupWeapons' | 'updateBeams' | 'updateTorpedoes' | 'updateSelfDestruct' | 'updateLamps' | 'firePhasers' | 'fireTorpedoes' |
  'setWeaponsLock' | 'raiseShields' | 'setPowerLevel' | 'setSpread' | 'armSelfDestruct'> = Object.freeze({
  setupWeapons, updateBeams, updateTorpedoes, updateSelfDestruct, updateLamps, firePhasers, fireTorpedoes,
  setWeaponsLock, raiseShields, setPowerLevel, setSpread, armSelfDestruct,
});
