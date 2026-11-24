// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData, ShipUnit } from '../../content/types';
import { dot, facing } from '../../sim/combat/aim';
import { alive, distance } from '../../sim/combat/battle';
import { fr, length, sub } from '../../sim/combat/math';
import { isEnterprise, KIND, type BattleState, type CombatShip } from '../../sim/combat/types';
import type { IndexedScreen } from '../indexed';
import { cFormat, COLOUR, drawField, drawImage, PAGE, scannerShips, STATUS_FONT, word, type ConsoleArt } from './console';

/**
 * The scanners (TacticalScreen::drawScanner, tactical.cpp:1161-1256): the damage page's on the Enterprise, the sensors' on the
 * target. The ship's picture with its 11 areas (palette entries 245-255) red by their worst damage and green by their lowest
 * power, its class, on the sensors page its shield facing the Enterprise, its range, heading and closure, and its log's three
 * lines. Pure: the console's frame sets the palette entries it returns and scrolls the log (scrollLog) after.
 */

/** kScannerPalette (tactical.cpp:227): the 11 areas' colours are entries 245 to 255. */
export const SCANNER_PALETTE = 245;
export const SCANNER_AREAS = 11;
/** The picture of the Enterprise on the scanner, whatever kScannerImages says of its kind (tactical.cpp:1198). */
const ENTERPRISE_IMAGE = 95;
/** drawScanner's kShields (tactical.cpp:1212): the shield a ship but the Enterprise turns to each of the eight facings. */
export const FACING_SHIELDS = [0, 1, 2, 2, 3, 3, 4, 5] as const;

/** What the scanner reads of a battle: it, combat.yaml, and the Enterprise's unit definitions (ship.yaml's), whose names and damage limits the systems' states lack. */
export interface ScannerSource { b: Readonly<BattleState>; combat: CombatData; enterpriseUnits: readonly ShipUnit[] }

/** A ship's unit definitions: the Enterprise's are ship.yaml's, the others combat.yaml's enemy template (the sim's unitDefs). */
const defsOf = (s: ScannerSource, ship: CombatShip): readonly ShipUnit[] => (isEnterprise(ship) ? s.enterpriseUnits : s.combat.enemyUnits);

/**
 * The 11 areas' colours (tactical.cpp:1171-1192), 33 bytes for entries 245-255: each area's power, the least current over max of
 * its units, makes it green, and its damage, the most damage over the most it can take, red, each in 32 steps on half to full
 * brightness, 0 at none. All black when the scanner is blank, and on the sensors page while the sensors are damaged.
 */
export function scannerColours(s: ScannerSource, page: number): Uint8Array {
  const colours = new Uint8Array(SCANNER_AREAS * 3);
  const { subject } = scannerShips(s.b, page);
  const c = s.b.console;
  if (scannerBlank(s.b, page) || !subject || (page === PAGE.sensors && c.sensorsDamaged)) return colours;
  const areas = isEnterprise(subject) ? s.combat.scanner.enterprise : s.combat.scanner.other;
  const units = subject.systems.units;
  const defs = defsOf(s, subject);
  for (let k = 0; k < SCANNER_AREAS; k++) {
    let power = 1, damage = 0;
    for (const i of areas[k] ?? []) {
      const u = units[i];
      if (!u) continue;
      power = Math.min(power, u.max ? fr(u.current / u.max) : 0);
      const most = defs[i]?.maxDamage ?? 0;
      damage = Math.max(damage, most ? fr(u.damage / most) : 0);
    }
    const r = Math.trunc(fr(Math.min(1, Math.max(0, damage)) * 31)), g = Math.trunc(fr(Math.min(1, Math.max(0, power)) * 31));
    colours[k * 3] = r ? Math.trunc(((r + 31) * 255) / 63) : 0;
    colours[k * 3 + 1] = g ? Math.trunc(((g + 31) * 255) / 63) : 0;
  }
  return colours;
}

/** Nothing to scan (tactical.cpp:1166-1167): no subject, a dead or cloaked one, or on the sensors page sensors that read nothing. */
export function scannerBlank(b: Readonly<BattleState>, page: number): boolean {
  const { subject } = scannerShips(b, page);
  return !subject || !alive(subject) || subject.decloakTime !== 0 || (page === PAGE.sensors && b.console.sensorsBlank);
}

/**
 * drawScanner's drawing (tactical.cpp:1195-1249), the colours apart: nothing when blank. The picture centred in its box, the
 * class (an unknown chodak or probe on the sensors page is the console's `alien` word, :1206-1208), the shield facing us and its
 * power (sensors), the range, heading and closure to the other ship, and the log's lines up to the one read. Returns the ship
 * whose log it showed, for scrollLog, or null.
 */
export function drawScanner(screen: IndexedScreen, art: ConsoleArt, s: ScannerSource, page: number): CombatShip | null {
  if (scannerBlank(s.b, page)) return null;
  const { subject, other } = scannerShips(s.b, page);
  if (!subject) return null;
  const font = art.fonts?.[STATUS_FONT];
  const text = (x: number, y: number, t: string) => { if (font) screen.drawString(font, x, y, t, COLOUR.lightBlue); };
  // (the port's own fallbacks: a kind combat.yaml lacks shows the Enterprise's picture and no class, where kScannerImages and
  // kClassNames cover every kind)
  const image = isEnterprise(subject) ? ENTERPRISE_IMAGE : s.combat.kinds[subject.type]?.scannerImage ?? ENTERPRISE_IMAGE;
  const im = art.images[image];
  if (im) drawImage(screen, art, image, 144 + Math.trunc((183 - im.width) / 2), 309 + Math.trunc((135 - im.height) / 2));
  let name = s.combat.kinds[subject.type]?.className ?? '';
  if (page === PAGE.sensors && !s.b.contactCues && (subject.type === KIND.chodak || subject.type === KIND.probe)) name = word(art, 'alien');
  drawField(screen, art, [130, 420, 383, 440], name, COLOUR.black);
  if (page === PAGE.sensors && other) {
    const shield = FACING_SHIELDS[facing(subject, other.pos)]!;
    const units = subject.systems.units;
    screen.fill(258, 422, 380, 430, COLOUR.black);
    if (shield < units.length) {
      text(234, 422, defsOf(s, subject)[shield]?.name ?? '');
      text(320, 422, cFormat(word(art, 'power'), units[shield]!.current / 1.334));
    }
  }
  if (other) {
    const d = distance(subject, other);
    drawField(screen, art, [401, 337, 466, 347], cFormat('%d', fr(d * 27)), COLOUR.darkBlue);
    text(445, 339, word(art, 'kilometres'));
    drawField(screen, art, [401, 393, 466, 407], cFormat('%3d', Math.trunc((subject.angles[0] * 360) / 16384)), COLOUR.darkBlue);
    text(421, 395, word(art, 'mark'));
    text(440, 395, cFormat('%3d', Math.trunc((subject.angles[1] * 360) / 16384)));
    let closure = length(sub(other.velocity, subject.velocity));
    if (dot(other.velocity, subject.velocity) > 0) closure = -closure;
    drawField(screen, art, [393, 449, 466, 465], cFormat('%1.2f', fr(closure / 1000)), COLOUR.darkBlue);
    text(416, 451, word(art, 'lightspeed'));
    text(431, 451, word(art, 'colon'));
    text(440, 451, cFormat('%.2f', fr(subject.speed / 1000)));
    text(459, 451, word(art, 'lightspeed'));
  }
  // and the ship's messages: up to three, the one read lowest
  screen.fill(130, 440, 383, 474, COLOUR.black);
  const log = subject.log;
  for (let i = 0; i < 3 && i <= subject.logRead && subject.logRead < log.length; i++) text(130, 464 - 12 * i, log[subject.logRead - i]!);
  return subject;
}
