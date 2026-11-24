// SPDX-License-Identifier: GPL-3.0-or-later
import { toInternal } from './aim';
import { alive, setView, VIEW } from './battle';
import { length, sub } from './math';
import { nextRandom, rnd } from './random';
import type { Animation, BattleContext, BattleState, CombatShip } from './types';

/**
 * What weapons.ts and damage.ts share: the rolls, TextureAnimation (combat.cpp:81-101) over the lifted frame counts,
 * the sound requests (Combat::playEffect, weapons.cpp:154-168) and Worf's camera cuts (Combat::cameraEvent,
 * ai.cpp:504-512).
 */

/** _random.rnd(n) at a ScummVM call site, which the trace hook hears (site as `file.cpp:line`). */
export function roll(ctx: BattleContext, b: BattleState, n: number, site: string): number {
  return rnd(b.random, n, ctx.onDraw, site);
}
/** _random.next() at a ScummVM call site (damage.cpp:431); the trace hook hears it with n -1. */
export function nextRoll(ctx: BattleContext, b: BattleState, site: string): number {
  const value = nextRandom(b.random);
  ctx.onDraw?.(site, -1, value);
  return value;
}

/** An animation's frames: the lifted count (CombatData.animations), 0 for none or no file (SpaceResources::animation's null). */
export function animationFrames(ctx: BattleContext, file: string | null): number {
  return file === null ? 0 : ctx.combat.animations?.[file] ?? 0;
}
/** TextureAnimation::start (combat.cpp:81-86): a missing or empty animation leaves it stopped. */
export function startAnimation(ctx: BattleContext, a: Animation, file: string | null, time: number, now: number, first = 0): void {
  const n = animationFrames(ctx, file);
  a.frames = n > 0 ? file : null;
  a.frame = a.frames !== null ? first % n : 0;
  a.frameTime = time;
  a.lastFrame = now;
}
/** TextureAnimation::stop (combat.h:93). */
export function stopAnimation(a: Animation): void {
  a.frames = null;
}
/** TextureAnimation::active (combat.h:94). */
export function animationActive(a: Animation): boolean {
  return a.frames !== null;
}
/** TextureAnimation::advance (combat.cpp:88-97): the next frame once its time is up; true when it goes back to the first. */
export function advanceAnimation(ctx: BattleContext, a: Animation, now: number): boolean {
  // (uint32 now <= lastFrame + frameTime)
  if (a.frames === null || now <= ((a.lastFrame + a.frameTime) >>> 0)) return false;
  a.lastFrame = now;
  a.frame++;
  if (a.frame < animationFrames(ctx, a.frames)) return false;
  a.frame = 0;
  return true;
}

/**
 * Combat::playEffect (weapons.cpp:154-168): a sound effect from a ship (null: at the camera), which the presentation plays
 * (SoundRequest). Its distance is taken here, as the request is made, from the camera the last step placed:
 * `(ship->internalPos() - _camera.pos).length()`, or 0 with no ship (weapons.cpp:156). The camera is read only for this
 * presentation field, which no step reads (Plan 28 R4). So is the bearing (3D SOUND's, Plan 34 Task 6): the ship's place in
 * the camera's axes (rows right, down, forward, as the view projects: draw.ts viewDepth), its angle from forward towards right.
 */
export function playEffect(b: BattleState, ship: CombatShip | null, sound: string): void {
  if (!ship) {
    b.sounds.push({ sound, ship: null, distance: 0 });
    return;
  }
  const cam = b.view.camera;
  const rel = sub(toInternal(ship.pos), cam.pos);
  const m = cam.axes;
  const right = rel.x * m[0]! + rel.y * m[1]! + rel.z * m[2]!;
  const forward = rel.x * m[6]! + rel.y * m[7]! + rel.z * m[8]!;
  b.sounds.push({ sound, ship: ship.index, distance: length(rel), bearing: Math.atan2(right, forward) });
}

/** kEventViewTime (ai.cpp:34): 0x6d2 * 1000 / 291, 6 s. */
export const EVENT_VIEW_TIME = Math.trunc((0x6d2 * 1000) / 291);
/** kViewChaseClose (combat.h:290). */
const VIEW_CHASE_CLOSE = 5;
/**
 * kEventViews (ai.cpp:506): the view each event cuts to. Made at the first call: battle.ts' step reads the sensors
 * (weapons.ts, which imports this module), so VIEW isn't defined yet as this module loads.
 */
let eventViews: readonly number[] | null = null;
const EVENT_VIEWS = () => (eventViews ??= [VIEW.target, VIEW.target, VIEW.target, VIEW.target, VIEW_CHASE_CLOSE, VIEW.chase, VIEW.flyIn]);

/** Combat::cameraEvent (ai.cpp:504-512): with Delegate on, Worf's battles cut to the action, at most every 6 s. */
export function cameraEvent(b: BattleState, ship: CombatShip, event: number): void {
  if (!b.console.delegate || event >= EVENT_VIEWS().length || b.now < b.console.eventViewTime || !alive(ship)) return;
  setView(b, ship.index, EVENT_VIEWS()[event]!);
  b.view.viewExpiry = b.now + EVENT_VIEW_TIME;
  b.console.eventViewTime = b.view.viewExpiry;
}
