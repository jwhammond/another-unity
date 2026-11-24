// SPDX-License-Identifier: GPL-3.0-or-later
import type { AstroStar, AstroThing, Universe } from '../content/types';
import type { MapCamera } from '../sim/astroCamera';
import { companionStar, magnitudeName, makePlanets, planetClassLetter, spectralName, THING, PLANET_BELT, STAR_BINARY, STAR_DWARF, STAR_HAS_OUTPOST, STAR_HAS_STARBASE, STAR_SCRIPTED, type Planet, type PlanetTables } from '../sim/planets';
import type { AstroLocation, Vec3i } from '../sim/ship';

// The astrogation map's drawing, ported from engines/unity/astrogation.cpp (AstrogationScreen::draw and what it calls; read-only reference). It is
// pure: it turns the state into the original's drawing commands in its own pixels (640x480; the map's window is [10, 19, 379, 348] of that) and
// the entries that can be clicked, and painting them (astroPaint.ts) is a separate step. Nothing here draws.

/** The map's window in the original's pixels (mapRect, with the strip under it: astrogation.cpp:961). */
export const MAP_WINDOW = { x: 10, y: 19, width: 379, height: 348 } as const;
/** Where the map's projection is centred on the screen (kMapCentreX, kMapCentreY) and how far the camera stands in the galaxy and sector views (kGalaxyDistance, kSectorDistance). */
const MAP_CENTRE_X = 194, MAP_CENTRE_Y = 184, GALAXY_DISTANCE = 1920, SECTOR_DISTANCE = 210;
/** How big things look in the sector view, by spectral class (kStarSizes). */
const STAR_SIZES = [22, 18, 8, 16, 14, 24, 28];
/** The star system view: the row the planets sit on, and where the globe goes (kSystemY, kGlobeX, kGlobeY, kGlobeSize). */
export const SYSTEM_Y = 76;
export const GLOBE = { x: 140, y: 176, size: 120 } as const;
const FLAG_CHARTED = 1, FLAG_VISITED = 4, FLAG_SCANNED = 8;

/** The map's colours (kColour* in astrogation.cpp:896-914 over the screen's palette; the screen's own are art.astro.tables.colours). */
export interface MapPalette {
  black: string; crossSection: string; grid: string; sectorBox: string; starbase: string; course: string; cursorYZ: string; destination: string;
  selectionBox: string; cubeBack: string; cursorXY: string; ticks: string; cursorXZ: string; digitZ: string; digitY: string; digitX: string;
  /** The five alignments' star colours (`_alignmentColours`). */
  alignment: string[];
  /** The text colours of the info and label fonts. */
  info: string; label: string;
}
/** Close to the original's, for when its palette is not published. */
export const DEFAULT_PALETTE: MapPalette = {
  black: '#000000', crossSection: '#404040', grid: '#606060', sectorBox: '#a4a4a4', starbase: '#fc8830', course: '#68e0fc', cursorYZ: '#fc4040', destination: '#fcfc00',
  selectionBox: '#d8d8d8', cubeBack: '#303030', cursorXY: '#4c4cfc', ticks: '#808080', cursorXZ: '#14c468', digitZ: '#fcfc00', digitY: '#14c468', digitX: '#fc4040',
  alignment: ['#44a0ec', '#14c468', '#fcfc00', '#ec4444', '#a4a4a4'], info: '#208ce0', label: '#1c74b8',
};
export function paletteOf(colours?: Record<string, string>, alignment?: readonly string[]): MapPalette {
  const p: MapPalette = { ...DEFAULT_PALETTE, alignment: alignment && alignment.length > 0 ? [...alignment] : DEFAULT_PALETTE.alignment };
  for (const [name, hex] of Object.entries(colours ?? {})) if (name in p && name !== 'alignment' && name !== 'info' && name !== 'label') (p as unknown as Record<string, string>)[name] = hex;
  return p;
}

export type MapFont = 'map' | 'info' | 'label';
/** One thing to draw, in the original's pixels, in order. Lines are inclusive of both ends, as the original's are. */
export type MapCommand =
  | { kind: 'fill'; x1: number; y1: number; x2: number; y2: number; colour: string }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; colour: string }
  | { kind: 'pixel'; x: number; y: number; colour: string }
  /** A picture by name, centred on (x, y), with its corner there or standing on it (its bottom edge on y, centred on x); `scale` is of 256 (the sector view's dimmer stars are smaller). */
  | { kind: 'sprite'; name: string; x: number; y: number; anchor: 'centre' | 'corner' | 'bottom'; scale?: number }
  | { kind: 'text'; x: number; y: number; text: string; font: MapFont; colour: string; align?: 'left' | 'centre' }
  | { kind: 'globe'; type: number; seed: number };

/** Something on the map that can be clicked: its place and size on the screen (centred), and what it is. */
export interface MapEntry { location: AstroLocation; x: number; y: number; width: number; height: number; colour: string; flags: number }
export const ENTRY_INHABITED = 1, ENTRY_STARBASE = 4;

export interface MapInput {
  universe: Universe;
  /** Astrogation::_flags, by thing id. */
  flags: readonly number[];
  cam: MapCamera;
  selection: AstroLocation;
  ship: { pos: Vec3i; transit: { to: Vec3i; name: string } | null };
  /** The distance to the cursor in light years (the course line's label). */
  lightYears: number;
  palette: MapPalette;
  tables: PlanetTables & { planetSizes?: readonly { radius: number; spacing: number }[]; messages?: readonly string[] };
  /** How far the camera is pulled back, 1 for as the original has it. */
  zoom?: number;
  /** The width of a string in a font, in the original's pixels (the painter measures; without it a guess). */
  measure?: (font: MapFont, text: string) => number;
}

export interface MapLayout {
  commands: MapCommand[];
  entries: MapEntry[];
  /** Whether the entries are on the screen and can be clicked (`_entriesShown`). */
  shown: boolean;
  /** What the picture of the planet or moon chosen is: drawn big on the system view. */
  name: string;
}

/** What the system view says without the executable's messages (index 1: nothing to show; 3: not scanned yet): our own words. */
const FALLBACK_MESSAGES = ['', 'No planets here', '', 'Not scanned yet'];

/** The sizes of the planets' pictures on the system view when the executable's are not published: bigger for the giants. */
export const FALLBACK_PLANET_SIZES = [18, 15, 8, 10, 9, 10, 13, 8, 6, 7, 11, 12, 12, 12, 20, 16].map(radius => ({ radius, spacing: radius * 2 + 6 }));

// ---- the universe, as Astrogation::star, station and phenomenon see it ------------------------------------------------------------

export function starAt(u: Universe, l: AstroLocation): AstroStar | undefined {
  const s = u.sectors[l.sector];
  if (l.sector < 0 || !s || l.star < 0 || l.star >= s.numStars) return undefined;
  return u.stars[s.firstStar + l.star];
}
export function stationAt(u: Universe, l: AstroLocation): AstroThing | undefined {
  const s = u.sectors[l.sector];
  if (l.sector < 0 || !s || l.station < 0 || s.station === -1) return undefined;
  return u.stations[s.station];
}
export function phenomenonAt(u: Universe, l: AstroLocation): AstroThing | undefined {
  const s = u.sectors[l.sector];
  if (l.sector < 0 || !s || l.phenomenon < 0 || l.phenomenon >= s.numPhenomena) return undefined;
  return u.phenomena[s.firstPhenomenon + l.phenomenon];
}
/** Astrogation::locationType: what a place is (a star, station or phenomenon), or -1. */
export function locationType(u: Universe, l: AstroLocation): number {
  if (l.star !== -1) return starAt(u, l) ? THING.star : -1;
  const thing = stationAt(u, l) ?? phenomenonAt(u, l);
  return thing ? thing.type : -1;
}
/** Astrogation::locationSubtype: what is chosen around a star (a planet, moon, outpost or belt), or -1. */
export function locationSubtype(u: Universe, l: AstroLocation): number {
  if (l.planet === -1) return -1;
  if (l.moon !== -1) return THING.moon;
  if (l.station !== -1) {
    const s = starAt(u, l);
    return s && s.special !== -1 ? u.specials[s.special]!.type : -1;
  }
  if (l.phenomenon !== -1) return THING.asteroidBelt;
  return THING.planet;
}
export const sameLocation = (a: AstroLocation, b: AstroLocation): boolean =>
  a.sector === b.sector && a.star === b.star && a.planet === b.planet && a.moon === b.moon && a.station === b.station && a.phenomenon === b.phenomenon;

/** The sector of a place's index: x + 8 y + 64 z (Astrogation::sector). */
export const sectorIndex = (x: number, y: number, z: number): number => Math.trunc(x / 20) + Math.trunc(y / 20) * 8 + Math.trunc(z / 20) * 64;

const here = (sector: number): AstroLocation => ({ sector, star: -1, planet: -1, moon: -1, station: -1, phenomenon: -1 });

// ---- the projection (AstrogationScreen::setProjection, project) ---------------------------------------------------------------------

interface Projection { sinYaw: number; cosYaw: number; sinPitch: number; cosPitch: number; centre: [number, number, number]; distance: number }

function projection(cam: MapCamera, x: number, y: number, z: number, distance: number): Projection {
  // (the angles are in steps of a 16384-step circle)
  const yaw = (Math.trunc(cam.azimuth * 16384 / 360) * 2 * Math.PI) / 16384;
  const pitch = (Math.trunc(cam.elevation * 16384 / 360) * 2 * Math.PI) / 16384;
  return { sinYaw: Math.sin(yaw), cosYaw: Math.cos(yaw), sinPitch: Math.sin(pitch), cosPitch: Math.cos(pitch), centre: [x, y, z], distance };
}

/** Where a point is on the screen, and how far back it is (a larger depth is further away). A little perspective, turned about the vertical axis and then tilted. */
function project(p: Projection, x: number, y: number, z: number): { x: number; y: number; depth: number } {
  const vx = (x - p.centre[0]) * 32, vy = (p.centre[1] - y) * 32, vz = (z - p.centre[2]) * 32;
  const px = p.cosYaw * vx + p.sinYaw * p.sinPitch * vy + p.sinYaw * p.cosPitch * vz;
  const py = p.cosPitch * vy - p.sinPitch * vz;
  const pz = -p.sinYaw * vx + p.cosYaw * p.sinPitch * vy + p.cosYaw * p.cosPitch * vz;
  const focus = 32 * 80;
  const d = p.distance * 32 + focus + pz;
  return { x: Math.trunc(focus * px / d) + MAP_CENTRE_X, y: Math.trunc(focus * py / d) + MAP_CENTRE_Y, depth: pz };
}

// ---- the layout --------------------------------------------------------------------------------------------------------------------

/** The sector the cursor is in. */
const cursorSectorOf = (cam: MapCamera): number => sectorIndex(cam.cursorSector[0] * 20, cam.cursorSector[1] * 20, cam.cursorSector[2] * 20);
const cursorAt = (cam: MapCamera): Vec3i => ({ x: cam.cursorSector[0] * 20 + cam.cursor[0], y: cam.cursorSector[1] * 20 + cam.cursor[1], z: cam.cursorSector[2] * 20 + cam.cursor[2] });

/** What the map has to click on in a view (AstrogationScreen::buildEntries). Positions are set when drawn, but for the system view's. */
export function buildEntries(input: MapInput): MapEntry[] {
  switch (input.cam.view) {
    case 'galaxy': return galaxyEntries(input);
    case 'sector': return sectorEntries(input);
    default: return systemEntries(input);
  }
}

function galaxyEntries({ universe: u, flags, cam, palette }: MapInput): MapEntry[] {
  const entries: MapEntry[] = [];
  u.sectors.forEach((sector, i) => {
    if (!(cam.regions & (1 << sector.alignment))) return;
    const colour = palette.alignment[Math.min(sector.alignment, palette.alignment.length - 1)]!;
    // the charted stars (and the outposts at dark ones)
    for (let j = 0; j < sector.numStars; j++) {
      const star = u.stars[sector.firstStar + j]!;
      const f = flags[star.id] ?? 0;
      if (!(f & FLAG_CHARTED)) continue;
      const entry: MapEntry = { location: { ...here(i), star: j }, x: 0, y: 0, width: 2, height: 2, colour, flags: 0 };
      if ((star.flags & STAR_SCRIPTED) && (f & FLAG_VISITED)) entry.flags |= ENTRY_INHABITED;
      if (star.flags & STAR_HAS_STARBASE) entry.flags |= ENTRY_STARBASE;
      const visible = !(star.flags & STAR_DWARF) && star.spectralClass < 60;
      if (visible || (star.flags & STAR_SCRIPTED)) {
        entries.push(entry);
      } else if (star.flags & STAR_HAS_OUTPOST) {
        entry.location.planet = star.special !== -1 ? u.specials[star.special]!.planet : -1;
        entry.width = entry.height = 4;
        entries.push(entry);
      }
    }
    // (the stations are always there)
    if (sector.station !== -1) entries.push({ location: { ...here(i), station: 0 }, x: 0, y: 0, width: 4, height: 4, colour, flags: 0 });
  });
  return entries;
}

function sectorEntries({ universe: u, flags, cam }: MapInput): MapEntry[] {
  const index = cursorSectorOf(cam);
  const sector = u.sectors[index];
  const entries: MapEntry[] = [];
  if (!sector) return entries;
  for (let i = 0; i < sector.numStars; i++) {
    const star = u.stars[sector.firstStar + i]!;
    if (!((flags[star.id] ?? 0) & FLAG_CHARTED)) continue;
    entries.push({ location: { ...here(index), star: i }, x: 0, y: 0, width: STAR_SIZES[Math.min(Math.trunc(star.spectralClass / 10), 6)]!, height: STAR_SIZES[Math.min(Math.trunc(star.spectralClass / 10), 6)]!, colour: '', flags: 0 });
  }
  for (let i = 0; i < sector.numPhenomena; i++) {
    const p = u.phenomena[sector.firstPhenomenon + i]!;
    if (!((flags[p.id] ?? 0) & FLAG_CHARTED)) continue;
    entries.push({ location: { ...here(index), phenomenon: i }, x: 0, y: 0, width: 18, height: 18, colour: '', flags: 0 });
  }
  if (sector.station !== -1) entries.push({ location: { ...here(index), station: 0 }, x: 0, y: 0, width: 18, height: 18, colour: '', flags: 0 });
  return entries;
}

/** The system view's entries: the planets left to right spaced by their size, with their moons, outpost and belt (buildSystemEntries). */
function systemEntries({ universe: u, flags, selection, tables }: MapInput): MapEntry[] {
  const star = starAt(u, selection);
  if (!star || !((flags[star.id] ?? 0) & FLAG_SCANNED)) return [];
  const planets = makePlanets(u, star, flags, tables);
  const sizes = tables.planetSizes ?? FALLBACK_PLANET_SIZES;
  const entries: MapEntry[] = [];
  let position = 0, half = 0;
  planets.forEach((planet, i) => {
    const size = sizes[Math.min(planet.type, sizes.length - 1)]!;
    position += half + (size.spacing >> 1);
    half = size.spacing >> 1;
    const x = position * 10 + 47;
    const at = { ...here(selection.sector), star: selection.star, planet: i };
    entries.push({ location: { ...at }, x, y: SYSTEM_Y, width: size.radius * 2, height: size.radius * 2, colour: '', flags: 0 });
    planet.moons.forEach((_, j) => {
      entries.push({ location: { ...at, moon: j }, x: x - 3 - 3 * j, y: SYSTEM_Y - size.radius - 9 - 9 * j, width: 6, height: 6, colour: '', flags: 0 });
    });
    if ((star.flags & STAR_HAS_OUTPOST) && star.special !== -1 && u.specials[star.special]!.planet === i) {
      entries.push({ location: { ...at, station: 0 }, x: x + 13, y: SYSTEM_Y - size.radius - 18, width: 13, height: 18, colour: '', flags: 0 });
    }
    if (planet.flags & PLANET_BELT) {
      entries.push({ location: { ...at, phenomenon: 0 }, x: x + size.radius + 4, y: SYSTEM_Y, width: 4, height: 100, colour: '', flags: 0 });
    }
  });
  return entries;
}

/** AstrogationScreen::findSelection: the entry that is chosen, or -1. */
export function findSelection(u: Universe, view: MapCamera['view'], entries: readonly MapEntry[], selection: AstroLocation): number {
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i]!.location;
    if (view === 'system') {
      if (sameLocation(l, selection)) return i;
      continue;
    }
    if (l.sector !== selection.sector) continue;
    if (selection.star !== -1) {
      if (l.star === selection.star) return i;
    } else if (selection.station !== -1) {
      if (l.station === selection.station) return i;
    } else if (selection.phenomenon !== -1 && l.phenomenon === selection.phenomenon) {
      return i;
    }
  }
  return -1;
}

/** AstrogationScreen::entryAt: the entry under a point on the screen, or -1 (only once they have been placed there). */
export function entryAt(layout: Pick<MapLayout, 'entries' | 'shown'>, x: number, y: number): number {
  if (!layout.shown) return -1;
  for (let i = 0; i < layout.entries.length; i++) {
    const e = layout.entries[i]!;
    const left = e.x - (e.width >> 1), top = e.y - (e.height >> 1);
    if (x >= left && x <= left + e.width && y >= top && y <= top + e.height) return i;
  }
  return -1;
}

/** The name drawn at the top of the map for what is chosen (drawTitle's second half): empty when nothing is. */
export function chosenName(input: Pick<MapInput, 'universe' | 'flags' | 'tables'>, l: AstroLocation): string {
  const u = input.universe;
  if (l.sector < 0) return '';
  const star = starAt(u, l);
  if (star) {
    const subtype = locationSubtype(u, l);
    if (subtype === -1) return star.systemName === '' ? star.name : star.systemName;
    if (subtype === THING.asteroidBelt) return 'Asteroid belt';
    if (subtype === THING.planet || subtype === THING.moon) {
      const planet = makePlanets(u, star, input.flags, input.tables)[l.planet];
      if (!planet) return '';
      return subtype === THING.moon && l.moon < planet.moons.length ? planet.moons[l.moon]!.name : planet.name;
    }
    return star.special !== -1 ? u.specials[star.special]!.name : '';
  }
  return stationAt(u, l)?.name ?? '';
}

/** The name a journey to a place carries (startCourse): the star system's, the planet's or moon's, the outpost's, or a station's or phenomenon's. */
export function destinationName(input: Pick<MapInput, 'universe' | 'flags' | 'tables'>, l: AstroLocation): string {
  const u = input.universe;
  const star = starAt(u, l);
  if (star) {
    const subtype = locationSubtype(u, l);
    const planet = subtype === -1 ? undefined : makePlanets(u, star, input.flags, input.tables)[l.planet];
    if (planet && (subtype === THING.planet || subtype === THING.asteroidBelt)) return planet.name;
    if (planet && subtype === THING.moon && planet.moons[l.moon]) return planet.moons[l.moon]!.name;
    if (planet && star.special !== -1) return u.specials[star.special]!.name;
    return star.systemName === '' ? star.name : star.systemName;
  }
  const thing = stationAt(u, l) ?? phenomenonAt(u, l);
  // (uncharted hazards aren't named)
  if (thing && ((thing.type & 0x40) === 0 || ((input.flags[thing.id] ?? 0) & FLAG_CHARTED))) return thing.name;
  return u.sectors[l.sector]?.name ?? '';
}

class Drawing {
  commands: MapCommand[] = [];
  fill(x1: number, y1: number, x2: number, y2: number, colour: string): void { this.commands.push({ kind: 'fill', x1, y1, x2, y2, colour }); }
  line(a: { x: number; y: number }, b: { x: number; y: number }, colour: string): void { this.commands.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, colour }); }
  pixel(x: number, y: number, colour: string): void { this.commands.push({ kind: 'pixel', x, y, colour }); }
  sprite(name: string, x: number, y: number, anchor: 'centre' | 'corner' | 'bottom' = 'centre', scale?: number): void {
    this.commands.push({ kind: 'sprite', name, x, y, anchor, ...(scale !== undefined ? { scale } : {}) });
  }
  text(x: number, y: number, text: string, font: MapFont, colour: string, align: 'left' | 'centre' = 'left'): void {
    this.commands.push({ kind: 'text', x, y, text, font, colour, ...(align === 'centre' ? { align } : {}) });
  }
}

/** The map's height for the font a text is in, in the original's pixels (kFontMap is 8 high). */
const FONT_HEIGHT: Record<MapFont, number> = { map: 8, info: 14, label: 18 };

/** AstrogationScreen::draw's map: the commands and the entries that can be clicked, for the camera and selection as they are. */
export function layoutMap(input: MapInput): MapLayout {
  const { universe: u, cam, selection, palette } = input;
  const d = new Drawing();
  const layout: MapLayout = { commands: d.commands, entries: [], shown: false, name: '' };
  // the black ground of the map, then what is chosen, roughly centred
  d.fill(10, 19, 387, 341, palette.black);
  const name = selection.sector >= 0 && cam.view !== 'system' ? chosenName(input, selection) : '';
  layout.name = name;
  if (name !== '') {
    d.fill(10, 30, 387, 39, palette.black);
    d.text(199, 30, name, 'info', palette.info, 'centre');
  }
  layout.entries = buildEntries(input);
  const ctx: Context = { input, d, layout };
  if (cam.view === 'galaxy') drawGalaxy(ctx);
  else if (cam.view === 'sector') drawSector(ctx);
  else if (starAt(u, selection)) drawSystem(ctx);
  else drawStation(ctx);
  return layout;
}

interface Context { input: MapInput; d: Drawing; layout: MapLayout }

const measure = (input: MapInput, font: MapFont, text: string): number => input.measure ? input.measure(font, text) : text.length * (font === 'map' ? 5 : font === 'info' ? 7 : 9);

/** drawMapText: text on a black box. */
function mapText(c: Context, x: number, y: number, text: string, colour: string): void {
  const w = measure(c.input, 'map', text);
  c.d.fill(x, y, x + w - 1, y + FONT_HEIGHT.map - 1, c.input.palette.black);
  c.d.text(x, y, text, 'map', colour);
}

function drawGrid(c: Context, mask: number, count: number, step: number, x0: number, y0: number, z0: number, colour: string, p: Projection): void {
  const x1 = x0 + count * step, y1 = y0 + count * step, z1 = z0 + count * step;
  for (let k = 0; k <= count; k++) {
    const dd = k * step;
    if (mask & 1) {
      // the left wall
      c.d.line(project(p, x0, y0 + dd, z0), project(p, x0, y0 + dd, z1), colour);
      c.d.line(project(p, x0, y0, z0 + dd), project(p, x0, y1, z0 + dd), colour);
    }
    if (mask & 2) {
      // the back wall
      c.d.line(project(p, x0, y0 + dd, z1), project(p, x1, y0 + dd, z1), colour);
      c.d.line(project(p, x0 + dd, y0, z1), project(p, x0 + dd, y1, z1), colour);
    }
    if (mask & 4) {
      // the floor
      c.d.line(project(p, x0, y0, z0 + dd), project(p, x1, y0, z0 + dd), colour);
      c.d.line(project(p, x0 + dd, y0, z0), project(p, x0 + dd, y0, z1), colour);
    }
  }
}

function drawGalaxy(c: Context): void {
  const { input, d, layout } = c;
  const { universe: u, cam, ship, palette } = input;
  const p = projection(cam, 80, 80, 80, GALAXY_DISTANCE * (input.zoom ?? 1));
  const cursor = cursorAt(cam);
  if (!cam.stars) {
    layout.shown = false;
    drawCrossSections(c, p);
    drawSectorBox(c, p);
    // a line from the ship to the cursor
    d.line(project(p, ship.pos.x, ship.pos.y, ship.pos.z), project(p, cursor.x, cursor.y, cursor.z), palette.course);
    return;
  }
  if (cam.grid) drawGrid(c, 7, 8, 20, 0, 0, 0, palette.grid, p);
  for (const entry of layout.entries) {
    const thing = starAt(u, entry.location) ?? stationAt(u, entry.location);
    if (!thing) continue;
    const at = project(p, thing.x, thing.y, thing.z);
    entry.x = at.x;
    entry.y = at.y;
    if (at.x < 1 || at.y < 1 || at.x >= 639 || at.y >= 479) continue;
    if ((entry.flags & ENTRY_STARBASE) && cam.starbases) {
      // a ring around a starbase
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) d.pixel(at.x + dx, at.y + dy, palette.starbase);
    } else if (!(entry.flags & ENTRY_STARBASE) && (entry.flags & ENTRY_INHABITED) && cam.inhabited) {
      // and a cross at an inhabited star
      d.pixel(at.x, at.y, entry.colour);
      d.pixel(at.x - 1, at.y, entry.colour);
      d.pixel(at.x + 1, at.y, entry.colour);
      d.pixel(at.x, at.y - 1, entry.colour);
      d.pixel(at.x, at.y + 1, entry.colour);
    } else {
      d.pixel(at.x, at.y, entry.colour);
    }
  }
  layout.shown = true;
  if (cam.grid) drawSectorBox(c, p);
  drawCourse(c, p);
}

function drawCrossSections(c: Context, p: Projection): void {
  const { d } = c;
  const { cam, palette } = c.input;
  // three planes through the middle of the chosen sector
  const middle = cam.cursorSector.map(s => s * 20 + 10) as [number, number, number];
  for (let k = 0; k <= 8; k++) {
    const dd = k * 20;
    const col = palette.crossSection;
    d.line(project(p, middle[0], dd, 0), project(p, middle[0], dd, 160), col);
    d.line(project(p, middle[0], 0, dd), project(p, middle[0], 160, dd), col);
    d.line(project(p, dd, middle[1], 0), project(p, dd, middle[1], 160), col);
    d.line(project(p, 0, middle[1], dd), project(p, 160, middle[1], dd), col);
    d.line(project(p, dd, 0, middle[2]), project(p, dd, 160, middle[2]), col);
    d.line(project(p, 0, dd, middle[2]), project(p, 160, dd, middle[2]), col);
  }
  // the back faces of the galaxy's cube: those whose outside faces away
  const faces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  const normals = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
  const corners = Array.from({ length: 8 }, (_, i) => project(p, i & 4 ? 160 : 0, i & 2 ? 160 : 0, i & 1 ? 160 : 0));
  faces.forEach((face, i) => {
    const [nx, ny0, nz] = normals[i]!;
    const depth = -p.sinYaw * nx! + p.cosYaw * p.sinPitch * -ny0! + p.cosYaw * p.cosPitch * nz!;
    if (depth <= 0) return;
    for (let j = 0; j < 4; j++) d.line(corners[face[j]!]!, corners[face[(j + 1) % 4]!]!, palette.cubeBack);
  });
  // and ticks along the edges of the planes
  for (let k = 0; k <= 8; k++) {
    const dd = k * 20;
    for (let plane = 0; plane < 3; plane++) {
      for (let end = 0; end < 2; end++) {
        const from = end ? 154 : 0, to = end ? 160 : 6;
        const pa: number[][] = [[0, 0, 0], [0, 0, 0]], qa: number[][] = [[0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 2; i++) { pa[i]![plane] = middle[plane]!; qa[i]![plane] = middle[plane]!; }
        const a = (plane + 1) % 3, b = (plane + 2) % 3;
        pa[0]![a] = dd; pa[0]![b] = from; pa[1]![a] = dd; pa[1]![b] = to;
        qa[0]![b] = dd; qa[0]![a] = from; qa[1]![b] = dd; qa[1]![a] = to;
        d.line(project(p, pa[0]![0]!, pa[0]![1]!, pa[0]![2]!), project(p, pa[1]![0]!, pa[1]![1]!, pa[1]![2]!), palette.ticks);
        d.line(project(p, qa[0]![0]!, qa[0]![1]!, qa[0]![2]!), project(p, qa[1]![0]!, qa[1]![1]!, qa[1]![2]!), palette.ticks);
      }
    }
  }
}

/** The chosen sector's cube, labelled with its coordinates. */
function drawSectorBox(c: Context, p: Projection): void {
  const { d } = c;
  const { cam, palette } = c.input;
  const corners: { x: number; y: number }[] = [];
  let maxX = 0, maxY = 0;
  for (let i = 0; i < 8; i++) {
    const at = project(p, cam.cursorSector[0] * 20 + (i & 4 ? 20 : 0), cam.cursorSector[1] * 20 + (i & 2 ? 20 : 0), cam.cursorSector[2] * 20 + (i & 1 ? 20 : 0));
    corners.push(at);
    maxX = Math.max(maxX, at.x);
    maxY = Math.max(maxY, at.y);
  }
  for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) if (!(i & (1 << j))) d.line(corners[i]!, corners[i | (1 << j)]!, palette.sectorBox);
  maxX = Math.min(maxX + 2, 363);
  maxY += 2;
  mapText(c, maxX, maxY, String(cam.cursorSector[0]), palette.digitX);
  mapText(c, maxX + 8, maxY, String(cam.cursorSector[1]), palette.digitY);
  mapText(c, maxX + 16, maxY, String(cam.cursorSector[2]), palette.digitZ);
}

/** The line from the ship to the cursor with the distance, and the course being followed. */
function drawCourse(c: Context, p: Projection): void {
  const { d } = c;
  const { cam, ship, palette, lightYears } = c.input;
  const cur = cursorAt(cam);
  const at = project(p, ship.pos.x, ship.pos.y, ship.pos.z);
  const cursor = project(p, cur.x, cur.y, cur.z);
  d.line(at, cursor, palette.course);
  const label = `${(Math.floor(lightYears * 1000) / 1000).toFixed(3)} LY`;
  const width = measure(c.input, 'map', label);
  const midX = Math.trunc((at.x + cursor.x) / 2), midY = Math.trunc((at.y + cursor.y) / 2);
  if ((cursor.x - at.x) * (cursor.y - at.y) > 0) mapText(c, midX - width - 4, midY, label, palette.course);
  else mapText(c, midX + 4, midY + 8, label, palette.course);
  if (!ship.transit) {
    d.sprite('ship_marker', at.x, at.y);
    return;
  }
  // and the course being followed
  const dest = project(p, ship.transit.to.x, ship.transit.to.y, ship.transit.to.z);
  d.line(at, dest, palette.destination);
  d.sprite('ship_marker', at.x, at.y);
  d.sprite('destination_marker', dest.x, dest.y);
  const name = ship.transit.name;
  const nameWidth = measure(c.input, 'map', name);
  if (dest.x + 9 + nameWidth >= 384) mapText(c, 384 - nameWidth, dest.y - 12, name, palette.destination);
  else mapText(c, dest.x + 9, dest.y - 4, name, palette.destination);
}

interface SectorSprite { image: string; x: number; y: number; floorX: number; floorY: number; scale: number; depth: number }

function drawSector(c: Context): void {
  const { input, d, layout } = c;
  const { universe: u, cam, selection, ship, palette } = input;
  const corner = cam.cursorSector.map(s => s * 20) as [number, number, number];
  const p = projection(cam, corner[0] + 10, corner[1] + 10, corner[2] + 10, SECTOR_DISTANCE * (input.zoom ?? 1));
  // the grid goes in front if the floor is seen from below
  const grid = cam.grid;
  const p0 = project(p, corner[0], corner[1], corner[2]);
  const p1 = project(p, corner[0] + 20, corner[1], corner[2]);
  const p2 = project(p, corner[0] + 20, corner[1], corner[2] + 20);
  let gridFirst: boolean;
  if (p2.x > p1.x) gridFirst = (p0.x - p1.x) / (p2.x - p1.x) * (p2.y - p1.y) + p1.y > p0.y;
  else if (p2.x < p1.x) gridFirst = (p0.x - p2.x) / (p1.x - p2.x) * (p1.y - p2.y) + p2.y < p0.y;
  else gridFirst = p0.x > p1.x;
  if (grid && gridFirst) drawGrid(c, 4, 5, 4, corner[0], corner[1], corner[2], palette.grid, p);

  const sprites: SectorSprite[] = [];
  for (const entry of layout.entries) {
    let thing: AstroThing | undefined = stationAt(u, entry.location);
    let image: string;
    let scale = 0x100;
    if (entry.location.star !== -1) {
      const star = starAt(u, entry.location)!;
      thing = star;
      image = `star_class${Math.min(Math.trunc(star.spectralClass / 10), 6)}`;
      scale = Math.max(0x40, Math.min(0x100, 0xe0 - star.magnitude));
    } else if (thing) {
      image = `station${Math.min(Math.max(thing.type - THING.deepSpaceStation, 0), 3)}`;
    } else {
      thing = phenomenonAt(u, entry.location)!;
      image = `hazard${Math.min(Math.max(thing.type - 0x40, 0), 6)}`;
    }
    const at = project(p, thing.x, thing.y, thing.z);
    const floor = project(p, thing.x, corner[1], thing.z);
    entry.x = at.x;
    entry.y = at.y;
    if (thing.type === THING.hiddenPlace) continue;
    sprites.push({ image, x: at.x, y: at.y, floorX: floor.x, floorY: floor.y, scale, depth: at.depth });
  }
  layout.shown = true;

  // the ship, if it's here
  if (Math.trunc(ship.pos.x / 20) === cam.cursorSector[0] && Math.trunc(ship.pos.y / 20) === cam.cursorSector[1] && Math.trunc(ship.pos.z / 20) === cam.cursorSector[2]) {
    const at = project(p, ship.pos.x, ship.pos.y, ship.pos.z);
    const floor = project(p, ship.pos.x, corner[1], ship.pos.z);
    sprites.push({ image: 'ship', x: at.x, y: at.y, floorX: floor.x, floorY: floor.y, scale: 0x100, depth: at.depth });
  }
  // (the furthest first)
  sprites.sort((a, b) => b.depth - a.depth);
  for (const s of sprites) {
    if (grid) d.line({ x: s.x, y: s.y }, { x: s.floorX, y: s.floorY }, palette.grid);
    if (s.scale === 0x100) d.sprite(s.image, s.x, s.y);
    // (dimmer stars are smaller)
    else d.sprite(s.image, s.x - Math.trunc(s.scale * 14 / 256), s.y - Math.trunc(s.scale * 14 / 256), 'corner', s.scale);
  }

  // a box around what's chosen, or the cursor
  const selected = findSelection(u, 'sector', layout.entries, selection);
  const phenomenon = phenomenonAt(u, selection);
  if (selected === -1 || (phenomenon && phenomenon.type === THING.hiddenPlace)) {
    drawCursor3D(c, p);
  } else {
    const e = layout.entries[selected]!;
    const box = palette.selectionBox;
    d.line({ x: e.x - 16, y: e.y - 16 }, { x: e.x + 16, y: e.y - 16 }, box);
    d.line({ x: e.x - 16, y: e.y + 16 }, { x: e.x + 16, y: e.y + 16 }, box);
    d.line({ x: e.x - 16, y: e.y - 16 }, { x: e.x - 16, y: e.y + 16 }, box);
    d.line({ x: e.x + 16, y: e.y - 16 }, { x: e.x + 16, y: e.y + 16 }, box);
  }
  if (grid && !gridFirst) drawGrid(c, 4, 5, 4, corner[0], corner[1], corner[2], palette.grid, p);
}

/** Three small squares through the cursor, across each pair of axes. */
function drawCursor3D(c: Context, p: Projection): void {
  const { d } = c;
  const { cam, palette } = c.input;
  const cur = cursorAt(cam);
  const x = cur.x, y = cur.y, z = cur.z;
  const colours = [palette.cursorXY, palette.cursorYZ, palette.cursorXZ];
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  for (let square = 0; square < 3; square++) {
    // the two axes across the square
    const u = square === 1 ? 1 : 0;
    const v = square === 0 ? 1 : 2;
    const corners = signs.map(([su, sv]) => {
      const q = [x, y, z];
      q[u]! += su;
      q[v]! += sv;
      return project(p, q[0]!, q[1]!, q[2]!);
    });
    for (let i = 0; i < 4; i++) d.line(corners[i]!, corners[(i + 1) % 4]!, colours[square]!);
    if (square) {
      // (with a cross through the middle)
      const a = [x, y, z], b = [x, y, z];
      a[u]! -= 1;
      b[u]! += 1;
      d.line(project(p, a[0]!, a[1]!, a[2]!), project(p, b[0]!, b[1]!, b[2]!), colours[square]!);
      a[u] = b[u] = u === 0 ? x : y;
      a[v]! -= 1;
      b[v]! += 1;
      d.line(project(p, a[0]!, a[1]!, a[2]!), project(p, b[0]!, b[1]!, b[2]!), colours[square]!);
    }
  }
}

function drawSystem(c: Context): void {
  const { input, d, layout } = c;
  const { universe: u, flags, selection, palette, tables } = input;
  const star = starAt(u, selection)!;
  const f = flags[star.id] ?? 0;
  d.fill(10, 344, 387, 364, palette.black);
  const messages = tables.messages ?? FALLBACK_MESSAGES;

  // the star, and its companion
  d.sprite('star', 10, 25, 'corner');
  d.text(13, 131, spectralName(star.spectralClass), 'info', palette.info);
  d.text(13, 147, magnitudeName(star.magnitude), 'info', palette.info);
  if (star.flags & STAR_BINARY) {
    const companion = companionStar(u, star, tables);
    d.sprite('companion', 350, 25, 'corner');
    d.text(353, 131, spectralName(companion.spectralClass), 'info', palette.info);
    d.text(353, 147, magnitudeName(companion.magnitude), 'info', palette.info);
  }
  if (!(f & FLAG_CHARTED)) d.text(146, 131, 'UNCHARTED', 'label', palette.label);

  layout.shown = layout.entries.length > 0;
  if (layout.entries.length === 0) {
    d.text(195, 185, messages[(f & FLAG_VISITED) ? 1 : 3] ?? '', 'label', palette.label, 'centre');
    return;
  }

  const planets = makePlanets(u, star, flags, tables);
  let orbitStart = 38;
  for (const entry of layout.entries) {
    const l = entry.location;
    if (l.moon !== -1) {
      d.sprite('moon', entry.x, entry.y);
    } else if (l.station !== -1) {
      const starbase = u.specials[star.special]?.type === THING.starbase;
      d.sprite(starbase ? 'starbase_icon' : 'outpost_icon', entry.x, entry.y);
    } else if (l.phenomenon !== -1) {
      d.sprite('belt', entry.x, entry.y);
    } else {
      // each planet's orbit, then the planet
      const planet = planets[l.planet]!;
      const radius = entry.width >> 1;
      const orbitEnd = l.planet === planets.length - 1 ? entry.x : entry.x + radius;
      d.line({ x: orbitStart, y: SYSTEM_Y }, { x: orbitEnd, y: SYSTEM_Y }, palette.grid);
      orbitStart = entry.x + radius;
      d.sprite(`planet${Math.min(planet.type, 15)}`, entry.x, entry.y);
      d.text(entry.x, 102, planetClassLetter(planet.type), 'info', palette.info);
      if (planet.moons.length > 0) {
        const moons = planet.moons.length;
        d.line({ x: entry.x, y: SYSTEM_Y - radius }, { x: entry.x - 3 * moons, y: SYSTEM_Y - radius - 9 * moons }, palette.grid);
      }
    }
  }

  // what's chosen, close up
  const selected = findSelection(u, 'system', layout.entries, selection);
  if (selected === -1) return;
  const entry = layout.entries[selected]!;
  d.sprite('selected', entry.x, 146);
  const subtype = locationSubtype(u, entry.location);
  if (subtype === THING.starbase || subtype === THING.outpost) {
    d.sprite(subtype === THING.starbase ? 'starbase_big' : 'outpost', 98, 127, 'corner');
    return;
  }
  const planet: Planet = planets[entry.location.planet]!;
  if (subtype === THING.moon) {
    const moon = planet.moons[entry.location.moon]!;
    d.commands.push({ kind: 'globe', type: moon.type, seed: moon.seed });
  } else {
    d.commands.push({ kind: 'globe', type: planet.type, seed: planet.seed });
  }
}

/** A station chosen in the system view, or nothing at all (drawStation). */
function drawStation(c: Context): void {
  const { input, d } = c;
  const { universe: u, selection, palette, tables } = input;
  d.fill(10, 344, 387, 364, palette.black);
  const station = stationAt(u, selection);
  if (!station) {
    d.text(195, 185, (tables.messages ?? FALLBACK_MESSAGES)[1] ?? '', 'label', palette.label, 'centre');
    return;
  }
  const image = station.type === THING.relay ? 'relay' : station.type === THING.buoy ? 'buoy' : 'deep_space_station';
  // (the picture stands on a line 296 down, centred on 195)
  d.sprite(image, 195, 296, 'bottom');
  d.text(195, 310, station.name, 'label', palette.label, 'centre');
}
