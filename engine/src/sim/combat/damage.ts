// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS, type CombatCueName, type ShipUnit } from '../../content/types';
import {
  UNIT_COMPUTER, UNIT_FUSION, UNIT_IMPULSE, UNIT_LIFE_SUPPORT, UNIT_MATTER_ANTIMATTER, UNIT_PHASER, UNIT_POWER_GRID, UNIT_SENSOR, UNIT_SHIELD,
  UNIT_TORPEDO, UNIT_WARP, unitHitWeight,
} from '../shipSystems';
import { hitShield, phaserEnergy } from './aim';
import { storyHit } from './assists';
import { alive, distance, liveShips, logMessage, setView, shipTarget, VIEW } from './battle';
import { nextTarget, setTarget } from './commands';
import { advanceAnimation, animationActive, animationFrames, cameraEvent, nextRoll, playEffect, roll, startAnimation, stopAnimation } from './effects';
import { STEP_SECONDS } from './flight';
import { add, angleFromSinCos, cosAngle, fma32, fr, scale, sinAngle, sqrtf, sub, v3, type V3 } from './math';
import { combatTicks } from './time';
import {
  anim, GAME_OVER_EXIT, isEnterprise, NO_EXIT, NO_HOOK, cueId, playCue, shieldName, playCueAfter, SHIP_STATE, unitDefs,
  type BattleContext, type BattleState, type CombatSeams, type CombatShip, type Debris, type HookResult,
} from './types';

/**
 * damage.cpp: shields, hits on a ship's units, criticals, explosions, a ship's end and its debris, collisions, and
 * the hooks into the world's scripts. Every roll is at ScummVM's call site, in its order (clang evaluates a call's
 * arguments, and a sum's terms, left to right).
 */

/** kFrameRate (damage.cpp:60-61): the original's frame rate, which some of the damage depends on. */
export const FRAME_RATE = 15;
/** kDestroyedTime (damage.cpp:62): a destroyed ship's debris goes after 0xb5e * 1000 / 291 ms (10 s). */
export const DESTROYED_TIME = Math.trunc((0xb5e * 1000) / 291);
/** kFadeTime (damage.cpp:63): and starts to fade after 0x246 * 1000 / 291 ms (2 s). */
export const FADE_TIME = Math.trunc((0x246 * 1000) / 291);

/** printf's "%4.2f". */
const f42 = (x: number) => x.toFixed(2).padStart(4);
/** (_now / 291) & 1 (damage.cpp:188, 223, 270, 285): which of two sounds or cues, by the original's second. */
const odd = (b: BattleState) => (Math.trunc(b.now / 291) & 1) === 1;

/** hitList (damage.cpp:65-69): the units a hit through a shield can reach, in order, or null for no such shield. */
export function hitList(ctx: BattleContext, ship: CombatShip, shield: number): readonly number[] | null {
  const lists = isEnterprise(ship) ? ctx.combat.hitLists.enterprise : ctx.combat.hitLists.other;
  return shield >= 0 && shield < (isEnterprise(ship) ? 8 : 6) ? lists[shield] ?? null : null;
}

/** shieldUnit (damage.cpp:71-79): the index of the ship's `shield`th shield unit, or null. */
export function shieldUnit(ctx: BattleContext, ship: CombatShip, shield: number): number | null {
  const defs = unitDefs(ctx, ship);
  let count = 0;
  for (let i = 0; i < ship.systems.units.length; i++) {
    if (defs[i]!.type === UNIT_SHIELD && count++ === shield) return i;
  }
  return null;
}

/**
 * Combat::pickUnit (damage.cpp:93-122): a weighted pick of the undamaged units at a depth on the shield's hit list.
 * The total counts the damaged ones too, and a roll on a boundary picks nothing (`cumulative < r`): quirks, kept (damage.cpp:101-120).
 */
export function pickUnit(ctx: BattleContext, b: BattleState, ship: CombatShip, shield: number, depth: number): number | null {
  const list = hitList(ctx, ship, shield);
  if (!list) return null;
  const defs = unitDefs(ctx, ship);
  const units = ship.systems.units;
  let total = 0;
  let any = false;
  for (const i of list) {
    if (i < units.length && defs[i]!.depth === depth) {
      total += unitHitWeight(defs[i]!, units[i]!);
      any = true;
    }
  }
  if (!any) return null;
  const r = roll(ctx, b, Math.max(total, 0), 'damage.cpp:109');
  let cumulative = 0;
  for (const i of list) {
    if (i >= units.length) continue;
    const u = units[i]!;
    if (defs[i]!.depth !== depth || u.damage) continue;
    const weight = unitHitWeight(defs[i]!, u);
    if (cumulative < r && r < cumulative + weight) return i;
    cumulative += weight;
  }
  return null;
}

/** Combat::concussion (damage.cpp:124-133): a picked unit (never life support) is knocked out. */
export function concussion(ctx: BattleContext, b: BattleState, ship: CombatShip, shield: number, depth: number): number | null {
  const i = pickUnit(ctx, b, ship, shield, depth);
  if (i === null) return null;
  const def = unitDefs(ctx, ship)[i]!;
  if (def.type === UNIT_LIFE_SUPPORT) return null;
  const u = ship.systems.units[i]!;
  u.damage = Math.min(u.damage + def.baseDamage + roll(ctx, b, def.baseDamage, 'damage.cpp:128'), def.maxDamage);
  u.current = 0;
  u.target = 0;
  logMessage(ship, `Unit ${def.name} damaged by concussion.`);
  return i;
}

/** The cue for each kind of unit hit on the Enterprise (damage.cpp:139-167), by unit type. */
const UNIT_CUES: Record<number, CombatCueName> = {
  [UNIT_POWER_GRID]: 'unitPowerGrid', [UNIT_IMPULSE]: 'unitImpulse', [UNIT_COMPUTER]: 'unitComputer', [UNIT_SENSOR]: 'unitSensor',
  [UNIT_TORPEDO]: 'unitTorpedo', [UNIT_WARP]: 'unitWarp', [UNIT_SHIELD]: 'unitShield', [UNIT_PHASER]: 'unitPhaser',
};
/** Combat::unitDamaged (damage.cpp:135-170): on the Enterprise, someone says what's been hit. */
export function unitDamaged(ctx: BattleContext, b: BattleState, ship: CombatShip, def: ShipUnit): void {
  if (!isEnterprise(ship)) return;
  const cue = UNIT_CUES[def.type];
  if (cue !== undefined) playCue(b, cueId(ctx, cue));
}

/** The ship's damage materials (createShip, combat.cpp:380-382): its kind's `<base>.dmg`, if it has damage textures. */
function damageMaterials(ctx: BattleContext, ship: CombatShip): readonly boolean[] | undefined {
  if (!(ship.flags & SHIP_FLAGS.damageTextures)) return undefined;
  return ctx.combat.damageMaterials?.[`${ctx.combat.kinds[ship.type]!.base}.dmg`];
}
/** Combat::damageTexture (damage.cpp:172-183): one of the ship's textures is swapped for its damaged one. */
export function damageTexture(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const materials = damageMaterials(ctx, ship);
  if (!materials || materials.length < 2) return;
  const index = roll(ctx, b, materials.length - 1, 'damage.cpp:175');
  if (!materials[index]) return;
  if (ship.damagedMaterials.includes(index)) return;
  ship.damagedMaterials.push(index);
}

/** Combat::phaserHit (damage.cpp:185-253): `energy` on a shield; what gets through reaches the units behind it, deck by deck. */
export function phaserHit(ctx: BattleContext, b: BattleState, ship: CombatShip, shield: number, energy: number): void {
  const enterprise = isEnterprise(ship);
  if (enterprise) playCue(b, odd(b) ? cueId(ctx, 'phaserHitOdd') : cueId(ctx, 'phaserHitEven'), 0, true);
  const s = shieldUnit(ctx, ship, shield);
  if (s === null) return;
  const defs = unitDefs(ctx, ship);
  const sh = ship.systems.units[s]!;
  // (weak shields ignore small hits, damage.cpp:193: a quirk, kept)
  if (sh.current < 40 && sh.current >= Math.trunc(energy / 2)) return;
  const name = enterprise ? shieldName(ctx, shield) : defs[s]!.name;

  if (sh.current >= energy) {
    // the shield holds
    sh.current -= energy;
    if (enterprise) playCue(b, cueId(ctx, 'shieldHolds'), 0, true);
    if (ship.logTime < b.now) {
      logMessage(ship, `Shield ${name} holding at ${f42(sh.current / 1.334)}`);
      ship.logTime = b.now + combatTicks(0x369);
    }
    // but something may be shaken loose ((int)((80 - current) * 0.3125 + 25), in double), even by a hit of 0 energy
    // (damage.cpp:207: a quirk, kept)
    if (roll(ctx, b, 100, 'damage.cpp:207') < Math.trunc((80 - sh.current) * 0.3125 + 25)) {
      const unit = concussion(ctx, b, ship, shield, 0);
      if (unit !== null) unitDamaged(ctx, b, ship, defs[unit]!);
    } else if (enterprise) {
      playCue(b, cueId(ctx, 'shieldHoldsUnshaken'));
    }
    afterHit(ctx, b, ship);
    return;
  }

  // it gets through
  explode(ctx, b, ship);
  cameraEvent(b, ship, 3);
  damageTexture(ctx, b, ship);
  if (enterprise) playEffect(b, ship, odd(b) ? 'hullhit1.mac' : 'hullhit2.mac');
  energy -= sh.current;
  sh.current = sh.target = 0;
  if (ship.logTime < b.now) {
    logMessage(ship, `Shield ${name} penetrated.`);
    ship.logTime = b.now + combatTicks(0x246);
  }
  const k = 35 - FRAME_RATE;
  for (let depth = 0; depth < 4 && energy > 0; depth++) {
    energy -= Math.trunc((roll(ctx, b, k, 'damage.cpp:232') + roll(ctx, b, k, 'damage.cpp:232') + roll(ctx, b, k, 'damage.cpp:232')) / 3);
    if (energy <= 0) break;
    const i = pickUnit(ctx, b, ship, shield, depth);
    if (i === null) continue;
    const def = defs[i]!, u = ship.systems.units[i]!;
    const m = Math.trunc((roll(ctx, b, def.maxDamage, 'damage.cpp:238') + roll(ctx, b, def.maxDamage, 'damage.cpp:238') + roll(ctx, b, def.maxDamage, 'damage.cpp:238')) / 3);
    const weight = unitHitWeight(def, u);
    // ((int)(m * ((int)(energy / (2.0f * MAX(hitWeight, 1))) >> 1)): a float quotient)
    let damage = m * (Math.trunc(fr(fr(energy) / fr(2 * Math.max(weight, 1)))) >> 1);
    // (some systems' base damage is more than they can take)
    damage = Math.min(Math.max(damage, def.baseDamage), def.maxDamage);
    logMessage(ship, `Unit ${def.name} damaged`);
    u.damage = Math.min(u.damage + damage, def.maxDamage);
    u.current = 0;
    u.target = 0;
    energy -= weight;
    u.hitWeight = 1;
    unitDamaged(ctx, b, ship, def);
  }
  if (energy > 0) critical(ctx, b, ship, true);
  afterHit(ctx, b, ship);
}

/** Combat::torpedoHit (damage.cpp:255-337): a strong shield repels a torpedo; else it reaches the decks, or the core. */
export function torpedoHit(ctx: BattleContext, b: BattleState, ship: CombatShip, shield: number): void {
  const enterprise = isEnterprise(ship);
  if (enterprise) playCue(b, cueId(ctx, 'torpedoStrikes'), 0, true);
  const s = shieldUnit(ctx, ship, shield);
  if (s === null) return;
  const defs = unitDefs(ctx, ship);
  const sh = ship.systems.units[s]!, shDef = defs[s]!;
  const sName = enterprise ? shieldName(ctx, shield) : shDef.name;
  if (sh.current > 19) {
    // it's repelled, and can take the shield below 0 (damage.cpp:265: a quirk, kept)
    sh.current -= 25;
    if (ship.torpedoLogTime < b.now) {
      logMessage(ship, `Photon torpedo repelled by ${sName}`);
      ship.torpedoLogTime = b.now + combatTicks(0x246);
      // (damage.cpp:270: the two "holding" cues of phaserHit, damage.cpp:200, 212)
      if (enterprise) playCue(b, odd(b) ? cueId(ctx, 'shieldHoldsUnshaken') : cueId(ctx, 'shieldHolds'));
    }
    afterHit(ctx, b, ship);
    return;
  }

  if (ship.torpedoLogTime < b.now) {
    logMessage(ship, `Photon torpedo penetrated ${sName}`);
    ship.torpedoLogTime = b.now + combatTicks(0x246);
  }
  let r = roll(ctx, b, 100, 'damage.cpp:280');
  if (sh.damage > 2 * shDef.maxDamage) r += 25;
  damageTexture(ctx, b, ship);
  if (enterprise) playEffect(b, ship, odd(b) ? 'hullhit1.mac' : 'hullhit2.mac');
  // a ship which can't escape may be finished off
  if (sh.damage >= shDef.maxDamage - 5 && Math.abs(ship.speed) < 1 && r < 50) {
    destroy(ctx, b, ship);
    afterHit(ctx, b, ship);
    return;
  }

  let depth = 0;
  if (r < 75) {
    logMessage(ship, `Photon penetration of deck ${roll(ctx, b, 8, 'damage.cpp:295')}.`);
    if (r < 25) {
      depth = 0;
      const unit = concussion(ctx, b, ship, shield, 0);
      if (unit !== null) unitDamaged(ctx, b, ship, defs[unit]!);
    } else if (r < 50) {
      depth = 1;
      concussion(ctx, b, ship, shield, 0);
      const unit = concussion(ctx, b, ship, shield, 1);
      if (unit !== null) unitDamaged(ctx, b, ship, defs[unit]!);
    } else {
      depth = 2;
      const unit = concussion(ctx, b, ship, shield, 2);
      if (unit !== null) unitDamaged(ctx, b, ship, defs[unit]!);
    }
  } else if (r > 75) {
    logMessage(ship, 'Photon penetration of ship core.');
    critical(ctx, b, ship, false);
    if (!alive(ship)) {
      afterHit(ctx, b, ship);
      return;
    }
  }

  const i = pickUnit(ctx, b, ship, shield, depth);
  if (i !== null) {
    const def = defs[i]!, u = ship.systems.units[i]!;
    const q = roll(ctx, b, 100, 'damage.cpp:324');
    if (q < 20) {
      logMessage(ship, 'Weapon blast was ineffective.');
    } else {
      if (q < 60) u.damage = def.maxDamage;
      else u.damage += Math.trunc((roll(ctx, b, def.maxDamage, 'damage.cpp:331') + roll(ctx, b, def.maxDamage, 'damage.cpp:331') + roll(ctx, b, def.maxDamage, 'damage.cpp:331')) / 3);
      u.current = 0;
      logMessage(ship, `Unit ${def.name} damaged by photon blast.`);
    }
  }
  afterHit(ctx, b, ship);
}

/** The units "All major systems offline" leaves repairable (damage.cpp:373-381). */
const MAJOR = new Set([UNIT_POWER_GRID, UNIT_MATTER_ANTIMATTER, UNIT_FUSION, UNIT_IMPULSE, UNIT_LIFE_SUPPORT, UNIT_WARP]);

/** Combat::critical (damage.cpp:339-411): shields, phasers, every major system, the reactors, or the ship itself. */
export function critical(ctx: BattleContext, b: BattleState, ship: CombatShip, gated: boolean): void {
  if (gated && roll(ctx, b, 30, 'damage.cpp:340') > 40 - FRAME_RATE) return;
  const enterprise = isEnterprise(ship);
  const defs = unitDefs(ctx, ship);
  const units = ship.systems.units;

  if (roll(ctx, b, 100, 'damage.cpp:345') < 20) {
    logMessage(ship, 'Shields temporarily offline');
    units.forEach((u, i) => {
      if (defs[i]!.type !== UNIT_SHIELD) return;
      u.current = u.target = 0;
      if (roll(ctx, b, 8, 'damage.cpp:351') === 3) u.damage = roll(ctx, b, defs[i]!.maxDamage, 'damage.cpp:352');
    });
    playCue(b, enterprise ? cueId(ctx, 'criticalShields') : cueId(ctx, 'criticalShieldsOther'));
  }
  if (roll(ctx, b, 100, 'damage.cpp:356') < 20) {
    logMessage(ship, 'Phasers offline');
    units.forEach((u, i) => {
      if (defs[i]!.type !== UNIT_PHASER) return;
      u.current = u.target = 0;
      u.damage = defs[i]!.maxDamage;
      damageTexture(ctx, b, ship);
    });
    if (enterprise) playCueAfter(b, cueId(ctx, 'criticalPhasers'));
  }
  if (roll(ctx, b, 100, 'damage.cpp:368') < 15) {
    logMessage(ship, 'All major systems offline');
    units.forEach((u, i) => {
      const def = defs[i]!;
      if (MAJOR.has(def.type)) {
        u.current = u.target = 0;
        u.damage = roll(ctx, b, def.maxDamage, 'damage.cpp:380');
      } else {
        // (every other unit is left fully damaged, damage.cpp:382-384: a quirk, kept)
        u.damage = def.maxDamage;
      }
      damageTexture(ctx, b, ship);
      damageTexture(ctx, b, ship);
    });
    if (enterprise) {
      playCue(b, cueId(ctx, 'systemsOffline'));
      playCueAfter(b, cueId(ctx, 'systemsOfflineAfter'), true);
    } else {
      playCue(b, cueId(ctx, 'systemsOfflineOther'));
    }
  }
  for (let reactor = 0; reactor < 2; reactor++) {
    if (roll(ctx, b, 100, 'damage.cpp:397') >= 20) continue;
    logMessage(ship, reactor ? 'Fusion reactor down' : 'Warp reactor down');
    const index = enterprise ? (reactor ? 33 : 34) : (reactor ? 18 : 19);
    const u = units[index];
    if (u) {
      u.current = u.target = 0;
      u.damage = defs[index]!.maxDamage;
    }
    if (enterprise) playCue(b, cueId(ctx, 'reactorDown'));
  }
  if (roll(ctx, b, 100, 'damage.cpp:408') < 15) destroy(ctx, b, ship);
  // (afterHit runs after a destroy too, damage.cpp:409-410, and does nothing for a destroyed ship: kept)
  afterHit(ctx, b, ship);
}

/**
 * Combat::explode (damage.cpp:413-419): one of the four booms, and an explosion's sound. rnd(3) is 0 to 3, so any of
 * the four, and rnd(4) can name `4_explo.mac`, which doesn't exist (damage.cpp:417-418: quirks, kept). `_booms` is never empty.
 */
export function explode(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const booms = ctx.combat.effects.booms;
  if (animationActive(ship.explosion) || booms.length === 0) return;
  ship.flags |= SHIP_STATE.shielding | SHIP_STATE.flashing;
  startAnimation(ctx, ship.explosion, booms[roll(ctx, b, 3, 'damage.cpp:417')] ?? null, combatTicks(0x1e), b.now);
  playEffect(b, ship, `${roll(ctx, b, 4, 'damage.cpp:418')}_explo.mac`);
}

/** Combat::flashShield (damage.cpp:421-433): the hit shield shows; the Enterprise's bridge sometimes flashes red. */
export function flashShield(ctx: BattleContext, b: BattleState, ship: CombatShip, attacker: CombatShip | null, from: V3, shield: number): void {
  const s = shieldUnit(ctx, ship, shield);
  const sprite = ctx.combat.kinds[ship.type]!.effects.shieldSprite;
  if (animationActive(ship.shieldFlash) || s === null || ship.systems.units[s]!.current <= 0 || animationFrames(ctx, sprite) === 0) return;
  ship.flags |= SHIP_STATE.shielding;
  startAnimation(ctx, ship.shieldFlash, sprite, combatTicks(0x48), b.now);
  ship.shieldAttacker = attacker ? attacker.index : null;
  ship.shieldFrom = { ...from };
  playEffect(b, ship, 'sheldht2.mac');
  if (isEnterprise(ship) && nextRoll(ctx, b, 'damage.cpp:431') < 0x4000) b.console.redFlash = true;
}

/** Combat::updateEffects (damage.cpp:435-460): the shield turns to face whoever hit it; the explosion plays out. */
export function updateEffects(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (animationActive(ship.shieldFlash)) {
    const from = ship.shieldAttacker !== null ? b.ships[ship.shieldAttacker]!.pos : ship.shieldFrom;
    const d = sub(from, ship.pos);
    // (sqrtf(d.x * d.x + d.y * d.y): fma(d.x, d.x, d.y * d.y); the angles are already within 0x3fff, so ScummVM's unmasked a0 and a1, damage.cpp:442-443, are angleToRadians': a quirk, kept)
    ship.shieldAngles = [angleFromSinCos(d.x, d.y), angleFromSinCos(d.z, sqrtf(fma32(d.x, d.x, fr(d.y * d.y))))];
    const [a0, a1] = ship.shieldAngles;
    ship.shieldImpact = add(ship.pos, scale(v3(fr(sinAngle(a0) * cosAngle(a1)), fr(cosAngle(a0) * cosAngle(a1)), sinAngle(a1)), ship.radius));
    if (advanceAnimation(ctx, ship.shieldFlash, b.now)) {
      stopAnimation(ship.shieldFlash);
      ship.flags &= ~SHIP_STATE.shielding;
    }
  }
  if (animationActive(ship.explosion)) {
    const last = animationFrames(ctx, ship.explosion.frames) - 1;
    const frame = ship.explosion.frame;
    if (advanceAnimation(ctx, ship.explosion, b.now)) {
      stopAnimation(ship.explosion);
      ship.flags &= ~SHIP_STATE.flashing;
    } else if (frame !== last && ship.explosion.frame === last) {
      damageTexture(ctx, b, ship);
    }
  }
}

/**
 * Combat::destroy (damage.cpp:462-563): the ship breaks up into six pieces of debris, and a self-destruct takes its
 * target with it. A conversation the destroyed hook starts holds the explosion back 5 s (damage.cpp:473-477): that's
 * HookResult.hailPending, `_vm->_pendingHail.type == 7` after the hook, which is left set only when processHails bailed
 * because the Enterprise is gone or dying (tactical.cpp:383-384; case 7 is :381); otherwise processHails ran the conversation and
 * cleared it. Plan 22's seams set it so. ScummVM's `ship->source` test (damage.cpp:471) is the seam's: without an
 * object it runs nothing and leaves nothing pending.
 */
export function destroy(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if ((ship.flags & SHIP_STATE.dying) || ship.destroyed) return;
  setView(b, ship.index, VIEW.target);
  ship.decloakTime = 0;

  if (isEnterprise(ship)) {
    const target = shipTarget(b, ship);
    if (alive(target)) runEventHook(ctx, b, target, 7);
  } else if (!(ship.hooksRun & (1 << 11))) {
    const after = runEventHook(ctx, b, ship, 11);
    // (a conversation holds the explosion back a little)
    if (after.hailPending && !ship.removeTime) {
      ship.removeTime = b.now + combatTicks(0x5af);
      return;
    }
  }
  if (ship.destroyed) return;

  // it breaks up
  cameraEvent(b, ship, 2);
  const kind = ctx.combat.kinds[ship.type]!;
  const debris: Debris = { ship: ship.index, pieces: [], scale: 1, alpha: -1, fadeTime: 0, removeTime: 0 };
  const enterprise = b.ships[0];
  if (!(ship.flags & SHIP_FLAGS.debris) && enterprise && enterprise.radius > 0) debris.scale = fr(ship.radius / enterprise.radius);
  for (let i = 0; i < 6; i++) {
    const angles: [number, number, number] = [0, 0, 0];
    const rates: [number, number, number] = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      angles[j] = ship.angles[j]!;
      rates[j] = roll(ctx, b, 0xa80, 'damage.cpp:505') - 0x564;
    }
    // (ship->velocity * 2.0f + Vector3((int)rnd(500) - 250.0f, ...): the three rolls left to right)
    const x = roll(ctx, b, 500, 'damage.cpp:507') - 250, y = roll(ctx, b, 500, 'damage.cpp:507') - 250, z = roll(ctx, b, 500, 'damage.cpp:508') - 250;
    const velocity = add(scale(ship.velocity, 2), v3(x, y, z));
    const boomTime = b.now + combatTicks(roll(ctx, b, 0x246, 'damage.cpp:509'));
    debris.pieces.push({
      // (base.pcN: the kind's own pieces, or the generic ones, as the lift resolved them)
      model: kind.models.debris[i] ?? null, pos: { ...ship.pos }, velocity, angles, rates,
      boom: anim(), boomTime, boomStarted: false,
    });
  }
  debris.fadeTime = b.now + FADE_TIME;
  debris.removeTime = b.now + DESTROYED_TIME;
  b.debris.push(debris);

  ship.destroyed = true;
  ctx.seams.deactivate(ctx, b, ship);
  explode(ctx, b, ship);
  playCue(b, cueId(ctx, 'destroyed'), 0, true);
  playCue(b, cueId(ctx, 'destroyedLater1'), combatTicks(0x246));
  playCue(b, cueId(ctx, 'destroyedLater2'), combatTicks(0x369));
  playCue(b, cueId(ctx, 'destroyedLater3'), combatTicks(0x48c), true);
  playCue(b, cueId(ctx, 'destroyedLater4'), combatTicks(0x5af));
  ship.flags |= SHIP_STATE.dying;
  for (const bank of ship.banks) {
    bank.active = false;
    stopAnimation(bank.beam);
  }
  ship.activeBeams = 0;
  if (isEnterprise(ship)) b.silenced = true;

  // a self-destruct takes the target with it
  const target = shipTarget(b, ship);
  if ((ship.flags & SHIP_FLAGS.blast) && alive(target)) {
    // (damage.cpp:539-545 is hitShield's fold, written out again)
    const shield = hitShield(ship, target);
    let total = 0, max = 0;
    for (const u of ship.systems.units) {
      total += u.current;
      max += u.max;
    }
    const power = max ? Math.trunc((total * 100) / max) * 64 : 0;
    // ((float)((int)distance(ship, target) / 2): half the distance's)
    const energy = phaserEnergy(fr(Math.trunc(Math.trunc(distance(ship, target)) / 2)), power);
    // (the blast is the destroyed ship's damage: Story quarters it on the Enterprise, by the user's ruling on Plan 23 Task 4 review finding 1)
    for (let i = 0; i < 3; i++) storyHit(ctx, ship, target, () => phaserHit(ctx, b, target, shield, energy));
  }
  logMessage(ship, 'SHIP DESTROYED');
  ship.logFrozen = true;
}

/** Combat::updateDebris (damage.cpp:565-596): the pieces fly, spin, blow up and fade; then the ship is gone. */
export function updateDebris(ctx: BattleContext, b: BattleState): void {
  const booms = ctx.combat.effects.booms;
  for (let i = 0; i < b.debris.length; i++) {
    const debris = b.debris[i]!;
    for (const piece of debris.pieces) {
      // ((int)(angles[k] + rates[k] * dt) & 0x3fff, damage.cpp:572: a float angle truncated and masked each step, a quirk kept; fma(rates[k], dt, angles[k]))
      for (let k = 0; k < 3; k++) piece.angles[k] = Math.trunc(fma32(piece.rates[k]!, STEP_SECONDS, piece.angles[k]!)) & 0x3fff;
      piece.pos = add(piece.pos, scale(piece.velocity, STEP_SECONDS));
      if (!piece.boomStarted && b.now > piece.boomTime && booms.length > 0) {
        piece.boomStarted = true;
        startAnimation(ctx, piece.boom, booms[roll(ctx, b, 3, 'damage.cpp:576')] ?? null, combatTicks(0x1e), b.now);
        playCue(b, cueId(ctx, 'debrisBoom'), combatTicks(0x48), true);
      }
      if (animationActive(piece.boom) && advanceAnimation(ctx, piece.boom, b.now)) stopAnimation(piece.boom);
    }
    // the pieces fade away
    if (b.now > debris.fadeTime) {
      debris.alpha = debris.alpha < 0 ? 0x222 : debris.alpha + 0x222;
      if (debris.alpha > 0x3ddd) debris.alpha = 0x4000;
    }
    if (b.now > debris.removeTime) {
      const ship = b.ships[debris.ship]!;
      b.debris.splice(i--, 1);
      removeShip(ctx, b, ship);
      if (b.exitCode !== NO_EXIT) return;
    }
  }
}

/** Combat::removeShip (damage.cpp:598-618): the debris is gone; Worf says so; losing the Enterprise ends the game. */
export function removeShip(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  ship.removed = true;
  if (ship.index === b.target) {
    nextTarget(b, 1);
    if (liveShips(b) < 2) setTarget(b, null);
  }
  // Worf says so (kDestroyedCues, damage.cpp:607-609, lifted as each kind's destroyedCue)
  const cue = ctx.combat.kinds[ship.type]!.destroyedCue;
  if (cue !== -1) playCue(b, cue, 0, true);
  runDestroyedHook(ctx, b, ship);
  // losing the Enterprise is the end of the game as its debris goes, not as it's hit (kShipGameEnd | 0x100, damage.cpp:615-617: a quirk, kept)
  if (isEnterprise(ship)) b.exitCode = GAME_OVER_EXIT;
}

/** Combat::collide (damage.cpp:620-638): ships that touch hit each other's shields, and may break up. Plan 21's avoidCollision calls it. */
export function collide(ctx: BattleContext, b: BattleState, a: CombatShip, c: CombatShip): void {
  const r = Math.min(a.radius, c.radius);
  const d = distance(a, c);
  if (r <= d) return;
  logMessage(a, 'Collision Imminent');
  // (not routed through storyHit, by the user's ruling on Plan 23 Task 4 review finding 1: both ships take this damage and neither deals it)
  for (const ship of [a, c]) {
    const cloaked = ship.decloakTime !== 0 && !isEnterprise(ship) && (ship.flags & SHIP_FLAGS.canCloak) !== 0;
    // (phaserHit(ship, rnd(5), cloaked ? rnd(2000) + 2000 : rnd(200) + 200): the shield's roll first)
    const shield = roll(ctx, b, 5, 'damage.cpp:630');
    phaserHit(ctx, b, ship, shield, cloaked ? roll(ctx, b, 2000, 'damage.cpp:630') + 2000 : roll(ctx, b, 200, 'damage.cpp:630') + 200);
  }
  for (const ship of [a, c]) {
    if (r > fr(2 * d) && roll(ctx, b, 5, 'damage.cpp:633') === 2) destroy(ctx, b, ship);
    else explode(ctx, b, ship);
  }
}

/** Combat::strengthBucket (damage.cpp:640-654): how the battle's going for the Enterprise, as the hook number 5, 6, 7, 9 or 10. */
export function strengthBucket(b: BattleState, ship: CombatShip): number {
  const e = b.ships[0];
  if (!e) return 5;
  const d = isEnterprise(ship) ? e.condition - (e.target !== null ? b.ships[e.target]!.condition : 0) : e.condition - ship.condition;
  if (Math.abs(d) < 29) return 5;
  if (d <= -29) return d < -49 ? 9 : 6;
  return d < 50 ? 7 : 10;
}

/**
 * Combat::runEventHook (damage.cpp:656-673): each hook once a ship; the script is the world's (eventScript). A ship
 * without its object returns before the hook is marked run, as ScummVM's does (:658-659; Plan 23 R5).
 */
export function runEventHook(ctx: BattleContext, b: BattleState, ship: CombatShip, hook: number): HookResult {
  if (!ctx.seams.hasSource(ctx, b, ship) || (ship.hooksRun & (1 << hook))) return NO_HOOK;
  ship.hooksRun |= 1 << hook;
  return ctx.seams.eventScript(ctx, b, ship, hook);
}

/**
 * hailResponse's bookkeeping (damage.cpp:675-682): the bucket whose script answers, marked run, or null when the ship
 * has no object or the bucket's has run already (each bucket once; no mark without an object, Plan 23 R5).
 */
export function hailBucket(ctx: BattleContext, b: BattleState, ship: CombatShip): number | null {
  const bucket = strengthBucket(b, ship);
  if (!ctx.seams.hasSource(ctx, b, ship) || (ship.hooksRun & (1 << bucket))) return null;
  ship.hooksRun |= 1 << bucket;
  return bucket;
}

/** Combat::hailResponse (damage.cpp:675-694): what they say to a hail depends on how the battle's going; each bucket once. TacticalScreen::hail calls it. */
export function hailResponse(ctx: BattleContext, b: BattleState, ship: CombatShip): boolean {
  const bucket = hailBucket(ctx, b, ship);
  return bucket !== null && ctx.seams.hailScript(ctx, b, ship, bucket).answered;
}

/** Combat::afterHit (damage.cpp:696-716): the hull-low script once the condition is under its threshold, then the bucket's hook. Nothing for a ship without its object (:698-699). */
export function afterHit(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  if (!ctx.seams.hasSource(ctx, b, ship) || ship.destroyed) return;
  if (ship.condition > 0 && ship.condition < ship.hullLowThreshold) ctx.seams.hullLowScript(ctx, b, ship);
  runEventHook(ctx, b, ship, strengthBucket(b, ship));
}

/**
 * Combat::runDestroyedHook (damage.cpp:718-732): the world's (destroyedScript); TacticalScreen::endCombat calls it too
 * (Plan 22). Nothing for a ship without its object (:719; Plan 23 R5).
 */
export function runDestroyedHook(ctx: BattleContext, b: BattleState, ship: CombatShip): HookResult {
  if (!ctx.seams.hasSource(ctx, b, ship)) return NO_HOOK;
  return ctx.seams.destroyedScript(ctx, b, ship);
}

/** damage.cpp's seams (types.ts CombatSeams). */
export const DAMAGE_SEAMS: Pick<CombatSeams, 'destroy' | 'updateEffects' | 'updateDebris'> = Object.freeze({ destroy, updateEffects, updateDebris });
