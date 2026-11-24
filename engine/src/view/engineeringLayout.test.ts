// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ShipUnit } from '../content/types';
import { newSystems, UNIT_FUSION, UNIT_POWER_GRID, UNIT_TORPEDO, UNIT_WARP } from '../sim/shipSystems';
import type { ShipContent } from '../content/types';
import {
  BACKGROUND, BRIDGE_BUTTON, buttonMs, COLOUR_MS, drawEngineering, hitAt, mrg, newUi, PACK_ENTRIES, PAGES, sliderAt, sliderKind, sliderOffset, tabRect, totalPower,
  unitFor, unitInfo, updateColours, type EngineeringArt, type EngineeringShip,
} from './engineeringLayout';
import { BitmapFont, IndexedScreen, Palette } from './indexed';

/** A one-bit font whose every glyph is a solid 3x3 block (width 4), from space to ~. */
function blockFont(): BitmapFont {
  const glyphs = Array.from({ length: 0x5f }, () => [0xe0, 0xe0, 0xe0]);
  return new BitmapFont(new Uint8Array([1, 3, 0x20, 0x7e, 3, 0, 0, 0, 0, ...glyphs.flatMap(g => [4, ...g])]));
}

/** Pictures that are each a 6x4 block of the colour 100 + their pack index, so a pixel says which was drawn. */
function art(place: Record<number, { x: number; y: number; flags: number }> = {}): EngineeringArt {
  const images = Array.from({ length: PACK_ENTRIES }, (_, i) => ({ width: i === BACKGROUND ? 640 : 6, height: i === BACKGROUND ? 480 : 4, pixels: new Uint8Array((i === BACKGROUND ? 640 * 480 : 24)).fill(i === BACKGROUND ? 1 : 100 + i) }));
  // (sliders are off the screen unless a test puts them somewhere, so that what a test looks at is drawn by one slider alone)
  const sliders = Array.from({ length: 70 }, (_, i) => place[i] ?? { x: 900, y: 0, flags: i & 1 ? 0x21 : 0x11 });
  return {
    images,
    tables: {
      sliders,
      labels: Array.from({ length: 59 }, (_, i) => ({ rect: [10, 20 + i, 50, 30 + i] as [number, number, number, number], text: `L${i}` })),
      rows: Array.from({ length: 38 }, () => [400, 400, 420, 410] as [number, number, number, number]),
      shieldOrder: [3, 2, 1, 0, 7, 6, 5, 4],
      paletteIndex: Array.from({ length: 35 }, (_, i) => 1 + i),
    },
    fonts: [blockFont(), blockFont(), blockFont()],
  };
}

function unit(name: string, type: number, extra: Partial<ShipUnit> = {}): ShipUnit {
  return { name, type, current: 50, target: 50, max: 100, chargeTicks: 291, dischargeTicks: 582, damage: 0, repair: 0, baseDamage: 0, maxDamage: 180, efficiency: type === UNIT_FUSION ? 95 : 0, ...extra };
}
/** 35 units named by their index, of the warp type but for a few. */
function ship(over: Record<number, Partial<ShipUnit>> = {}, types: Record<number, number> = {}): EngineeringShip {
  const units = Array.from({ length: 35 }, (_, i) => unit(`Unit ${i}`, types[i] ?? UNIT_WARP, over[i]));
  return { units, systems: newSystems({ data: { units } } as unknown as ShipContent) };
}
const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x]!;

describe('the engineering screen\'s tables and hit tests', () => {
  const a = art({ 0x37: { x: 100, y: 200, flags: 0x21 }, 0x38: { x: 300, y: 200, flags: 0x11 } });
  it('maps sliders to units: the shields in the executable\'s order, the rest two to a unit', () => {
    expect([0, 1, 2, 3, 14, 15].map(s => unitFor(a.tables, s))).toEqual([3, 3, 2, 2, 4, 4]);
    expect([16, 17, 0x36, 0x37, 0x45].map(s => unitFor(a.tables, s))).toEqual([8, 8, 27, 27, 34]);
  });
  it('reads what a slider sets from its flags: repair, power, a reactor\'s power, the torpedoes, or nothing for a read-only one', () => {
    expect([0x11, 0x21, 0x221, 0x1001, 0x801, 0x820].map(sliderKind)).toEqual(['repair', 'power', 'reactor', 'torpedoes', null, null]);
  });
  it('finds the slider whose box (from 7 left and 3 above its corner, 130 by 25) holds a point, on the page only', () => {
    const s = a.tables.sliders[0x37]!;
    expect(sliderAt(a.tables, 0, s.x + 20, s.y + 5)).toBe(0x37);
    expect(sliderAt(a.tables, 0, s.x - 8, s.y + 5)).toBe(-1);
    expect(sliderAt(a.tables, 0, s.x - 7, s.y - 3)).toBe(0x37);
    expect(sliderAt(a.tables, 0, s.x + 123, s.y)).toBe(-1);
    expect(sliderAt(a.tables, 2, s.x + 20, s.y + 5)).toBe(-1);
    expect(sliderOffset(a.tables, 0x37, s.x + 30)).toBe(30);
    expect(sliderOffset(a.tables, 0x37, s.x + 500)).toBe(119);
    expect(sliderOffset(a.tables, 0x37, s.x - 5)).toBe(0);
  });
  it('finds the tab or button under a point', () => {
    expect(hitAt(140, 21)).toEqual({ tab: 0 });
    expect(hitAt(245, 54 + 29)).toEqual({ tab: 1 });
    expect(hitAt(246, 21)).toBeNull();
    expect(hitAt(500, 400)).toEqual({ button: 0 });
    expect(hitAt(500, 430)).toEqual({ button: 1 });
    expect(hitAt(400, 420)).toEqual({ button: 2 });
    expect(tabRect(4)).toEqual([139, 159, 246, 189]);
    expect(BRIDGE_BUTTON).toEqual([490, 390, 611, 424]);
  });
  it('holds Bridge and Tactical down for 0x91 of the original\'s ticks and Delegate for 0x24', () => {
    expect([buttonMs(0), buttonMs(1), buttonMs(2)]).toEqual([498, 498, 123]);
    expect(COLOUR_MS).toBe(61);
  });
});

describe('unitInfo (drawInfo)', () => {
  it('says a damaged unit needs minutes to repair, and nothing else', () => {
    const s = ship({ 3: { damage: 90 } });
    expect(unitInfo(s.units[3]!, { ...s.systems.units[3]!, damage: 90 })).toEqual({ name: 'Unit 3', lines: [], state: '1.5000 minutes to repair', operational: false });
  });
  it('gives a unit\'s capacity and level in megawatts and its charge and discharge times in seconds of the original\'s clock', () => {
    const s = ship({ 4: { max: 267, current: 134, chargeTicks: 291, dischargeTicks: 582 } });
    s.systems.units[4]!.current = 134;
    const said = unitInfo(s.units[4]!, s.systems.units[4]!);
    expect(said.lines).toEqual([{ value: '200.15', unit: 'MW' }, { value: '100.45', unit: 'MW' }, { value: '267.000', unit: 'sec' }, { value: '534.000', unit: 'sec' }]);
    expect(said.state).toBe('100% OPERATIONAL');
  });
  it('gives the torpedoes by number loaded, and a reactor its output rather than its setting', () => {
    const t = ship({ 5: { max: 10, current: 3, chargeTicks: 291 } }, { 5: UNIT_TORPEDO });
    t.systems.units[5]!.current = 3;
    expect(unitInfo(t.units[5]!, t.systems.units[5]!).lines.map(l => `${l.value} ${l.unit}`)).toEqual(['10 torps', '3 loaded', '10.000 sec', '2.35 sec']);
    const r = ship({ 6: { max: 25, current: 20 } }, { 6: UNIT_FUSION });
    r.systems.units[6]!.current = 20;
    // 20 of 25 is 80 percent of the way: 95 percent efficient, a fusion reactor makes 25 units at the most
    expect(unitInfo(r.units[6]!, r.systems.units[6]!).lines[1]).toEqual({ value: (0.95 * 0.8 * 25 / 1.334).toFixed(2), unit: 'MW' });
  });
});

describe('totalPower (drawTotalPower)', () => {
  it('adds what each system still wants to reach its target (not the torpedoes\') and what they all use, but not the reactors or the grid', () => {
    const units = [unit('a', UNIT_WARP), unit('b', UNIT_WARP), unit('reactor', UNIT_FUSION), unit('torps', UNIT_TORPEDO), unit('grid', UNIT_POWER_GRID)];
    const s: EngineeringShip = { units, systems: newSystems({ data: { units } } as unknown as ShipContent) };
    const set = [[10, 40], [70, 60], [5, 5], [7, 99], [30, 30]];
    s.systems.units.forEach((u, i) => { u.current = set[i]![0]!; u.target = set[i]![1]!; });
    s.systems.pool = 500;
    // (a wants 30 more, b 10 less; the torpedoes' target is the cells to load, not power; the reactor and the grid are not drawn on)
    expect(totalPower(s)).toEqual({ demand: 30 - 10, spare: 500 - 20, usage: 10 + 70 + 7 });
  });
});

describe('updateColours', () => {
  const a = art();
  it('rotates the three shimmering ranges, shows damaged systems on the schematics red and working ones green, and blinks the hovered one grey', () => {
    const p = new Palette(Uint8Array.from({ length: 768 }, (_, i) => Math.floor(i / 3)));
    const s = ship();
    s.systems.units[28]!.damage = 10;
    const ui = newUi(true);
    // (the power page: slider 0x36 (repair) and 0x37 are unit 27, 0x38 and 0x39 unit 28: palette indices 28 and 29)
    a.tables.sliders[0x36]!.flags = 0x11;
    a.tables.sliders[0x38]!.flags = 0x11;
    updateColours(p, a, ui, s, 0);
    // (0x77-0x7f turned one step: entry 0x77 now has 0x78's colour)
    expect(p.rgb[0x77 * 3]).toBe(0x78);
    expect(p.rgb[0x7f * 3]).toBe(0x77);
    expect(p.rgb[0x72 * 3]).toBe(0x71);
    expect(p.rgb[0x48 * 3]).toBe(0x49);
    expect(p.rgb[29 * 3]).toBe(0x10);
    expect(p.rgb[28 * 3]).toBe(0x23);
    ui.hover = 0x38;
    // (123 ms to a blink: the odd ones are grey)
    updateColours(p, a, ui, s, 123);
    expect([...p.rgb.subarray(29 * 3, 29 * 3 + 3)]).toEqual([0x80, 0x80, 0x80]);
    updateColours(p, a, ui, s, 246);
    expect(p.rgb[29 * 3]).toBe(0x10);
  });
});

describe('drawEngineering', () => {
  it('draws the tabs, the one open in its lit picture, the buttons and the Delegate lamp', () => {
    const a = art();
    const s = new IndexedScreen();
    s.set(a.images[BACKGROUND]!);
    const ui = newUi(true);
    drawEngineering(s, a, ui, ship());
    // (entry 13 + 4 - page is the open tab, 18 + 4 - page the others)
    expect(px(s, 139, 20)).toBe(100 + mrg(13 + 4));
    expect(px(s, 139, 54)).toBe(100 + mrg(18 + 4 - 1));
    expect(px(s, 490, 390)).toBe(100 + mrg(10));
    expect(px(s, 490, 424)).toBe(100 + mrg(9));
    expect(px(s, 358, 389)).toBe(100 + mrg(3));
    // (the lamp is drawn after the button, at 368, 423: on while delegating)
    expect(px(s, 368, 423)).toBe(100 + mrg(11));
    ui.delegate = false;
    ui.pressed = 2;
    ui.page = 1;
    drawEngineering(s, a, ui, ship());
    expect(px(s, 358, 389)).toBe(100 + mrg(4));
    expect(px(s, 367, 424)).toBe(100 + mrg(11));
    expect(px(s, 139, 20)).toBe(100 + mrg(18 + 4));
    expect(px(s, 139, 54)).toBe(100 + mrg(13 + 4 - 1));
  });

  it('draws a power bar lit to its level, grey beyond, with the target as a band to a point', () => {
    const a = art({ 0x37: { x: 100, y: 200, flags: 0x21 } });
    const s = new IndexedScreen();
    const sh = ship({ 27: { current: 50, max: 100, target: 80 } });
    sh.systems.units[27]!.current = 50;
    sh.systems.units[27]!.target = 80;
    drawEngineering(s, a, newUi(true), sh);
    // (slider 0x37 at 100, 200: unit 27's power; actual 50 percent lights 10 of 20 segments, the 11th partly)
    const x = 100, y = 200;
    expect(px(s, x + 6 * 12 + 2, y + 12)).toBe(0x84);
    expect(px(s, x + 6 * 19 + 4, y + 12)).toBe(0x84);
    expect(px(s, x + 6 * 5 + 2, y + 12)).not.toBe(0x84);
    // the target 80 percent is at x + (80 * 118 + 50) / 100 = x + 94: a bright line down 11 rows
    expect(px(s, x + 94, y + 10)).toBe(0xae);
    expect(px(s, x + 94, y + 11)).not.toBe(0xae);
    // (and the band above it, in light blue)
    expect(px(s, x + 50, y + 2)).toBe(0xad);
  });

  it('draws a repair bar from the damage, and a reactor\'s efficiency strip', () => {
    const a = art({ 0x45: { x: 300, y: 100, flags: 0x221 } });
    const s = new IndexedScreen();
    const sh = ship({}, { 34: UNIT_FUSION });
    sh.systems.units[34]!.efficiency = 95;
    drawEngineering(s, a, newUi(true), sh);
    // (slider 0x45 is a reactor's: a strip 19 below the bar. Efficiency 95 is 19 fives: segments 1 to 18 are green, the 19th and 20th red, as drawSlider's
    // second loop begins at the efficient segment itself, and the first, at the bar's own x, is blue)
    expect(px(s, 302, 100 + 21)).toBe(0x0d);
    expect(px(s, 300 + 6 + 2, 100 + 21)).toBe(0x23);
    expect(px(s, 300 + 6 * 18 + 2, 100 + 21)).toBe(0x23);
    expect(px(s, 300 + 6 * 19 + 2, 100 + 21)).toBe(0x10);
  });

  it('draws a repair bar from the damage out of 180, and the repair asked for as its band', () => {
    const a = art({ 0x36: { x: 100, y: 200, flags: 0x11 } });
    const s = new IndexedScreen();
    const sh = ship({ 27: { maxDamage: 180 } });
    sh.systems.units[27]!.damage = 90;
    sh.systems.units[27]!.repair = 45;
    drawEngineering(s, a, newUi(true), sh);
    // (90 of 180 is half: ten segments lit, the rest grey; the 45 asked for is a quarter, x + (25 * 118 + 50) / 100 = x + 30)
    expect(px(s, 100 + 6 * 12 + 2, 200 + 12)).toBe(0x84);
    expect(px(s, 100 + 6 * 5 + 2, 200 + 12)).not.toBe(0x84);
    expect(px(s, 100 + 30, 200 + 10)).toBe(0xae);
  });

  it('draws the torpedoes\' ten cells and a box round the one being loaded to', () => {
    const a = art({ 0x26: { x: 300, y: 250, flags: 0x1000 } });
    const s = new IndexedScreen();
    const sh = ship({ 19: { current: 2, max: 10, target: 5 } }, { 19: UNIT_TORPEDO });
    sh.systems.units[19]!.current = 2;
    sh.systems.units[19]!.target = 5;
    const ui = newUi(true);
    ui.page = 1;
    drawEngineering(s, a, ui, sh);
    // (slider 0x26, unit 19, is at 300, 250: cells from the 3rd are grey inside, the 5th's box is light blue)
    expect(px(s, 300 + 10 * 7 + 5, 250 + 8)).toBe(0x85);
    expect(px(s, 300 + 10 * 7 + 2, 250 + 8)).toBe(0x87);
    expect(px(s, 300 + 10 * 7 + 1, 250 + 8)).toBe(0x84);
    expect(px(s, 300 + 10 * 4, 250 + 8)).toBe(0xad);
    expect(px(s, 300 + 10 * 5, 250 + 8)).toBe(0xad);
    expect(px(s, 300 + 10 * 4 + 5, 250 + 18)).toBe(0xad);
  });

  it('shows the unit pointed at in the info box, and clears it when none is', () => {
    const a = art({ 0x37: { x: 100, y: 200, flags: 0x21 } });
    const s = new IndexedScreen();
    const ui = newUi(true);
    drawEngineering(s, a, ui, ship());
    // the title row is dark blue, the last red, the middle ones black, whatever is below them
    expect(px(s, 100, 397)).toBe(0xa9);
    expect(px(s, 100, 467)).toBe(0xa1);
    expect(px(s, 100, 425)).toBe(0);
    ui.hover = 0x37;
    drawEngineering(s, a, ui, ship());
    // (the name is drawn in the light blue over the dark)
    expect([...s.pixels.subarray(397 * 640 + 100, 397 * 640 + 130)].some(v => v === 0xad)).toBe(true);
    expect([...s.pixels.subarray(467 * 640 + 100, 467 * 640 + 130)].some(v => v === 0xa3)).toBe(true);
  });

  it('draws the torpedoes in store on the Weapons page, and the reactors\' pictures on the Power page only', () => {
    const a = art();
    const s = new IndexedScreen();
    const ui = newUi(true);
    drawEngineering(s, a, ui, ship());
    expect(px(s, 448, 241)).toBe(100 + mrg(35));
    expect(px(s, 259, 241)).toBe(100 + mrg(36));
    ui.page = 1;
    drawEngineering(s, a, ui, ship());
    expect([...s.pixels.subarray(336 * 640 + 350, 336 * 640 + 400)].some(v => v === 0xff || v !== 0)).toBe(true);
    // (the panel is wiped each frame: the Power page's art is gone from the Weapons page)
    expect(px(s, 448, 241)).toBe(0);
    expect(PAGES).toHaveLength(5);
  });
});
