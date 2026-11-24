// SPDX-License-Identifier: GPL-3.0-or-later
import { bindLibm, MATH_LIBM } from '../../sim/combat/math';
import { trigTables } from '../../sim/combat/libm';
import type { CombatShip } from '../../sim/combat/types';
import type { IndexedScreen } from '../indexed';
import { buttonShown, drawButton, drawConn, drawLamps, drawManeuvers, drawPage, drawSliders, drawStatus, drawTabs, NUM_BUTTONS, PAGE, type ConsoleArt, type ConsoleUi } from './console';
import { FLASH_COLOUR } from './effects';
import { drawRadar, type RadarBlip, type RadarMemory } from './radar';
import { drawScanner, SCANNER_AREAS, SCANNER_PALETTE, scannerColours, type ScannerSource } from './scanner';

/**
 * One frame of the console (TacticalScreen::draw, tactical.cpp:1293-1337, all but render): the background, then the parts
 * in draw's order; and the palette it is shown in (the scanners' entries, the red flash's two). Plan 27.
 */

/** What a frame of the console drew that the page acts on: the radar's blips (for a click), the ship whose log it showed, the scanner's colours. */
export interface ConsoleDrawn {
  blips: RadarBlip[];
  /** The scanner showed this ship's log: its lines scroll on (scrollLog), as drawScanner's own end does (tactical.cpp:1250-1255). */
  scanned: CombatShip | null;
  /** Entries 245-255 as drawScanner set them (33 bytes), or null on a page without a scanner (consolePalette then gives them the space palette's). */
  scanner: Uint8Array | null;
}

/**
 * draw (tactical.cpp:1293-1337): the background (drawScene's, unity.cpp:1412), the tabs, the page, the buttons (each on its
 * page, no zoom while wide), the sliders, the lamps and the status; the scanner on its two pages; the radar while it shows
 * (not wide, and the console's radar open: `b.console.radarShown`); the maneuvers on TACTICS; CONN's own. The battle's trig
 * table is bound while it draws (facing reads it) and the binding put back.
 */
export function drawConsole(screen: IndexedScreen, art: ConsoleArt, s: ScannerSource, ui: ConsoleUi, radar: RadarMemory): ConsoleDrawn {
  const t = trigTables(s.combat);
  const was = bindLibm(t ? { sin: t.sin, cos: t.cos, angle: null } : MATH_LIBM);
  try {
    const { b } = s;
    screen.set(art.plate);
    drawTabs(screen, art, ui.page);
    drawPage(screen, art, ui.page);
    for (let i = 0; i < NUM_BUTTONS; i++) if (buttonShown(i, ui.page, b.view.wide)) drawButton(screen, art, b, ui, i);
    drawSliders(screen, art, b, ui.page);
    drawLamps(screen, art, b);
    drawStatus(screen, art, b, s.combat);
    const scanning = ui.page === PAGE.damage || ui.page === PAGE.sensors;
    const scanner = scanning ? scannerColours(s, ui.page) : null;
    const scanned = scanning ? drawScanner(screen, art, s, ui.page) : null;
    const blips = b.console.radarShown ? drawRadar(screen, b, s.combat, radar, ui.wall) : [];
    if (ui.page === PAGE.tactics) drawManeuvers(screen, art, b, ui);
    if (ui.page === PAGE.conn) drawConn(screen, art, b);
    return { blips, scanned, scanner };
  } finally {
    bindLibm(was);
  }
}

/**
 * The palette the console is shown in: the space palette, with the scanner's entries as drawScanner set them, and the red flash
 * (tactical.cpp:484-493): entry 0 to (0x80, 0x40, 0x40) and entry 0xac to entry 0's own colour, by `flash` (1 the original's,
 * 0.4 under prefers-reduced-motion, 0 none: the view host's held flash, Plan 27 R11). Into `out`. A page without a scanner
 * leaves its entries as the space palette has them: ScummVM's hold their last colours, but only the scanner's pictures use them.
 */
export function consolePalette(base: Uint8Array, scanner: Uint8Array | null, flash: number, out: Uint8Array = new Uint8Array(256 * 3)): Uint8Array {
  out.set(base.subarray(0, 256 * 3));
  if (scanner) out.set(scanner.subarray(0, SCANNER_AREAS * 3), SCANNER_PALETTE * 3);
  if (flash > 0) {
    const mix = (from: number, to: number) => Math.round(from + (to - from) * Math.min(1, flash));
    const black = [base[0]!, base[1]!, base[2]!];
    for (let c = 0; c < 3; c++) {
      out[c] = mix(base[c]!, FLASH_COLOUR[c]!);
      out[0xac * 3 + c] = mix(base[0xac * 3 + c]!, black[c]!);
    }
  }
  return out;
}
