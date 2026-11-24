// SPDX-License-Identifier: GPL-3.0-or-later
import { angleFromSinCos, apply, cosAngle, fma32, fr, fromAngles, sinAngle, sqrtf, sub, v3, type M3, type V3 } from './math';
import { isEnterprise, type CombatShip } from './types';

/**
 * Where things are from a ship: weapons.cpp's helpers (weapons.cpp:66-89, 170-195), and the phasers' range and
 * energy (weapons.cpp:60, 363-366), shared by weapons.ts and damage.ts. Battle coordinates are x, y forward and z up;
 * a ship's internal ones (its model's) x right, y down and z forward (combat.h:144; space3d.h:38).
 */

/** forward (weapons.cpp:74-78): a battle vector of `length` along a heading and pitch. */
export function forward(len: number, yaw: number, pitch: number): V3 {
  // (radians, weapons.cpp:70-72, is angleToRadians: sinf and cosf of whole angles; products only: nothing fused)
  return { x: fr(fr(sinAngle(yaw) * cosAngle(pitch)) * len), y: fr(fr(cosAngle(yaw) * cosAngle(pitch)) * len), z: fr(sinAngle(pitch) * len) };
}

/** anglesTo (weapons.cpp:80-85): the heading and pitch from one point to another. */
export function anglesTo(to: V3, from: V3): [number, number] {
  const d = sub(to, from);
  // (sqrtf(d.x * d.x + d.y * d.y): fma(d.x, d.x, d.y * d.y))
  return [angleFromSinCos(d.x, d.y), angleFromSinCos(d.z, sqrtf(fma32(d.x, d.x, fr(d.y * d.y))))];
}

/** toInternal (weapons.cpp:87-89): a battle vector in a model's coordinates. */
export function toInternal(w: V3): V3 {
  return { x: w.x, y: -w.z, z: w.y };
}
/** The way back, as weapons.cpp:353 and 356 write it inline: Vector3(v.x, v.z, -v.y). */
export function fromInternal(v: V3): V3 {
  return { x: v.x, y: v.z, z: -v.y };
}

/** CombatShip::orientation (combat.cpp:111-113). */
export function orientation(ship: CombatShip): M3 {
  return fromAngles(ship.angles[0], ship.angles[1], ship.angles[2]);
}

/** Vector3::dot (space3d.h:44): x * v.x + y * v.y + z * v.z, which clang fuses as fma(z, v.z, fma(x, v.x, y * v.y)) (Plan 19's R2). */
export function dot(a: V3, b: V3): number {
  return fma32(a.z, b.z, fma32(a.x, b.x, fr(a.y * b.y)));
}

/** (float)0.70710677 */
const R = fr(0.70710677);
const N1 = v3(-R, 0, R), N2 = v3(0.5, -R, 0.5), N3 = v3(-0.5, -R, -0.5);

/** Combat::facing (weapons.cpp:170-178): which of eight parts of the space around `ship` a point is in, split by three planes. */
export function facing(ship: CombatShip, point: V3): number {
  const m = orientation(ship);
  const n1 = apply(m, N1), n2 = apply(m, N2), n3 = apply(m, N3);
  const d = toInternal(sub(ship.pos, point));
  return (dot(n1, d) > 0 ? 4 : 0) | (dot(n2, d) > 0 ? 2 : 0) | (dot(n3, d) > 0 ? 1 : 0);
}

/**
 * hitShield (weapons.cpp:180-191): which of the target's shields takes a hit, "as the original has it, from the
 * shooter's point of view" (a quirk, kept): the shooter's facing of the target. Ships but the Enterprise have six
 * shields, so 6 is 5 and 7 is 1.
 */
export function hitShield(shooter: CombatShip, target: CombatShip): number {
  const f = facing(shooter, target.pos);
  if (!isEnterprise(target)) {
    if (f === 6) return 5;
    if (f === 7) return 1;
  }
  return f;
}

/** foreFacing (weapons.cpp:193-195): the facings the fore weapons cover. */
export function foreFacing(code: number): boolean {
  return code === 0 || code === 1 || code === 4 || code === 5;
}

/** kPhaserRange (weapons.cpp:60). */
export const PHASER_RANGE = 11250;

/**
 * The phasers' energy at a distance, as updateBeams (weapons.cpp:363-366) and destroy's blast (damage.cpp:553-557)
 * both write it: k = (int)((int)(11250.0f - d) / 714 + 6.75f), then k * k * power / 250; none beyond the range.
 */
export function phaserEnergy(d: number, power: number): number {
  if (d > PHASER_RANGE) return 0;
  const k = Math.trunc(fr(Math.trunc(Math.trunc(fr(PHASER_RANGE - d)) / 714) + 6.75));
  return Math.trunc((k * k * power) / 250);
}
