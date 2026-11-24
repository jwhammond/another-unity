// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../sim/combat/commands';
import { SIM_SEAMS } from '../../sim/combat/seams';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { imageColour as ic, miniConsoleArt } from '../../testing/console';
import { IndexedScreen } from '../indexed';
import {
  BUTTON, BUTTONS, buttonShown, cFormat, COLOUR, drawButton, drawConn, drawLamps, drawManeuvers, drawPage, drawSliders, drawStatus, drawTabs, IMAGE,
  PAGE, PAGE_RECT, phaserSliderY, PHASER_SLIDER_X, powerCell, SALVO_X, SALVO_Y, scannerShips, selfDestructText, tabRect, type ConsoleUi,
} from './console';

const ui = (o: Partial<ConsoleUi> = {}): ConsoleUi => ({ page: PAGE.conn, pressed: -1, buttonTime: 0, arrow: -1, wall: 50000, ...o });
const screen = () => {
  const s = new IndexedScreen();
  s.pixels.fill(1);
  return s;
};
const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x];
/** A battle with weapons (setupWeapons: the Enterprise's six banks). */
const armed = () => miniBattle({ ctx: miniBattleContext({ ...SIM_SEAMS }) });

describe('cFormat (the printf subset the console formats with)', () => {
  it('pads ints right, left and with zeros, truncates, and writes fixed decimals', () => {
    expect([cFormat('%3d %%', 7), cFormat('%-2d', 5), cFormat('%3d', -5), cFormat('%d', -12.7), cFormat('%4.2f', 1.5), cFormat('%.2f', 0.3)])
      .toEqual(['  7 %', '5 ', ' -5', '-12', '1.50', '0.30']);
    expect([cFormat('%03.05f', 12.5), cFormat('0%02.05f', 9.25), cFormat('%1.2f', -0.125 * 3), cFormat('=%3.2f=', 2)]).toEqual(['12.50000', '09.25000', '-0.38', '=2.00=']);
  });
});

describe('the console\'s parts, as TacticalScreen::draw draws them (tactical.cpp:951-1053, 1258-1337)', () => {
  it('draws the current page\'s tab current and the others normal, in their rects (tactical.cpp:62-65, 1298-1301)', () => {
    const s = screen();
    drawTabs(s, miniConsoleArt(), PAGE.tactics);
    expect([px(s, tabRect(4)[0], tabRect(4)[1]), px(s, tabRect(3)[0], tabRect(3)[1]), px(s, tabRect(0)[0], tabRect(0)[1])]).toEqual([ic(77), ic(68), ic(72)]);
  });

  it('blanks the page\'s place for any page but the phasers\', and draws its pictures (tactical.cpp:1282-1291)', () => {
    const s = screen();
    drawPage(s, miniConsoleArt(), PAGE.conn);
    // (CONN's three pictures: Delegate's at (277, 374), the alert's at (277, 315), the countdown's at (129, 405))
    expect([px(s, PAGE_RECT[0], PAGE_RECT[1]), px(s, PAGE_RECT[2] - 1, PAGE_RECT[3] - 1), px(s, PAGE_RECT[2], PAGE_RECT[1]), px(s, 277, 374), px(s, 277, 315), px(s, 129, 405)])
      .toEqual([0, 0, 1, ic(66), ic(80), ic(13)]);
    const p = screen();
    drawPage(p, miniConsoleArt(), PAGE.phasers);
    expect([...p.pixels].every(v => v === 1)).toBe(true);
  });

  it('draws a button down while pressed or on, nothing for one the background shows up, HAIL at red alert and SPLIT wide (tactical.cpp:951-978)', () => {
    const { b } = miniBattle();
    const art = miniConsoleArt();
    const at = (button: number) => { const s = screen(); drawButton(s, art, b, ui({ pressed: button === BUTTON.view ? BUTTON.view : -1 }), button); return px(s, BUTTONS[button]!.x, BUTTONS[button]!.y); };
    b.console.redAlert = false;
    expect([at(BUTTON.bridge), at(BUTTON.engineering), at(BUTTON.view), at(BUTTON.phasers), at(BUTTON.full)]).toEqual([ic(41), ic(43), ic(81), 1, ic(84)]);
    b.console.redAlert = true;
    b.view.wide = true;
    b.console.shieldsRaised = true;
    b.console.spreadDegrees = 10;
    expect([at(BUTTON.bridge), at(BUTTON.full), at(BUTTON.shields), at(BUTTON.weaponsLock), at(BUTTON.spread + 2), at(BUTTON.spread + 1)])
      .toEqual([ic(IMAGE.hailUp), ic(IMAGE.split), ic(10), ic(8), ic(21), ic(36)]);
  });

  it('shows a page\'s buttons only on it, and no zoom while wide (tactical.cpp:587-591, 1303-1307)', () => {
    expect([buttonShown(BUTTON.shields, PAGE.conn, false), buttonShown(BUTTON.shields, PAGE.tactics, false), buttonShown(BUTTON.bridge, PAGE.tactics, false)]).toEqual([true, false, true]);
    expect([buttonShown(BUTTON.zoomIn, PAGE.conn, false), buttonShown(BUTTON.zoomOut, PAGE.conn, true), buttonShown(BUTTON.allPhasers, PAGE.phasers, true)]).toEqual([true, false, true]);
  });

  it('draws each bank\'s setting in fives and its charge in twenty cells, with its percentage (tactical.cpp:988-1002)', () => {
    const { b } = armed();
    const e = b.ships[0]!;
    expect(e.banks.length).toBe(6);
    e.banks[0]!.setting = 50;
    e.banks[0]!.active = true;
    e.banks[0]!.charge = 34;
    const s = screen();
    drawSliders(s, miniConsoleArt(), b, PAGE.phasers);
    const y = phaserSliderY(0);
    // (ten 6-pixel blocks of setting from x 153; the charge's 6 of 20 cells light, the rest grey; the bar's ground black)
    expect([px(s, PHASER_SLIDER_X, y), px(s, PHASER_SLIDER_X + 59, y), px(s, PHASER_SLIDER_X + 61, y), px(s, PHASER_SLIDER_X + 0x79, y + 0x13)]).toEqual([COLOUR.paleBlue, COLOUR.paleBlue, COLOUR.black, COLOUR.black]);
    expect([px(s, PHASER_SLIDER_X + 6 * 5 + 1, y + 1), px(s, PHASER_SLIDER_X + 6 * 6 + 1, y + 1)]).toEqual([COLOUR.lightBlue, COLOUR.grey]);
    // (the percentage's field, dark blue, its text light blue)
    expect([px(s, 392, 311), px(s, 392 + 8, 312)]).toEqual([COLOUR.darkBlue, COLOUR.lightBlue]);
  });

  it('draws each tube\'s salvo: the loaded cells, the setting\'s frames and its number, and the spread\'s degrees (tactical.cpp:1003-1021)', () => {
    const { b } = miniBattle();
    b.console.salvo[0] = { loaded: 3, setting: 2 };
    const s = screen();
    // (the salvo picture as wide as the ten cells)
    drawSliders(s, miniConsoleArt({ sizes: { [IMAGE.salvo]: [121, 23] } }), b, PAGE.torpedoes);
    const x = SALVO_X, y = SALVO_Y[0];
    // (the salvo picture, a cell past the loaded dimmed, the setting's frame's left edge pale blue)
    expect([px(s, x + 1, y), px(s, x + 12 * 3 + 2, y + 2), px(s, x + 12 * 2 + 2, y + 2), px(s, x, y + 1), px(s, x + 12 * 2, y + 0x16)]).toEqual([ic(97), COLOUR.dim, ic(97), COLOUR.paleBlue, COLOUR.paleBlue]);
    expect(px(s, 380, 397)).toBe(COLOUR.darkBlue);
  });

  it('draws the lamps by updateLamps\' states, the banks\' and the tubes\' (tactical.cpp:1024-1029)', () => {
    const { b } = miniBattle();
    b.console.lamps = [0, 1, 2, 0, 1, 2, 0, 1];
    const s = screen();
    drawLamps(s, miniConsoleArt(), b);
    expect([316, 336, 356].map(x => px(s, x, 280))).toEqual([ic(49), ic(50), ic(51)]);
    expect([px(s, 519, 280), px(s, 579, 280)]).toEqual([ic(56), ic(57)]);
  });

  it('fills the five status fields and writes the power\'s and speed\'s units, which an older lift hasn\'t (tactical.cpp:1036-1053)', () => {
    const { b } = miniBattle();
    const s = screen();
    drawStatus(s, miniConsoleArt(), b, miniCombat());
    expect([0, 1, 2, 3, 4].map(i => px(s, 543, 308 + 11 * i))).toEqual(Array(5).fill(COLOUR.darkBlue));
    expect([px(s, 574, 320), px(s, 563, 353)]).toEqual([COLOUR.lightBlue, COLOUR.lightBlue]);
    const bare = screen();
    drawStatus(bare, miniConsoleArt({ text: false }), b, miniCombat());
    // (the words lie in the fields' own ground: without them it is all dark blue)
    expect([px(bare, 574, 320), px(bare, 563, 353)]).toEqual([COLOUR.darkBlue, COLOUR.darkBlue]);
  });

  it('draws the maneuver rows, the arrows pressed while the button time runs, and Engage or Disengage (tactical.cpp:1258-1280)', () => {
    const { b } = miniBattle();
    const s = screen();
    drawManeuvers(s, miniConsoleArt(), b, ui({ arrow: 1, buttonTime: 50100, wall: 50000 }));
    expect([px(s, 129, 310), px(s, 130, 311 + 8), px(s, 387, 318), px(s, 387, 341), px(s, 370, 437)]).toEqual([ic(IMAGE.maneuver), 0, ic(IMAGE.up), ic(IMAGE.downDown), ic(IMAGE.engage)]);
    b.console.engageButton = true;
    b.console.menuSelected = 0;
    drawManeuvers(s, miniConsoleArt(), b, ui({ arrow: 1, buttonTime: 50000, wall: 50000 }));
    expect([px(s, 129, 310), px(s, 387, 341), px(s, 370, 437)]).toEqual([ic(IMAGE.maneuverSelected), ic(IMAGE.down), ic(IMAGE.disengage)]);
  });

  it('counts the self-destruct down in eight digits by the battle\'s clock, from 10 s with three before the point (tactical.cpp:1326-1335)', () => {
    expect([selfDestructText(22000, 10000), selfDestructText(15500, 10000), selfDestructText(9000, 10000)]).toEqual(['12.00000', '05.50000', '00.00000']);
    const { b } = miniBattle();
    b.console.selfDestructTime = b.now + 5500;
    b.console.powerLevel = 2;
    const s = screen();
    drawConn(s, miniConsoleArt(), b);
    // (0 5 . 5 0 0 0 0 at x 150, 164, ...: digits are images 115 on, the point 128)
    expect([0, 1, 2, 3].map(i => px(s, 150 + 14 * i, 439))).toEqual([ic(115), ic(120), ic(IMAGE.decimalPoint), ic(120)]);
    const cell = powerCell(2);
    expect([px(s, cell[0], cell[1]), px(s, cell[2] - 1, cell[3] - 1), px(s, cell[2], cell[1]), px(s, 368, 423)]).toEqual([COLOUR.brightBlue, COLOUR.brightBlue, 1, ic(IMAGE.delegateOff)]);
  });

  it('scans the Enterprise on its damage page and the target on the sensors\' (tactical.cpp:1162-1165)', () => {
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    expect(scannerShips(b, PAGE.damage)).toEqual({ subject: b.ships[0], other: b.ships[1] });
    expect(scannerShips(b, PAGE.sensors)).toEqual({ subject: b.ships[1], other: b.ships[0] });
    applyCommand(ctx, b, { type: 'target', ship: null });
    expect(scannerShips(b, PAGE.sensors)).toEqual({ subject: null, other: b.ships[0] });
  });
});
