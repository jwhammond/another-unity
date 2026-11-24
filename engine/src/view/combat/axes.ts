// SPDX-License-Identifier: GPL-3.0-or-later
import { Matrix4, Vector3 } from 'three';
import type { M3, V3 } from '../../sim/combat/math';

/**
 * The one conversion between ScummVM's internal axes and three's (M8 spec §3.1): internal x is right, y down and z
 * forward (space3d.h:38); three's world is x right, y up and z towards the viewer. Internal becomes three's by a half
 * turn about x, (x, y, z) to (x, -y, -z): a rotation, never a mirror. The space build's models carry their own root
 * rotation (tools/space ROOT_ROTATION, a half turn about z), which modelMatrix undoes, so a model's vertices go
 * through nothing else.
 */

/** An internal point or direction in three's axes. */
export function toThree(v: V3, out = new Vector3()): Vector3 {
  return out.set(v.x, -v.y, -v.z);
}

/** The half turn about x (C), and the space build's root rotation, a half turn about z (Rz). Each is its own inverse. */
const C = new Matrix4().set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
const RZ = new Matrix4().set(-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

/**
 * An internal row-vector matrix (v * m, space3d.h:53-63) as three's column-vector rotation: its transpose. Rows
 * become columns.
 */
function columns(m: M3, out: Matrix4): Matrix4 {
  return out.set(m[0]!, m[3]!, m[6]!, 0, m[1]!, m[4]!, m[7]!, 0, m[2]!, m[5]!, m[8]!, 0, 0, 0, 0, 1);
}

const tmp = new Matrix4();
/**
 * Where a model goes: at internal `pos`, turned by its orientation `m` (CombatShip::orientation), as three's matrix
 * for the node that holds a space build model (whose root rotation Rz it undoes): C · mᵀ · Rz, at C(pos). A vertex
 * v of the model's file then lands at C(v · m + pos), as drawObject puts it (space3d.cpp:283-304). `scale` is
 * SpaceModel::scale's factor (space3d.cpp:467-479: every vertex times it), which an effect's model takes.
 */
export function modelMatrix(pos: V3, m: M3, out = new Matrix4(), scale = 1): Matrix4 {
  out.copy(C).multiply(columns(m, tmp)).multiply(RZ);
  if (scale !== 1) out.multiply(tmp.makeScale(scale, scale, scale));
  out.elements[12] = pos.x;
  out.elements[13] = -pos.y;
  out.elements[14] = -pos.z;
  return out;
}

/**
 * The camera's world matrix in three's axes: its right, up (the internal down, negated) and back (the internal
 * forward, negated) as columns, at C(pos). `axes` are Combat::Camera's rows: right, down, forward (combat.h:436).
 */
export function cameraMatrix(pos: V3, axes: M3, out = new Matrix4()): Matrix4 {
  const [rx, ry, rz, dx, dy, dz, fx, fy, fz] = axes as [number, number, number, number, number, number, number, number, number];
  return out.set(
    rx, -dx, -fx, pos.x,
    -ry, dy, fy, -pos.y,
    -rz, dz, fz, -pos.z,
    0, 0, 0, 1,
  );
}
