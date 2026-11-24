// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { logMessage } from '../../sim/combat/battle';
import { applyCommand } from '../../sim/combat/commands';
import { v3 } from '../../sim/combat/math';
import { KIND } from '../../sim/combat/types';
import { miniBattle, miniEnterpriseUnits } from '../../testing/combat';
import { imageColour as ic, miniConsoleArt } from '../../testing/console';
import { IndexedScreen } from '../indexed';
import { COLOUR, PAGE } from './console';
import { drawScanner, scannerBlank, scannerColours, type ScannerSource } from './scanner';

const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x];
/** miniCombat's battle 3, the chodak targeted; the fixture's scanner shows one area (units 7, 1 and 2 of the Enterprise, 1 and 2 of others). */
function source(): ScannerSource & ReturnType<typeof miniBattle> {
  const { ctx, b } = miniBattle();
  applyCommand(ctx, b, { type: 'target', ship: 1 });
  return { ctx, b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits() };
}

describe('the scanners (drawScanner, tactical.cpp:1161-1256)', () => {
  it('colours each area green by its lowest power and red by its worst damage, in 32 steps from half to full (tactical.cpp:1171-1192)', () => {
    const s = source();
    const units = s.b.ships[0]!.systems.units;
    // (half power on unit 1: 15 steps, (15 + 31) * 255 / 63 = 186; unit 2 a quarter damaged of 100: 7 steps, 153)
    units[1]!.current = units[1]!.max / 2;
    units[2]!.damage = 25;
    // (an area without units, as the fixture's other ten, is at full power: 31 steps, (31 + 31) * 255 / 63 = 250)
    expect([...scannerColours(s, PAGE.damage).subarray(0, 6)]).toEqual([153, 186, 0, 0, 250, 0]);
  });

  it('reads nothing on the sensors page while they are damaged, and is blank with no target, a cloaked one or blank sensors (tactical.cpp:1167-1173)', () => {
    const s = source();
    s.b.console.sensorsDamaged = true;
    expect(scannerColours(s, PAGE.sensors).every(v => v === 0)).toBe(true);
    expect(scannerColours(s, PAGE.damage).some(v => v > 0)).toBe(true);
    s.b.ships[1]!.decloakTime = s.b.now + 1;
    expect([scannerBlank(s.b, PAGE.sensors), scannerBlank(s.b, PAGE.damage)]).toEqual([true, false]);
    s.b.ships[1]!.decloakTime = 0;
    s.b.console.sensorsBlank = true;
    expect([scannerBlank(s.b, PAGE.sensors), scannerBlank(s.b, PAGE.damage)]).toEqual([true, false]);
    applyCommand(s.ctx, s.b, { type: 'target', ship: null });
    expect(scannerBlank(s.b, PAGE.sensors)).toBe(true);
    const screen = new IndexedScreen();
    expect(drawScanner(screen, miniConsoleArt(), s, PAGE.sensors)).toBeNull();
    expect(screen.pixels.every(v => v === 0)).toBe(true);
  });

  it('draws the ship\'s picture centred in its box, its class, and its log up to the line read, the read line lowest (tactical.cpp:1195-1249)', () => {
    const s = source();
    const e = s.b.ships[0]!;
    for (let i = 0; i < 4; i++) logMessage(e, `-L${i}-`);
    e.logRead = 1;
    const screen = new IndexedScreen();
    // (the Enterprise's picture, 95, 111 x 104: at 144 + 36, 309 + 15)
    const art = miniConsoleArt({ sizes: { 95: [111, 104] } });
    expect(drawScanner(screen, art, s, PAGE.damage)).toBe(e);
    expect([px(screen, 180, 324), px(screen, 179, 324), px(screen, 131, 421), px(screen, 132, 423)]).toEqual([ic(95), 0, COLOUR.black, COLOUR.lightBlue]);
    // (two lines: the one read at y 464, the one before it at 452; none at 440)
    expect([px(screen, 130, 464), px(screen, 130, 452), px(screen, 130, 440)]).toEqual([COLOUR.lightBlue, COLOUR.lightBlue, COLOUR.black]);
  });

  it('names an unknown chodak by the console\'s word on the sensors page, and shows the shield facing us with its power (tactical.cpp:1205-1220)', () => {
    const s = source();
    s.b.contactCues = false;
    s.b.ships[1]!.type = KIND.chodak;
    s.b.ships[1]!.pos = v3(0, 5000, 0);
    const screen = new IndexedScreen();
    drawScanner(screen, miniConsoleArt(), s, PAGE.sensors);
    // ('-Oddity-' is eight glyphs of 4 pixels (3 lit) from x 131; the class's own, '-Zap-', five: then the shield's name at x 234 and its power at 320)
    expect([px(screen, 157, 422), px(screen, 234, 422), px(screen, 320, 422)]).toEqual([COLOUR.lightBlue, COLOUR.lightBlue, COLOUR.lightBlue]);
    s.b.contactCues = true;
    drawScanner(screen, miniConsoleArt(), s, PAGE.sensors);
    expect([px(screen, 145, 422), px(screen, 157, 422)]).toEqual([COLOUR.lightBlue, COLOUR.black]);
    // (range: the distance x 27 in the dark blue field)
    expect([px(screen, 402, 338), px(screen, 445, 339)]).toEqual([COLOUR.darkBlue, COLOUR.lightBlue]);
  });
});
