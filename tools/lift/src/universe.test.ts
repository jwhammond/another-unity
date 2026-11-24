// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Problems } from './problems';
import { liftUniverse, parseAstroDb, K_STAR_HAS_OUTPOST, K_STAR_HAS_STARBASE } from './universe';
import { makeAstroDb } from './testing/astro-db';
import { rawFromMini } from './testing/ctx';

const SOL = { id: 7, type: 0x20, seed: 99, x: 90, y: 91, z: 92, name: '-Sol-', flags: 1, spectralClass: 5, magnitude: -3, orbitScale: 4, systemName: '-Sys-', scriptedName: '-Zap-', scriptedDescription: '-Zip-' };

describe('parseAstroDb', () => {
  it('reads stars, a phenomenon and a station with their pool names', () => {
    const u = parseAstroDb(makeAstroDb({
      sectors: [{ numStars: 2, numPhenomena: 1, alignment: 3, description: '-Desc-' }, { numStars: 0 }],
      stars: [SOL, { id: 8, type: 0x20, name: '-Sun-', spectralClass: 900 }],
      phenomena: [{ id: 20, type: 0x44, name: '-Hole-', range: 6, x: 1 }],
      stations: [{ id: 30, type: 0x80, name: '-Dock-', sector: 1 }],
    }));
    expect(u.sectors).toHaveLength(512);
    expect(u.sectors[0]).toMatchObject({ numStars: 2, numPhenomena: 1, alignment: 3, firstStar: 0, firstPhenomenon: 0, description: '-Desc-', station: -1 });
    expect(u.sectors[1]).toMatchObject({ firstStar: 2, firstPhenomenon: 1, station: 0 });
    expect(u.stars[0]).toEqual({ ...SOL, range: 0, special: -1 });
    expect(u.stars[1].spectralClass).toBe(69);
    expect(u.phenomena).toEqual([{ id: 20, type: 0x44, seed: 0, x: 1, y: 0, z: 0, name: '-Hole-', range: 6 }]);
    expect(u.stations).toEqual([{ id: 30, type: 0x80, seed: 0, x: 0, y: 0, z: 0, name: '-Dock-', range: 0 }]);
  });

  it('skips a special whose star is beyond its sector\'s, and flags a starbase\'s star', () => {
    const u = parseAstroDb(makeAstroDb({
      sectors: [{ numStars: 1 }, { numStars: 2 }],
      stars: [SOL, SOL, SOL],
      specials: [
        { id: 1, type: 0x84, sector: 0, star: 1, name: '-Out-' },
        { id: 2, type: 0x84, sector: 1, star: 1, name: '-Post-' },
        { id: 3, type: 0x83, sector: 1, star: 0, name: '-Base-', planet: 2 },
        { id: 4, type: 0x84, sector: 700, star: 0 },
      ],
    }));
    expect(u.specials.map(s => s.id)).toEqual([2, 3]);
    expect(u.stars[0]).toMatchObject({ flags: 1, special: -1 });
    expect(u.stars[1]).toMatchObject({ flags: 1 | K_STAR_HAS_OUTPOST | K_STAR_HAS_STARBASE, special: 1 });
    expect(u.stars[2]).toMatchObject({ flags: 1 | K_STAR_HAS_OUTPOST, special: 0 });
    expect(u.specials[1]).toMatchObject({ planet: 2, name: '-Base-', range: 0 });
  });

  it('gives a sector with description -1 an empty description', () => {
    expect(parseAstroDb(makeAstroDb({ sectors: [{ description: null }, { description: '-D-' }] })).sectors.map(s => s.description).slice(0, 3)).toEqual(['', '-D-', '']);
  });
});

describe('liftUniverse', () => {
  const lines = Array.from({ length: 512 }, (_, i) => `-S${i}-`).join('\r\n');
  const raw = (flags: number[], extra: object = {}) => {
    const r = rawFromMini();
    const executable = {
      ...r.executable, _sectorRegions: Array.from({ length: 512 }, (_, i) => i % 7), _regionChatter: [2, 3], _warpSpeeds: [100, 200], _impulseSpeeds: [5],
    };
    return {
      ...r, executable, astro: makeAstroDb({ sectors: [{ numStars: 1 }], stars: [SOL], stations: [{ id: 3, type: 0x80, sector: 4 }] }),
      sectorNames: Buffer.from(lines, 'latin1'), astStat: { file: 'ast_stat.dat' as const, offset: 1762, count: flags.length, _flags: flags }, ...extra,
    };
  };

  it('joins the names, regions and flags', () => {
    const problems = new Problems();
    const u = liftUniverse(raw([1, 2]), problems)!;
    expect(u.sectors[0]).toMatchObject({ name: '-S0-', region: 0 });
    expect(u.sectors[10]).toMatchObject({ name: '-S10-', region: 3 });
    expect(u.sectors[4].station).toBe(0);
    expect(u.flags).toEqual([1, 2]);
    expect([u.regionChatter, u.warpSpeeds, u.impulseSpeeds]).toEqual([[2, 3], [100, 200], [5]]);
    expect(problems.warnings).toEqual([]);
  });

  it('lifts the scripted warps and the planet orbits', () => {
    const base = raw([1, 2]);
    const executable = { ...base.executable, _scriptedWarps: [{ code: 90090090, sector: 1, star: 0, planet: 2, type: 0, index: -1 }], _planetOrbits: [100, 200] };
    const u = liftUniverse({ ...base, executable }, new Problems())!;
    expect(u.scriptedWarps).toEqual([{ code: 90090090, sector: 1, star: 0, planet: 2, type: 0, index: -1 }]);
    expect(u.scriptedWarps[0].planet).toBe(2);
    expect(u.planetOrbits[1]).toBe(200);
  });

  it('lifts the reveals', () => {
    const base = raw([1, 2]);
    const u = liftUniverse({ ...base, executable: { ...base.executable, _astroReveals: [7, 9] } }, new Problems())!;
    expect(u.reveals).toEqual([7, 9]);
  });

  it('warns once when the flags aren\'t one per thing', () => {
    const problems = new Problems();
    liftUniverse(raw([1, 2, 3]), problems);
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/3 flags for 2 things/);
  });

  it('is undefined, with a warning, without astro.db', () => {
    const problems = new Problems();
    const { astro: _astro, ...without } = raw([]);
    expect(liftUniverse(without, problems)).toBeUndefined();
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/astro\.db/);
  });
});
