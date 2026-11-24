// SPDX-License-Identifier: GPL-3.0-or-later
import type { Universe } from '../content/types';
import { cursorTo, type MapCamera, type MapView } from '../sim/astroCamera';
import { makePlanets } from '../sim/planets';
import { NOWHERE, type AstroLocation } from '../sim/ship';
import {
  entryAt, findSelection, locationType, phenomenonAt, sameLocation, sectorIndex, starAt, stationAt, type MapEntry, type MapInput, type MapLayout,
} from './astroLayout';

// What the astrogation screen has chosen and how clicking and the cursor change it, ported from engines/unity/astrogation.cpp (AstrogationScreen::
// selectionChanged, cursorMoved, selectEntry, pressButton's map click, buildSectorEntries and buildSystemEntries' last paragraphs; read-only
// reference). The state is the map camera (astroCamera.ts: the cursor) and the location chosen; neither is saved and the world never reads them.

/** What astrogation has picked, for the panels: a sector, then a star in it, then a planet of the star, its moon, outpost or belt; or a station or phenomenon of the sector. */
export interface AstroSelection { sector: number; star?: number; planet?: number; moon?: number; station?: boolean; phenomenon?: number }

export const locationOf = (s: AstroSelection | null): AstroLocation => s === null ? { ...NOWHERE } : {
  sector: s.sector, star: s.star ?? -1, planet: s.planet ?? -1, moon: s.moon ?? -1, station: s.station ? 0 : -1, phenomenon: s.phenomenon ?? -1,
};
export const selectionOf = (l: AstroLocation): AstroSelection | null => l.sector < 0 ? null : {
  sector: l.sector,
  ...(l.star >= 0 ? { star: l.star } : {}), ...(l.planet >= 0 ? { planet: l.planet } : {}), ...(l.moon >= 0 ? { moon: l.moon } : {}),
  ...(l.station >= 0 ? { station: true } : {}), ...(l.phenomenon >= 0 ? { phenomenon: l.phenomenon } : {}),
};

type Basis = Pick<MapInput, 'universe' | 'flags' | 'tables'>;

/** How far the place chosen is from its star, in light seconds (selectionChanged's `_destOrbit`). */
export function destOrbit(b: Basis, l: AstroLocation): number {
  const star = starAt(b.universe, l);
  if (!star || l.planet === -1) return 0;
  const planet = makePlanets(b.universe, star, b.flags, b.tables)[l.planet];
  if (!planet) return 0;
  if (l.moon !== -1 && l.moon < planet.moons.length) return planet.moons[l.moon]!.orbit;
  return l.station === -1 ? planet.orbit : 0;
}

/** AstrogationScreen::selectionChanged's first half: the cursor goes to what is chosen (and the sector to the chosen sector). */
export function cursorToSelection(u: Universe, cam: MapCamera, l: AstroLocation): void {
  const thing = starAt(u, l) ?? stationAt(u, l) ?? phenomenonAt(u, l);
  cursorTo(cam, l.sector, thing ? { x: thing.x, y: thing.y, z: thing.z } : null);
}

/** AstrogationScreen::cursorMoved: what is at the cursor, if charted, is chosen; else the sector alone (the galaxy view only chooses the sector). */
export function cursorMoved(u: Universe, flags: readonly number[], cam: MapCamera): AstroLocation {
  const index = sectorIndex(cam.cursorSector[0] * 20, cam.cursorSector[1] * 20, cam.cursorSector[2] * 20);
  const l: AstroLocation = { ...NOWHERE, sector: index };
  if (cam.view === 'galaxy') return l;
  // anything at the cursor is chosen
  const x = cam.cursorSector[0] * 20 + cam.cursor[0], y = cam.cursorSector[1] * 20 + cam.cursor[1], z = cam.cursorSector[2] * 20 + cam.cursor[2];
  const sector = u.sectors[index];
  if (!sector) return l;
  for (let i = 0; i < sector.numStars; i++) {
    const star = u.stars[sector.firstStar + i]!;
    if (star.x === x && star.y === y && star.z === z && ((flags[star.id] ?? 0) & 1)) { l.star = i; break; }
  }
  for (let i = 0; l.star === -1 && i < sector.numPhenomena; i++) {
    const p = u.phenomena[sector.firstPhenomenon + i]!;
    if (p.x === x && p.y === y && p.z === z && ((flags[p.id] ?? 0) & 1)) { l.phenomenon = i; break; }
  }
  if (l.star === -1 && l.phenomenon === -1 && sector.station !== -1) {
    const s = u.stations[sector.station]!;
    if (s.x === x && s.y === y && s.z === z) l.station = 0;
  }
  return l;
}

/** What a click on the map does (pressButton, the map's part): the new selection, and whether the cursor goes to it (selectionChanged(true)); null for nothing. */
export function clickMap(u: Universe, cam: MapCamera, layout: Pick<MapLayout, 'entries' | 'shown'>, x: number, y: number): { selection: AstroLocation; setCursor: boolean } | null {
  const hit = entryAt(layout, x, y);
  if (cam.view === 'galaxy') {
    // clicking anywhere chooses a sector, by where it is on the screen
    cam.cursorSector[0] = Math.trunc(Math.max(0, Math.min(199, x - 100)) * 8 / 200);
    cam.cursorSector[1] = 7 - Math.trunc(Math.max(0, Math.min(179, y - 90)) * 8 / 180);
    let selection: AstroLocation = { ...NOWHERE, sector: sectorIndex(cam.cursorSector[0] * 20, cam.cursorSector[1] * 20, cam.cursorSector[2] * 20) };
    if (hit !== -1) selection = { ...layout.entries[hit]!.location };
    return { selection, setCursor: true };
  }
  if (hit === -1) return null;
  const entry = layout.entries[hit]!;
  if (cam.view === 'system') {
    // (outposts can't be chosen here)
    if (entry.location.station !== -1) return null;
    return { selection: { ...entry.location }, setCursor: false };
  }
  return { selection: { ...entry.location }, setCursor: true };
}

/**
 * What the original does once it has built the entries for a view (the end of buildSectorEntries and buildSystemEntries): with nothing to choose in the
 * sector only the sector stays chosen, and a system with nothing in particular chosen has the star chosen. Returns the new selection and whether the
 * cursor goes to it, or null to leave it. `keep` is a script's warp to a hidden place, which stays.
 */
export function settleSelection(input: MapInput, entries: readonly MapEntry[], keep = false): { selection: AstroLocation; setCursor: boolean } | null {
  const { universe: u, cam, selection } = input;
  if (cam.view === 'sector') {
    const index = sectorIndex(cam.cursorSector[0] * 20, cam.cursorSector[1] * 20, cam.cursorSector[2] * 20);
    if (entries.length > 0 && findSelection(u, 'sector', entries, selection) !== -1) return null;
    if (keep) return null;
    if (entries.length > 0 && selection.sector !== index) return { selection: { ...entries[0]!.location }, setCursor: true };
    const only: AstroLocation = { ...NOWHERE, sector: index };
    if (sameLocation(selection, only)) return null;
    return { selection: only, setCursor: true };
  }
  if (cam.view === 'system') {
    const star = starAt(u, selection);
    if (!star || !((input.flags[star.id] ?? 0) & 8)) return null;
    if (findSelection(u, 'system', entries, selection) !== -1) return null;
    const only: AstroLocation = { ...NOWHERE, sector: selection.sector, star: selection.star };
    return sameLocation(selection, only) ? null : { selection: only, setCursor: false };
  }
  return null;
}

/** AstrogationScreen::start: something chosen is shown close up (a star or a place, the sector; a planet of it, the system). */
export function viewFor(l: AstroLocation): MapView | null {
  if (l.star === -1 && l.station === -1 && l.phenomenon === -1) return null;
  return l.planet === -1 ? 'sector' : 'system';
}

/** Whether a selection is a hazard (the original speaks a warning when one is chosen); a type from 0x41 to 0x45. */
export function isHazard(u: Universe, l: AstroLocation): boolean {
  const type = locationType(u, l);
  return type >= 0x41 && type <= 0x45;
}
