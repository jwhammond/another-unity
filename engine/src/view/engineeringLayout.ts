// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipUnit } from '../content/types';
import { SLIDER_WIDTH, UNIT_FUSION, UNIT_MATTER_ANTIMATTER, UNIT_POWER_GRID, UNIT_TORPEDO, type SliderKind, type SystemsState } from '../sim/shipSystems';
import { type BitmapFont, type IndexedImage, type IndexedScreen, type Palette } from './indexed';

/**
 * The engineering screen drawn as the original draws it (engineering.cpp: EngineeringScreen::draw, drawSlider, drawInfo, drawTotalPower,
 * updateColours), onto an indexed screen from the game's own pictures and fonts. Pure: the browser panel feeds it the published pack
 * (engine/src/view/indexed.ts), the tables from the executable and the ship's systems, and puts the screen on a canvas.
 */

export const PAGE_NAMES = ['Power', 'Weapons', 'Shields', 'Sensors', 'Other'] as const;
export const NUM_PAGES = 5;

/** Each page's sliders, labels, rows and schematics (kPages). */
export const PAGES: readonly { firstSlider: number; lastSlider: number; firstLabel: number; lastLabel: number; firstRow: number; lastRow: number; schematics: [number, number] }[] = [
  { firstSlider: 0x36, lastSlider: 0x45, firstLabel: 0x2d, lastLabel: 0x3a, firstRow: 0x1c, lastRow: 0x25, schematics: [27, 28] },
  { firstSlider: 0x1a, lastSlider: 0x29, firstLabel: 0x14, lastLabel: 0x22, firstRow: 0x0d, lastRow: 0x15, schematics: [33, 34] },
  { firstSlider: 0x00, lastSlider: 0x0f, firstLabel: 0x00, lastLabel: 0x0b, firstRow: 0x00, lastRow: 0x07, schematics: [31, 32] },
  { firstSlider: 0x10, lastSlider: 0x19, firstLabel: 0x0c, lastLabel: 0x13, firstRow: 0x08, lastRow: 0x0c, schematics: [29, 30] },
  { firstSlider: 0x2a, lastSlider: 0x35, firstLabel: 0x23, lastLabel: 0x2c, firstRow: 0x16, lastRow: 0x1b, schematics: [25, 26] },
];

// slider flags
export const SLIDER_REPAIR = 0x10, SLIDER_POWER = 0x20, SLIDER_REACTOR = 0x200, SLIDER_READ_ONLY = 0x800, SLIDER_TORPEDOES = 0x1000;

/** The first picture of the pack is the background; eng01b.mrg's entry `i` is the pack's `i + 1`. */
export const BACKGROUND = 0;
export const mrg = (entry: number): number => entry + 1;

// eng01b.mrg
const IMAGE_REPAIR_BAR = 0, IMAGE_POWER_BAR = 1, IMAGE_DELEGATE_UP = 3, IMAGE_DELEGATE_DOWN = 4, IMAGE_TACTICAL_DOWN = 5, IMAGE_BRIDGE_DOWN = 7;
const IMAGE_TACTICAL = 9, IMAGE_BRIDGE = 10, IMAGE_LAMP_ON = 11, IMAGE_LAMP_OFF = 12, IMAGE_CURRENT_TABS = 13, IMAGE_TABS = 18;
const IMAGE_FUSION_ART = 35, IMAGE_MATTER_ANTIMATTER_ART = 36, IMAGE_TORPEDO_CELLS = 37, IMAGE_INFO = 40;

/** The pictures the screen needs from the pack: the background and entries 0 to 40 of the MRG. */
export const PACK_ENTRIES = 1 + 41;

// fonts
export const LABEL_FONT = 2, INFO_FONT = 0;

// colours (palette indices)
const BLACK = 0, BLUE = 0x0d, DAMAGED = 0x10, WORKING = 0x23, GREY = 0x84, LIGHT_GREY = 0x85, LIGHTER_GREY = 0x87;
const DARK_RED = 0xa1, RED = 0xa3, DARK_BLUE = 0xa9, LIGHT_BLUE = 0xad, BRIGHT_BLUE = 0xae, WHITE = 0xff;

const MAX_DISPLAYED_DAMAGE = 180;
/** How much power the Total Power bars show. */
const MAX_POOL = 2400, MAX_USAGE = 10380, POWER_UNITS_PER_MW = 1.334;
/** The original's clock ticks a second. */
const TICKS = 291;
/** A system blinks grey when its slider is hovered over. */
const HOVER_GREY = [0x80, 0x80, 0x80] as const;
const NUM_SHIELDS = 8;

export interface EngineeringTables {
  sliders: { x: number; y: number; flags: number }[];
  labels: { rect: [number, number, number, number]; text: string }[];
  rows: [number, number, number, number][];
  shieldOrder: number[];
  paletteIndex: number[];
}

/** What the screen draws with. */
export interface EngineeringArt {
  /** The pack's pictures: BACKGROUND, then `mrg(i)`. */
  images: readonly IndexedImage[];
  tables: EngineeringTables;
  /** fonts[INFO_FONT] and fonts[LABEL_FONT] at least. */
  fonts: readonly BitmapFont[];
}

/** The part of the screen's state the player moves. */
export interface EngineeringUi {
  page: number;
  /** The slider the pointer is over, or -1. */
  hover: number;
  /** The button that is down: 0 Bridge, 1 Tactical, 2 Delegate, or -1. */
  pressed: number;
  /** Whether La Forge is running things. */
  delegate: boolean;
}

export const newUi = (delegate: boolean): EngineeringUi => ({ page: 0, hover: -1, pressed: -1, delegate });

/** The ship, as the screen reads it: the lifted units and their live state. */
export interface EngineeringShip { units: readonly ShipUnit[]; systems: SystemsState }

/** The tab's, the buttons' rectangles ([left, top, right, bottom], exclusive) in the original's pixels (engineering.cpp:117-124). */
export const tabRect = (page: number): [number, number, number, number] => { const top = [20, 54, 89, 124, 159][page]!; return [139, top, 246, top + 30]; };
export const BRIDGE_BUTTON: [number, number, number, number] = [490, 390, 611, 424];
export const TACTICAL_BUTTON: [number, number, number, number] = [490, 424, 611, 460];
export const DELEGATE_BUTTON: [number, number, number, number] = [360, 391, 443, 455];

/** The unit a slider stands for (unitFor): the shields are in another order on the screen. */
export function unitFor(tables: { shieldOrder: readonly number[] }, slider: number): number {
  return slider < 2 * NUM_SHIELDS ? tables.shieldOrder[slider >> 1] ?? slider >> 1 : slider >> 1;
}

/** What a slider sets, from its flags. */
export function sliderKind(flags: number): SliderKind | null {
  if (flags & SLIDER_READ_ONLY) return null;
  if (flags & SLIDER_TORPEDOES) return 'torpedoes';
  if (flags & SLIDER_REPAIR) return 'repair';
  if (flags & SLIDER_POWER) return flags & SLIDER_REACTOR ? 'reactor' : 'power';
  return null;
}

/** EngineeringScreen::sliderAt: the slider whose box holds the point, on the page. */
export function sliderAt(tables: Pick<EngineeringTables, 'sliders'>, page: number, x: number, y: number): number {
  for (let slider = PAGES[page]!.firstSlider; slider <= PAGES[page]!.lastSlider; slider++) {
    const s = tables.sliders[slider];
    if (s && x >= s.x - 7 && x < s.x + 123 && y >= s.y - 3 && y < s.y + 22) return slider;
  }
  return -1;
}

const inside = (r: readonly [number, number, number, number], x: number, y: number): boolean => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** What a click at a point is on: a tab (`{ tab }`), a button (`{ button }`: 0 Bridge, 1 Tactical, 2 Delegate) or nothing. */
export function hitAt(x: number, y: number): { tab: number } | { button: number } | null {
  for (let page = 0; page < NUM_PAGES; page++) if (inside(tabRect(page), x, y)) return { tab: page };
  if (inside(BRIDGE_BUTTON, x, y)) return { button: 0 };
  if (inside(TACTICAL_BUTTON, x, y)) return { button: 1 };
  if (inside(DELEGATE_BUTTON, x, y)) return { button: 2 };
  return null;
}

/** How long a button stays down before it acts, in the original's ticks (0x91 for Bridge and Tactical, 0x24 for Delegate). */
export const BUTTON_TICKS = [0x91, 0x91, 0x24] as const;
export const buttonMs = (button: number): number => Math.trunc(BUTTON_TICKS[button]! * 1000 / TICKS);

/** The units' ticks in seconds of the original's clock, as the info lines show them. */
const seconds = (n: number): number => n / 291.0;

/**
 * EngineeringScreen::updateColours: the power bars and the reactors shimmer, the schematics show damaged systems in red and working ones in
 * green, and the system under the pointer blinks. `now` is in milliseconds. Changes the palette, which the screen's pixels are shown through.
 */
export function updateColours(palette: Palette, art: Pick<EngineeringArt, 'tables'>, ui: EngineeringUi, ship: EngineeringShip, now: number): void {
  palette.rotate(0x77, 0x7f);
  palette.rotate(0x72, 0x68);
  palette.rotate(0x48, 0x52);
  const page = PAGES[ui.page]!;
  for (let slider = page.firstSlider; slider <= page.lastSlider; slider++) {
    const s = art.tables.sliders[slider];
    if (!s || !(s.flags & SLIDER_REPAIR)) continue;
    const index = art.tables.paletteIndex[unitFor(art.tables, slider)] ?? 0;
    const unit = ship.systems.units[unitFor(art.tables, slider)];
    if (index && unit) palette.copyEntry(index, unit.damage ? DAMAGED : WORKING);
  }
  // and the one under the pointer blinks
  if (ui.hover !== -1 && Math.trunc(now / Math.trunc(0x24 * 1000 / TICKS)) % 2) {
    const index = art.tables.paletteIndex[unitFor(art.tables, ui.hover)] ?? 0;
    if (index) palette.setEntry(index, HOVER_GREY);
  }
}

/** How often updateColours runs (0x12 ticks) in milliseconds. */
export const COLOUR_MS = Math.trunc(0x12 * 1000 / TICKS);

function drawSlider(screen: IndexedScreen, art: EngineeringArt, slider: number, ship: EngineeringShip): void {
  const s = art.tables.sliders[slider];
  const index = unitFor(art.tables, slider);
  const unit = ship.systems.units[index];
  if (!s || !unit) return;
  const { x, y } = s;
  const fill = (x1: number, y1: number, x2: number, y2: number, colour: number) => screen.fill(x1, y1, x2, y2, colour);

  if (s.flags & SLIDER_TORPEDOES) {
    // ten cells, lit while loaded, and a box around the one to load up to
    screen.blit(art.images[mrg(IMAGE_TORPEDO_CELLS)]!, x, y);
    for (let i = unit.current; i < 10; i++) {
      fill(x + 10 * i + 1, y + 1, x + 10 * i + 9, y + 17, GREY);
      fill(x + 10 * i + 2, y + 2, x + 10 * i + 8, y + 16, LIGHTER_GREY);
      fill(x + 10 * i + 3, y + 3, x + 10 * i + 7, y + 15, LIGHT_GREY);
    }
    if (unit.target !== unit.current && unit.target > 0) {
      const k = unit.target - 1;
      fill(x + 10 * k, y + 1, x + 10 * k, y + 17, LIGHT_BLUE);
      fill(x + 10 * (k + 1), y + 1, x + 10 * (k + 1), y + 17, LIGHT_BLUE);
      fill(x + 10 * k, y + 1, x + 10 * (k + 1), y + 1, LIGHT_BLUE);
      fill(x + 10 * k, y + 18, x + 10 * (k + 1), y + 18, LIGHT_BLUE);
    }
    return;
  }

  let actual: number, target: number;
  if (s.flags & SLIDER_REPAIR) {
    actual = Math.trunc(unit.damage * 100 / MAX_DISPLAYED_DAMAGE);
    target = Math.trunc(unit.repair * 100 / MAX_DISPLAYED_DAMAGE);
  } else {
    actual = unit.max ? Math.trunc(unit.current * 100 / unit.max) : 0;
    target = unit.max ? Math.trunc(unit.target * 100 / unit.max) : 0;
  }
  actual = Math.min(Math.max(actual, 0), 100);
  target = Math.min(Math.max(target, 0), 100);

  // the bar, with its segments lit up to the actual value
  fill(x - 4, y, x - 3, y + 15, LIGHT_BLUE);
  screen.blit(art.images[mrg(s.flags & SLIDER_REPAIR ? IMAGE_REPAIR_BAR : IMAGE_POWER_BAR)]!, x, y);
  const lit = Math.trunc(actual / 5), partial = actual % 5;
  if (lit < 20) {
    for (let i = lit + 1; i < 20; i++) fill(x + 6 * i, y, x + 6 * i + 4, y + 15, GREY);
    for (let j = partial; j < 5; j++) fill(x + 6 * lit + j, y, x + 6 * lit + j, y + 15, GREY);
  }
  if (!actual) fill(x - 2, y, x - 1, y + 15, BLACK);

  // the target is a band to a point
  if (target) {
    const m = x + Math.trunc((target * 118 + 50) / 100);
    if (m > x) {
      fill(x - 2, y, m, y + 6, LIGHT_BLUE);
      if (x + 4 <= m) fill(x - 2, y + 6, m - 5, y + 6, DARK_BLUE);
      for (let i = 0; i < 4; i++) if (x + 3 - i < m) fill(m - 4 + i, y + 6 + i, m, y + 6 + i, LIGHT_BLUE);
    }
    fill(m, y, m, y + 10, BRIGHT_BLUE);
  }

  // the reactors also show their efficiency
  if (s.flags & SLIDER_REACTOR) {
    fill(x, y + 19, x + 4, y + 23, BLUE);
    const efficient = Math.max(Math.trunc(unit.efficiency / 5), 1);
    for (let i = 1; i <= efficient; i++) fill(x + 6 * i, y + 19, x + 6 * i + 4, y + 23, WORKING);
    for (let i = efficient; i < 20; i++) fill(x + 6 * i, y + 19, x + 6 * i + 4, y + 23, DAMAGED);
  }
}

const f2 = (n: number): string => n.toFixed(2);
const f3 = (n: number): string => n.toFixed(3);

/** What the info box says of a unit (drawInfo): the name, then four values with their units and the state, as text rows. */
export function unitInfo(def: ShipUnit, unit: SystemsState['units'][number]): { name: string; lines: { value: string; unit: string }[]; state: string; operational: boolean } {
  if (unit.damage) return { name: def.name, lines: [], state: `${(unit.damage / 60.0).toFixed(4)} minutes to repair`, operational: false };
  const lines: { value: string; unit: string }[] = [];
  if (def.type === UNIT_TORPEDO) {
    lines.push({ value: String(unit.max), unit: 'torps' }, { value: String(unit.current), unit: 'loaded' });
    lines.push({ value: f3(unit.max * seconds(def.chargeTicks)), unit: 'sec' }, { value: '2.35', unit: 'sec' });
  } else {
    let current = unit.current;
    if ((def.type === UNIT_FUSION || def.type === UNIT_MATTER_ANTIMATTER) && unit.max) {
      // the reactors show their output
      let rate = unit.current / unit.max;
      if (rate >= 0.95) rate = (rate - 0.95) * (def.type === UNIT_FUSION ? 16 : 8) + 1;
      current = unit.efficiency / 100.0 * rate * (def.type === UNIT_FUSION ? 25 : 100);
    }
    lines.push({ value: f2(unit.max / POWER_UNITS_PER_MW), unit: 'MW' }, { value: f2(current / POWER_UNITS_PER_MW), unit: 'MW' });
    lines.push({ value: f3(unit.max * seconds(def.chargeTicks)), unit: 'sec' }, { value: f3(unit.max * seconds(def.dischargeTicks)), unit: 'sec' });
  }
  return { name: def.name, lines, state: '100% OPERATIONAL', operational: true };
}

function drawInfo(screen: IndexedScreen, art: EngineeringArt, ship: EngineeringShip, unitIndex: number): void {
  const rows = [397, 413, 425, 437, 450, 467];
  const info = art.fonts[INFO_FONT]!;
  rows.forEach((row, i) => screen.fill(100, row, 230, row + 9, i === 0 ? DARK_BLUE : i === rows.length - 1 ? DARK_RED : BLACK));
  if (unitIndex === -1) return;
  const def = ship.units[unitIndex], unit = ship.systems.units[unitIndex];
  if (!def || !unit) return;
  const said = unitInfo(def, unit);
  screen.drawString(info, 100, rows[0]!, said.name, LIGHT_BLUE);
  if (!said.operational) {
    screen.drawString(info, 100, rows[5]!, said.state, WHITE);
    return;
  }
  said.lines.forEach((line, i) => {
    screen.drawString(info, 100, rows[i + 1]!, line.value, LIGHT_BLUE);
    screen.drawString(info, 134, rows[i + 1]!, line.unit, LIGHT_BLUE);
  });
  screen.drawString(info, 100, rows[5]!, said.state, RED);
}

/** The three Total Power figures: what the systems still want, what the pool has beyond it, and what they use (drawTotalPower). */
export function totalPower(ship: EngineeringShip): { demand: number; spare: number; usage: number } {
  let demand = 0, usage = 0;
  ship.units.forEach((def, i) => {
    const unit = ship.systems.units[i]!;
    if (def.type === UNIT_FUSION || def.type === UNIT_MATTER_ANTIMATTER || def.type === UNIT_POWER_GRID) return;
    usage += unit.current;
    if (def.type !== UNIT_TORPEDO) demand += unit.target - unit.current;
  });
  return { demand, spare: ship.systems.pool - demand, usage };
}

function drawTotalPower(screen: IndexedScreen, art: EngineeringArt, ship: EngineeringShip): void {
  const { demand, spare, usage } = totalPower(ship);
  const info = art.fonts[INFO_FONT]!;
  screen.fill(148, 238, 238, 356, BLACK);
  const bars = [
    { value: demand, colour: BLUE, left: 157, right: 177, textX: 160, height: Math.trunc((Math.min(demand, MAX_POOL) * 100 + MAX_POOL / 2) / MAX_POOL) },
    { value: spare, colour: DAMAGED, left: 180, right: 207, textX: 184, height: Math.trunc((spare * 100 + MAX_POOL / 2) / MAX_POOL) },
    { value: usage, colour: WORKING, left: 210, right: 230, textX: 210, height: Math.trunc((usage * 100 + MAX_USAGE / 2) / MAX_USAGE) },
  ];
  if (bars[1]!.height > 97) bars[1]!.height = 100;
  bars.forEach((bar, i) => {
    const height = Math.min(Math.max(bar.height, 0), 100);
    for (let j = 1; j < height; j += 2) screen.fill(bar.left, 355 - j, bar.right, 355 - j, bar.colour);
    const text = bar.value < 0 ? '---' : i === 1 && bar.value >= MAX_POOL ? `${1799}+` : String(Math.trunc(bar.value / POWER_UNITS_PER_MW + 0.5));
    screen.drawString(info, bar.textX, bar.value > 0 ? 345 - height : 345, text, WHITE);
  });
}

/** EngineeringScreen::draw: the panel is drawn afresh over what is there; nothing outside it is touched. */
export function drawEngineering(screen: IndexedScreen, art: EngineeringArt, ui: EngineeringUi, ship: EngineeringShip, torpedoes: number = ship.systems.torpedoes): void {
  const image = (entry: number): IndexedImage => art.images[mrg(entry)]!;
  const page = PAGES[ui.page]!;
  screen.fill(254, 27, 635, 357, BLACK);
  screen.fill(245, 20, 248, 196, BLACK);

  screen.blit(image(ui.pressed === 0 ? IMAGE_BRIDGE_DOWN : IMAGE_BRIDGE), 490, 390);
  screen.blit(image(ui.pressed === 1 ? IMAGE_TACTICAL_DOWN : IMAGE_TACTICAL), 490, 424);
  if (ui.pressed === 2) {
    screen.blit(image(IMAGE_DELEGATE_DOWN), 358, 389);
    screen.blit(image(ui.delegate ? IMAGE_LAMP_OFF : IMAGE_LAMP_ON), 367, 424);
  } else {
    screen.blit(image(IMAGE_DELEGATE_UP), 358, 389);
    screen.blit(image(ui.delegate ? IMAGE_LAMP_ON : IMAGE_LAMP_OFF), 368, 423);
  }

  for (let p = 0; p < NUM_PAGES; p++) {
    const r = tabRect(p);
    screen.blit(image((p === ui.page ? IMAGE_CURRENT_TABS : IMAGE_TABS) + 4 - p), r[0], r[1]);
  }

  const label = art.fonts[LABEL_FONT]!;
  for (let i = page.firstLabel; i <= page.lastLabel; i++) {
    const l = art.tables.labels[i];
    if (l) screen.drawString(label, l.rect[0] + 1, l.rect[1] + 2, l.text);
  }
  for (let slider = page.firstSlider; slider <= page.lastSlider; slider++) drawSlider(screen, art, slider, ship);
  for (let i = page.firstRow; i <= page.lastRow; i++) {
    const row = art.tables.rows[i];
    if (!row) continue;
    const [left, top, right, bottom] = row;
    screen.fill(left, top, left, bottom, GREY);
    screen.fill(right, top, right, bottom, GREY);
    screen.fill(left, top, right, top, GREY);
    screen.fill(left, bottom, right, bottom, GREY);
  }

  screen.blit(image(page.schematics[0]), 15, 34);
  screen.blit(image(page.schematics[1]), 15, 195);
  screen.blit(image(IMAGE_INFO), 5, 393);
  if (ui.page === 0) {
    screen.blit(image(IMAGE_FUSION_ART), 448, 241);
    screen.blit(image(IMAGE_MATTER_ANTIMATTER_ART), 259, 241);
  }

  // the torpedoes left, next to "Total"
  if (ui.page === 1) {
    screen.fill(350, 336, 420, 350, BLACK);
    screen.drawString(label, 350, 336, String(torpedoes));
  }

  drawTotalPower(screen, art, ship);
  drawInfo(screen, art, ship, ui.hover === -1 ? -1 : unitFor(art.tables, ui.hover));
}

/** A slider's pointer position as the distance along it, from a point in the screen's pixels (setSlider's `x - s.x`). */
export function sliderOffset(tables: Pick<EngineeringTables, 'sliders'>, slider: number, x: number): number {
  return Math.min(Math.max(x - (tables.sliders[slider]?.x ?? 0), 0), SLIDER_WIDTH);
}
