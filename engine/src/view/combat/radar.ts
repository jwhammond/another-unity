// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData } from '../../content/types';
import { alive } from '../../sim/combat/battle';
import { fr, length, sub, type V3 } from '../../sim/combat/math';
import type { BattleState } from '../../sim/combat/types';
import type { IndexedScreen } from '../indexed';
import type { RadarMemory } from './files';

/**
 * The radar in the console's left panel (TacticalScreen::drawRadar, tactical.cpp:1059-1159): the box, its scrolling grid and
 * the perspective floor, then (when the step's sensors answered yes: Plan 27 R5) the ships on stems coloured by kind, the
 * target's filled and blinking, and the torpedoes as points. Pure: it draws onto an indexed screen and moves the grid's memory.
 */

/** The radar's colours in the space palette (tactical.cpp:233-238). */
export const RADAR_COLOUR = { background: 0x82, grid: 0x83, blink: 0x85, torpedo: 0xa4 } as const;
/** kBlinkTime (tactical.cpp:239): the target's blip changes every 0x48 ticks, 247 ms, by the wall clock. */
export const BLINK_TIME = Math.trunc((0x48 * 1000) / 291);
/** A click this near a blip (in the original's pixels, either way) targets its ship (mouseClick, tactical.cpp:693-699). */
export const BLIP_REACH = 8;

export { newRadarMemory, type RadarMemory } from './files';

/** A ship drawn on the radar, for mouseClick: its index and the top of its stem, in the original's pixels. */
export interface RadarBlip { ship: number; x: number; y: number }

/** roundf: halves away from zero. */
const roundf = (v: number): number => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);
/** fmodf, as C's: the remainder takes the dividend's sign. */
const fmodf = (a: number, b: number): number => fr(a % b);

/**
 * drawRadar. `wall` is the wall clock (g_system->getMillis(), the blink's). Draws nothing with no Enterprise or a destroyed
 * one; the grid and box only when the step's sensors said no (`b.console.radarSeen`). Returns the ships drawn, the Enterprise's
 * own among them (a click takes only another's).
 */
export function drawRadar(screen: IndexedScreen, b: Readonly<BattleState>, combat: CombatData, memory: RadarMemory, wall: number): RadarBlip[] {
  const blips: RadarBlip[] = [];
  const e = b.ships[0];
  if (!e || e.destroyed) return blips;
  const fill = (x0: number, y0: number, x1: number, y1: number, colour: number) => screen.fill(x0, y0, x1, y1, colour);
  const line = (x0: number, y0: number, x1: number, y1: number, colour: number) => screen.line(x0, y0, x1, y1, colour);
  // (the range halves with each step of zoom)
  const level = b.view.zoomLevel;
  const scale = level >= 0 ? fr(1 / (1 << level)) : 2;
  const g = level >= 0 ? 8 << level : 4;
  const range = fr(40000 * scale), half = fr(range / 2);
  const sx = fr(fr(208.34) * scale), sy = sx, szx = fr(fr(526.32) * scale), szy = fr(fr(833.32) * scale);
  const size = 2 + level;

  // the grid moves as the Enterprise does
  const moved = sub(e.pos, memory.centre);
  memory.centre = { ...e.pos };
  if (length(moved) < range) {
    memory.scroll[0] = fr(memory.scroll[0] - fr(fr(g * moved.x) / 512));
    memory.scroll[1] = fr(memory.scroll[1] - fr(fr(g * moved.z) / 512));
    memory.scroll[2] = fr(memory.scroll[2] - fr(fr(g * moved.y) / 768));
  }
  const scroll = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    memory.scroll[i] = fmodf(memory.scroll[i]!, g);
    if (memory.scroll[i]! < 0) memory.scroll[i] = fr(memory.scroll[i]! + g);
    scroll[i] = Math.trunc(memory.scroll[i]!);
  }
  fill(81, 28, 273, 220, RADAR_COLOUR.background);
  for (let k = 0; k < Math.trunc(193 / g); k++) {
    const x = 81 + scroll[0]! + k * g, y = 28 + scroll[1]! + k * g;
    if (x <= 273) line(x, 28, x, 220, RADAR_COLOUR.grid);
    if (y <= 220) line(81, y, 273, y, RADAR_COLOUR.grid);
  }
  for (let k = 0, lines = 0; k < Math.trunc(Math.trunc(193 / g) / 2) && lines < 35; k++) {
    const v = k * Math.trunc(g / 2) + Math.trunc(scroll[2]! / 2), y = 220 + v;
    if (y <= 220 || y > 266) continue;
    const shift = Math.trunc(fr(fr(v * fr(1.6041666)) + 0.5));
    line(83 - shift, y, 270 - shift, y, RADAR_COLOUR.grid);
    lines++;
  }
  line(81, 28, 81, 220, RADAR_COLOUR.grid);
  line(273, 28, 273, 220, RADAR_COLOUR.grid);
  line(81, 28, 273, 28, RADAR_COLOUR.grid);
  line(81, 220, 273, 220, RADAR_COLOUR.grid);
  line(80, 221, 6, 266, RADAR_COLOUR.grid);
  line(198, 266, 272, 221, RADAR_COLOUR.grid);
  line(5, 74, 80, 29, RADAR_COLOUR.grid);

  // (with poor sensors, sometimes nothing shows: the step's checkSensors, tactical.cpp:1112-1113; Plan 27 R5)
  if (!b.console.radarSeen) return blips;

  // the ships, on stems from the floor
  const blink = (Math.floor(wall / BLINK_TIME) & 1) === 1;
  const place = (p: V3): { x: number; base: number; top: number } | null => {
    const d = sub(p, e.pos);
    if (Math.abs(d.x) > half || Math.abs(d.y) > half || Math.abs(d.z) > half) return null;
    const x = roundf(fr(d.x / sx)) + roundf(fr(d.y / szx)) + 141;
    const floor = roundf(fr(d.y / szy));
    return { x, base: 242 - floor, top: 242 - (floor + roundf(fr(fr(half + d.z) / sy))) };
  };
  b.ships.forEach((ship, i) => {
    if (!alive(ship) || ship.decloakTime) return;
    const at = place(ship.pos);
    if (!at) return;
    const { x, base, top } = at;
    if (x < 12 || x > 307 || top < 30 || top > 288 - 2 * size || base < 30 || base > 288 || top > base - 2 * size) return;
    blips.push({ ship: i, x, y: top });
    // (the port's own: a kind combat.yaml lacks is drawn in the grid's colour, where kRadarColours covers every kind)
    const colour = combat.kinds[ship.type]?.radarColour ?? RADAR_COLOUR.grid;
    if (b.target === i) {
      const c = blink ? colour : RADAR_COLOUR.blink;
      line(x, top + size, x, base, c);
      fill(x - size, top - size, x + size, top + size, c);
    } else {
      line(x, top + size, x, base, colour);
      line(x - size, top - size, x + size, top - size, colour);
      line(x - size, top + size, x + size, top + size, colour);
      line(x - size, top - size, x - size, top + size, colour);
      line(x + size, top - size, x + size, top + size, colour);
    }
  });
  for (const t of b.torpedoes) {
    if (!t.active) continue;
    const at = place(t.pos);
    if (at && at.x >= 12 && at.x <= 307 && at.top >= 30 && at.top <= 288) fill(at.x, at.top, at.x, at.top, RADAR_COLOUR.torpedo);
  }
  return blips;
}

/** mouseClick's radar (tactical.cpp:693-699): the first blip but the Enterprise's within BLIP_REACH of (x, y) either way, or null. */
export function blipAt(blips: readonly RadarBlip[], x: number, y: number): number | null {
  for (const blip of blips) if (Math.abs(x - blip.x) < BLIP_REACH && Math.abs(y - blip.y) < BLIP_REACH && blip.ship > 0) return blip.ship;
  return null;
}
