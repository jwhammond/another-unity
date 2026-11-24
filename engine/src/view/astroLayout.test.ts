// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AstroStar, AstroThing, Universe } from '../content/types';
import { newMapCamera, type MapCamera } from '../sim/astroCamera';
import { makePlanets } from '../sim/planets';
import { NOWHERE, type AstroLocation } from '../sim/ship';
import {
  buildEntries, chosenName, destinationName, DEFAULT_PALETTE, entryAt, findSelection, layoutMap, locationSubtype, locationType, paletteOf, sameLocation,
  sectorIndex, SYSTEM_Y, type MapCommand, type MapInput,
} from './astroLayout';

// A small universe in sector 292 (4-4-4: x, y, z from 80 to 99): a charted star at the galaxy's centre, a charted but unscanned one, a scanned binary B3 star
// with five planets (the one the original's screen shows, a seed checked against a capture), a hazard and a hidden place; and a station in sector 293.
const thing = (id: number, type: number, x: number, y: number, z: number, name = `T${id}`): AstroThing => ({ id, type, seed: 0, x, y, z, name, range: 3 });
const star = (id: number, x: number, y: number, z: number, over: Partial<AstroStar> = {}): AstroStar => ({
  ...thing(id, 0x20, x, y, z, `S${id}`), flags: 0, spectralClass: 25, magnitude: 40, orbitScale: 10, systemName: '', scriptedName: '', scriptedDescription: '', special: -1, ...over,
});
const stars: AstroStar[] = [
  star(1, 80, 80, 80),
  star(2, 90, 90, 90),
  star(3, 86, 93, 98, { seed: 39679, flags: 2, spectralClass: 13, magnitude: -20, orbitScale: 202 }),
  star(4, 95, 85, 85, { spectralClass: 66 }),
];
const empty = { numStars: 0, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: '', name: '', region: 0 };
const universe = (): Universe => {
  const sectors = Array.from({ length: 512 }, (_, i) => ({ ...empty, name: `Sector${i}` }));
  sectors[292] = { ...sectors[292]!, numStars: 4, firstStar: 0, numPhenomena: 2, firstPhenomenon: 0, alignment: 1 };
  sectors[293] = { ...sectors[293]!, station: 0 };
  return {
    sectors, stars: stars.map(s => ({ ...s })), phenomena: [thing(10, 0x44, 94, 94, 94, 'Hole'), thing(11, 0x49, 88, 88, 88, 'Hidden')], stations: [thing(20, 0x83, 100, 90, 90, 'Base')],
    specials: [], flags: [], regionChatter: [], warpSpeeds: [], impulseSpeeds: [], scriptedWarps: [],
    planetOrbits: [4, 7, 10, 16, 28, 52, 100, 196, 388, 772, 1540, 3076, 6148, 12292, 24548, 0], reveals: [],
  };
};
const here = (over: Partial<AstroLocation>): AstroLocation => ({ ...NOWHERE, sector: 292, ...over });

function input(over: Partial<MapInput> = {}, cam: Partial<MapCamera> = {}): MapInput {
  const flags: number[] = [];
  flags[1] = 1; flags[2] = 1; flags[3] = 1 | 4 | 8; flags[4] = 0; flags[10] = 1; flags[11] = 1; flags[20] = 1;
  return {
    universe: universe(), flags, cam: { ...newMapCamera(), azimuth: 0, elevation: 0, spinning: false, ...cam }, selection: here({}),
    ship: { pos: { x: 90, y: 90, z: 90 }, transit: null }, lightYears: 17.32049, palette: paletteOf(), tables: {}, measure: (_f, t) => t.length * 5, ...over,
  };
}
const of = <K extends MapCommand['kind']>(commands: MapCommand[], kind: K) => commands.filter((c): c is Extract<MapCommand, { kind: K }> => c.kind === kind);

describe('the galaxy view', () => {
  it('has an entry for each charted star, coloured by its sector\'s alignment, and none for the uncharted', () => {
    const entries = buildEntries(input());
    // (star 4 is not charted; the station is always there)
    expect(entries.map(e => [e.location.sector, e.location.star, e.location.station])).toEqual([[292, 0, -1], [292, 1, -1], [292, 2, -1], [293, -1, 0]]);
    expect(entries[0]!.colour).toBe(DEFAULT_PALETTE.alignment[1]);
    expect(entries.every(e => e.flags === 0)).toBe(true);
  });
  it('leaves out a region switched off, and a dwarf with nothing in it', () => {
    expect(buildEntries(input({}, { regions: 0x1f & ~2 })).map(e => e.location.sector)).toEqual([293]);
    const u = universe();
    u.stars[0] = { ...u.stars[0]!, flags: 1 };
    expect(buildEntries(input({ universe: u })).map(e => e.location.star)).toEqual([1, 2, -1]);
    u.stars[0] = { ...u.stars[0]!, flags: 1 | 4, special: 0 };
    u.specials = [{ ...thing(30, 0x84, 80, 80, 80), sector: 292, star: 0, planet: 2 }];
    const outpost = buildEntries(input({ universe: u })).find(e => e.location.star === 0)!;
    expect([outpost.location.planet, outpost.width]).toEqual([2, 4]);
  });
  it('plots a star at the galaxy\'s centre at the middle of the map, as a pixel in its colour, with the grid and the sector box', () => {
    const layout = layoutMap(input());
    expect(layout.shown).toBe(true);
    const star0 = layout.entries[0]!;
    expect([star0.x, star0.y]).toEqual([194, 184]);
    expect(of(layout.commands, 'pixel').some(p => p.x === 194 && p.y === 184 && p.colour === DEFAULT_PALETTE.alignment[1])).toBe(true);
    // the grid's 3 walls of 9 lines each way, the cube's 12 edges, the ship's line to the cursor
    const lines = of(layout.commands, 'line');
    expect(lines.filter(l => l.colour === DEFAULT_PALETTE.grid)).toHaveLength(3 * 9 * 2);
    expect(lines.filter(l => l.colour === DEFAULT_PALETTE.sectorBox)).toHaveLength(12);
    expect(lines.filter(l => l.colour === DEFAULT_PALETTE.course)).toHaveLength(1);
    expect(of(layout.commands, 'text').map(t => t.text)).toContain('17.320 LY');
    expect(of(layout.commands, 'sprite').map(s => s.name)).toEqual(['ship_marker']);
  });
  it('rings a starbase and crosses an inhabited star when those switches are on, and draws the course being followed', () => {
    const u = universe();
    u.stars[0] = { ...u.stars[0]!, flags: 8 | 0x10 };
    const flags: number[] = []; flags[1] = 1 | 4; flags[2] = 1;
    const on = layoutMap(input({ universe: u, flags, ship: { pos: { x: 90, y: 90, z: 90 }, transit: { to: { x: 100, y: 80, z: 80 }, name: 'There' } } }, { starbases: true, inhabited: true }));
    expect(of(on.commands, 'pixel').filter(p => p.colour === DEFAULT_PALETTE.starbase)).toHaveLength(8);
    expect(of(on.commands, 'line').filter(l => l.colour === DEFAULT_PALETTE.destination)).toHaveLength(1);
    expect(of(on.commands, 'sprite').map(s => s.name)).toEqual(['ship_marker', 'destination_marker']);
    expect(of(on.commands, 'text').some(t => t.text === 'There')).toBe(true);
    u.stars[0] = { ...u.stars[0]!, flags: 0x10 };
    const cross = layoutMap(input({ universe: u, flags }, { inhabited: true }));
    expect(of(cross.commands, 'pixel').filter(p => p.colour === DEFAULT_PALETTE.alignment[1]).length).toBeGreaterThanOrEqual(5);
  });
  it('with the stars off shows the cross sections and the sector box, with nothing to click', () => {
    const layout = layoutMap(input({}, { stars: false }));
    expect(layout.shown).toBe(false);
    expect(of(layout.commands, 'pixel')).toHaveLength(0);
    expect(of(layout.commands, 'line').some(l => l.colour === DEFAULT_PALETTE.crossSection)).toBe(true);
    expect(of(layout.commands, 'line').some(l => l.colour === DEFAULT_PALETTE.ticks)).toBe(true);
    expect(entryAt(layout, 194, 184)).toBe(-1);
  });
  it('picks the entry under a point, within its size', () => {
    const layout = layoutMap(input());
    expect(entryAt(layout, 194, 184)).toBe(0);
    expect(entryAt(layout, 195, 185)).toBe(0);
    expect(entryAt(layout, 200, 190)).toBe(-1);
  });
  it('writes the chosen name at the top, and nothing for a sector alone in the system view', () => {
    const named = layoutMap(input({ selection: here({ star: 0 }) }));
    expect(named.name).toBe('S1');
    expect(of(named.commands, 'text')[0]).toMatchObject({ text: 'S1', x: 199, y: 30, align: 'centre' });
    expect(layoutMap(input()).name).toBe('');
  });
});

describe('the sector view', () => {
  const cam: Partial<MapCamera> = { view: 'sector', cursorSector: [4, 4, 4], cursor: [10, 10, 10] };
  it('has the charted stars sized by class, the charted hazards and the station', () => {
    const entries = buildEntries(input({}, cam));
    expect(entries.map(e => [e.location.star, e.location.phenomenon, e.width])).toEqual([[0, -1, 8], [1, -1, 8], [2, -1, 18], [-1, 0, 18], [-1, 1, 18]]);
    expect(buildEntries(input({}, { ...cam, cursorSector: [5, 4, 4] })).map(e => e.location.station)).toEqual([0]);
  });
  it('draws the furthest first, with each one\'s line down to the floor, dimmer stars smaller, and not the hidden place', () => {
    const layout = layoutMap(input({}, cam));
    const sprites = of(layout.commands, 'sprite');
    // (the hidden place is not drawn, the ship is: 3 stars, a hazard and the ship)
    expect(sprites).toHaveLength(5);
    expect(sprites.map(s => s.name)).toContain('hazard4');
    expect(sprites.map(s => s.name)).toContain('ship');
    // (a magnitude of 4.0: 0xe0 - 40, the original's scale; the dimmest is not under 0x40)
    expect(sprites.find(s => s.name === 'star_class2')!.scale).toBe(0xe0 - 40);
    expect(of(layout.commands, 'line').filter(l => l.colour === DEFAULT_PALETTE.grid).length).toBeGreaterThan(sprites.length);
  });
  it('boxes what is chosen 32 across, and draws the cursor\'s three squares when nothing is', () => {
    const chosen = layoutMap(input({ selection: here({ star: 1 }) }, cam));
    const box = of(chosen.commands, 'line').filter(l => l.colour === DEFAULT_PALETTE.selectionBox);
    expect(box).toHaveLength(4);
    const e = chosen.entries[1]!;
    expect(box[0]).toMatchObject({ x1: e.x - 16, y1: e.y - 16, x2: e.x + 16, y2: e.y - 16 });
    const cursor = layoutMap(input({}, cam));
    for (const colour of [DEFAULT_PALETTE.cursorXY, DEFAULT_PALETTE.cursorYZ, DEFAULT_PALETTE.cursorXZ]) expect(of(cursor.commands, 'line').filter(l => l.colour === colour).length).toBeGreaterThanOrEqual(4);
  });
  it('draws no grid with it off', () => {
    expect(of(layoutMap(input({}, { ...cam, grid: false })).commands, 'line').filter(l => l.colour === DEFAULT_PALETTE.grid)).toHaveLength(0);
  });
});

describe('the system view', () => {
  const cam: Partial<MapCamera> = { view: 'system', cursorSector: [4, 4, 4] };
  const sel = here({ star: 2 });
  const scanned = (extra: Partial<MapInput> = {}) => input({ selection: sel, ...extra }, cam);
  it('has no planets for a star that has not been visited, and says why', () => {
    const layout = layoutMap(input({ selection: here({ star: 1 }) }, cam));
    expect(layout.entries).toEqual([]);
    const text = of(layout.commands, 'text');
    expect(text.some(t => t.text === 'Not scanned yet' && t.y === 185 && t.align === 'centre')).toBe(true);
    // (the star and its class and magnitude are there all the same)
    expect(of(layout.commands, 'sprite')[0]).toMatchObject({ name: 'star', x: 10, y: 25, anchor: 'corner' });
    expect(text.map(t => t.text)).toContain('A5');
    expect(text.map(t => t.text)).toContain('4.0');
  });
  it('places the planets left to right spaced by their size, with their moons above, and writes their classes', () => {
    const layout = layoutMap(scanned());
    const planets = layout.entries.filter(e => e.location.moon === -1);
    expect(planets).toHaveLength(5);
    expect(planets.every(e => e.y === SYSTEM_Y)).toBe(true);
    const sizes = planets.map(e => e.width / 2);
    // x = (sum of half spacings) * 10 + 47: with the fallback sizes (spacing = 2 radius + 6)
    let position = 0, half = 0;
    planets.forEach((e, i) => {
      const spacing = sizes[i]! * 2 + 6;
      position += half + (spacing >> 1);
      half = spacing >> 1;
      expect(e.x).toBe(position * 10 + 47);
    });
    const moons = layout.entries.filter(e => e.location.moon !== -1);
    expect(moons.map(e => e.location.moon)).toEqual([0, 1, 0, 1, 2, 3, 0]);
    expect(moons.every(e => e.width === 6)).toBe(true);
    const letters = of(layout.commands, 'text').filter(t => t.y === 102).map(t => t.text).join('');
    expect(letters).toBe('GJJGJ');
    expect(of(layout.commands, 'sprite').filter(s => s.name.startsWith('planet')).map(s => s.name)).toEqual(['planet6', 'planet9', 'planet9', 'planet6', 'planet9']);
    // each planet's orbit line, from the star
    expect(of(layout.commands, 'line').filter(l => l.colour === DEFAULT_PALETTE.grid && l.y1 === SYSTEM_Y && l.y2 === SYSTEM_Y)).toHaveLength(5);
    expect(of(layout.commands, 'text').map(t => t.text)).toContain('B3');
    // and the binary star's sister
    expect(of(layout.commands, 'sprite').some(s => s.name === 'companion' && s.x === 350)).toBe(true);
  });
  it('shows what is chosen close up: the planet\'s globe, its marker under the row, and a moon\'s own globe', () => {
    const u = universe();
    const planets = makePlanets(u, u.stars[2]!, [], {});
    const planet = layoutMap(scanned({ selection: here({ star: 2, planet: 1 }) }));
    expect(of(planet.commands, 'sprite').some(s => s.name === 'selected' && s.y === 146)).toBe(true);
    expect(planet.commands.at(-1)).toEqual({ kind: 'globe', type: planets[1]!.type, seed: planets[1]!.seed });
    const moon = layoutMap(scanned({ selection: here({ star: 2, planet: 1, moon: 1 }) }));
    expect(moon.commands.at(-1)).toEqual({ kind: 'globe', type: planets[1]!.moons[1]!.type, seed: planets[1]!.moons[1]!.seed });
    // (nothing chosen in particular: no globe)
    expect(of(layoutMap(scanned()).commands, 'globe')).toHaveLength(0);
  });
  it('draws a station alone in the system view, with its name below, and a message for nothing', () => {
    const station = layoutMap(input({ selection: { ...NOWHERE, sector: 293, station: 0 } }, { view: 'system', cursorSector: [5, 4, 4] }));
    expect(of(station.commands, 'sprite')[0]).toMatchObject({ name: 'deep_space_station', x: 195, y: 296, anchor: 'bottom' });
    expect(of(station.commands, 'text').some(t => t.text === 'Base' && t.y === 310)).toBe(true);
    const nothing = layoutMap(input({ selection: here({}) }, cam));
    expect(of(nothing.commands, 'text').some(t => t.y === 185)).toBe(true);
  });
});

describe('what a place is, and what it is called', () => {
  it('knows stars, stations and phenomena, and what is chosen around a star', () => {
    const u = universe();
    expect(locationType(u, here({ star: 0 }))).toBe(0x20);
    expect(locationType(u, { ...NOWHERE, sector: 293, station: 0 })).toBe(0x83);
    expect(locationType(u, here({ phenomenon: 0 }))).toBe(0x44);
    expect(locationType(u, here({}))).toBe(-1);
    expect(locationSubtype(u, here({ star: 0 }))).toBe(-1);
    expect(locationSubtype(u, here({ star: 0, planet: 0 }))).toBe(0x21);
    expect(locationSubtype(u, here({ star: 0, planet: 0, moon: 0 }))).toBe(0x22);
    expect(locationSubtype(u, here({ star: 0, planet: 0, phenomenon: 0 }))).toBe(0x47);
    expect(sectorIndex(80, 80, 80)).toBe(292);
    expect(sameLocation(here({ star: 1 }), here({ star: 1 }))).toBe(true);
    expect(sameLocation(here({ star: 1 }), here({ star: 2 }))).toBe(false);
  });
  it('names the chosen place and the destination as the original does', () => {
    const b = input();
    const u = b.universe;
    expect(chosenName(b, here({ star: 2 }))).toBe('S3');
    expect(chosenName(b, here({ star: 2, planet: 0 }))).toBe('S3 I');
    expect(chosenName(b, here({ star: 2, planet: 1, moon: 0 }))).toBe('S3 IIa');
    expect(chosenName(b, here({ star: 2, planet: 0, phenomenon: 0 }))).toBe('Asteroid belt');
    expect(chosenName(b, { ...NOWHERE, sector: 293, station: 0 })).toBe('Base');
    expect(chosenName(b, here({}))).toBe('');
    u.stars[2] = { ...u.stars[2]!, systemName: 'Sol' };
    expect(chosenName(b, here({ star: 2 }))).toBe('Sol');
    expect(destinationName(b, here({ star: 2, planet: 0 }))).toBe('Sol I');
    expect(destinationName(b, here({ star: 2 }))).toBe('Sol');
    expect(destinationName(b, here({ phenomenon: 0 }))).toBe('Hole');
    // (an uncharted hazard is not named: the sector is)
    expect(destinationName({ ...b, flags: [] }, here({ phenomenon: 0 }))).toBe('Sector292');
  });
  it('finds the entry that is chosen, by what is chosen (the system view wants all of it to match)', () => {
    const b = input({}, { view: 'sector', cursorSector: [4, 4, 4] });
    const entries = buildEntries(b);
    expect(findSelection(b.universe, 'sector', entries, here({ star: 1 }))).toBe(1);
    expect(findSelection(b.universe, 'sector', entries, here({ phenomenon: 1 }))).toBe(4);
    expect(findSelection(b.universe, 'sector', entries, here({}))).toBe(-1);
    expect(findSelection(b.universe, 'system', entries, here({ star: 1 }))).toBe(1);
    expect(findSelection(b.universe, 'system', entries, here({ star: 1, planet: 0 }))).toBe(-1);
  });
});

describe('the palette', () => {
  it('takes the published colours by name and the alignments\', and keeps its own for the rest', () => {
    const p = paletteOf({ grid: '#123456', nonsense: '#ffffff' }, ['#000001', '#000002']);
    expect(p.grid).toBe('#123456');
    expect(p.course).toBe(DEFAULT_PALETTE.course);
    expect(p.alignment).toEqual(['#000001', '#000002']);
    expect(paletteOf().alignment).toHaveLength(5);
  });
});
