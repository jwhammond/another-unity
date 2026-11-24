// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rect } from './art';

/**
 * The transporter room's map and its lock-on (TransporterScreen::showMap and updateLock, transporter.cpp:243-300), as the original runs it: the map
 * of the world the team will beam to, a line crossing it row by row until it reaches the target's row, a second line crossing from the left to the
 * target's column, then the blip where they meet. Nothing here draws: it is the state and the rectangles (the original's 640x480 pixels).
 */

/** kMapX, kMapY, kMapLeft, kMapTop (transporter.cpp:56-59): the map's anchor (the bottom of its centre) and the scan's first column and row. */
export const MAP_X = 234;
export const MAP_Y = 414;
export const MAP_LEFT = 51;
export const MAP_TOP = 297;
/** Where the map's picture lies (tmaps.spr is 368x120, drawn from the bottom of its centre at (234, 414)): over the lists. */
export const MAP_RECT: Rect = [50, 294, 368, 120];
/** The scan's sprites' sizes: beamhori.spr, beamvert.spr and a frame of tranblip.spr. */
export const ACROSS_SIZE = [366, 2] as const;
export const DOWN_SIZE = [2, 118] as const;
export const BLIP_SIZE = [38, 38] as const;
/** A step of the scan every 0x14 ticks of the original's 291 a second. */
export const LOCK_STEP_MS = (0x14 * 1000) / 291;
/** The row moves two pixels a step, the column three. */
const ROW_STEP = 2;
const COLUMN_STEP = 3;

export interface MapLock {
  /** 0 the row line is crossing, 1 the column line is, 2 locked on (or, with no target, never). */
  stage: 0 | 1 | 2;
  /** `_lockX` and `_lockY`: the column and row the lines are at. */
  x: number;
  y: number;
  /** Milliseconds since the last step. */
  carry: number;
}

/** showMap: the scan starts at the map's first row and column. */
export function startLock(): MapLock {
  return { stage: 0, x: MAP_LEFT, y: MAP_TOP, carry: 0 };
}

/**
 * updateLock: lets `ms` pass, a step at a time (a long frame catches up, as the original's loop does). `scan` is the room's `_target` (the lifted
 * target of the world, or the first entry when there is none: the row line goes round and round to its row, as `_hasTarget` false keeps it scanning).
 * Returns whether this call locked on.
 */
export function advanceLock(lock: MapLock, ms: number, scan: { x: number; y: number }, hasTarget: boolean): boolean {
  if (lock.stage === 2) return false;
  lock.carry += ms;
  let locked = false;
  while (lock.carry >= LOCK_STEP_MS && lock.stage < 2) {
    lock.carry -= LOCK_STEP_MS;
    if (lock.stage === 0) {
      lock.y += ROW_STEP;
      if (lock.y >= scan.y) {
        if (!hasTarget) {
          lock.y = MAP_TOP;
        } else {
          lock.y = scan.y;
          lock.stage = 1;
        }
      }
    } else {
      lock.x += COLUMN_STEP;
      if (lock.x >= scan.x) {
        lock.x = scan.x;
        lock.stage = 2;
        locked = true;
      }
    }
  }
  return locked;
}

export interface LockRects {
  /** The row line (beamhori.spr). */
  across: Rect;
  /** The column line (beamvert.spr), once the row line has found the row. */
  down: Rect | null;
  /** The blip (tranblip.spr), once it has locked on: centred on the target. */
  blip: Rect | null;
}

/**
 * Where the scan's sprites are, from drawSprite's bottom-centre anchor: the row line at (kMapX, lockY + 2), the column line at (lockX + 1, kMapY), the blip at
 * (scan.x, scan.y + 19).
 */
export function lockRects(lock: MapLock, scan: { x: number; y: number }): LockRects {
  const at = (x: number, y: number, [w, h]: readonly [number, number]): Rect => [x - Math.trunc(w / 2), y - h, w, h];
  return {
    across: at(MAP_X, lock.y + 2, ACROSS_SIZE),
    down: lock.stage >= 1 ? at(lock.x + 1, MAP_Y, DOWN_SIZE) : null,
    blip: lock.stage === 2 ? at(scan.x, scan.y + 19, BLIP_SIZE) : null,
  };
}
