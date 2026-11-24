// SPDX-License-Identifier: GPL-3.0-or-later
import type { AstroStar, AstroThing, ShipContent, Universe } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import { AstroRandom, liveUnits, typePercent, unitPercent, type SystemsState } from './shipSystems';
import { enterprise, markMovieSeen, NO_SCENARIO, NOWHERE, sectorOf, type AstroLocation, type Vec3i } from './ship';
import { chooseWarpMovie } from './shipFx';
import { countPlanets, makePlanets, orbitOf, THING } from './planets';
import { startClock, stopClock } from './stations';
import type { World } from './world';
import type { ShipState } from './ship';

// Astrogation's model, ported from engines/unity/astrogation.cpp (read-only reference). The screen, the voices, the
// warp movie (the content names none), the encounters and the region chatter are not here: see the comments below.

/** kMinWarpTime, kMinImpulseTime (astrogation.cpp:36-38): the shortest journeys, in milliseconds. */
export const MIN_WARP_MS = 25000;
export const MIN_IMPULSE_MS = 8500;
/** kLightYear (astrogation.cpp:41): a light year, in the units of the speed tables. */
export const LIGHT_YEAR = 87600000;
/** kMaxImpulseDistance (astrogation.h): the longest journey at impulse. */
export const MAX_IMPULSE_DISTANCE = 512000;
/** kBattleDistance (astrogation.cpp:68): a short journey keeps the battle where it is. */
export const BATTLE_DISTANCE = 3.5;

// the types of things in the universe (astrogation.h:57-70)
const ASTRO_STAR = 0x20, ASTRO_PLANET = 0x21, ASTRO_STARBASE = 0x83;
// ship system types (ship.h:38-49)
const UNIT_IMPULSE = 3, UNIT_WARP = 4, UNIT_FUSION = 5, UNIT_MATTER_ANTIMATTER = 6, UNIT_SENSOR = 8;
/** kChartingSensors (astrogation.cpp:62): the sensors chart what's around them, if they're working. */
const CHARTING_SENSORS = 0x22;

/** R1: the sim converts ScummVM milliseconds to ticks once. */
export function msToTicks(ms: number): number {
  return Math.ceil(ms * TICKS_PER_SECOND / 1000);
}

// ---- the ship's systems (ship.cpp:214-236, 255-266) -------------------------------------------------------

/** ShipSystems::maxWarp (ship.cpp:228-236), R2: over the lifted units, with no damage. 100 means no warp. */
export function maxWarp(c: ShipContent, live?: SystemsState): number {
  const warp = typePercent(c, UNIT_WARP, false, live) * typePercent(c, UNIT_MATTER_ANTIMATTER, false, live) * 1.375 / 100;
  const impulse = typePercent(c, UNIT_IMPULSE, true, live) * typePercent(c, UNIT_FUSION, false, live) * 1.375 / 100;
  const rating = (impulse / 2 + 3.5 * warp) / 4;
  const max = Math.trunc(Math.trunc(rating * 10 + 100) / 10) * 10;
  return Math.min(max, 940);
}

/** ShipSystems::sensorPercent (ship.cpp:252-266): the long range sensors count for half. */
function sensorPercent(c: ShipContent, live?: SystemsState): number {
  let longRange = 0, others = 0;
  for (const u of liveUnits(c, live)) {
    if (u.type !== UNIT_SENSOR) continue;
    if (u.name.toLowerCase().startsWith('long')) longRange = unitPercent(u);
    else others += unitPercent(u);
  }
  return Math.trunc((4 * longRange + others) / 8);
}

// ---- planets (universe.cpp:57-60, 119-135) -----------------------------------------------------------------

/** PlanetMaker::countPlanets (universe.cpp:119-135), R3: how many planets a star has. */
export function planetCount(star: AstroStar): number {
  return countPlanets(star);
}

/** planetOrbit (universe.cpp:57-59): `_planetOrbits[min(position, 15)] * scale / 10`. */
export function planetOrbit(u: Universe, star: AstroStar, i: number): number {
  return orbitOf(u, star.orbitScale, i);
}

// ---- distance and time ------------------------------------------------------------------------------------

/** Astrogation::distanceTo (astrogation.cpp:376-387): the distance in speed-table units, and the light years. */
export function distanceTo(ship: ShipState, to: Vec3i, orbit: number): { distance: number; lightYears: number } {
  const dx = to.x - ship.pos.x, dy = to.y - ship.pos.y, dz = to.z - ship.pos.z;
  const years = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // within a star system, the distance from the star counts too
  const from = ship.orbit * 10000 / 3600, dest = orbit * 10000 / 3600;
  const inSystem = years === 0 ? Math.abs(dest - from) : from + dest;
  return { distance: years * LIGHT_YEAR + inSystem, lightYears: years };
}

export interface AstroTime { years: number; months: number; days: number; hours: number; minutes: number; seconds: number }

/** splitTime (astrogation.cpp:390-395): three units, rounding towards zero as the original does. */
function splitTime(value: number, first: number, second: number, third: number): [number, number, number] {
  const a = Math.trunc(value / first);
  value -= a * first;
  const b = Math.trunc(value / second);
  value -= b * second;
  return [a, b, Math.trunc(value / third)];
}

/** Astrogation::journeyTime (astrogation.cpp:397-450). */
export function journeyTime(u: Universe, speed: number, distance: number): AstroTime {
  const time: AstroTime = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  if (!speed) { time.years = 999; return time; }
  // (warp speeds are the warp factor * 100, from 100)
  let velocity: number;
  if (speed > 10) {
    const index = Math.min(Math.max((Math.trunc(speed / 100) - 1) * 10 + Math.trunc((speed % 100) / 10), 0), u.warpSpeeds.length - 1);
    velocity = u.warpSpeeds[index];
  } else {
    velocity = u.impulseSpeeds[speed - 1];
  }
  // a year is 10000 units, and the hours and so on are in 1/10^8 years
  if (velocity > distance) {
    [time.hours, time.minutes, time.seconds] = splitTime(distance * 10000 / velocity, 11415, 190, 3);
  } else {
    [time.years, time.months, time.days] = splitTime(distance / velocity, 10000, 833, 27);
    const covered = velocity * (time.years * 10000 + time.months * 833 + time.days * 27);
    if (covered < distance) [time.hours, time.minutes, time.seconds] = splitTime((distance - covered) * 10000 / velocity, 11415, 190, 3);
  }
  if (time.seconds >= 60) { time.seconds -= 60; time.minutes++; }
  if (time.minutes >= 60) { time.minutes -= 60; time.hours++; }
  if (time.hours >= 24) { time.hours -= 24; time.days++; }
  if (time.days >= 30) { time.days -= 30; time.months++; }
  if (time.months >= 12) { time.months -= 12; time.years++; }
  return time;
}

/** AstroTime::days360 (astrogation.cpp:452-454). */
export function days360(t: AstroTime): number {
  return t.years * 360 + t.months * 30 + t.days + t.hours / 24 + t.minutes / 1440 + t.seconds / 86400;
}

// ---- courses ----------------------------------------------------------------------------------------------

/**
 * A course the player plots. The original's screen picks a star, a planet, a moon, an outpost, an asteroid belt, a station or a phenomenon
 * (an AstroLocation): `moon` is a planet's moon, and with a star and planet `station` is that planet's outpost or starbase and `phenomenon` its belt.
 */
export interface Course {
  sector: number; star?: number; planet?: number; moon?: number; station?: boolean; phenomenon?: number;
  warp: boolean; speed: number;
  /** retarget's corner of a sector with nothing chosen (astrogation.cpp:1160-1165): used when nothing is at the destination. */
  point?: Vec3i;
}
export type CourseError = 'nothing there' | 'too fast' | 'no warp' | 'too far for impulse';

interface Destination { location: AstroLocation; to: Vec3i; orbit: number; type: number; starId: number }

/** AstrogationScreen::startCourse's destination (astrogation.cpp:1795-1840), for what Plan 11 plots (R3). */
function destinationOf(u: Universe, course: Course, flags: readonly number[]): Destination | CourseError {
  const sector = u.sectors[course.sector];
  if (!sector) return 'nothing there';
  const location: AstroLocation = { ...NOWHERE, sector: course.sector };
  if (course.star !== undefined) {
    if (!Number.isInteger(course.star) || course.star < 0 || course.star >= sector.numStars) return 'nothing there';
    const star = u.stars[sector.firstStar + course.star];
    location.star = course.star;
    let type: number = ASTRO_STAR, orbit = 0;
    const moon = course.moon !== undefined && course.moon >= 0;
    const outpost = course.station === true, belt = course.phenomenon !== undefined && course.phenomenon >= 0;
    if (course.planet !== undefined && course.planet >= 0) {
      const planets = makePlanets(u, star, flags);
      const planet = planets[course.planet];
      if (!Number.isInteger(course.planet) || !planet) return 'nothing there';
      location.planet = course.planet;
      if (moon) {
        const m = planet.moons[course.moon!];
        if (!m) return 'nothing there';
        location.moon = course.moon!;
        type = THING.moon;
        orbit = m.orbit;
      } else if (outpost) {
        // (a star's outpost or starbase, around the planet it is at: the orbit stays 0, startCourse does not set one)
        const special = star.special === -1 ? undefined : u.specials[star.special];
        if (!special || special.planet !== course.planet) return 'nothing there';
        location.station = 0;
        type = special.type;
      } else if (belt) {
        if (!(planet.flags & 1)) return 'nothing there';
        location.phenomenon = 0;
        type = THING.asteroidBelt;
        orbit = planet.orbit;
      } else {
        type = ASTRO_PLANET;
        orbit = planet.orbit;
      }
    } else if (moon || outpost || belt) {
      return 'nothing there';
    }
    return { location, to: { x: star.x, y: star.y, z: star.z }, orbit, type, starId: star.id };
  }
  let thing: AstroThing | undefined;
  if (course.station) {
    location.station = 0;
    thing = sector.station === -1 ? undefined : u.stations[sector.station];
  } else if (course.phenomenon !== undefined) {
    location.phenomenon = course.phenomenon;
    if (course.phenomenon >= 0 && course.phenomenon < sector.numPhenomena) thing = u.phenomena[sector.firstPhenomenon + course.phenomenon];
  }
  if (!thing) {
    // (locationType -1: startCourse goes to the cursor, astrogation.cpp:1793-1795)
    if (course.point) return { location, to: { ...course.point }, orbit: 0, type: -1, starId: 0 };
    return 'nothing there';
  }
  return { location, to: { x: thing.x, y: thing.y, z: thing.z }, orbit: 0, type: thing.type, starId: 0 };
}

/** The plotted course's destination and journey time, for the screen (no state change). */
export function previewCourse(world: World, course: Course): { location: AstroLocation; to: Vec3i; orbit: number; time: AstroTime } | CourseError {
  const ship = world.content.ship;
  if (!ship) throw new Error('this game has no ship');
  const d = destinationOf(ship.universe, course, world.state.ship.flags);
  if (typeof d === 'string') return d;
  const { distance } = distanceTo(world.state.ship, d.to, d.orbit);
  return { location: d.location, to: d.to, orbit: d.orbit, time: journeyTime(ship.universe, course.speed, distance) };
}

function setBattleScenario(world: World, scenario: number): void {
  const ship = world.state.ship;
  if (ship.battleScenario === scenario) return;
  ship.battleScenario = scenario;
  world.bus.emit({ type: 'battleScenario', scenario });
}

function enableTrigger(world: World, id: string): void {
  // (Astrogation::enableTrigger, astrogation.cpp:628-632: an unknown trigger is ignored)
  if (Object.hasOwn(world.state.triggers, id)) world.setTriggerEnabled(id, true);
}

function orFlag(ship: ShipState, id: number, bits: number): void {
  while (ship.flags.length <= id) ship.flags.push(0);
  ship.flags[id] |= bits;
}

/** Astrogation::updateEnterprise (astrogation.cpp:289-294): the Enterprise's object follows the ship. */
function updateEnterprise(world: World): void {
  const o = enterprise(world);
  o.universe = { ...world.state.ship.pos };
  world.bus.emit({ type: 'objectChanged', id: world.content.ship!.data.astro.enterprise });
}

/** Astrogation::locationName (astrogation.cpp:300-314): a place's name; around a star with an outpost, the outpost's; else the sector's. */
export function locationName(u: Universe, loc: AstroLocation): string {
  const sector = u.sectors[loc.sector];
  if (loc.sector < 0 || !sector) return '';
  const star = loc.star >= 0 && loc.star < sector.numStars ? u.stars[sector.firstStar + loc.star] : undefined;
  if (star) return loc.station !== -1 && star.special !== -1 ? u.specials[star.special]?.name ?? '' : star.name;
  const phen = loc.phenomenon >= 0 && loc.phenomenon < sector.numPhenomena ? u.phenomena[sector.firstPhenomenon + loc.phenomenon] : undefined;
  const station = loc.station >= 0 && sector.station !== -1 ? u.stations[sector.station] : undefined;
  return (phen ?? station)?.name ?? sector.name;
}

/** Astrogation::chartSector (astrogation.cpp:364-374): the sensors chart a sector's things, if they're working. */
export function chartSector(world: World, sector: number): void {
  const c = world.content.ship;
  if (!c) return;
  const s = c.universe.sectors[sector];
  if (!s || sensorPercent(c, world.state.ship.systems) <= CHARTING_SENSORS) return;
  const ship = world.state.ship;
  for (let i = 0; i < s.numStars; i++) orFlag(ship, c.universe.stars[s.firstStar + i].id, 1);
  for (let i = 0; i < s.numPhenomena; i++) orFlag(ship, c.universe.phenomena[s.firstPhenomenon + i].id, 1);
  if (s.station !== -1) orFlag(ship, c.universe.stations[s.station].id, 1);
}

/**
 * AstrogationScreen::checkCourse + startCourse + engage (astrogation.cpp:1768-1858) and Astrogation::startTransit
 * (452-480). The voices and the warp movie are presentation; planEncounters (astrogation.cpp:696) is
 * after M4 (spec section 7). Returns why the course is refused, or null once under way.
 */
export function engage(world: World, course: Course): CourseError | null {
  const c = world.content.ship;
  if (!c) throw new Error('this game has no ship');
  const ship = world.state.ship;
  const d = destinationOf(c.universe, course, ship.flags);
  if (typeof d === 'string') return d;
  const { distance, lightYears } = distanceTo(ship, d.to, d.orbit);
  // checkCourse (1768-1790): no distance is no course
  if (distance === 0) return 'nothing there';
  const max = maxWarp(c, ship.systems);
  const canWarp = max !== 100;
  if (course.warp) {
    if (!canWarp) return 'no warp';
    if (course.speed > max) return 'too fast';
  } else if (distance > MAX_IMPULSE_DISTANCE) {
    return 'too far for impulse';
  }
  // (a long journey leaves any battle behind, astrogation.cpp:1853)
  if (lightYears > BATTLE_DISTANCE) setBattleScenario(world, NO_SCENARIO);
  // startTransit: a day of the journey takes a second
  const time = journeyTime(c.universe, course.speed, distance);
  const ms = Math.max(Math.trunc(days360(time) * 1000), course.warp ? MIN_WARP_MS : MIN_IMPULSE_MS);
  const fresh = ship.transit === null;
  // (startTransit: _clockStopped = 0)
  ship.clockStopped = 0;
  ship.transit = {
    from: { ...ship.pos }, to: d.to, orbit: d.orbit, destination: d.location, destType: d.type, destStarId: d.starId,
    warp: course.warp, speed: course.speed, startTick: world.clock.now, ticks: msToTicks(ms),
  };
  ship.location = { ...NOWHERE };
  // (a new journey starts with nothing on the viewscreen, and no battle: updateRegion, astrogation.cpp:525-532, on the
  // first frame of a transit only; re-engaging mid-transit keeps both. The Enterprise's anim_index, which the viewscreen shows
  // when the ship isn't in transit, goes to 0xffff: -1 here, as an alter's stop leaves it)
  if (fresh) {
    const ent = world.state.objects[c.data.astro.enterprise];
    if (ent) ent.anim = -1;
    setBattleScenario(world, NO_SCENARIO);
  }
  world.bus.emit({ type: 'astro', what: 'engage', pos: { ...ship.pos }, orbit: ship.orbit, location: d.location, speed: course.speed, ticks: ship.transit.ticks });
  // (a warp that starts a journey plays a movie, which doesn't count towards it: astrogation.cpp:1855-1856, 797-813)
  // (AstrogationScreen::engage, astrogation.cpp:1850: the record is of the course chosen)
  addSensorRecord(world, d.location);
  if (fresh && course.warp) {
    const movie = chooseWarpMovie(world);
    // (playMovie remembers it for the holodeck, unity.cpp:363-364)
    markMovieSeen(ship, `warp:${movie}`);
    void world.enqueue(async () => {
      stopClock(world);
      try {
        await world.presenter.play({ warpMovie: movie });
      } finally {
        startClock(world);
      }
    });
  }
  return null;
}

/** The sensor records show this many at a time (bridge.cpp kNumSensorRows). */
export const SENSOR_ROWS = 3;
const sameLocation = (a: AstroLocation, b: AstroLocation) =>
  a.sector === b.sector && a.star === b.star && a.planet === b.planet && a.moon === b.moon && a.station === b.station && a.phenomenon === b.phenomenon;

/** Astrogation::addSensorRecord (astrogation.cpp:678-686): the newest goes first, and going to the same place again doesn't count. */
export function addSensorRecord(world: World, location: AstroLocation): void {
  const ship = world.state.ship;
  if (sameLocation(location, ship.lastSensorRecord)) return;
  ship.lastSensorRecord = { ...location };
  ship.sensorRecords.unshift({ ...location });
  ship.sensorScroll = 0;
}

/** BridgeScreen::mouseClick's arrows (bridge.cpp:315-328): one record up or down, unless at the end. Whether it moved. */
export function scrollSensors(world: World, direction: 1 | -1): boolean {
  const ship = world.state.ship;
  if (direction < 0 ? ship.sensorScroll === 0 : ship.sensorScroll + SENSOR_ROWS >= ship.sensorRecords.length) return false;
  ship.sensorScroll += direction;
  return true;
}

/** Astrogation::stopTransit (astrogation.cpp:482-487): the ship stops wherever it's got to, without arriving. */
export function stopTransit(world: World): void {
  const ship = world.state.ship;
  if (!ship.transit) return;
  const t = ship.transit;
  ship.transit = null;
  // (_speed = 0 and _destinationType = -1: the bridge's destination readout goes, astrogation.cpp:482-488)
  ship.locationType = -1;
  world.bus.emit({ type: 'astro', what: 'stop', pos: { ...ship.pos }, orbit: ship.orbit, location: ship.location, speed: t.speed, ticks: t.ticks });
}

/** Astrogation::arrive (astrogation.cpp:602-625). The viewscreen update is Task 6's. */
function arrive(world: World): void {
  const ship = world.state.ship;
  const t = ship.transit!;
  const names = world.content.ship!.data.astro;
  ship.pos = { ...t.to };
  ship.orbit = t.orbit;
  updateEnterprise(world);
  ship.location = t.destination;
  ship.locationType = t.destType;
  ship.transit = null;
  ship.lastSector = sectorOf(world.content.ship!.universe, ship.pos);
  chartSector(world, ship.lastSector);
  if (t.destStarId) orFlag(ship, t.destStarId, 0xc);
  if (t.destType === ASTRO_STARBASE) {
    enableTrigger(world, names.triggers.arriveStarbase);
    setBattleScenario(world, names.starbaseBattle);
  } else if (t.destination.star !== -1 && ship.station !== 'astrogation') {
    enableTrigger(world, names.triggers.arriveStar);
  }
  world.bus.emit({ type: 'astro', what: 'arrive', pos: { ...ship.pos }, orbit: ship.orbit, location: t.destination, speed: t.speed, ticks: t.ticks });
}

/**
 * Astrogation::update (astrogation.cpp:502-523): moves the ship, charts sectors, arrives. updateRegion's chatter
 * (525-600) and the encounters are after M4 (spec section 7).
 */
export function updateAstro(world: World): void {
  const ship = world.state.ship;
  const t = ship.transit;
  if (!t || ship.clockStopped) return;
  const progress = (world.clock.now - t.startTick) / t.ticks;
  if (progress >= 1) { arrive(world); return; }
  const at = (a: number, b: number) => a + Math.floor((b - a) * progress + 0.5);
  ship.pos = { x: at(t.from.x, t.to.x), y: at(t.from.y, t.to.y), z: at(t.from.z, t.to.z) };
  updateEnterprise(world);
  // entering a sector charts it
  const sector = sectorOf(world.content.ship!.universe, ship.pos);
  if (sector !== ship.lastSector) {
    chartSector(world, sector);
    ship.lastSector = sector;
  }
}

/** Astrogation::enter (astrogation.cpp:815-831): the first-visit and second-visit triggers. */
export function enterAstrogation(world: World): void {
  const ship = world.state.ship;
  const { triggers } = world.content.ship!.data.astro;
  const known = (id: string) => Object.hasOwn(world.state.triggers, id);
  // the first time here starts the story, unless that's been and gone
  if (!ship.visits.first) {
    if (known(triggers.runAway) && !world.state.triggers[triggers.runAway].enabled) ship.visits.first = true;
    else enableTrigger(world, triggers.firstVisit);
  }
  if (!ship.visits.second) {
    if (known(triggers.secondVisitCheck) && world.state.triggers[triggers.secondVisitCheck].enabled) {
      enableTrigger(world, triggers.secondVisit);
      ship.visits.second = true;
    }
  }
  // a warp from a script engages by itself (AstrogationScreen::start, astrogation.cpp:1124-1128)
  world.autoEngage = null;
  if (ship.warpPending) retarget(world);
}

/** The stations and phenomena a scripted warp's type names (astrogation.cpp:1148-1151): 0x4_ is a phenomenon. */
const WARP_PHENOMENON = 0x40;

/**
 * AstrogationScreen::retarget (astrogation.cpp:1142-1178): the scripted warp becomes the course, at warpSpeed (990 and
 * up is maxWarp, 0 leaves the screen's own speed), and engages by itself on a later frame. The sensor record is not here
 * (R10). A warp the content doesn't list (a save's) sets no course: nothing engages.
 */
export function retarget(world: World): void {
  const c = world.content.ship;
  if (!c) throw new Error('this game has no ship');
  const ship = world.state.ship;
  ship.warpPending = false;
  const warp = c.universe.scriptedWarps.find(w => w.code === ship.scriptedWarp);
  // (990 means as fast as the engines can go, and 0 leaves it be)
  if (ship.warpSpeed) {
    world.warpSetting = ship.warpSpeed >= 990 ? maxWarp(c, ship.systems) : ship.warpSpeed;
    ship.warpSpeed = 0;
  }
  if (!warp) { world.autoEngage = null; return; }
  const course: Course = { sector: warp.sector, warp: true, speed: world.warpSetting };
  if (warp.star !== -1) {
    course.star = warp.star;
    if (warp.planet !== -1) course.planet = warp.planet;
  } else if ((warp.type & 0xf0) === WARP_PHENOMENON) course.phenomenon = warp.index;
  else course.station = true;
  // the original goes to the corner of a sector with nothing chosen, but scripts expect the ship at the given place
  if (warp.code >= 1000) {
    course.point = {
      x: (warp.sector % 8) * 20 + Math.trunc(warp.code / 1000000) % 20,
      y: (Math.trunc(warp.sector / 8) % 8) * 20 + Math.trunc(warp.code / 1000) % 1000 % 20,
      z: Math.trunc(warp.sector / 64) * 20 + warp.code % 1000 % 20,
    };
  }
  world.autoEngage = course;
}

/** Astrogation::atPlanetFor (astrogation.cpp:649-657): a scripted warp's code with a planet matches only that planet. */
export function atPlanetFor(world: World, p: Vec3i): boolean {
  const code = p.x * 1000000 + p.y * 1000 + p.z;
  for (const warp of world.content.ship?.universe.scriptedWarps ?? []) {
    if (warp.code === code && warp.planet !== -1) return world.state.ship.location.planet === warp.planet;
  }
  return true;
}
