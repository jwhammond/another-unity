// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The away team's panel as the original lays it out (awayteam.cpp:44-69): its rectangles in the 640 by 480 screen's pixels, the panel
 * itself the 640 by 80 strip at y 400. The HUD draws the published panel (art.panel) in that box, scaled with the game's frame, and puts
 * its controls over these rectangles.
 */
import type { VerbMode } from './store';

/** [left, top, right, bottom), screen pixels, as awayteam.cpp's PanelRect. */
export type PanelRect = readonly [number, number, number, number];

export const PANEL: PanelRect = [0, 400, 640, 480];
export const ADMIN: PanelRect = [0, 421, 46, 480];
export const PORTRAIT: PanelRect = [50, 426, 99, 478];
export const COMMUNICATOR: PanelRect = [191, 427, 232, 475];
export const LEFT_ARROW: PanelRect = [413, 427, 438, 476];
export const RIGHT_ARROW: PanelRect = [438, 427, 463, 476];
export const PHASER_GAUGE: PanelRect = [410, 401, 640, 421];
export const STATUS: PanelRect = [0, 402, 410, 419];
/** The health bar beside the portrait: 25 bands of 2 rows (drawHealthBar, awayteam.cpp:838-863). */
export const HEALTH: PanelRect = [100, 426, 105, 476];
export const SLOT_X = [242, 296, 350, 474, 528, 582] as const;
export const SLOT_Y = 427;
export const SLOT_W = 52;
export const SLOT_H = 48;
export const SLOTS = SLOT_X.length;
/** The whole strip, slot to slot (arrows and all): an object dropped on it is picked up (awayteam.cpp:662-666). */
export const INVENTORY_STRIP: PanelRect = [SLOT_X[0], SLOT_Y, SLOT_X[SLOTS - 1] + SLOT_W, SLOT_Y + SLOT_H];
export const slotRect = (i: number): PanelRect => [SLOT_X[i]!, SLOT_Y, SLOT_X[i]! + SLOT_W, SLOT_Y + SLOT_H];

/** The verb buttons, in the original's order (kModeButtons): each sprite's selected picture is `<verb>_on`. */
export const VERB_RECTS: readonly { mode: VerbMode; rect: PanelRect }[] = [
  { mode: 'look', rect: [108, 424, 148, 451] },
  { mode: 'use', rect: [148, 424, 189, 451] },
  { mode: 'talk', rect: [108, 451, 148, 477] },
  { mode: 'walk', rect: [148, 451, 189, 477] },
];

/** The setting under a gauge position, as the status line says it while the pointer is over the gauge. */
export const PHASER_LABELS: readonly string[] = ['Phaser off', 'Low phaser setting', 'Medium phaser setting', 'High phaser setting'];

/**
 * The gauge's coloured squares are the positions 1 to 15 (position 0 is the black box the marker starts in): the squares up to the
 * marker are lit, those beyond it dimmed. A square's cell is the position's 14 pixels, less its bevel.
 */
export const PHASER_SQUARES = 15;
export function phaserSquareRect(position: number): PanelRect {
  const x = 414 + 14 * position;
  return [x + 2, 407, x + 12, 419];
}

/** The phaser marker's frames, their size, and how long each shows: 50 ticks of 291 a second (awayteam.cpp:908-917). */
export const MARKER_W = 16;
export const MARKER_H = 20;
export const MARKER_FRAME_MS = (50 * 1000) / 291;
/** Where the grey cover goes when the team has no phaser (kSpriteNoPhaser at 411, 401; 229 by 24). */
export const NO_PHASER: PanelRect = [411, 401, 640, 425];

/** A rectangle as CSS percentages of the panel's box (the 640 by 80 strip), for an absolutely placed element. */
export function panelBox([l, t, r, b]: PanelRect): { left: string; top: string; width: string; height: string } {
  const [pl, pt, pr, pb] = PANEL;
  const pct = (v: number) => `${+(v * 100).toFixed(4)}%`;
  return { left: pct((l - pl) / (pr - pl)), top: pct((t - pt) / (pb - pt)), width: pct((r - l) / (pr - pl)), height: pct((b - t) / (pb - pt)) };
}

/** The gauge's 16 positions, every 4 a setting (off, low, medium, high): the position under screen x (setPhaserFromGauge, awayteam.cpp:785-795). */
export function phaserIndexAt(x: number): number {
  return Math.min(Math.floor(Math.max(x - 414, 0) / 14), 15);
}
export const phaserSettingOf = (index: number): number => Math.floor(index / 4);

/** The marker's position for the setting: the one last pointed at while it is that setting's, else the setting's first. */
export function phaserIndexFor(setting: number, last: number | null): number {
  return last !== null && phaserSettingOf(last) === setting ? last : setting * 4;
}

/** The marker's rectangle at a gauge position: centred on x 420 + 14 * index, y 413. */
export function markerRect(index: number): PanelRect {
  const x = 420 + 14 * index - MARKER_W / 2;
  const y = 413 - MARKER_H / 2;
  return [x, y, x + MARKER_W, y + MARKER_H];
}

/** The six slots' items from the first shown (`offset`), clamped so a shrinking inventory never leaves an empty page; and which way it scrolls. */
export function inventoryPage<T>(items: readonly T[], offset: number): { offset: number; shown: (T | undefined)[]; left: boolean; right: boolean } {
  const at = Math.max(0, Math.min(offset, items.length - SLOTS));
  return {
    offset: at,
    shown: Array.from({ length: SLOTS }, (_, i) => items[at + i]),
    left: at > 0,
    right: items.length > at + SLOTS,
  };
}

/**
 * The health bar's 25 bands, top first: empty above the health, red at or below the threshold, else green (drawHealthBar). Each band is 4
 * points of 100 here: the reference's `100 - 2 * band` would stop at 52, leaving the bar empty from half health down.
 */
export function healthBands(health: number, max: number, threshold: number): ('empty' | 'healthy' | 'injured')[] {
  const pct = max > 0 ? Math.max(0, Math.floor((health * 100) / max)) : 100;
  const limit = max > 0 ? Math.floor((threshold * 100) / max) : 0;
  return Array.from({ length: 25 }, (_, band) => {
    const level = 100 - 4 * band;
    return level > pct ? 'empty' : level > limit ? 'healthy' : 'injured';
  });
}
