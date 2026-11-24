// SPDX-License-Identifier: GPL-3.0-or-later
import { orientation, toInternal, dot } from './aim';
import { alive, setView, VIEW } from './battle';
import { add, angleFromSinCos, apply, cross, fma32, fr, fromAngles, fromRows, length, mul, normalized, scale, sqrtf, sub, v3, type M3, type V3 } from './math';
import { TRAIL_LENGTH, type BattleContext, type BattleState, type CameraPose, type CombatSeams, type CombatShip } from './types';

/**
 * Combat::updateCamera's placement (combat.cpp:848-948) and its helpers (chaseView, axisView, lookAt, lookAlong,
 * overviewPosition: combat.cpp:789-846), the updateCamera seam (M8 spec §3.3): run at the end of each step and once
 * at setup, as ScummVM's are (combat.cpp:503, 275). The view state it reads (which view, of whom, the expiry) is the
 * sim's, set by updateView just before; the camera it writes (`b.view.camera`, `viewDistance`, `stepCamera`) the sim
 * never reads. It draws no random number. Its float maths is ScummVM's in float32, fused where clang fuses (math.ts).
 */

/** kChaseElevation (combat.cpp:67): the camera 8.1 degrees above the ship. */
export const CHASE_ELEVATION = 0x170;
/** kViewFlyIn's cut to tracking within this distance (combat.cpp:896). */
const FLY_IN_NEAR = 500;
/** 1e30f (combat.cpp:892). */
const FAR = fr(1e30);

/** CombatShip::internalPos (combat.cpp:107-109). */
const internalPos = (ship: CombatShip): V3 => toInternal(ship.pos);

/** Combat::chaseView (combat.cpp:789-793): behind and above the ship, `distance` away, turned by `yawOffset`. */
export function chaseView(cam: CameraPose, ship: CombatShip, yawOffset: number, distance: number): void {
  const m = mul(fromAngles(yawOffset, -CHASE_ELEVATION, 0), orientation(ship));
  cam.pos = add(internalPos(ship), apply(m, v3(0, 0, -distance)));
  cam.axes = m;
}

/** Combat::axisView (combat.cpp:795-799): from the ship's own up (rolled by `rollOffset`), looking down at it. */
export function axisView(cam: CameraPose, ship: CombatShip, rollOffset: number, distance: number, flip: boolean): void {
  const m = mul(fromAngles(0, 0, rollOffset), orientation(ship));
  cam.pos = add(internalPos(ship), apply(m, v3(0, -distance, 0)));
  lookAlong(cam, apply(m, v3(0, 1, 0)), apply(m, v3(flip ? -1 : 1, 0, 0)));
}

/** Combat::lookAt (combat.cpp:801-808): the camera turned to look along `dir`, unrolled. */
export function lookAt(cam: CameraPose, dir: V3): void {
  const d = length(dir) < fr(0.001) ? v3(0, 1, 0) : dir;
  const yaw = angleFromSinCos(d.x, d.z);
  // (sqrtf(d.x * d.x + d.z * d.z): fma(d.x, d.x, d.z * d.z))
  const pitch = angleFromSinCos(-d.y, sqrtf(fma32(d.x, d.x, fr(d.z * d.z))));
  cam.axes = fromAngles(yaw, pitch, 0);
}

/** Combat::lookAlong (combat.cpp:810-814): forward along `forward`, with `down` (made square to it) as down. */
export function lookAlong(cam: CameraPose, forward: V3, down: V3): void {
  const f = normalized(forward);
  const d = normalized(sub(down, scale(f, dot(down, f))));
  cam.axes = fromRows(cross(d, f), d, f);
}

/** Combat::overviewPosition (combat.cpp:816-846): above all the live ships (in internal coordinates). */
export function overviewPosition(b: BattleState): V3 {
  const ship = b.ships[0]!;
  let count = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0, maxZ = 0;
  for (const s of b.ships) {
    if (!alive(s)) continue;
    const p = s.pos;
    if (!count) {
      minX = maxX = p.x;
      minY = maxY = p.y;
      maxZ = p.z;
    } else {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      maxZ = Math.max(maxZ, p.z);
    }
    count++;
  }
  let world: V3;
  if (count <= 1) {
    world = add(ship.pos, v3(0, 0, fr(ship.radius * 5)));
  } else {
    const half = fr(Math.max(fr(maxX - minX), fr(maxY - minY)) / 2);
    // (maxZ + 3.0f * half: fma(3, half, maxZ))
    world = v3(fr(fr(minX + maxX) / 2), fr(fr(minY + maxY) / 2), fma32(3, half, maxZ));
  }
  return v3(world.x, -world.z, world.y);
}

/** The camera's placement for the step (Combat::updateCamera's switch, combat.cpp:858-946). */
export function updateCamera(_ctx: BattleContext, b: BattleState): void {
  const v = b.view;
  const cam = v.camera;
  v.stepCamera = { pos: { ...cam.pos }, axes: [...cam.axes] };
  const ship = v.viewShip === null ? null : b.ships[v.viewShip];
  if (!ship) return;
  const r = ship.radius;
  const zoomed = fr(v.zoom * r);
  // (kViewDrop, turned into tracking by updateView: placed once, as combat.cpp:933-939 does before its setView)
  if (v.dropped) {
    v.dropped = false;
    chaseView(cam, ship, 0, fr(2 * r));
    return;
  }
  switch (v.view) {
    case VIEW.chase:
    case VIEW.waypoint: // (no way points yet: combat.cpp:861)
      chaseView(cam, ship, 0, zoomed);
      break;
    case VIEW.side:
      axisView(cam, ship, 0x1000, zoomed, false);
      break;
    case VIEW.otherSide:
      axisView(cam, ship, 0x3000, zoomed, true);
      break;
    case VIEW.top:
      axisView(cam, ship, 0, zoomed, false);
      break;
    case VIEW.bottom:
      axisView(cam, ship, 0x2000, zoomed, false);
      break;
    case VIEW.chaseClose: {
      // (from where the ship was a moment ago: combat.cpp:876-882)
      const pose = ship.trail[TRAIL_LENGTH - 1]!;
      const m: M3 = mul(fromAngles(0, -CHASE_ELEVATION, 0), fromAngles(pose.angles[0], pose.angles[1], pose.angles[2]));
      cam.pos = add(v3(pose.pos.x, -pose.pos.z, pose.pos.y), apply(m, v3(0, 0, fr(-2 * r))));
      cam.axes = m;
      break;
    }
    case VIEW.overview:
      cam.pos = overviewPosition(b);
      lookAlong(cam, v3(0, 1, 0), v3(0, 0, -1));
      break;
    case VIEW.flyIn: {
      // (from above the battle, in towards the ship: combat.cpp:888-906)
      if (v.viewFrame === 0) {
        cam.pos = overviewPosition(b);
        v.viewDistance = FAR;
      }
      const dir = sub(internalPos(ship), cam.pos);
      const dist = length(dir);
      if (dist >= v.viewDistance || dist < FLY_IN_NEAR) {
        setView(b, 0, VIEW.tracking);
        break;
      }
      v.viewDistance = dist;
      if (v.viewFrame < 300) {
        const part = v.viewFrame <= 100 ? 8 : v.viewFrame <= 200 ? 4 : 2;
        cam.pos = add(cam.pos, scale(normalized(dir), fr(dist / part)));
      }
      lookAt(cam, dir);
      break;
    }
    case VIEW.spinRoll:
      axisView(cam, ship, (v.viewFrame % 63) * 0x100, zoomed, false);
      break;
    case VIEW.spinYaw:
      chaseView(cam, ship, (v.viewFrame % 63) * 0x100, zoomed);
      break;
    case VIEW.target: {
      // (over the ship's shoulder, towards its target; frozen when it has none: combat.cpp:914-926)
      const target = ship.target === null ? null : b.ships[ship.target];
      if (!alive(target) || target === ship || target.decloakTime) break;
      const dir = sub(internalPos(target), internalPos(ship));
      const yaw = angleFromSinCos(dir.x, dir.z);
      const pitch = angleFromSinCos(-dir.y, sqrtf(fma32(dir.x, dir.x, fr(dir.z * dir.z))));
      const m = mul(fromAngles(0, -CHASE_ELEVATION, 0), fromAngles(yaw, pitch, 0));
      cam.pos = add(internalPos(ship), apply(m, v3(0, 0, fr(-v.zoom * r))));
      cam.axes = m;
      break;
    }
    case VIEW.orbit:
      chaseView(cam, ship, v.orbitAngle, zoomed);
      break;
    case VIEW.tracking:
      lookAt(cam, sub(internalPos(ship), cam.pos));
      break;
    case VIEW.forward:
      chaseView(cam, ship, 0, fr(-2 * r));
      break;
    default:
      // (the frozen views keep the camera where it is)
      break;
  }
}

/** The camera's seam (types.ts CombatSeams.updateCamera): M8's. */
export const CAMERA_SEAMS: Readonly<Pick<CombatSeams, 'updateCamera'>> = Object.freeze({ updateCamera });
