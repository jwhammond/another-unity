// SPDX-License-Identifier: GPL-3.0-or-later
import type { AstroSector, AstroSpecial, AstroStar, AstroThing, Universe } from '@another-unity/engine';
import type { Problems } from './problems';
import type { RawIR } from './raw';

/** origdata.h and astrogation.h. */
export const NUM_SECTORS = 512;
export const NUM_SPECTRAL_CLASSES = 70;
export const K_STAR_HAS_OUTPOST = 4;
export const K_STAR_HAS_STARBASE = 8;
export const K_ASTRO_STARBASE = 0x83;

const SECTOR_SIZE = 0x24;
const STAR_SIZE = 0x44;
const PHENOMENON_SIZE = 0x28;
const THING_SIZE = 0x24;

export type ParsedAstro = Omit<Universe, 'flags' | 'regionChatter' | 'warpSpeeds' | 'impulseSpeeds' | 'scriptedWarps' | 'planetOrbits' | 'reveals'>;

/** The string at `pool + offset` (astrogation.cpp readPoolString): latin1, NUL-terminated; offset -1 is empty. */
function poolString(bytes: Uint8Array, pool: number, offset: number): string {
  if (offset === -1) return '';
  let end = pool + offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return String.fromCharCode(...bytes.subarray(pool + offset, end));
}

/** A field-by-field port of Astrogation::load's astro.db half (astrogation.cpp 157-266). */
export function parseAstroDb(bytes: Uint8Array): ParsedAstro {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectors: AstroSector[] = [];
  const descriptions: number[] = [];
  let numStars = 0;
  let numPhenomena = 0;
  for (let i = 0; i < NUM_SECTORS; i++) {
    const at = i * SECTOR_SIZE;
    const sector: AstroSector = {
      numStars: v.getUint32(at + 4, true), numPhenomena: v.getUint32(at + 8, true), alignment: v.getUint32(at + 0x10, true),
      firstStar: numStars, firstPhenomenon: numPhenomena, station: -1, description: '', name: '', region: -1,
    };
    descriptions.push(v.getInt32(at + 0x20, true));
    numStars += sector.numStars;
    numPhenomena += sector.numPhenomena;
    sectors.push(sector);
  }
  const starsStart = NUM_SECTORS * SECTOR_SIZE;
  const phenomenaStart = starsStart + numStars * STAR_SIZE;
  const counts = phenomenaStart + numPhenomena * PHENOMENON_SIZE;
  const numStations = v.getUint32(counts, true);
  const numSpecials = v.getUint32(counts + 4, true);
  const stationsStart = counts + 8;
  const pool = stationsStart + (numStations + numSpecials) * THING_SIZE;

  sectors.forEach((s, i) => {
    if (descriptions[i] !== -1) s.description = poolString(bytes, pool, descriptions[i]);
  });

  const thing = (start: number): AstroThing => ({
    id: v.getUint16(start + 4, true), type: v.getUint8(start + 6), seed: v.getUint32(start + 8, true),
    x: v.getInt32(start + 0xc, true), y: v.getInt32(start + 0x10, true), z: v.getInt32(start + 0x14, true),
    name: poolString(bytes, pool, v.getInt32(start + 0x1c, true)), range: v.getInt16(start + 0x20, true),
  });
  const pooled = (at: number) => poolString(bytes, pool, v.getInt32(at, true));

  const stars: AstroStar[] = [];
  for (let i = 0; i < numStars; i++) {
    const start = starsStart + i * STAR_SIZE;
    stars.push({
      ...thing(start), range: 0, special: -1,
      flags: v.getUint8(start + 0x20),
      spectralClass: Math.min(Math.max(v.getInt16(start + 0x24, true), 0), NUM_SPECTRAL_CLASSES - 1),
      magnitude: v.getInt16(start + 0x26, true), orbitScale: v.getInt16(start + 0x28, true),
      systemName: pooled(start + 0x30), scriptedName: pooled(start + 0x34), scriptedDescription: pooled(start + 0x38),
    });
  }
  const phenomena: AstroThing[] = [];
  for (let i = 0; i < numPhenomena; i++) phenomena.push(thing(phenomenaStart + i * PHENOMENON_SIZE));

  const stations: AstroThing[] = [];
  for (let i = 0; i < numStations; i++) {
    const start = stationsStart + i * THING_SIZE;
    const station = { ...thing(start), range: 0 };
    const sector = v.getInt32(start + 0x20, true);
    if (sector >= 0 && sector < sectors.length) sectors[sector].station = stations.length;
    stations.push(station);
  }

  // the outposts and starbases, which orbit stars' planets
  const specials: AstroSpecial[] = [];
  for (let i = 0; i < numSpecials; i++) {
    const start = stationsStart + (numStations + i) * THING_SIZE;
    const special: AstroSpecial = {
      ...thing(start), range: 0, sector: v.getInt16(start + 0x20, true), star: v.getUint8(start + 0x22), planet: v.getUint8(start + 0x23),
    };
    // (Astrogation::load skips a special whose sector or star doesn't exist)
    if (special.sector < 0 || special.sector >= sectors.length || special.star >= sectors[special.sector].numStars) continue;
    const star = stars[sectors[special.sector].firstStar + special.star];
    star.flags |= K_STAR_HAS_OUTPOST;
    if (special.type === K_ASTRO_STARBASE) star.flags |= K_STAR_HAS_STARBASE;
    star.special = specials.length;
    specials.push(special);
  }
  return { sectors, stars, phenomena, stations, specials };
}

/** The universe: astro.db, with sector.ast's names, `_sectorRegions`, ast_stat.dat's flags and the speeds (Plan 10 Task 7). */
export function liftUniverse(raw: RawIR, problems: Problems): Universe | undefined {
  // (read before the early return, so the lossless check sees them read even without astro.db)
  const regions = raw.executable._sectorRegions.map(r => r);
  const regionChatter = raw.executable._regionChatter.map(r => r);
  const warpSpeeds = raw.executable._warpSpeeds.map(s => s);
  const impulseSpeeds = raw.executable._impulseSpeeds.map(s => s);
  const scriptedWarps = raw.executable._scriptedWarps.map(w => ({ code: w.code, sector: w.sector, star: w.star, planet: w.planet, type: w.type, index: w.index }));
  const planetOrbits = raw.executable._planetOrbits.map(o => o);
  const reveals = raw.executable._astroReveals.map(r => r);
  if (!raw.astro) {
    problems.warn('verbatim/astro.db', 'not in the export (sh tools/rawcheck/run-harness.sh export 300): the universe is not lifted');
    return undefined;
  }
  const parsed = parseAstroDb(raw.astro);
  // (loadSectorNames reads 8*8*8 lines)
  const names = raw.sectorNames ? Buffer.from(raw.sectorNames).toString('latin1').split('\n').map(l => l.replace(/\r$/, '')) : [];
  if (!raw.sectorNames) problems.warn('verbatim/sector.ast', 'not in the export: the sectors have no names');
  parsed.sectors.forEach((s, i) => {
    s.name = names[i] ?? '';
    s.region = regions[i] ?? -1;
  });
  if (regions.length !== NUM_SECTORS) problems.warn('executable._sectorRegions', `${regions.length} regions for ${NUM_SECTORS} sectors`);
  const flags = raw.astStat ? raw.astStat._flags.map(f => f) : [];
  const things = parsed.stars.length + parsed.phenomena.length + parsed.stations.length + parsed.specials.length;
  if (!raw.astStat) problems.warn('ast_stat.json', 'not in the export: the starting flags are empty');
  else if (flags.length !== things) {
    problems.warn('ast_stat.json', `${flags.length} flags for ${things} things (Astrogation::load reads one per star, phenomenon, station and special)`);
  }
  return { ...parsed, flags, regionChatter, warpSpeeds, impulseSpeeds, scriptedWarps, planetOrbits, reveals };
}
