// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AstroStar, AstroThing, Universe } from '../content/types';
import {
  companionStar, countPlanets, inhabitedPlanets, magnitudeName, makePlanets, moonText, phenomenonText, planetClassLetter, planetText, sectorText,
  spectralName, starText, stationText, typeName, zone, PLANET_BELT, PLANET_INHABITED,
} from './planets';

const ORBITS = [4, 7, 10, 16, 28, 52, 100, 196, 388, 772, 1540, 3076, 6148, 12292, 24548, 0];
const universe = (stars: AstroStar[] = []): Universe => ({
  sectors: [], stars, phenomena: [], stations: [], specials: [], flags: [], regionChatter: [], warpSpeeds: [], impulseSpeeds: [], scriptedWarps: [],
  planetOrbits: ORBITS, reveals: [],
});
const star = (over: Partial<AstroStar> = {}): AstroStar => ({
  id: 5, type: 0x20, seed: 39679, x: 86, y: 93, z: 98, name: 'Alpha', range: 0, flags: 2, spectralClass: 13, magnitude: -20, orbitScale: 202,
  systemName: '', scriptedName: '', scriptedDescription: '', special: -1, ...over,
});

describe('makePlanets', () => {
  // A binary B3 star whose system the original's astrogation screen shows (checked against a capture of it): five planets of classes G J J G J (the
  // letters under them), the moons 0, 2, 4, 0 and 1, no belt and nobody at home.
  const s = star();
  const planets = makePlanets(universe([s]), s, []);

  it('draws the same planets, classes and moons as the original from the star\'s seed', () => {
    expect(planets.map(p => planetClassLetter(p.type)).join('')).toBe('GJJGJ');
    expect(planets.map(p => p.moons.length)).toEqual([0, 2, 4, 0, 1]);
    expect(planets.map(p => p.orbit)).toEqual([80, 141, 202, 323, 565]);
    expect(planets.map(p => p.flags)).toEqual([0, 0, 0, 0, 0]);
    expect(planets[1]!.moons.map(m => [m.type, m.orbit])).toEqual([[8, 151], [8, 163]]);
    expect(planets[0]!.seed).toBe(23126);
  });
  it('names them after the system with the numeral, and the moons after the planet', () => {
    expect(planets.map(p => p.name)).toEqual(['Alpha I', 'Alpha II', 'Alpha III', 'Alpha IV', 'Alpha V']);
    expect(planets[1]!.moons.map(m => m.name)).toEqual(['Alpha IIa', 'Alpha IIb']);
    const named = makePlanets(universe(), star({ systemName: 'Sol' }), [], { numerals: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] });
    expect(named[2]!.name).toBe('Sol 3');
    // (a moon of a planet whose numeral ends in a letter other than I, V, X gets a space)
    const odd = makePlanets(universe(), star(), [], { numerals: ['a', 'b', 'c', 'd', 'e'] });
    expect(odd[1]!.moons[0]!.name).toBe('Alpha b a');
  });
  it('has none for a dwarf with a bad draw, one where the story needs a planet, and is the same every time', () => {
    const dwarf = star({ flags: 1, seed: 1 });
    expect(countPlanets(dwarf)).toBe(0);
    expect(makePlanets(universe(), dwarf, [])).toEqual([]);
    expect(makePlanets(universe(), { ...dwarf, flags: 0x11 }, [])).toHaveLength(1);
    expect(makePlanets(universe(), s, [])).toEqual(planets);
  });
  it('puts a belt on at most one planet and people on the scripted star\'s planets, and renames the story\'s planet once it is revealed', () => {
    let belts = 0, inhabited = 0;
    for (let seed = 1; seed < 400; seed++) {
      const ps = makePlanets(universe(), star({ seed, flags: 0x10, spectralClass: 20 }), []);
      belts += ps.filter(p => p.flags & PLANET_BELT).length;
      expect(ps.filter(p => p.flags & PLANET_BELT).length).toBeLessThanOrEqual(1);
      if (ps.some(p => p.flags & PLANET_INHABITED)) inhabited++;
      // (a scripted star always has someone living somewhere)
      expect(ps.length === 0 || ps.some(p => p.flags & PLANET_INHABITED)).toBe(true);
    }
    expect(belts).toBeGreaterThan(0);
    expect(inhabited).toBeGreaterThan(0);
    const story = star({ flags: 0x10, seed: 7, scriptedName: '0 Lost World' });
    expect(makePlanets(universe(), story, [])[0]!.name).toBe('Alpha I');
    const flags: number[] = []; flags[5] = 0x10;
    const revealed = makePlanets(universe(), story, flags);
    expect(revealed[0]!.name).toBe('Lost World');
    expect(revealed[0]!.flags & PLANET_INHABITED).toBe(PLANET_INHABITED);
  });
});

describe('zone', () => {
  it('is 0 close in, 1 to 3 where it is habitable, and more beyond', () => {
    expect(zone(30, 0)).toBe(0);
    expect(zone(30, 498)).toBeGreaterThanOrEqual(0);
    expect(zone(30, 24548)).toBeGreaterThan(3);
    // (the dimmer the star, the nearer in the zones are)
    expect(zone(60, 3600)).toBeGreaterThan(zone(10, 3600));
  });
});

describe('names and text', () => {
  it('writes spectral classes, magnitudes and planet letters', () => {
    expect(spectralName(13)).toBe('B3');
    expect(spectralName(69)).toBe('M9');
    expect(spectralName(0)).toBe('O0');
    expect(magnitudeName(-20)).toBe('-2.0');
    expect(magnitudeName(125)).toBe('12.5');
    expect(magnitudeName(-5)).toBe('-0.5');
    expect(planetClassLetter(0)).toBe('A');
    expect(planetClassLetter(15)).toBe('T');
    expect(typeName(0x83)).toBe('Starbase');
    expect(typeName(0x45)).toBe('Subspace Vortex');
    expect(typeName(0x99)).toBe('');
  });
  it('makes the binary star\'s sister from its seed, with the magnitude of its class', () => {
    const s = star();
    const c = companionStar(universe(), s, { magnitudes: Array.from({ length: 70 }, (_, i) => i * 2) });
    expect(c.spectralClass).toBe(66);
    expect(c.magnitude).toBe(132);
    expect(spectralName(c.spectralClass)).toBe('M6');
  });
  it('describes a star: scanned or not, its planets and who is at home', () => {
    const s = star();
    const u = universe([s]);
    const flags: number[] = [];
    expect(starText(u, s, flags)).toMatch(/^This is a class B3 star with an absolute magnitude of -2\.0\.  It belongs to a binary star system, with a class M6 sister star of absolute magnitude/);
    expect(starText(u, s, flags)).toMatch(/This star is currently unscanned\.  $/);
    flags[5] = 8;
    expect(starText(u, s, flags)).toMatch(/It possesses 5 planets, none of which is known to be inhabited\.  $/);
    expect(starText(u, star({ flags: 1, seed: 1 }), [0, 0, 0, 0, 0, 8])).toMatch(/white dwarf with an absolute/);
  });
  it('describes a planet once its system is scanned, a moon, a station and a phenomenon', () => {
    const s = star();
    const planet = makePlanets(universe([s]), s, [])[1]!;
    expect(planetText(s, planet, [])).toBeNull();
    const scanned: number[] = []; scanned[5] = 8;
    expect(planetText(s, planet, scanned, { planetDescriptions: Array.from({ length: 16 }, (_, i) => `d${i}`) })).toBe('d9');
    expect(planetText({ ...s, scriptedDescription: '1 Special' }, planet, [0, 0, 0, 0, 0, 0x18])).toBe('Special');
    expect(moonText({ seed: 0, orbit: 0, name: '', flags: 0, type: 8 })).toBe('This is a class I moon.  ');
    expect(moonText({ seed: 0, orbit: 0, name: '', flags: 0, type: 15 })).toBe('This is a class T moon.  ');
    const outpost: AstroThing = { id: 9, type: 0x84, seed: 0, x: 0, y: 0, z: 0, name: 'Outpost 9', range: 0 };
    expect(stationText(outpost, undefined, [])).toBe('This is a Federation Outpost.  Current status of this unit is: Fully Operational.  ');
    const gone: number[] = []; gone[9] = 0x10;
    expect(stationText(outpost, undefined, gone)).toBe('This is a Federation Outpost.  Outpost destroyed by Romulan fleet.');
    const relay: AstroThing = { ...outpost, type: 0x81 };
    expect(stationText(relay, undefined, [])).toMatch(/^This is a Federation subspace communications relay\.  Current status of this unit is: /);
    const hazard: AstroThing = { id: 3, type: 0x44, seed: 0, x: 0, y: 0, z: 0, name: 'Hole', range: 1 };
    expect(phenomenonText(hazard)).toBe('Hole: Gravity, Radiation, & Subspace Distortion danger -- avoid!  Known zone of influence: 1 light-year');
    expect(phenomenonText({ ...hazard, type: 0x40, range: 4 })).toBe('HoleKnown zone of influence: 4 light-years');
  });
  it('says what a sector is aligned with, and adds its own description', () => {
    const u = universe();
    u.sectors = [{ numStars: 0, numPhenomena: 0, alignment: 2, firstStar: 0, firstPhenomenon: 0, station: -1, description: 'Quiet.', name: 'N', region: 0 }];
    expect(sectorText(u, 0, { alignmentTexts: ['a', 'b', 'c', 'd', 'e'] })).toBe('c  Quiet.');
    expect(inhabitedPlanets(star(), [], [])).toBe(0);
  });
});
