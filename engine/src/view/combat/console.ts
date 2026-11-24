// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData, ConsoleTextName } from '../../content/types';
import { maneuverAt } from '../../sim/combat/maneuvers';
import type { BattleState, CombatShip } from '../../sim/combat/types';
import { type BitmapFont, type IndexedImage, type IndexedScreen } from '../indexed';
import type { ConsoleRepaint } from './spaceArt';

/**
 * The tactical console drawn as TacticalScreen::draw draws it (tactical.cpp:1293-1337), all but the 3D view: the tabs, the
 * page and its pictures, the buttons, the sliders, the lamps and the status fields, the maneuver menu, CONN's Delegate image,
 * power level and self-destruct digits; the radar and the scanners are radar.ts' and scanner.ts'. Onto an indexed screen from
 * the original's own pictures (COMBAT_STILLS.console) and fonts, in the space palette. Pure: the console's canvas puts the
 * screen on the page (ui/combat/console.tsx), the screenshot check's port side does too. Plan 27.
 */

/** A rectangle as Common::Rect keeps one: left and top in, right and bottom out. */
export type Rect = readonly [number, number, number, number];
export const contains = (r: Rect, x: number, y: number): boolean => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** The console's pictures, palette, fonts and words. */
export interface ConsoleArt {
  /** spc00a.pic: the console's background. */
  plate: IndexedImage;
  /** space.mrg's entries, by their number in the file (COMBAT_STILLS.console's entries 1 on). */
  images: readonly IndexedImage[];
  /** The space palette (COMBAT_STILLS.palette), 256 entries of 8-bit RGB. */
  palette: Uint8Array;
  /** The game's fonts by number (font0.fon ...); null draws no text (art.fonts not published). */
  fonts: readonly BitmapFont[] | null;
  /** combat.yaml's consoleText; null draws none of the console's own words (an export before Plan 27). */
  text: Readonly<Record<ConsoleTextName, string>> | null;
  /** With the art on and `art.space.console` published, the repaint the indices let show through (Plan 30 R7); else none. */
  repaint?: ConsoleRepaint | null;
}

/** The pages, by their number in the original (kPagePhasers 0, kPageTorpedoes 1, kPageDamage 2, kPageConn 3, kPageTactics 4, kPageSensors 5). */
export const PAGE = { phasers: 0, torpedoes: 1, damage: 2, conn: 3, tactics: 4, sensors: 5 } as const;
export const NUM_PAGES = 6;
/** The pages' names, the spec's own (§5.1): the tabs are pictures of the original's words. */
export const PAGE_LABELS = ['Phaser banks', 'Torpedoes', 'Own damage', 'Helm', 'Maneuvers', 'Target sensors'] as const;
/** Each page's tab in space.mrg: current, then normal (kTabImages, tactical.cpp:62-64). */
export const TAB_IMAGES: readonly (readonly [number, number])[] = [[73, 72], [79, 78], [71, 70], [69, 68], [77, 76], [75, 74]];
/** tabRect (tactical.cpp:65). */
export const tabRect = (page: number): Rect => [0, 297 + 31 * page, 127, 326 + 31 * page];
/** pageRect (tactical.cpp:67): where the pages go; the background shows the phasers' page. */
export const PAGE_RECT: Rect = [123, 300, 479, 477];

/** The buttons (tactical.cpp:71-89). */
export const BUTTON = {
  bridge: 0, engineering: 1, view: 2, full: 3, phasers: 4, torpedoes: 5, both: 6, zoomIn: 7, zoomOut: 8, shields: 9, weaponsLock: 10,
  selfDestruct: 11, delegate: 12, allPhasers: 13, noPhasers: 14, spread: 15,
} as const;
export const NUM_BUTTONS = BUTTON.spread + 10;
/** kButtons (tactical.cpp:90-121): each button's place, its space.mrg images (up, down), its page (-1 for all) and whether the background shows it up. */
export const BUTTONS: readonly { x: number; y: number; up: number; down: number; page: number; inBackground: boolean }[] = [
  { x: 490, y: 390, up: 41, down: 40, page: -1, inBackground: false },
  { x: 490, y: 424, up: 43, down: 42, page: -1, inBackground: false },
  { x: 327, y: 0, up: 82, down: 81, page: -1, inBackground: false },
  { x: 479, y: 0, up: 84, down: 84, page: -1, inBackground: false },
  { x: 316, y: 248, up: 59, down: 60, page: -1, inBackground: true },
  { x: 519, y: 248, up: 61, down: 62, page: -1, inBackground: true },
  { x: 436, y: 248, up: 39, down: 38, page: -1, inBackground: true },
  { x: 303, y: 21, up: 102, down: 103, page: -1, inBackground: true },
  { x: 303, y: 133, up: 104, down: 105, page: -1, inBackground: true },
  { x: 129, y: 307, up: 7, down: 10, page: PAGE.conn, inBackground: false },
  { x: 129, y: 341, up: 8, down: 11, page: PAGE.conn, inBackground: false },
  { x: 129, y: 375, up: 9, down: 12, page: PAGE.conn, inBackground: false },
  { x: 358, y: 389, up: 17, down: 16, page: PAGE.conn, inBackground: false },
  { x: 276, y: 310, up: 52, down: 53, page: PAGE.phasers, inBackground: true },
  { x: 130, y: 310, up: 54, down: 55, page: PAGE.phasers, inBackground: true },
  { x: 308, y: 339, up: 18, down: 19, page: PAGE.torpedoes, inBackground: false },
  { x: 324, y: 339, up: 36, down: 37, page: PAGE.torpedoes, inBackground: false },
  { x: 340, y: 339, up: 20, down: 21, page: PAGE.torpedoes, inBackground: false },
  { x: 356, y: 339, up: 22, down: 23, page: PAGE.torpedoes, inBackground: false },
  { x: 372, y: 339, up: 24, down: 25, page: PAGE.torpedoes, inBackground: false },
  { x: 388, y: 339, up: 26, down: 27, page: PAGE.torpedoes, inBackground: false },
  { x: 404, y: 339, up: 28, down: 29, page: PAGE.torpedoes, inBackground: false },
  { x: 420, y: 339, up: 30, down: 31, page: PAGE.torpedoes, inBackground: false },
  { x: 436, y: 339, up: 32, down: 33, page: PAGE.torpedoes, inBackground: false },
  { x: 452, y: 339, up: 34, down: 35, page: PAGE.torpedoes, inBackground: false },
];
/** The pictures that stand in for others (tactical.cpp:122-134): FULL becomes SPLIT, and at red alert HAIL replaces BRIDGE. */
export const IMAGE = {
  split: 83, hailUp: 45, hailDown: 44, delegateOff: 15, delegateOn: 14, phaserLamp: 49, tubeLamp: 56, salvo: 97, digit: 115, decimalPoint: 128,
  maneuver: 112, maneuverSelected: 111, headingClosed: 110, headingClosedSelected: 109, headingOpen: 108, headingOpenSelected: 107,
  up: 5, upDown: 3, down: 6, downDown: 4, engage: 65, disengage: 64,
} as const;
/** The pages' other pictures (kPagePictures, tactical.cpp:136-152): the phasers' page is the background's own. */
export const PAGE_PICTURES: readonly { page: number; image: number; x: number; y: number }[] = [
  { page: 0, image: 106, x: 303, y: 308 }, { page: 1, image: 2, x: 304, y: 312 }, { page: 1, image: 0, x: 131, y: 330 }, { page: 1, image: 1, x: 131, y: 389 },
  { page: 2, image: 67, x: 387, y: 305 }, { page: 3, image: 66, x: 277, y: 374 }, { page: 3, image: 80, x: 277, y: 315 }, { page: 3, image: 13, x: 129, y: 405 },
  { page: 4, image: 125, x: 360, y: 310 }, { page: 5, image: 67, x: 387, y: 305 },
];
/** The phaser banks' sliders, the tubes' salvos and CONN's power levels (tactical.cpp:155-163). */
export const PHASER_SLIDER_X = 153;
export const phaserSliderY = (bank: number): number => 311 + 27 * bank;
export const SALVO_X = 136;
export const SALVO_Y = [352, 411] as const;
export const SLIDER_WIDTH = 113;
const POWER_CELLS = [[286, 320], [319, 357], [356, 394], [393, 431], [430, 464]] as const;
export const powerCell = (level: number): Rect => [POWER_CELLS[level]![0], 339, POWER_CELLS[level]![1] + 1, 367];
/** The space palette's colours the console draws in (tactical.cpp:165-179). */
export const COLOUR = { black: 0, dim: 0x82, grey: 0x84, darkBlue: 0xa9, lightBlue: 0xad, brightBlue: 0xae, paleBlue: 0xaf } as const;
/** kStatusFont and kManeuverFont (tactical.cpp:180, 199). */
export const STATUS_FONT = 0;
export const MANEUVER_FONT = 2;
/** The TACTICS page's rows, arrows and Engage (tactical.cpp:183-203). */
export const MANEUVER_ROWS = 7;
export const maneuverRow = (row: number): Rect => [129, 310 + 22 * row, 361, 333 + 22 * row];
export const UP_ARROW: Rect = [387, 318, 436, 342];
export const DOWN_ARROW: Rect = [387, 341, 436, 365];
export const ENGAGE_BUTTON: Rect = [370, 437, 471, 466];
/** The three status fields' rows (drawStatus, tactical.cpp:1049-1050) and the phaser charges' (drawSliders' kTextY, :999). */
const STATUS_X = 542, PHASER_TEXT_Y = [310, 334, 362, 390, 417, 443] as const;

/** What the console's own state is, beside the battle's: TacticalScreen's _page, _pressedButton, _buttonTime and _pressedArrow, and the wall clock now. */
export interface ConsoleUi {
  page: number;
  /** The button down, or -1 (_pressedButton). */
  pressed: number;
  /** When the button down acts and comes up, wall ms (_buttonTime); the arrows show pressed until then. */
  buttonTime: number;
  /** The arrow last pressed, 0 up and 1 down, or -1 (_pressedArrow). */
  arrow: number;
  /** g_system->getMillis() now: the wall clock, ms. */
  wall: number;
}

/**
 * The C printf subset the console formats with (tactical.cpp:1000-1052, 1218-1241, 1329): `%d`, `%3d`, `%-2d`, `%4.2f`, `%.2f`,
 * `%1.2f`, `%3.2f`, `%03.05f`, `%02.05f` and `%%`. An int conversion truncates, as the ints ScummVM passes already are.
 */
export function cFormat(format: string, ...args: number[]): string {
  let next = 0;
  return format.replace(/%(-)?(0)?(\d+)?(?:\.(\d+))?([df%])/g, (_all, left: string | undefined, zero: string | undefined, width: string | undefined, precision: string | undefined, kind: string) => {
    if (kind === '%') return '%';
    const v = args[next++] ?? 0;
    let s = kind === 'd' ? String(Math.trunc(v)) : v.toFixed(precision === undefined ? 6 : Number(precision));
    const w = width === undefined ? 0 : Number(width);
    if (s.length < w) {
      if (left) s = s.padEnd(w, ' ');
      else if (zero) s = s.startsWith('-') ? `-${s.slice(1).padStart(w - 1, '0')}` : s.padStart(w, '0');
      else s = s.padStart(w, ' ');
    }
    return s;
  });
}

/** Graphics::drawString in a font of the console's (a missing font draws nothing). */
function drawString(screen: IndexedScreen, art: ConsoleArt, x: number, y: number, text: string, font: number, colour = 0): void {
  const f = art.fonts?.[font];
  if (f) screen.drawString(f, x, y, text, colour);
}

/** drawMRG: one of space.mrg's pictures at (x, y), skipping colour 13 (a missing entry draws nothing). */
export function drawImage(screen: IndexedScreen, art: ConsoleArt, image: number, x: number, y: number): void {
  const im = art.images[image];
  // (the port's own: a picture the set lacks, from an older or partial export, is skipped rather than thrown on)
  if (im) screen.blit(im, x, y);
}

/** drawField (tactical.cpp:1031-1034): the field filled, then the text in the status font, light blue. */
export function drawField(screen: IndexedScreen, art: ConsoleArt, rect: Rect, text: string, fill: number): void {
  screen.fillRect(fill, rect[0] + 1, rect[1] + 1, rect[2] + 1, rect[3] + 1);
  drawString(screen, art, rect[0] + 1, rect[1] + 2, text, STATUS_FONT, COLOUR.lightBlue);
}

/** The console's word `name`, or nothing (an export before Plan 27). */
export const word = (art: ConsoleArt, name: ConsoleTextName): string => art.text?.[name] ?? '';

/** drawButton (tactical.cpp:951-978): down while pressed, a toggle while it's on; the background shows some up; HAIL at red alert, SPLIT when wide. */
export function drawButton(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>, ui: ConsoleUi, button: number): void {
  const def = BUTTONS[button]!;
  const c = b.console;
  let down = ui.pressed === button;
  if (button === BUTTON.shields) down = down || c.shieldsRaised;
  else if (button === BUTTON.weaponsLock) down = down || c.weaponsLock;
  else if (button === BUTTON.selfDestruct) down = down || c.selfDestructTime !== 0;
  else if (button >= BUTTON.spread && button < BUTTON.spread + 10) down = down || c.spreadDegrees === (button - BUTTON.spread) * 5;
  if (!down && def.inBackground) return;
  let image = down ? def.down : def.up;
  if (button === BUTTON.bridge && c.redAlert) image = down ? IMAGE.hailDown : IMAGE.hailUp;
  else if (button === BUTTON.full && b.view.wide) image = IMAGE.split;
  drawImage(screen, art, image, def.x, def.y);
}

/** Whether a button is on the console now (draw's and buttonAt's filter, tactical.cpp:587-591, 1303-1307): its page's, and not zoom while wide. */
export function buttonShown(button: number, page: number, wide: boolean): boolean {
  const p = BUTTONS[button]!.page;
  if (p !== -1 && p !== page) return false;
  return !(wide && (button === BUTTON.zoomIn || button === BUTTON.zoomOut));
}

/** A unit's power as the bars and fields read it: current over max, in hundredths; none without a max. */
const percent = (current: number, max: number): number => (max ? Math.trunc((current * 100) / max) : 0);

/** drawSliders (tactical.cpp:984-1022): the phaser banks' settings and charges, or the tubes' salvos and the spread. */
export function drawSliders(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>, page: number): void {
  const e = b.ships[0];
  if (!e) return;
  if (page === PAGE.phasers) {
    e.banks.slice(0, 6).forEach((bank, i) => {
      const unit = e.systems.units[bank.unit];
      // (the port's own: a bank whose unit is missing reads 0, where the original reads its unit unchecked)
      const charge = bank.active ? bank.charge : unit ? percent(unit.current, unit.max) : 0;
      const x = PHASER_SLIDER_X, y = phaserSliderY(i);
      screen.fill(x, y, x + 0x79, y + 0x13, COLOUR.black);
      for (let j = 0; j < Math.trunc(bank.setting / 5); j++) screen.fill(x + 6 * j, y, x + 6 * j + 6, y + 0x11, COLOUR.paleBlue);
      for (let j = 0; j < 20; j++) screen.fill(x + 6 * j + 1, y + 1, x + 6 * j + 5, y + 0x10, j < Math.trunc(charge / 5) ? COLOUR.lightBlue : COLOUR.grey);
      drawField(screen, art, [391, PHASER_TEXT_Y[i]!, 463, PHASER_TEXT_Y[i]! + 10], cFormat('%3d %%', charge), COLOUR.darkBlue);
    });
  } else if (page === PAGE.torpedoes) {
    for (const tube of [0, 1] as const) {
      const salvo = b.console.salvo[tube];
      const x = SALVO_X, y = SALVO_Y[tube];
      drawImage(screen, art, IMAGE.salvo, x, y);
      for (let j = Math.min(10, Math.max(0, salvo.loaded)); j < 10; j++) screen.fill(x + 12 * j + 2, y + 2, x + 12 * j + 10, y + 0x14, COLOUR.dim);
      for (let j = 0; j < Math.min(10, Math.max(0, salvo.setting)); j++) {
        screen.fill(x + 12 * j, y + 1, x + 12 * j, y + 0x16, COLOUR.paleBlue);
        screen.fill(x + 12 * (j + 1), y + 1, x + 12 * (j + 1), y + 0x16, COLOUR.paleBlue);
        screen.fill(x + 12 * j, y + 1, x + 12 * (j + 1), y + 1, COLOUR.paleBlue);
        screen.fill(x + 12 * j, y + 0x16, x + 12 * (j + 1), y + 0x16, COLOUR.paleBlue);
      }
      drawString(screen, art, 268, SALVO_Y[tube] + 4, cFormat('%d', salvo.setting), STATUS_FONT, COLOUR.lightBlue);
    }
    drawField(screen, art, [379, 396, 396, 416], cFormat('%-2d', b.console.spreadDegrees), COLOUR.darkBlue);
  }
}

/** drawLamps (tactical.cpp:1024-1029): the six banks' lamps and the two tubes', each of three pictures by updateLamps' state. */
export function drawLamps(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>): void {
  // (the port's own: a lamp the state lacks is drawn as not bearing, 2; updateLamps always sets all eight)
  for (let i = 0; i < 6; i++) drawImage(screen, art, IMAGE.phaserLamp + (b.console.lamps[i] ?? 2), 316 + 20 * i, 280);
  for (let i = 0; i < 2; i++) drawImage(screen, art, IMAGE.tubeLamp + (b.console.lamps[6 + i] ?? 2), 519 + 60 * i, 280);
}

/**
 * drawStatus (tactical.cpp:1036-1053): the Enterprise's shield towards the target (its name, combat.yaml's shieldNames), that
 * shield's power, its pitch and heading in degrees, and its speed; then the power's and speed's units.
 */
export function drawStatus(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>, combat: CombatData): void {
  const e = b.ships[0];
  if (!e) return;
  const f = b.console.targetFacing & 7;
  const shield = e.systems.units[f];
  const texts = [
    combat.shieldNames[f] ?? '',
    cFormat('%4.2f', (shield?.current ?? 0) / 1.334),
    cFormat('%d', Math.trunc((e.angles[1] * 360) / 16384)),
    cFormat('%d', Math.trunc((e.angles[0] * 360) / 16384)),
    cFormat('%.2f', e.speed / 1000),
  ];
  texts.forEach((text, i) => drawField(screen, art, [STATUS_X, 307 + 11 * i, 602, 316 + 11 * i], text, COLOUR.darkBlue));
  drawString(screen, art, 574, 320, word(art, 'megawatts'), STATUS_FONT, COLOUR.lightBlue);
  drawString(screen, art, 563, 353, word(art, 'lightspeed'), STATUS_FONT, COLOUR.lightBlue);
}

/**
 * drawManeuvers (tactical.cpp:1258-1280): the seven rows, each its picture (a heading's open or closed, the selected's own)
 * and label in the maneuver font; the arrows, pressed while the button time runs; Engage, or Disengage while engaged by it.
 */
export function drawManeuvers(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>, ui: ConsoleUi): void {
  for (let i = 0; i < MANEUVER_ROWS; i++) {
    const item = maneuverAt(b as BattleState, i);
    const selected = b.console.menuSelected === i;
    let image: number = selected ? IMAGE.maneuverSelected : IMAGE.maneuver;
    let textX = 168;
    if (item?.heading) {
      image = item.open ? (selected ? IMAGE.headingOpenSelected : IMAGE.headingOpen) : (selected ? IMAGE.headingClosedSelected : IMAGE.headingClosed);
      textX = 153;
    }
    const r = maneuverRow(i);
    screen.fillRect(0, r[0] + 1, r[1] + 1, r[2], r[3]);
    drawImage(screen, art, image, r[0], r[1]);
    if (item) drawString(screen, art, textX, 315 + 22 * i, item.label, MANEUVER_FONT);
  }
  const pressed = ui.buttonTime > ui.wall;
  drawImage(screen, art, pressed && ui.arrow === 0 ? IMAGE.upDown : IMAGE.up, UP_ARROW[0], UP_ARROW[1]);
  drawImage(screen, art, pressed && ui.arrow === 1 ? IMAGE.downDown : IMAGE.down, DOWN_ARROW[0], DOWN_ARROW[1]);
  drawImage(screen, art, b.console.engageButton ? IMAGE.disengage : IMAGE.engage, ENGAGE_BUTTON[0], ENGAGE_BUTTON[1]);
}

/** The six tabs (tactical.cpp:1298-1301): the page's own current, the rest normal. */
export function drawTabs(screen: IndexedScreen, art: ConsoleArt, page: number): void {
  for (let p = 0; p < NUM_PAGES; p++) drawImage(screen, art, TAB_IMAGES[p]![p === page ? 0 : 1], tabRect(p)[0], tabRect(p)[1]);
}

/** drawPage (tactical.cpp:1282-1291): any page but the phasers' blanks the page's place, then draws its pictures. */
export function drawPage(screen: IndexedScreen, art: ConsoleArt, page: number): void {
  if (page !== PAGE.phasers) screen.fillRect(0, PAGE_RECT[0], PAGE_RECT[1], PAGE_RECT[2], PAGE_RECT[3]);
  for (const p of PAGE_PICTURES) if (p.page === page && p.page !== PAGE.phasers) drawImage(screen, art, p.image, p.x, p.y);
}

/**
 * The self-destruct countdown's digits (tactical.cpp:1326-1335): the seconds left, `%03.05f` from 10 and `0%02.05f` under,
 * its first eight characters each a digit's picture or the decimal point's. `now` is the clock the time was set on: the battle's
 * (Plan 27 R7), where the original reads the wall clock, g_system->getMillis (:1327), against a time set on the battle's
 * (`_now`, weapons.cpp:700).
 */
export function selfDestructText(selfDestructTime: number, now: number): string {
  const left = selfDestructTime > now ? Math.fround((selfDestructTime - now) / 1000) : 0;
  return cFormat(left >= 10 ? '%03.05f' : '0%02.05f', left).slice(0, 8);
}

/** CONN's own (tactical.cpp:1320-1336): the Delegate image, the power level's cell marked top and bottom, and the countdown while armed. */
export function drawConn(screen: IndexedScreen, art: ConsoleArt, b: Readonly<BattleState>): void {
  const c = b.console;
  drawImage(screen, art, c.delegate ? IMAGE.delegateOn : IMAGE.delegateOff, 368, 423);
  const cell = powerCell(Math.min(4, Math.max(0, c.powerLevel)));
  screen.line(cell[0], cell[1], cell[2] - 1, cell[1], COLOUR.brightBlue);
  screen.line(cell[0], cell[3] - 1, cell[2] - 1, cell[3] - 1, COLOUR.brightBlue);
  if (!c.selfDestructTime) return;
  [...selfDestructText(c.selfDestructTime, b.now)].forEach((ch, i) => {
    drawImage(screen, art, ch >= '0' && ch <= '9' ? IMAGE.digit + (ch.charCodeAt(0) - 48) : IMAGE.decimalPoint, 150 + 14 * i, 439);
  });
}

/** The ship a scanner page shows, and the other (drawScanner, tactical.cpp:1162-1165): the Enterprise on its damage page, the target on the sensors'. */
export function scannerShips(b: Readonly<BattleState>, page: number): { subject: CombatShip | null; other: CombatShip | null } {
  const e = b.ships[0] ?? null;
  const t = b.target === null ? null : b.ships[b.target] ?? null;
  return page === PAGE.damage ? { subject: e, other: t } : { subject: t, other: e };
}
