// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AstroStar, AstroThing, Universe } from '../content/types';
import { newMapCamera, type MapCamera } from '../sim/astroCamera';
import { NOWHERE, type AstroLocation } from '../sim/ship';
import { layoutMap, paletteOf, type MapInput } from './astroLayout';
import { clickMap, cursorMoved, cursorToSelection, destOrbit, isHazard, locationOf, selectionOf, settleSelection, viewFor } from './astroSelect';

const thing = (id: number, type: number, x: number, y: number, z: number): AstroThing => ({ id, type, seed: 0, x, y, z, name: `T${id}`, range: 1 });
const star = (id: number, x: number, y: number, z: number, over: Partial<AstroStar> = {}): AstroStar => ({
  ...thing(id, 0x20, x, y, z), flags: 0, spectralClass: 25, magnitude: 40, orbitScale: 10, systemName: '', scriptedName: '', scriptedDescription: '', special: -1, ...over,
});
const empty = { numStars: 0, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: '', name: '', region: 0 };
function universe(): Universe {
  const sectors = Array.from({ length: 512 }, () => ({ ...empty }));
  sectors[292] = { ...empty, numStars: 2, firstStar: 0, numPhenomena: 1, firstPhenomenon: 0 };
  sectors[293] = { ...empty, station: 0 };
  return {
    sectors, stars: [star(1, 85, 90, 90, { seed: 39679, flags: 2, spectralClass: 13, magnitude: -20, orbitScale: 202 }), star(2, 90, 82, 83)],
    phenomena: [thing(10, 0x44, 95, 95, 95)], stations: [thing(20, 0x83, 100, 90, 90)], specials: [], flags: [], regionChatter: [], warpSpeeds: [], impulseSpeeds: [],
    scriptedWarps: [], planetOrbits: [4, 7, 10, 16, 28, 52, 100, 196, 388, 772, 1540, 3076, 6148, 12292, 24548, 0], reveals: [],
  };
}
const here = (over: Partial<AstroLocation>): AstroLocation => ({ ...NOWHERE, sector: 292, ...over });
const flags = (): number[] => { const f: number[] = []; f[1] = 1 | 4 | 8; f[2] = 1; f[10] = 1; f[20] = 1; return f; };
function input(selection: AstroLocation, cam: Partial<MapCamera> = {}): MapInput {
  return {
    universe: universe(), flags: flags(), cam: { ...newMapCamera(), azimuth: 0, elevation: 0, spinning: false, cursorSector: [4, 4, 4], ...cam }, selection,
    ship: { pos: { x: 90, y: 90, z: 90 }, transit: null }, lightYears: 0, palette: paletteOf(), tables: {}, measure: (_f, t) => t.length * 5,
  };
}

describe('selection and location', () => {
  it('turn into each other, with nowhere as null', () => {
    expect(selectionOf(locationOf(null))).toBeNull();
    expect(selectionOf(here({ star: 1, planet: 2, moon: 0 }))).toEqual({ sector: 292, star: 1, planet: 2, moon: 0 });
    expect(selectionOf({ ...NOWHERE, sector: 293, station: 0 })).toEqual({ sector: 293, station: true });
    expect(locationOf({ sector: 3, star: 1, station: true })).toEqual({ sector: 3, star: 1, planet: -1, moon: -1, station: 0, phenomenon: -1 });
    expect(locationOf({ sector: 292, phenomenon: 0 }).phenomenon).toBe(0);
  });
  it('shows a star or place close up: the sector, or the system for a planet of it', () => {
    expect(viewFor(here({}))).toBeNull();
    expect(viewFor(here({ star: 0 }))).toBe('sector');
    expect(viewFor(here({ phenomenon: 0 }))).toBe('sector');
    expect(viewFor(here({ star: 0, planet: 1 }))).toBe('system');
    expect(viewFor({ ...NOWHERE, sector: 293, station: 0 })).toBe('sector');
  });
  it('knows the hazards, which the original warns of when one is chosen', () => {
    const u = universe();
    expect(isHazard(u, here({ phenomenon: 0 }))).toBe(true);
    expect(isHazard(u, here({ star: 0 }))).toBe(false);
  });
});

describe('the cursor and the choice', () => {
  it('goes to what is chosen: the thing\'s place in its sector, or the sector\'s corner', () => {
    const u = universe(), cam = newMapCamera();
    cursorToSelection(u, cam, here({ star: 0 }));
    expect([cam.cursorSector, cam.cursor]).toEqual([[4, 4, 4], [5, 10, 10]]);
    cursorToSelection(u, cam, { ...NOWHERE, sector: 293, station: 0 });
    expect([cam.cursorSector, cam.cursor]).toEqual([[5, 4, 4], [0, 10, 10]]);
    cursorToSelection(u, cam, here({}));
    expect(cam.cursor).toEqual([0, 0, 0]);
  });
  it('chooses what is at the cursor if it is charted, and only the sector in the galaxy view', () => {
    const u = universe(), f = flags();
    const cam = { ...newMapCamera(), view: 'sector' as const, cursorSector: [4, 4, 4] as [number, number, number], cursor: [5, 10, 10] as [number, number, number] };
    expect(cursorMoved(u, f, cam)).toEqual(here({ star: 0 }));
    cam.cursor = [15, 15, 15];
    expect(cursorMoved(u, f, cam)).toEqual(here({ phenomenon: 0 }));
    cam.cursor = [11, 11, 11];
    expect(cursorMoved(u, f, cam)).toEqual(here({}));
    f[10] = 0;
    cam.cursor = [15, 15, 15];
    expect(cursorMoved(u, f, cam)).toEqual(here({}));
    cam.cursorSector = [5, 4, 4]; cam.cursor = [0, 10, 10];
    expect(cursorMoved(u, f, cam)).toEqual({ ...NOWHERE, sector: 293, station: 0 });
    expect(cursorMoved(u, f, { ...cam, view: 'galaxy' })).toEqual({ ...NOWHERE, sector: 293 });
  });
  it('knows how far the place chosen is from its star: a planet\'s or moon\'s orbit, nothing for an outpost or the star', () => {
    const b = input(here({}));
    expect(destOrbit(b, here({ star: 0 }))).toBe(0);
    expect(destOrbit(b, here({ star: 0, planet: 0 }))).toBe(80);
    expect(destOrbit(b, here({ star: 0, planet: 1, moon: 0 }))).toBe(151);
    expect(destOrbit(b, here({ star: 0, planet: 1, station: 0 }))).toBe(0);
    expect(destOrbit(b, here({ star: 0, planet: 9 }))).toBe(0);
  });
});

describe('clicking the map', () => {
  it('in the galaxy view chooses the sector by where the click is on the screen, and a star if one is hit', () => {
    const b = input(here({}));
    const layout = layoutMap(b);
    const cam = b.cam;
    const hit = clickMap(b.universe, cam, layout, 100, 90 + 179);
    expect(cam.cursorSector.slice(0, 2)).toEqual([0, 0]);
    expect(hit).toEqual({ selection: { ...NOWHERE, sector: 4 * 8 * 0 + 0 + 4 * 64 }, setCursor: true });
    const star0 = layout.entries[0]!;
    const onStar = clickMap(b.universe, cam, layout, star0.x, star0.y);
    expect(onStar!.selection).toEqual(here({ star: 0 }));
    // (clamped to the grid)
    clickMap(b.universe, cam, layout, 999, -50);
    expect(cam.cursorSector.slice(0, 2)).toEqual([7, 7]);
  });
  it('in the sector view chooses what was clicked, and does nothing for a click on nothing', () => {
    const b = input(here({}), { view: 'sector' });
    const layout = layoutMap(b);
    const e = layout.entries[1]!;
    expect(clickMap(b.universe, b.cam, layout, e.x, e.y)).toEqual({ selection: here({ star: 1 }), setCursor: true });
    expect(clickMap(b.universe, b.cam, layout, 5, 5)).toBeNull();
  });
  it('in the system view chooses a planet but not the outpost, and leaves the cursor', () => {
    const b = input(here({ star: 0 }), { view: 'system' });
    const layout = layoutMap(b);
    const planet = layout.entries[0]!;
    expect(clickMap(b.universe, b.cam, layout, planet.x, planet.y)).toEqual({ selection: here({ star: 0, planet: 0 }), setCursor: false });
    const outpost = { ...layout, entries: [{ ...planet, location: here({ star: 0, planet: 0, station: 0 }) }] };
    expect(clickMap(b.universe, b.cam, outpost, planet.x, planet.y)).toBeNull();
  });
});

describe('settling what is chosen when the entries are built', () => {
  it('in the sector view, a choice that is not there falls back to the first thing there, or to the sector alone', () => {
    const lost = input(here({ star: 0, planet: 3 }), { view: 'sector' });
    const entries = layoutMap(lost).entries;
    expect(settleSelection(lost, entries)).toBeNull();
    const elsewhere = input({ ...NOWHERE, sector: 100, star: 0 }, { view: 'sector' });
    expect(settleSelection(elsewhere, layoutMap(elsewhere).entries)).toEqual({ selection: here({ star: 0 }), setCursor: true });
    const bare = input({ ...NOWHERE, sector: 300 }, { view: 'sector', cursorSector: [4, 4, 4] });
    expect(settleSelection(bare, [])).toEqual({ selection: here({}), setCursor: true });
    const only = input(here({}), { view: 'sector' });
    expect(settleSelection(only, [])).toBeNull();
    // (a script's warp to a hidden place stays)
    expect(settleSelection(bare, [], true)).toBeNull();
    const fine = input(here({ star: 1 }), { view: 'sector' });
    expect(settleSelection(fine, layoutMap(fine).entries)).toBeNull();
  });
  it('in the system view, a planet that is not there leaves the star chosen; the galaxy view settles nothing', () => {
    const b = input(here({ star: 0, planet: 9 }), { view: 'system' });
    expect(settleSelection(b, layoutMap(b).entries)).toEqual({ selection: here({ star: 0 }), setCursor: false });
    const ok = input(here({ star: 0, planet: 1 }), { view: 'system' });
    expect(settleSelection(ok, layoutMap(ok).entries)).toBeNull();
    const starOnly = input(here({ star: 0 }), { view: 'system' });
    expect(settleSelection(starOnly, layoutMap(starOnly).entries)).toBeNull();
    // (an unscanned star has no entries and is left alone)
    const unscanned = input(here({ star: 1, planet: 0 }), { view: 'system' });
    expect(settleSelection(unscanned, [])).toBeNull();
    expect(settleSelection(input(here({})), [])).toBeNull();
  });
});
