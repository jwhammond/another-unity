// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How the crew walk onto the transporter pads and off them again (TransporterScreen::walk and updateWalkers, transporter.cpp:314-410): in through the
 * door at the left, across the room and onto the pad, or back the same way. The path is the executable's (`_transporterWalkOn`, `_transporterWalkOff`) with
 * the pad's own stand point and size filled in as `walk` does. Nothing here draws: it is the position, size and animation at each moment.
 */

export interface Waypoint { x: number; y: number; direction: number; scale: number }
export interface PadSpot { stand: [number, number]; scale: number }

/** kWalkSpeed: pixels a second at full size, scaled by the size they are drawn at (transporter.cpp:119). */
export const WALK_SPEED = 160;
/** kWalkDelay: when the recommended team set off, one after another (transporter.cpp:120). */
export const WALK_DELAY_MS = (20 * 1000) / 15;
/** kDoorNear: the door stays open while someone walking is left of this (transporter.cpp:116). */
export const DOOR_NEAR = 198;
/** One update never counts more than this of real time, as the original's does (`MIN(now - lastTime, 100)`). */
export const MAX_STEP_MS = 100;
/** kAnimStanding (transporter.cpp:411): what a padded crew member plays when they have arrived. */
export const ANIM_STANDING = 0x18;

/**
 * `walk`'s path for a pad. Walking on: the executable's six waypoints with the fourth's direction set by the side the pad is on (the even pads are the left), the
 * fifth the middle of the way from the fourth to the pad, five pixels up, and the sixth the pad. Walking off: the executable's four with the first the pad and the
 * second's direction set by the side.
 */
export function walkPath(on: readonly Waypoint[], off: readonly Waypoint[], pad: number, spot: PadSpot, leaving: boolean): Waypoint[] {
  const left = pad % 2 === 0;
  const stand = { x: spot.stand[0], y: spot.stand[1] };
  if (leaving) {
    const path = off.map(w => ({ ...w }));
    path[0] = { ...path[0]!, ...stand, scale: spot.scale };
    path[1] = { ...path[1]!, direction: left ? 3 : 9 };
    return path;
  }
  const path = on.map(w => ({ ...w }));
  path[3] = { ...path[3]!, direction: left ? 0 : 3 };
  const door = path[3]!;
  path[4] = { ...path[4]!, x: Math.trunc((door.x + stand.x) / 2), y: Math.trunc((door.y + stand.y) / 2) - 5, direction: left ? 9 : 3 };
  path[5] = { ...path[5]!, ...stand, direction: path[4]!.direction, scale: spot.scale };
  return path;
}

export interface Walker {
  pad: number;
  leaving: boolean;
  path: Waypoint[];
  /** The waypoint they are heading for. */
  next: number;
  x: number;
  y: number;
  scale: number;
  /** The animation they play: the direction of the leg they are on. */
  anim: number;
  /** When they set off (the room's milliseconds), and the last update's time. */
  start: number;
  last: number;
}

/** `walk`: a walker at the start of its path, to set off at `start` (the room's milliseconds). */
export function newWalker(pad: number, leaving: boolean, path: Waypoint[], start: number): Walker {
  const first = path[0]!;
  return { pad, leaving, path, next: 1, x: first.x, y: first.y, scale: first.scale, anim: path[1]!.direction, start, last: start };
}

/** Whether the walker has set off yet (until then they are not drawn, as the original leaves their object inactive). */
export const started = (w: Walker, now: number): boolean => now >= w.start;

/**
 * `updateWalkers` for one walker at time `now`: they go toward the next waypoint at the speed their size gives, the size changing along the leg, and on arriving
 * at the last waypoint they are done. Returns whether they are.
 */
export function stepWalker(w: Walker, now: number): boolean {
  if (now < w.start) return false;
  const from = w.path[w.next - 1]!;
  const to = w.path[w.next]!;
  w.anim = to.direction;
  const remaining = (WALK_SPEED * w.scale) / 256 * Math.min(now - w.last, MAX_STEP_MS) / 1000;
  w.last = now;
  const dx = to.x - w.x, dy = to.y - w.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length > remaining) {
    w.x += (dx * remaining) / length;
    w.y += (dy * remaining) / length;
  } else {
    w.x = to.x;
    w.y = to.y;
    w.next++;
  }
  const total = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
  const done = total > 0 ? 1 - Math.min(length, total) / total : 1;
  w.scale = from.scale + Math.trunc((to.scale - from.scale) * done);
  return w.next >= w.path.length;
}

/** The place the original draws them: the position rounded as `(uint)(x + 0.5)`. */
export const walkerAt = (w: Walker): [number, number] => [Math.trunc(w.x + 0.5), Math.trunc(w.y + 0.5)];
