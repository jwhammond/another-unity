// SPDX-License-Identifier: GPL-3.0-or-later
import type { AstroStar, AstroThing, Universe } from '../content/types';
import { AstroRandom } from './shipSystems';

// The planets of a star system and the text astrogation says about things, ported from engines/unity/universe.cpp (read-only reference). The
// planets are stored nowhere: they are made up from the star's seed, exactly as the original does (scripts and the warp table refer to
// planets by number), so this must draw the same numbers in the same order.

/** Planet classes (universe.cpp:31-48). */
export const CLASS = {
  gasSupergiant: 0, gasGiant: 1, hot: 2, molten: 3, thin: 4, young: 5, heavyGases: 6, smallMolten: 7, small: 8, tenuous: 9, habitable: 10,
  frozen: 11, m: 12, n: 13, ultragiant: 14, waterGiant: 15,
} as const;
export const PLANET_CLASSES = 16;
/** Planet flags (astrogation.h:117-120). */
export const PLANET_BELT = 1, PLANET_INHABITED = 0x10;
/** Star flags (astrogation.h:85-89). */
export const STAR_DWARF = 1, STAR_BINARY = 2, STAR_HAS_OUTPOST = 4, STAR_HAS_STARBASE = 8, STAR_SCRIPTED = 0x10;
/** The types of things in the universe (astrogation.h:57-70). */
export const THING = {
  star: 0x20, planet: 0x21, moon: 0x22, roguePlanet: 0x43, blackHole: 0x44, asteroidBelt: 0x47, scriptedPlace: 0x48, hiddenPlace: 0x49,
  deepSpaceStation: 0x80, relay: 0x81, buoy: 0x82, starbase: 0x83, outpost: 0x84,
} as const;

export interface Moon { seed: number; orbit: number; name: string; flags: number; type: number }
export interface Planet { index: number; seed: number; orbit: number; name: string; flags: number; type: number; moons: Moon[] }

/** What the original keeps in its executable, which the maker needs; absent (no art tables published), plain Roman numerals and the universe's own magnitudes stand in. */
export interface PlanetTables {
  numerals?: readonly string[];
  magnitudes?: readonly number[];
  planetDescriptions?: readonly string[];
  alignmentTexts?: readonly string[];
}
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Light seconds in an astronomical unit (universe.cpp:51). */
const SECONDS_PER_AU = 498;
/** Shonoisho Epsilon's inhabitants are found by the story (universe.cpp:54-55). */
const SHONOISHO = { x: 88, y: 45, z: 105 }, ALIGN_OUTPOST_ID = 3914;

/** planetOrbit (universe.cpp:57-59). */
export function orbitOf(u: Universe, scale: number, position: number): number {
  return Math.trunc(u.planetOrbits[Math.min(position, u.planetOrbits.length - 1)]! * scale / 10);
}

/** How hot a planet is (universe.cpp:62-80): 0 is hot, 1 to 3 habitable, and more cold. */
export function zone(spectralClass: number, orbit: number): number {
  const au = Math.trunc(((orbit << 10) | 0) / SECONDS_PER_AU) >>> 0;
  let z: number;
  if (spectralClass <= 5) z = au >>> 12;
  else if (spectralClass <= 15) z = Math.trunc(au / 0xa00);
  else if (spectralClass <= 25) z = Math.trunc(au / 0x600);
  else if (spectralClass <= 35) z = Math.trunc(au / 0x300);
  else if (spectralClass <= 45) z = au >>> 9;
  else if (spectralClass <= 55) z = Math.trunc(au / 0x180);
  else z = au >>> 7;
  return ((z & 0xffff) << 16) >> 16;
}

/** The rarer classes use up more of a star system's budget (universe.cpp:83-91). */
function classCost(type: number): number {
  if (type === CLASS.ultragiant || type === CLASS.waterGiant) return 6;
  if (type === CLASS.gasSupergiant || type === CLASS.gasGiant) return 4;
  if (type >= CLASS.small && type <= CLASS.frozen) return 2;
  return 4;
}

/** How many planets a star has (PlanetMaker::countPlanets, universe.cpp:119-135). */
export function countPlanets(star: AstroStar, random: AstroRandom = new AstroRandom()): number {
  random.seed(star.seed);
  let count: number;
  if (star.flags & STAR_DWARF) count = random.rnd(99) >= 90 ? 1 : 0;
  else if (random.rnd(99) < 10) count = 0;
  else count = random.rnd((star.flags & STAR_BINARY) ? 5 : 9) + 1;
  // (the story and the outposts need somewhere to be)
  if (!count && (star.flags & (STAR_SCRIPTED | STAR_HAS_OUTPOST))) count = 1;
  return count;
}

class PlanetMaker {
  private random = new AstroRandom();
  private budget = 0;
  private count = 0;
  private moonBudget = 0;
  constructor(private u: Universe, private star: AstroStar, private flags: readonly number[], private tables: PlanetTables) {}

  /** PlanetMaker::pick (universe.cpp:137-170). The original asserts that the budget cannot run out. */
  private pick(planet: Planet, first: number, second: number): number {
    const remaining = this.count - planet.index;
    if (planet.index === 0) { this.budget -= classCost(first); return first; }
    let limit: number;
    if (remaining === 1) limit = this.budget;
    else if (remaining === 2) limit = this.budget >> 1;
    else limit = Math.trunc((this.budget - 6) / (remaining - 1));
    if (classCost(first) <= limit) { this.budget -= classCost(first); return first; }
    if (classCost(second) <= limit) { this.budget -= classCost(second); return second; }
    this.budget -= 2;
    return CLASS.small;
  }

  /** PlanetMaker::planetClass (universe.cpp:172-231). */
  private planetClass(planet: Planet): number {
    const r = this.random;
    const z = zone(this.star.spectralClass, planet.orbit);
    // class M and N planets are only where the story needs them
    const scripted = this.star.spectralClass > 25 && (this.star.flags & STAR_SCRIPTED) !== 0;
    if (z >= 1 && z <= 3) {
      if (r.rnd(99) >= 45) return this.pick(planet, scripted ? CLASS.m : CLASS.hot, CLASS.habitable);
      if (r.rnd(99) >= 90) {
        switch (r.rnd(2)) {
          case 0: return this.pick(planet, CLASS.hot, CLASS.habitable);
          case 1: return this.pick(planet, CLASS.habitable, CLASS.small);
          default: return this.pick(planet, CLASS.small, CLASS.small);
        }
      }
      if (r.rnd(99) >= 93) return this.pick(planet, scripted ? CLASS.n : CLASS.hot, CLASS.habitable);
      switch (r.rnd(2)) {
        case 0: return this.pick(planet, CLASS.molten, CLASS.habitable);
        case 1: return this.pick(planet, CLASS.thin, CLASS.habitable);
        default: return this.pick(planet, CLASS.young, CLASS.habitable);
      }
    }
    if (z < 1) {
      if (r.rnd(99) >= 47) return this.pick(planet, CLASS.tenuous, CLASS.small);
      if (r.rnd(99) >= 65) return this.pick(planet, CLASS.heavyGases, CLASS.tenuous);
      return this.pick(planet, CLASS.small, CLASS.small);
    }
    if (r.rnd(99) >= 50) return this.pick(planet, CLASS.gasGiant, CLASS.frozen);
    if (r.rnd(99) >= 80) return this.pick(planet, CLASS.gasSupergiant, CLASS.frozen);
    if (r.rnd(99) >= 90) return this.pick(planet, CLASS.small, CLASS.small);
    if (r.rnd(99) >= 95) return this.pick(planet, CLASS.frozen, CLASS.small);
    if (r.rnd(99) >= 97) return this.pick(planet, CLASS.waterGiant, CLASS.gasGiant);
    switch (r.rnd(2)) {
      case 0: return this.pick(planet, CLASS.smallMolten, CLASS.frozen);
      case 1: return this.pick(planet, CLASS.ultragiant, CLASS.gasSupergiant);
      default: return this.pick(planet, CLASS.small, CLASS.small);
    }
  }

  /** PlanetMaker::moonClass (universe.cpp:233-259). */
  private moonClass(orbit: number, planetType: number): number {
    const r = this.random;
    const z = zone(this.star.spectralClass, orbit);
    if (z >= 1 && z <= 3) {
      const habitable = planetType === CLASS.m || planetType === CLASS.n || planetType === CLASS.young || planetType === CLASS.thin
        || planetType === CLASS.molten || planetType === CLASS.hot;
      if (habitable) return r.rnd(1) === 0 ? CLASS.habitable : CLASS.small;
      return CLASS.small;
    }
    if (z < 1) return planetType === CLASS.heavyGases && r.rnd(99) >= 47 ? CLASS.tenuous : CLASS.small;
    if ((planetType === CLASS.ultragiant || planetType === CLASS.waterGiant || planetType === CLASS.gasSupergiant) && r.rnd(99) >= 50) return CLASS.gasGiant;
    if (planetType === CLASS.gasGiant) {
      if (r.rnd(99) >= 90) return CLASS.small;
      return r.rnd(1) === 0 ? CLASS.frozen : CLASS.smallMolten;
    }
    return CLASS.small;
  }

  /** PlanetMaker::moonOrbit (universe.cpp:261-274): moons are spread out within a quarter of the way to the next planet. */
  private moonOrbit(planet: Planet, moon: number): number {
    let gap = 63;
    if (planet.index !== 14) {
      gap = (orbitOf(this.u, this.star.orbitScale, planet.index + 1) - planet.orbit) >>> 0;
      gap = ((gap - Math.trunc(gap / 10)) >>> 0) >>> 2;
    }
    if (gap > 63 || gap === 0) gap = 63;
    const half = gap >> 1;
    const offset = ((this.random.rnd(half) + half) << 16) >> 16;
    return (planet.orbit + moon * gap + offset) >>> 0;
  }

  /** PlanetMaker::inhabit (universe.cpp:276-313). */
  private inhabit(planet: Planet, chance: boolean): boolean {
    const r = this.random;
    const nextSeed = r.rnd(0xffff);
    let inhabited = true;
    if (chance) {
      switch (planet.type) {
        case CLASS.m: case CLASS.n: break;
        case CLASS.waterGiant: inhabited = r.rnd(99) >= 50; break;
        case CLASS.gasSupergiant: case CLASS.smallMolten: inhabited = r.rnd(99) >= 80; break;
        case CLASS.hot: case CLASS.thin: case CLASS.young: case CLASS.heavyGases: case CLASS.habitable: inhabited = r.rnd(99) >= 90; break;
        default: inhabited = r.rnd(99) >= 95;
      }
      if (inhabited && planet.moons.length > 0 && r.rnd(99) >= 95) planet.moons[0]!.flags |= PLANET_INHABITED;
    }
    if (inhabited) planet.flags |= PLANET_INHABITED;
    // (so that the rest doesn't depend on how many numbers were used)
    r.seed(nextSeed);
    return inhabited;
  }

  make(): Planet[] {
    const r = this.random;
    const star = this.star;
    const planets: Planet[] = [];
    r.seed(star.seed);
    this.budget = 0x22;
    // (these are thrown away)
    r.rnd(999); r.rnd(1); r.rnd(9);
    this.count = countPlanets(star, r);
    if (!this.count) return planets;
    this.moonBudget = 10;
    const base = star.systemName === '' ? star.name : star.systemName;
    const numerals = this.tables.numerals ?? ROMAN;
    for (let i = 0; i < this.count; i++) {
      const planet: Planet = { index: i, flags: 0, seed: r.rnd(0xffff), orbit: orbitOf(this.u, star.orbitScale, i), name: '', type: 0, moons: [] };
      planet.type = this.planetClass(planet);
      // (a flag which nothing uses)
      if (!(star.flags & STAR_HAS_OUTPOST)) r.rnd(99);
      planet.name = `${base} ${numerals[Math.min(i, numerals.length - 1)]}`;
      let moons = 0;
      if (this.moonBudget > 0 && r.rnd(99) < 60) {
        moons = 1;
        if (r.rnd(99) >= 64) {
          moons++;
          if (r.rnd(99) >= 78) {
            moons++;
            if (r.rnd(99) >= 87) moons++;
          }
        }
        moons = Math.min(moons, this.moonBudget);
        this.moonBudget -= moons;
      }
      for (let j = 0; j < moons; j++) {
        const orbit = this.moonOrbit(planet, j);
        const seed = r.next();
        // (the planets' numerals all end in I, V or X, so there's no space)
        const last = planet.name.slice(-1);
        planet.moons.push({ orbit, seed, name: planet.name + (last === 'X' || last === 'V' || last === 'I' ? '' : ' ') + String.fromCharCode(97 + j), flags: 0, type: this.moonClass(orbit, planet.type) });
      }
      planets.push(planet);
    }
    if (r.rnd(99) >= 70) {
      const belt = this.count === 1 ? 0 : r.rnd(this.count - 2) & 0xffff;
      planets[belt]!.flags |= PLANET_BELT;
    }
    // a scripted system has someone living there, on the given planet if any
    if (star.flags & STAR_SCRIPTED) {
      if (star.scriptedName === '') {
        let inhabited = 0;
        for (let i = 0; i < this.count; i++) inhabited += this.inhabit(planets[i]!, true) ? 1 : 0;
        if (!inhabited) this.inhabit(planets[r.rnd(this.count - 1) & 0xffff]!, false);
      } else {
        const index = star.scriptedName.charCodeAt(0) - 48;
        if (index >= 0 && index < this.count) this.inhabit(planets[index]!, false);
      }
    }
    // the planet's real name, once a script reveals it
    if (star.scriptedName !== '' && ((this.flags[star.id] ?? 0) & 0x10)) {
      const index = star.scriptedName.charCodeAt(0) - 48;
      if (index >= 0 && index < this.count) planets[index]!.name = star.scriptedName.slice(2);
    }
    // (the original only ever sets the first planet's seed here)
    let seed = 0;
    for (let i = 0; i < this.count; i++) seed = r.next();
    planets[0]!.seed = seed;
    return planets;
  }
}

/** Astrogation::makePlanets (universe.cpp:393-396): a star's planets, with their moons and which have a belt or people. */
export function makePlanets(u: Universe, star: AstroStar, flags: readonly number[], tables: PlanetTables = {}): Planet[] {
  return new PlanetMaker(u, star, flags, tables).make();
}

/** Astrogation::inhabitedPlanets (universe.cpp:398-410). */
export function inhabitedPlanets(star: AstroStar, planets: readonly Planet[], flags: readonly number[]): number {
  let inhabited = planets.filter(p => p.flags & PLANET_INHABITED).length;
  // Shonoisho Epsilon's people are found by the story
  if (!inhabited && star.x === SHONOISHO.x && star.y === SHONOISHO.y && star.z === SHONOISHO.z && ((flags[star.id] ?? 0) & 0x10)) inhabited = 1;
  return inhabited;
}

/** The magnitude of a spectral class, when the executable's table is not published: that of a star the universe has of the class. */
function magnitudeOfClass(u: Universe, tables: PlanetTables, spectralClass: number): number {
  const table = tables.magnitudes?.[spectralClass];
  if (table !== undefined) return table;
  return u.stars.find(s => s.spectralClass === spectralClass)?.magnitude ?? 0;
}

/** Astrogation::companionStar (universe.cpp:412-427): a binary star's sister. */
export function companionStar(u: Universe, star: AstroStar, tables: PlanetTables = {}): { spectralClass: number; magnitude: number } {
  const r = new AstroRandom();
  r.seed(star.seed);
  let spectralClass: number;
  if (r.rnd(99) >= 35) spectralClass = r.rnd(9) + 60;
  else if (r.rnd(99) >= 85) spectralClass = r.rnd(9) + 50;
  else if (r.rnd(99) >= 92) spectralClass = r.rnd(9) + 40;
  else if (r.rnd(99) >= 98) spectralClass = r.rnd(9) + 30;
  else spectralClass = r.rnd(29);
  return { spectralClass, magnitude: magnitudeOfClass(u, tables, spectralClass) };
}

/** Astrogation::spectralName (universe.cpp:429-432): "B3". */
export function spectralName(spectralClass: number): string {
  return `${'OBAFGKM'[Math.min(Math.trunc(spectralClass / 10), 6)]}${spectralClass % 10}`;
}

/** Astrogation::magnitudeName (universe.cpp:434-436): "-2.0". */
export function magnitudeName(magnitude: number): string {
  return `${magnitude < 0 ? '-' : ''}${Math.trunc(Math.abs(magnitude) / 10)}.${Math.abs(magnitude) % 10}`;
}

/** Astrogation::planetClassLetter (universe.cpp:438-441). */
export function planetClassLetter(type: number): string {
  return 'ABCDEFGHIJKLMNST'[Math.min(type, 15)]!;
}

/** Astrogation::typeName (universe.cpp:443-480). */
export function typeName(type: number): string {
  switch (type) {
    case THING.star: return 'star';
    case THING.planet: return 'planet';
    case THING.moon: return 'moon';
    case 0x40: return 'Antimatter Cloud';
    case 0x41: return 'Ion Storm';
    case 0x42: return 'Quasaroid';
    case THING.roguePlanet: return 'Rogue Planet';
    case THING.blackHole: return 'Blackhole';
    case 0x45: return 'Subspace Vortex';
    case 0x46: return 'unknown hazard';
    case THING.deepSpaceStation: return 'Deepspace Station';
    case THING.relay: return 'subspace communications relay';
    case THING.buoy: return 'navigational & scanning buoy';
    case THING.starbase: return 'Starbase';
    case THING.outpost: return 'Outpost';
    default: return '';
  }
}

/** Astrogation::sectorText (universe.cpp:482-488). */
export function sectorText(u: Universe, sector: number, tables: PlanetTables = {}): string {
  const s = u.sectors[sector]!;
  const names = tables.alignmentTexts;
  let text = names?.[Math.min(s.alignment, names.length - 1)] ?? ['aligned with the Federation', 'aligned with the Romulans', 'nonaligned', 'in the nebula', 'in the neutral zone'][Math.min(s.alignment, 4)]!;
  if (s.description !== '') text += `  ${s.description}`;
  return text;
}

/** Astrogation::starText (universe.cpp:490-545): the star's paragraph on the info panel. */
export function starText(u: Universe, star: AstroStar, flags: readonly number[], tables: PlanetTables = {}): string {
  let text = `This is a class ${spectralName(star.spectralClass)}${star.flags & STAR_DWARF ? ' white dwarf ' : ' star '}with an absolute magnitude of ${magnitudeName(star.magnitude)}.  `;
  if (star.flags & STAR_BINARY) {
    const c = companionStar(u, star, tables);
    text += `It belongs to a binary star system, with a class ${spectralName(c.spectralClass)} sister star of absolute magnitude ${magnitudeName(c.magnitude)}. `;
  }
  const f = flags[star.id] ?? 0;
  if (!(f & 0xc)) {
    text += 'This star is currently unscanned.  ';
  } else if (f & 8) {
    const planets = makePlanets(u, star, flags, tables);
    const count = planets.length;
    if (!count) text += 'It possesses no planets.  ';
    else if (count === 1) text += 'It possesses 1 planet, ';
    else text += `It possesses ${count} planets, `;
    if (count) {
      const inhabited = inhabitedPlanets(star, planets, flags);
      if (count === 1) {
        text += inhabited ? 'which is known to be inhabited.  ' : 'which is known to be uninhabited.  ';
      } else {
        if (!inhabited) text += count === 2 ? 'neither ' : 'none ';
        else if (inhabited === count) text += inhabited === 2 ? 'both ' : 'all ';
        else text += `${inhabited} `;
        text += inhabited < 2 ? 'of which is known to be inhabited.  ' : 'of which are known to be inhabited.  ';
      }
    }
    if ((star.flags & STAR_HAS_OUTPOST) && star.special !== -1) text += `${u.specials[star.special]!.name} orbits this system.  `;
    if (planets.some(p => p.flags & PLANET_BELT)) text += 'This star system has an asteroid belt.  ';
  }
  return text;
}

/** Astrogation::planetText (universe.cpp:547-564): only once the system has been scanned. */
export function planetText(star: AstroStar, planet: Planet, flags: readonly number[], tables: PlanetTables = {}): string | null {
  const f = flags[star.id] ?? 0;
  if (!(f & 8)) return null;
  // the story's planet can have its own description
  const d = star.scriptedDescription;
  if (d.length > 2 && d[0] !== 'm' && (f & 0x10) && d.charCodeAt(0) - 48 === planet.index) return d.slice(2);
  const own = tables.planetDescriptions;
  return own?.[Math.min(planet.type, own.length - 1)] ?? `A class ${planetClassLetter(planet.type)} planet.`;
}

/** Astrogation::moonText (universe.cpp:566-570). */
export function moonText(moon: Moon): string {
  return `This is a class ${moon.type < 15 ? 'ABCDEFGHIJKLMNS'[moon.type] : 'T'} moon.  `;
}

/** Astrogation::stationText (universe.cpp:572-606): `star` is the system an outpost is in. */
export function stationText(station: AstroThing, star: AstroStar | undefined, flags: readonly number[]): string {
  const f = (id: number) => flags[id] ?? 0;
  if (star && star.scriptedDescription.length > 2 && star.scriptedDescription[0] === 'm' && (f(star.id) & 0x10)) return star.scriptedDescription.slice(2);
  let text = `This is a Federation ${typeName(station.type)}.  `;
  if (!(f(station.id) & 0x10)) {
    if (station.type === THING.relay || station.type === THING.buoy) {
      const status = ['Fully Operational.  ', 'Operational -- Awaiting Resupply.  ', 'Partially Operational.  ', 'Non-operational.  ', 'Unknown -- contact lost.  '];
      const r = new AstroRandom();
      r.seed(station.seed);
      const n = Math.min(r.rnd(4), status.length - 1);
      text += `Current status of this unit is: ${status[n]}`;
      if (n === status.length - 1) text += 'stardate 46254.5.  ';
    } else {
      text += 'Current status of this unit is: Fully Operational.  ';
    }
  } else if (station.type === THING.outpost) {
    // scripts reveal what's happened to some of them
    text += station.id === ALIGN_OUTPOST_ID ? 'Federation Outpost destroyed by alien invasion force.' : 'Outpost destroyed by Romulan fleet.';
  } else if (station.type === THING.relay) {
    text += 'Relay destroyed by Romulan fleet.';
  }
  return text;
}

/** Astrogation::phenomenonText (universe.cpp:608-640). */
export function phenomenonText(phenomenon: AstroThing): string {
  let text = phenomenon.name;
  switch (phenomenon.type) {
    case THING.roguePlanet: {
      const r = new AstroRandom();
      r.seed(phenomenon.seed);
      text += r.rnd(99) >= 15 ? 'L ' : 'I ';
      break;
    }
    case THING.blackHole: text += ': Gravity, Radiation, & Subspace Distortion danger -- avoid!  '; break;
    case 0x41: text += ': Reduced sensor range, Hull Erosion danger -- use caution -- possible systems damage in high-gradient areas.  '; break;
    case 0x45: text += ': Subspace Distortion danger -- use warp drive with care -- strong warp drive stress, possible coil failure.  '; break;
    case 0x42: text += ': Extreme Radiation & Subspace Distortion danger -- avoid !  '; break;
    default:
  }
  text += `Known zone of influence: ${phenomenon.range} ${phenomenon.range === 1 ? 'light-year' : 'light-years'}`;
  return text;
}
