// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipContent, ShipUnit } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import { newRandom, nextRandom, rnd, seedRandom, type RandomState } from './combat/random';

/**
 * The ship's units, as the lifted data gives them (ship.cpp), their live state (levels, damage, repairs, the power pool) and the ship systems' tick,
 * which ShipSystems::tick (ship.cpp:101-212) runs from the bridge, astrogation, the computer and engineering; and astrogation's random numbers.
 */

export const UNIT_PHASER = 1, UNIT_TORPEDO = 2, UNIT_IMPULSE = 3, UNIT_WARP = 4, UNIT_FUSION = 5, UNIT_MATTER_ANTIMATTER = 6, UNIT_SHIELD = 7;
export const UNIT_SENSOR = 8, UNIT_TRACTOR = 9, UNIT_LIFE_SUPPORT = 10, UNIT_COMPUTER = 11, UNIT_POWER_GRID = 13, UNIT_ALL = 0x100e;

/** What the ship starts with and what torpedoes cost (ship.cpp:35-42). */
export const STARTING_POWER = 2400, STARTING_TORPEDOES = 275, TORPEDO_LOAD_COST = 25, TORPEDO_UNLOAD_RETURN = 20;
/** The original's clock runs this many ticks a second (ship.cpp:34); ours, TICKS_PER_SECOND. */
const ORIGINAL_TICKS_PER_SECOND = 291.3;

/** One unit's live state: a unit's name, type and the like are the content's (the same index). */
export interface UnitState {
  current: number; target: number; max: number;
  damage: number; repair: number; efficiency: number;
  /** The tick of the next charging step and the next repair step; 0 until the first tick. */
  nextStep: number; nextRepair: number;
  /**
   * Combat's working fields, which ShipUnit keeps but ShipSystems::sync never saves (ship.cpp:267-284): the hit
   * weight a penetrating hit sets to 1 (damage.cpp:247), and the power Delegate gives the unit and its cap
   * (ship.h:65), which the weapons lock, the shields and the power levels set (weapons.cpp:621, 642, 655, 670-671).
   * Absent until combat sets them. Absent means the template's values: its hit weight (unitHitWeight), and for
   * aiTarget and aiCap the TEMPLATE's max, unscaled: ship.cpp:81 runs as the template loads, before createShip scales
   * a ship's max by its strength (combat.cpp:370-377). ScummVM only writes aiTarget and aiCap (ship.cpp:81;
   * weapons.cpp:621, 642, 655, 670-671) and never reads them.
   */
  hitWeight?: number; aiTarget?: number; aiCap?: number;
}

/** The ship's systems (ShipSystems): every unit, the power available to them, the torpedoes in store and the reactors' last output. */
export interface SystemsState {
  units: UnitState[];
  pool: number;
  torpedoes: number;
  matterAntimatterOutput: number;
  fusionOutput: number;
  lastReactorTick: number;
  lastTick: number;
}

/** ShipSystems::reset (ship.cpp:77-83), and a new game's: every unit as the executable has it. */
export function newSystems(c: ShipContent | undefined): SystemsState {
  return {
    units: (c?.data.units ?? []).map(u => ({
      current: u.current, target: u.target, max: u.max, damage: u.damage, repair: u.repair,
      // (ShipSystems::load reads every unit's, ship.cpp:77)
      efficiency: u.efficiency,
      nextStep: 0, nextRepair: 0,
    })),
    pool: STARTING_POWER,
    torpedoes: STARTING_TORPEDOES,
    matterAntimatterOutput: 0,
    fusionOutput: 0,
    lastReactorTick: 0,
    lastTick: 0,
  };
}

/** ShipUnit::hitWeight: what combat has set (damage.cpp:247), else the lifted template's (ship.cpp:79; combatDataProblems makes sure there is one). */
export function unitHitWeight(def: ShipUnit, u: UnitState): number {
  return u.hitWeight ?? def.hitWeight ?? 0;
}

/** ShipSystems::sensorOutput (ship.cpp:238-247): the sensors' power as a percentage of their most, roundf((float)). */
export function sensorOutput(defs: readonly ShipUnit[], s: SystemsState): number {
  let current = 0, max = 0;
  defs.forEach((def, i) => {
    if (def.type !== UNIT_SENSOR) return;
    current += s.units[i]!.current;
    max += s.units[i]!.max;
  });
  // (roundf of the float current * 100.0f / max: halves away from zero; neither is negative)
  return current && max ? Math.round(Math.fround(Math.fround(current * 100) / max)) : 0;
}

/** A unit as the rules read it: the content's name and type with the live levels (or the content's own, with no state). */
export interface LiveUnit { name: string; type: number; current: number; max: number }

export function liveUnits(c: ShipContent, live?: SystemsState): LiveUnit[] {
  return c.data.units.map((u, i) => {
    const s = live?.units[i];
    return { name: u.name, type: u.type, current: s ? s.current : u.current, max: s ? s.max : u.max };
  });
}

/** ShipUnit::percent (ship.h:69): `max ? current * 100 / max : 0`, in integers. */
export function unitPercent(u: { current: number; max: number }): number {
  return u.max ? Math.trunc(u.current * 100 / u.max) : 0;
}

/** ShipSystems::typePercent (ship.cpp:214-226): the average, or with `best` the best, of a type's units. */
export function typePercent(c: ShipContent, type: number, best: boolean, live?: SystemsState): number {
  let total = 0, count = 0, top = 0;
  for (const u of liveUnits(c, live)) {
    if (u.type !== type) continue;
    total += unitPercent(u);
    top = Math.max(top, unitPercent(u));
    count++;
  }
  if (!count) return 0;
  return best ? top : Math.trunc(total / count);
}

/** ShipSystems::computerPercent (ship.cpp:263-265): the best of the computer units. */
export function computerPercent(c: ShipContent, live?: SystemsState): number {
  return typePercent(c, UNIT_COMPUTER, true, live);
}

// ---- the tick (ship.cpp:101-212) ---------------------------------------------------------------------------

/** ticksToMillis (ship.cpp:43-45): the original's ticks as milliseconds, truncated. */
function ticksToMillis(ticks: number): number {
  return Math.trunc(ticks * 1000 / ORIGINAL_TICKS_PER_SECOND);
}

/** The clock a ship's systems tick on: its units a second, and a span of milliseconds in its units. */
export interface SystemsClock { perSecond: number; ms(n: number): number }
/** The ship's own clock: the sim's ticks, the original's milliseconds rounded up (Plan 11 R1). */
export const SHIP_CLOCK: SystemsClock = { perSecond: TICKS_PER_SECOND, ms: n => Math.ceil(n * TICKS_PER_SECOND / 1000) };
/** Combat's clock: milliseconds, as ScummVM's (combat.cpp:409-419 steps on g_system->getMillis()). */
export const MS_CLOCK: SystemsClock = { perSecond: 1000, ms: n => n };

/** The original's ticks as ours, through milliseconds as everywhere (Plan 11 R1). */
export function originalTicks(n: number): number {
  return SHIP_CLOCK.ms(ticksToMillis(n));
}

/** ShipSystems::tick: reactors fill the grid twice a second, then each unit repairs and charges. A long gap means the clock was stopped. */
export function tickSystems(c: ShipContent, s: SystemsState, now: number): void {
  tickUnits(c.data.units, s, now, SHIP_CLOCK);
}

/**
 * ShipSystems::tick (ship.cpp:109-121) over any ship's units (`defs`, the same index as `s.units`) on either clock: combat
 * ticks every ship's on MS_CLOCK. The gaps are uint32s, as ScummVM's: a last tick ahead of `now` (a retime between the
 * clocks that left it so) is a long gap, which starts the units afresh (Plan 23).
 */
export function tickUnits(defs: readonly ShipUnit[], s: SystemsState, now: number, clock: SystemsClock): void {
  if (!s.lastTick || ((now - s.lastTick) >>> 0) > clock.ms(1000)) {
    for (const u of s.units) u.nextStep = u.nextRepair = now;
    s.lastReactorTick = now;
  }
  s.lastTick = now;
  tickReactors(defs, s, now, clock);
  defs.forEach((def, i) => tickUnit(def, s.units[i]!, s, now, clock));
}

/** ShipSystems::tickReactors (ship.cpp:123-153). */
function tickReactors(defs: readonly ShipUnit[], s: SystemsState, now: number, clock: SystemsClock): void {
  // twice a second, the reactors fill the power grid (the gap a uint32, as tick's)
  const gap = (now - s.lastReactorTick) >>> 0;
  if (gap < clock.ms(500)) return;
  const fraction = Math.min(gap / clock.perSecond, 1);
  s.lastReactorTick = now;
  s.matterAntimatterOutput = s.fusionOutput = 0;
  let grid = -1;
  defs.forEach((def, i) => {
    const u = s.units[i]!;
    if (def.type === UNIT_POWER_GRID) grid = i;
    if ((def.type !== UNIT_FUSION && def.type !== UNIT_MATTER_ANTIMATTER) || u.damage || !u.max) return;
    // (running flat out gives a little more)
    let rate = u.current / u.max;
    if (rate >= 0.95) rate = (rate - 0.95) * (def.type === UNIT_FUSION ? 16 : 8) + 1;
    const output = Math.trunc(fraction * u.efficiency / 100 * rate * (def.type === UNIT_FUSION ? 100 : 25));
    if (def.type === UNIT_FUSION) s.fusionOutput = output;
    else s.matterAntimatterOutput = output;
  });
  const g = grid >= 0 ? s.units[grid]! : undefined;
  const gd = grid >= 0 ? defs[grid]! : undefined;
  const capacity = g && gd ? Math.trunc(g.max * (gd.maxDamage - g.damage) / Math.max(gd.maxDamage, 1)) : 0;
  s.pool = Math.min(Math.max(s.pool + Math.trunc((s.matterAntimatterOutput + s.fusionOutput) / 2), 0), capacity);
  if (g) g.current = s.pool;
}

/** ShipSystems::tickUnit (ship.cpp:155-212). */
function tickUnit(def: ShipUnit, u: UnitState, s: SystemsState, now: number, clock: SystemsClock): void {
  // repairs cost power, a point a second
  if (now >= u.nextRepair) {
    u.nextRepair = now + clock.ms(1000);
    if (u.repair > 0 && u.damage > 0 && s.pool > 0) {
      u.damage--;
      u.repair--;
      s.pool--;
    }
  }
  // a damaged system is offline until it is repaired
  if (u.damage) {
    u.current = 0;
    return;
  }
  if (now < u.nextStep || def.type === UNIT_POWER_GRID) return;
  const charge = clock.ms(ticksToMillis(def.chargeTicks));
  switch (def.type) {
    case UNIT_TORPEDO:
      u.nextStep = now + charge;
      if (u.current < u.target && s.pool >= TORPEDO_LOAD_COST && s.torpedoes > 0) {
        u.current++;
        s.torpedoes--;
        s.pool -= TORPEDO_LOAD_COST;
      } else if (u.current > u.target) {
        u.current--;
        s.torpedoes++;
        s.pool += TORPEDO_UNLOAD_RETURN;
      }
      break;
    case UNIT_FUSION:
    case UNIT_MATTER_ANTIMATTER:
      // the reactors change their output freely
      u.nextStep = now + charge;
      if (u.current < u.target) u.current++;
      else if (u.current > u.target) u.current--;
      break;
    default:
      // other systems charge from the power grid, and give power back
      if (u.current < u.target && s.pool > 0) {
        u.nextStep = now + charge;
        const step = Math.min(u.target - u.current, s.pool, 5);
        u.current += step;
        s.pool -= step;
      } else if (u.current > u.target) {
        u.nextStep = now + clock.ms(ticksToMillis(Math.trunc(def.chargeTicks / 2)));
        u.current--;
        s.pool++;
      }
      break;
  }
}

/** ShipSystems::setDamage (ship.cpp:95-107): every unit of a type (or all) goes offline; mode 1 repairs it, 2 destroys it. */
export function setDamage(c: ShipContent, s: SystemsState, type: number, mode: 1 | 2): void {
  setUnitsDamage(c.data.units, s, type, mode);
}
/** setDamage over a ship's unit definitions: the Enterprise's in a battle too (the starbase's repair, ai.cpp:321). */
export function setUnitsDamage(defs: readonly ShipUnit[], s: SystemsState, type: number, mode: 1 | 2): void {
  defs.forEach((def, i) => {
    const u = s.units[i];
    if (!u || (type !== UNIT_ALL && def.type !== type)) return;
    u.current = 0;
    if (mode === 1) u.damage = 0;
    else u.damage = def.maxDamage;
    u.repair = Math.min(u.repair, u.damage);
  });
}

/** ShipSystems::reset (ship.cpp:77-83): everything as new, as after a visit to a starbase. */
export function resetSystems(c: ShipContent, s: SystemsState): void {
  Object.assign(s, newSystems(c));
}

/** The slider's width in pixels (engineering.cpp kSliderWidth) and the torpedo cells' (kTorpedoCellsWidth). */
export const SLIDER_WIDTH = 119, TORPEDO_CELLS_WIDTH = 101;

/** What a slider sets: the repair a unit is given, its power target (a reactor's only while it is whole), or the torpedoes to load. */
export type SliderKind = 'repair' | 'power' | 'reactor' | 'torpedoes';

/** EngineeringScreen::setSlider (engineering.cpp:228-250): `x` is the pointer's distance along the slider in pixels, clipped to its width. */
export function setSlider(c: ShipContent, s: SystemsState, unit: number, kind: SliderKind, x: number): void {
  const def = c.data.units[unit], u = s.units[unit];
  if (!def || !u) return;
  x = Math.min(Math.max(Math.trunc(x), 0), SLIDER_WIDTH);
  if (kind === 'torpedoes') {
    u.target = Math.min(Math.trunc(x * 10 / TORPEDO_CELLS_WIDTH), u.max);
  } else if (kind === 'repair') {
    u.repair = Math.min(Math.trunc(def.maxDamage * x / SLIDER_WIDTH), u.damage);
  } else if (kind === 'power') {
    u.target = Math.trunc(u.max * x / SLIDER_WIDTH);
  } else if (!u.damage) {
    // (a reactor cannot be adjusted while it is damaged)
    u.target = Math.trunc(u.max * x / SLIDER_WIDTH);
  }
}

/** AstroRandom (astrogation.h:143-156), for astrogation and the computer: combat's random.ts, over a state of its own. */
export class AstroRandom {
  private readonly r: RandomState = newRandom();
  seed(seed: number): void { seedRandom(this.r, seed); }
  next(): number { return nextRandom(this.r); }
  /** From 0 to n, inclusive. */
  rnd(n: number): number { return rnd(this.r, n); }
}

