// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3i } from './ship';

// The astrogation screen's map camera and cursor, ported from engines/unity/astrogation.cpp (read-only reference): the three views, the
// rotation pad, the cursor and the three panels. Presentation state: it is not saved and the world never reads it.

export type MapView = 'galaxy' | 'sector' | 'system';
export type MapPanel = 'info' | 'course' | 'display';
export const MAP_VIEWS: MapView[] = ['galaxy', 'sector', 'system'];
export const MAP_PANELS: MapPanel[] = ['info', 'course', 'display'];

/** The original's clockTicks per second (kStatusBlinkTime: 0x246 ticks are two seconds). */
export const CLOCK_TICKS_PER_SECOND = 291;
/** A second pad click within this many ticks starts the map spinning (astrogation.cpp:1702, 0x3c). */
export const DOUBLE_CLICK_TICKS = 0x3c;
/** A spin turns a degree every this many ticks (astrogation.cpp:1190, 0x13). */
export const TICKS_PER_DEGREE = 0x13;

/** The Display tab's nine switches, in the original's order: stars, grid, five regions, inhabited stars, starbases. */
export const DISPLAY_SWITCHES = 9;

export interface MapCamera {
  view: MapView;
  panel: MapPanel;
  /** Degrees, 0 to 359. */
  azimuth: number;
  elevation: number;
  /** Which sector, 0 to 7 on each axis; and where in it, 0 to 19. */
  cursorSector: [number, number, number];
  cursor: [number, number, number];
  spinning: boolean;
  azimuthSpin: number;
  elevationSpin: number;
  spinStart: number;
  spinAzimuth: number;
  spinElevation: number;
  lastPadClick: number;
  /** kDisplayStars, kDisplayGrid, and a bit for each alignment, then inhabited and starbases. */
  stars: boolean;
  grid: boolean;
  regions: number;
  inhabited: boolean;
  starbases: boolean;
}

/**
 * AstrogationScreen::setDefaults (astrogation.cpp:1046-1064): the map starts at 6 degrees azimuth and 3 elevation, spinning (the pad's middle button
 * sets them the other way round), on the Info tab (`start` opens it; a scripted warp opens the Course tab). The spin itself, an azimuth turn of -3, is set by `startSpin`, as `start` does on every visit.
 */
export function newMapCamera(): MapCamera {
  return {
    view: 'galaxy', panel: 'info', azimuth: 6, elevation: 3, cursorSector: [0, 0, 0], cursor: [0, 0, 0],
    spinning: true, azimuthSpin: -3, elevationSpin: 0, spinStart: 0, spinAzimuth: 6, spinElevation: 3, lastPadClick: 0,
    stars: true, grid: true, regions: 0x1f, inhabited: false, starbases: false,
  };
}

/**
 * What AstrogationScreen::start does each time the screen opens (1111-1115): the spin is azimuth only, backwards, from where the map is now.
 * Whether it turns is `spinning`, which the first visit sets and a touch of the pad ends (it stays ended on later visits, as the original's does).
 */
export function startSpin(cam: MapCamera, now: number): void {
  cam.azimuthSpin = -3;
  cam.elevationSpin = 0;
  cam.spinStart = now;
  cam.spinAzimuth = cam.azimuth;
  cam.spinElevation = cam.elevation;
}

const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;

/** AstrogationScreen::padClicked (1708-1746): the pad's buttons are up, down, left, right and the middle one. */
export function padClick(cam: MapCamera, button: number, now: number): void {
  const twice = now < cam.lastPadClick + DOUBLE_CLICK_TICKS;
  if (button === 0 || button === 1) {
    if (twice) { cam.spinning = true; cam.elevationSpin = button === 0 ? 3 : -3; }
    else { cam.spinning = false; cam.elevation = wrap(cam.elevation + (button === 0 ? 3 : -3)); cam.elevationSpin = 0; }
  } else if (button === 2 || button === 3) {
    if (twice) { cam.spinning = true; cam.azimuthSpin = button === 2 ? 3 : -3; }
    else { cam.spinning = false; cam.azimuth = wrap(cam.azimuth + (button === 2 ? 3 : -3)); cam.azimuthSpin = 0; }
  } else if (!cam.spinning) {
    // (the middle button sets these the other way round, as the original's does)
    cam.elevation = 6;
    cam.azimuth = 3;
  } else {
    cam.spinning = false;
    cam.elevationSpin = cam.azimuthSpin = 0;
  }
  cam.spinStart = now;
  cam.spinElevation = cam.elevation;
  cam.spinAzimuth = cam.azimuth;
  cam.lastPadClick = now;
}

/** AstrogationScreen::update's spin (1189-1196): the map turns by itself, except in the system view. */
export function spin(cam: MapCamera, now: number): void {
  if (!cam.spinning || cam.view === 'system') return;
  const turn = Math.trunc((now - cam.spinStart) / TICKS_PER_DEGREE) % 360;
  if (cam.elevationSpin) cam.elevation = wrap(cam.spinElevation + (cam.elevationSpin > 0 ? turn : -turn));
  if (cam.azimuthSpin) cam.azimuth = wrap(cam.spinAzimuth + (cam.azimuthSpin > 0 ? turn : -turn));
}

/** A drag turns the map by hand: it stops any spin. */
export function turnBy(cam: MapCamera, azimuth: number, elevation: number): void {
  cam.spinning = false;
  cam.azimuthSpin = cam.elevationSpin = 0;
  cam.azimuth = wrap(cam.azimuth + azimuth);
  cam.elevation = wrap(cam.elevation + elevation);
}

/** AstrogationScreen::moveCursor (1636-1649): the sector in the galaxy view, the place in it in the sector view; none in the system view. Whether it moved. */
export function moveCursor(cam: MapCamera, axis: number, step: number): boolean {
  if (cam.view === 'system') return false;
  if (cam.view === 'galaxy') cam.cursorSector[axis] = (cam.cursorSector[axis] + step + 8) % 8;
  else cam.cursor[axis] = (cam.cursor[axis] + step + 20) % 20;
  return true;
}

/** The cursor's place in the universe's units (cursorMoved, 1614-1616). */
export function cursorPoint(cam: MapCamera): Vec3i {
  return { x: cam.cursorSector[0] * 20 + cam.cursor[0], y: cam.cursorSector[1] * 20 + cam.cursor[1], z: cam.cursorSector[2] * 20 + cam.cursor[2] };
}

/** The sector index of the cursor's sector (Astrogation::sector). */
export function cursorSectorIndex(cam: MapCamera): number {
  return cam.cursorSector[0] + cam.cursorSector[1] * 8 + cam.cursorSector[2] * 64;
}

/** What the cursor goes to when something is chosen (selectionChanged, 1226-1243): the thing's place in its sector, or the sector's corner. */
export function cursorTo(cam: MapCamera, sector: number, thing: Vec3i | null): void {
  cam.cursor = thing ? [thing.x % 20, thing.y % 20, thing.z % 20] : [0, 0, 0];
  if (sector >= 0) cam.cursorSector = [sector & 7, (sector >> 3) & 7, (sector >> 6) & 7];
}

/** AstrogationScreen::toggleDisplay (1749-1764). Item: 0 stars, 1 grid, 2-6 the regions, 7 inhabited, 8 starbases. Returns whether it is now on. */
export function toggleDisplay(cam: MapCamera, item: number): boolean {
  if (item === 0) return (cam.stars = !cam.stars);
  if (item === 1) return (cam.grid = !cam.grid);
  if (item < 7) { cam.regions ^= 1 << (item - 2); return (cam.regions & (1 << (item - 2))) !== 0; }
  if (item === 7) return (cam.inhabited = !cam.inhabited);
  return (cam.starbases = !cam.starbases);
}

export function displayOn(cam: MapCamera, item: number): boolean {
  return item === 0 ? cam.stars : item === 1 ? cam.grid : item < 7 ? (cam.regions & (1 << (item - 2))) !== 0 : item === 7 ? cam.inhabited : cam.starbases;
}

/** The ticks the original's clock would have reached after this many milliseconds. */
export const ticksOf = (ms: number): number => Math.trunc(ms * CLOCK_TICKS_PER_SECOND / 1000);
