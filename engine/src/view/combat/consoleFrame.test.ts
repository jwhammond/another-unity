// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../sim/combat/commands';
import { bindLibm, MATH_LIBM } from '../../sim/combat/math';
import { miniBattle, miniEnterpriseUnits } from '../../testing/combat';
import { imageColour as ic, miniConsoleArt } from '../../testing/console';
import { IndexedScreen } from '../indexed';
import { BUTTON, BUTTONS, IMAGE, PAGE, PAGE_RECT, tabRect, type ConsoleUi } from './console';
import { consolePalette, drawConsole } from './consoleFrame';
import { newRadarMemory, RADAR_COLOUR } from './radar';

const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x];
const ui = (page: number): ConsoleUi => ({ page, pressed: -1, buttonTime: 0, arrow: -1, wall: 0 });
function frame(page: number, edit: (b: ReturnType<typeof miniBattle>['b'], ctx: ReturnType<typeof miniBattle>['ctx']) => void = () => {}) {
  const { ctx, b } = miniBattle();
  applyCommand(ctx, b, { type: 'target', ship: 1 });
  edit(b, ctx);
  const screen = new IndexedScreen();
  const drawn = drawConsole(screen, miniConsoleArt(), { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits() }, ui(page), newRadarMemory());
  return { screen, drawn, b };
}

describe('a frame of the console (TacticalScreen::draw, tactical.cpp:1293-1337)', () => {
  it('draws the background, the tabs, the page and its buttons, the lamps and the radar; CONN\'s own on CONN', () => {
    const { screen: s, drawn } = frame(PAGE.conn);
    expect([px(s, 0, 0), px(s, tabRect(3)[0], tabRect(3)[1]), px(s, PAGE_RECT[0], PAGE_RECT[1]), px(s, 368, 423), px(s, BUTTONS[BUTTON.shields]!.x, BUTTONS[BUTTON.shields]!.y)])
      .toEqual([1, ic(69), 0, ic(IMAGE.delegateOff), ic(7)]);
    expect([px(s, 316, 280), px(s, 81, 28), drawn.blips.map(x => x.ship), drawn.scanned, drawn.scanner]).toEqual([ic(51), RADAR_COLOUR.grid, [0, 1], null, null]);
  });

  it('draws no radar while wide, nor zoom; the scanner only on its pages, which say whose log it showed', () => {
    const wide = frame(PAGE.damage, (b, ctx) => applyCommand(ctx, b, { type: 'wide', on: true }));
    expect([px(wide.screen, 81, 28), px(wide.screen, BUTTONS[BUTTON.zoomIn]!.x, BUTTONS[BUTTON.zoomIn]!.y), px(wide.screen, BUTTONS[BUTTON.full]!.x, BUTTONS[BUTTON.full]!.y)]).toEqual([1, 1, ic(IMAGE.split)]);
    expect([wide.drawn.blips, wide.drawn.scanned, wide.drawn.scanner?.length]).toEqual([[], wide.b.ships[0], 33]);
    const sensors = frame(PAGE.sensors);
    expect(sensors.drawn.scanned).toBe(sensors.b.ships[1]);
    expect(frame(PAGE.tactics).drawn.scanned).toBeNull();
  });

  it('leaves the trig table bound as it found it (facing reads the battle\'s)', () => {
    const before = bindLibm(MATH_LIBM);
    bindLibm(before);
    frame(PAGE.sensors);
    expect(bindLibm(before)).toBe(before);
  });
});

describe('consolePalette (tactical.cpp:484-493, 1193)', () => {
  const base = new Uint8Array(768).map((_, i) => i % 256);
  it('takes the scanner\'s entries 245-255 and leaves them as the space palette has them without a scanner', () => {
    const scanner = new Uint8Array(33).fill(7);
    expect([...consolePalette(base, scanner, 0).subarray(245 * 3, 246 * 3)]).toEqual([7, 7, 7]);
    expect([...consolePalette(base, null, 0).subarray(245 * 3, 246 * 3)]).toEqual([...base.subarray(245 * 3, 246 * 3)]);
  });

  it('flashes entry 0 red (0x80, 0x40, 0x40) and 0xac to entry 0\'s colour, or 40% of the way under reduced motion', () => {
    const full = consolePalette(base, null, 1);
    expect([...full.subarray(0, 3), ...full.subarray(0xac * 3, 0xac * 3 + 3)]).toEqual([0x80, 0x40, 0x40, 0, 1, 2]);
    const calm = consolePalette(base, null, 0.4);
    // (entry 0 is (0, 1, 2) here; 0xac's (4, 5, 6): 40% of the way to (0x80, 0x40, 0x40) and to (0, 1, 2))
    expect([...calm.subarray(0, 3), ...calm.subarray(0xac * 3, 0xac * 3 + 3)]).toEqual([51, 26, 27, 2, 3, 4]);
    expect([...consolePalette(base, null, 0).subarray(0, 3)]).toEqual([0, 1, 2]);
  });
});
