// SPDX-License-Identifier: GPL-3.0-or-later
import { orientation } from './aim';
import { alive, distance, logMessage, shipTarget } from './battle';
import { collide } from './damage';
import { STEP_SECONDS } from './flight';
import { add, AXES, angleFromSinCos, apply, clip, fma32, fr, fromAngles, length, sqrtf, sub, transpose, v3, type V3 } from './math';
import { combatTicks } from './time';
import type { BattleContext, BattleState, CombatShip } from './types';

/**
 * How the AI and tactics fly a ship (ai.cpp:48-131): turn rates toward a waypoint, the controls smoothed over the
 * last steps, and a collision avoided. Step calls them for every ship the AI or tactics fly (combat.cpp:466-471).
 */

/** kCollisionRange (ai.cpp:44). */
export const COLLISION_RANGE = 8000;
/**
 * avoidCollision's kicks, 500.0f * kStepSeconds and 750.0f * kStepSeconds (ai.cpp:124-128): clang folds them to float
 * constants, 33 and 49.5 (measured), so `speed += 500.0f * kStepSeconds` is an add of a constant, not fused.
 */
const SPEED_KICK = fr(500 * STEP_SECONDS);
const TARGET_KICK = fr(750 * STEP_SECONDS);

/** signedAngle (ai.cpp:48-51): -0x2000 to 0x2000. */
export function signedAngle(angle: number): number {
  const a = angle & 0x3fff;
  return a > 0x2000 ? a - 0x4000 : a;
}
/** MAX (common/util.h): (a > b) ? a : b. */
const max = (a: number, b: number): number => (a > b ? a : b);

/** The point from the ship, in the ship's frame's axes (ai.cpp:55, 68): Vector3(p.x - pos.x, -(p.z - pos.z), p.y - pos.y). */
function toward(ship: CombatShip, point: V3): V3 {
  return v3(fr(point.x - ship.pos.x), -fr(point.z - ship.pos.z), fr(point.y - ship.pos.y));
}

/** Combat::directionTo (ai.cpp:53-59): the yaw and pitch to a point in the ship's own frame: 0 is ahead, 0x1000 right (or up). */
export function directionTo(ship: CombatShip, point: V3): [number, number] {
  const l = apply(transpose(orientation(ship)), toward(ship, point));
  // (sqrtf(l.x * l.x + l.z * l.z): fma(l.x, l.x, l.z * l.z))
  return [angleFromSinCos(l.x, l.z), angleFromSinCos(-l.y, sqrtf(fma32(l.x, l.x, fr(l.z * l.z))))];
}

/** Combat::steerTowards (ai.cpp:61-77): turn rates toward a point, up to 128 a step (64 to roll), levelling the wings to the line of sight; under 32 is none. */
export function steerTowards(_ctx: BattleContext, _b: BattleState, ship: CombatShip, point: V3): void {
  const [yaw, pitch] = directionTo(ship, point);
  const y = clip(signedAngle(yaw), -128, 128);
  const p = clip(signedAngle(pitch), -128, 128);
  // and level the wings to the line of sight
  const v = toward(ship, point);
  const across = v3(v.z, 0, -v.x);
  const body = apply(transpose(orientation(ship)), across);
  const q = apply(transpose(fromAngles(yaw, pitch, 0)), body);
  const r = clip(signedAngle(angleFromSinCos(q.y, q.x)), -64, 64);
  ship.controls.yaw = Math.abs(y) < 32 ? 0 : y;
  ship.controls.pitch = Math.abs(p) < 32 ? 0 : p;
  ship.controls.roll = Math.abs(r) < 32 ? 0 : r;
}

/**
 * Combat::filterInputs (ai.cpp:79-99): the AI's controls, smoothed over the last four steps; a change of direction
 * starts at a quarter. inputHistory[i] holds the outputs in 0-2 and the raw inputs in 4-6.
 */
export function filterInputs(_ctx: BattleContext, _b: BattleState, ship: CombatShip): void {
  const h = ship.inputHistory;
  for (let a = 0; a < 3; a++) {
    const raw = ship.controls[AXES[a]!];
    let current = raw;
    const last = h[0]![4 + a]!;
    // a change of direction starts slowly
    if ((current < 0) !== (last < 0) && current !== 0 && last !== 0) current = fr(current * 0.25);
    let sum = 0;
    for (let i = 0; i < 4; i++) sum = fr(sum + fr(h[i]![a]! + h[i]![4 + a]!));
    // (((sum + 2.0f * current) / 10.0f + inputHistory[0][a]) * 0.5f: fma(2, current, sum), measured)
    const out = fr(fr(fr(fma32(2, current, sum) / 10) + h[0]![a]!) * 0.5);
    for (let i = 3; i > 0; i--) {
      h[i]![a] = h[i - 1]![a]!;
      h[i]![4 + a] = h[i - 1]![4 + a]!;
    }
    h[0]![a] = out;
    h[0]![4 + a] = raw;
    ship.controls[AXES[a]!] = out;
  }
}

/**
 * Combat::avoidCollision (ai.cpp:101-131): a ship about to hit its target (within a second at their speeds) holds
 * everything for 5 s, turns hard away, makes for 575, and they collide if they touch (damage.ts's collide).
 */
export function avoidCollision(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const target = shipTarget(b, ship);
  if (!alive(target)) return;
  const d = distance(ship, target);
  if (d > COLLISION_RANGE) return;
  const speedA = length(ship.velocity), speedB = length(target.velocity);
  if (speedA < 2 && speedB < 2 && d > fr(ship.radius + target.radius)) return;
  // will they come close in the next second? (MAX(speedA, speedB) * 4.5f + MAX(radii): fused, measured)
  const threshold = fma32(max(speedA, speedB), 4.5, max(ship.radius, target.radius));
  const later = length(sub(add(ship.pos, ship.velocity), add(target.pos, target.velocity)));
  if (d >= threshold && later >= threshold) return;

  logMessage(ship, 'Collision Imminent');
  const hold = b.now + combatTicks(0x5af);
  ship.holdTime = ship.scriptTime = ship.strategyTime = ship.freezeTime = hold;
  for (const key of AXES) ship.controls[key] = ship.controls[key] > 0 ? -100 : 100;
  if (ship.speed < 575) {
    ship.speed = fr(ship.speed + SPEED_KICK);
    ship.targetSpeed = fr(ship.targetSpeed + TARGET_KICK);
  } else if (ship.speed > 575) {
    ship.speed = fr(ship.speed - SPEED_KICK);
    ship.targetSpeed = fr(ship.targetSpeed - TARGET_KICK);
  }
  collide(ctx, b, ship, target);
}
