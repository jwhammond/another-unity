// SPDX-License-Identifier: GPL-3.0-or-later
import { Matrix4, Quaternion } from 'three';
import type { CombatKind } from '../../content/types';
import { alive } from '../../sim/combat/battle';
import { apply, fromAngles, length, sub, transpose, type M3, type V3 } from '../../sim/combat/math';
import { toInternal } from '../../sim/combat/aim';
import { STEP_SECONDS } from '../../sim/combat/flight';
import { STEP_TIME } from '../../sim/combat/time';
import type { BattleState, CameraPose, CombatShip } from '../../sim/combat/types';
import { FLAT_DISTANCE } from './projection';

/**
 * What a frame draws of a battle, and where (M8 spec §3.1, §3.3, Decisions 7 and 8): pure functions of the battle's
 * state, kept apart from three's scene so each rule is tested on its own.
 */

/**
 * How far the frame is between the last two steps (M8 spec Decision 7): the battle's clock past the last step, over a
 * step, 0 to 1. The parity mode draws the step's state, as the original does: 1.
 */
export function stepFraction(b: Pick<BattleState, 'now' | 'lastStep'>, parity: boolean): number {
  if (parity) return 1;
  return Math.min(1, Math.max(0, (b.now - b.lastStep) / STEP_TIME));
}

/** An internal orientation (row-vector) matrix as a quaternion in the same (internal) axes. */
function quaternionOf(m: M3, out: Quaternion): Quaternion {
  const t = new Matrix4().set(m[0]!, m[3]!, m[6]!, 0, m[1]!, m[4]!, m[7]!, 0, m[2]!, m[5]!, m[8]!, 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(t);
}
/** A quaternion (internal axes) back as a row-vector matrix. */
function matrixOf(q: Quaternion): M3 {
  const e = new Matrix4().makeRotationFromQuaternion(q).elements;
  // (elements are column-major: column j is e[4j..4j+2]; the row-vector matrix is the transpose of the column one)
  return [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!];
}
const qa = new Quaternion(), qb = new Quaternion();
/** Between two poses: positions straight, orientations by the shorter arc (slerp). `t` 1 is `to`. */
export function between(from: { pos: V3; m: M3 }, to: { pos: V3; m: M3 }, t: number): { pos: V3; m: M3 } {
  if (t >= 1) return to;
  quaternionOf(from.m, qa);
  quaternionOf(to.m, qb);
  qa.slerp(qb, t);
  const lerp = (a: number, c: number) => a + (c - a) * t;
  return { pos: { x: lerp(from.pos.x, to.pos.x), y: lerp(from.pos.y, to.pos.y), z: lerp(from.pos.z, to.pos.z) }, m: matrixOf(qa) };
}

/**
 * A ship's pose to draw (internal coordinates): between the step before and this step's. The step before's is in its
 * trail: fly records the old position with the new angles (combat.cpp:668-672), so it is trail[0]'s position and
 * trail[1]'s angles.
 */
export function shipPose(ship: CombatShip, t: number): { pos: V3; m: M3 } {
  const now = { pos: toInternal(ship.pos), m: fromAngles(ship.angles[0], ship.angles[1], ship.angles[2]) };
  const p = ship.trail[0], q = ship.trail[1];
  if (t >= 1 || !p || !q || !alive(ship) || teleported(ship)) return now;
  return between({ pos: toInternal(p.pos), m: fromAngles(q.angles[0], q.angles[1], q.angles[2]) }, now, t);
}

/**
 * Whether the ship's last step moved it outside fly, which records the trail: the starbase's move (ai.cpp:124) and the
 * warp's (warp.ts:87), each a cut. fly moves a ship speed * STEP_SECONDS, and its speed is held to maxSpeed, at most
 * baseMaxSpeed (flight.ts:191-193, updateMaxSpeed's factor being at most 1). A flight step at top speed reaches
 * baseMaxSpeed * STEP_SECONDS exactly in exact maths, and float32 rounding pushes it just over, hence the 2x margin; the
 * teleports are 24000 and more, so the margin loses no cut.
 */
export function teleported(ship: CombatShip): boolean {
  const p = ship.trail[0];
  if (!p) return false;
  return length(sub(ship.pos, p.pos)) > 2 * ship.baseMaxSpeed * STEP_SECONDS;
}

/**
 * The camera to draw from: between the step before's and this step's (`stepCamera`, `camera`), except across a cut: a
 * step that began a view (its first frame, viewFrame 1 after the step's count), or one in which a ship jumped (a warp or
 * the starbase's move, `teleported`: the camera the views place follows ships, so it jumps with them), shows the
 * camera as it is.
 */
export function cameraPose(b: BattleState, t: number): CameraPose {
  const v = b.view;
  if (t >= 1 || v.viewFrame <= 1 || b.ships.some(teleported)) return v.camera;
  const p = between({ pos: v.stepCamera.pos, m: v.stepCamera.axes }, { pos: v.camera.pos, m: v.camera.axes }, t);
  return { pos: p.pos, axes: p.m };
}

/** Whether the original draws a ship (Combat::render, combat.cpp:968-972): alive, and not cloaked (`now` before its decloak time). */
export function shipShown(ship: CombatShip, now: number): boolean {
  return alive(ship) && !(ship.decloakTime && now < ship.decloakTime);
}

/** The shimmer as a cloaked ship appears (M8 spec Decision 8): 400 ms from its decloak time, never before. */
export const SHIMMER_MS = 400;
/** How far through its shimmer a ship is at `now`: null before it starts and after it ends, else 0 to 1. */
export function shimmerAt(decloakAt: number, now: number): number | null {
  if (now < decloakAt || now >= decloakAt + SHIMMER_MS) return null;
  return (now - decloakAt) / SHIMMER_MS;
}

/** The model a ship is drawn with and how (Combat::drawShip, combat.cpp:1028-1056): its detail, its reduced, or flat (unlit, untextured), or none. */
export interface ShipTier { model: string; flat: boolean }
/**
 * Combat::drawShip's level of detail (combat.cpp:1031-1043), from the camera's distance: the detailed model nearer
 * than detailDistance; the reduced (if the kind has one) beyond; beyond reducedDistance (detailDistance without a
 * reduced model) flat; from kFlatDistance on nothing. The kind's models are CombatShip.models. The Combat Options' Low
 * detail (the F1 options' Low, help.cpp 0x168388: every ship's LOD flags flat) is flat at every distance.
 */
export function shipTier(kind: Pick<CombatKind, 'detailDistance' | 'reducedDistance'>, models: CombatShip['models'], dist: number, low = false): ShipTier | null {
  let lod = models.reduced ? 1 : 0;
  let flat = false;
  if (dist < kind.detailDistance) {
    lod = 0;
  } else if (dist >= (models.reduced ? kind.reducedDistance : kind.detailDistance)) {
    if (dist >= FLAT_DISTANCE) return null;
    flat = true;
  }
  const model = lod === 0 ? models.detail : models.reduced;
  return model ? { model, flat: flat || low } : null;
}

/** The camera's distance to a point (internal), as drawShip measures it: (ship->internalPos() - _camera.pos).length(). */
export function cameraDistance(cam: CameraPose, pos: V3): number {
  return length(sub(pos, cam.pos));
}

/** A point's depth in front of the camera (drawModel's view.z: _viewMatrix.apply(pos - _camera.pos).z). */
export function viewDepth(cam: CameraPose, pos: V3): number {
  return apply(transpose(cam.axes), sub(pos, cam.pos)).z;
}

/** drawModel's cull (combat.cpp:1010-1012): behind the camera by more than its size. `size` is the model's largest extent. */
export function culled(depth: number, size: number): boolean {
  return depth + size < 1;
}
