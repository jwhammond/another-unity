// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Plan 16 R2: a pinhole camera for a ship set, fitted to a few traced 2D-3D points. Design space is Y-up, in metres, the camera
 * looking down -Z at zero yaw and pitch; yaw turns it to the left (toward -X), pitch up, roll about its view axis (positive
 * rolls the image clockwise). Pixels are 640x480 with the origin top-left and square pixels. The principal point is the centre,
 * lifted by `shiftY` pixels when the original was drawn with a level camera and a lens shift (the ship's backgrounds were: their
 * verticals stay vertical while the horizon sits well above the middle of the frame).
 */
export type Vec3 = [number, number, number];
export interface Camera {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view, radians. */
  fovY: number;
  /** Pixels the principal point sits above the centre (0 when absent). */
  shiftY?: number;
  width: 640;
  height: 480;
}
export interface Plane {
  /** n . p = d */
  normal: Vec3;
  d: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The camera's orthonormal axes in design space (x right, y up, f forward) and its focal length in pixels. */
export function basis(c: Camera): { right: Vec3; up: Vec3; forward: Vec3; focal: number } {
  const cp = Math.cos(c.pitch);
  const forward: Vec3 = [-Math.sin(c.yaw) * cp, Math.sin(c.pitch), -Math.cos(c.yaw) * cp];
  const right0 = norm(cross(forward, [0, 1, 0]));
  const up0 = cross(right0, forward);
  const cr = Math.cos(c.roll);
  const sr = Math.sin(c.roll);
  const right: Vec3 = [right0[0] * cr - up0[0] * sr, right0[1] * cr - up0[1] * sr, right0[2] * cr - up0[2] * sr];
  const up: Vec3 = [up0[0] * cr + right0[0] * sr, up0[1] * cr + right0[1] * sr, up0[2] * cr + right0[2] * sr];
  return { right, up, forward, focal: c.height / 2 / Math.tan(c.fovY / 2) };
}

/** Pixels, origin top-left. A point behind the camera gives NaN. */
export function project(c: Camera, p: Vec3): [number, number] {
  const b = basis(c);
  const d = sub(p, c.position);
  const z = dot(d, b.forward);
  if (z <= 1e-9) return [NaN, NaN];
  return [c.width / 2 + (b.focal * dot(d, b.right)) / z, c.height / 2 - (c.shiftY ?? 0) - (b.focal * dot(d, b.up)) / z];
}

/** The ray through a pixel: its direction (not normalised: forward + offsets). */
export function rayDir(c: Camera, uv: [number, number]): Vec3 {
  const b = basis(c);
  const x = (uv[0] - c.width / 2) / b.focal;
  const y = -(uv[1] - c.height / 2 + (c.shiftY ?? 0)) / b.focal;
  return [b.forward[0] + x * b.right[0] + y * b.up[0], b.forward[1] + x * b.right[1] + y * b.up[1], b.forward[2] + x * b.right[2] + y * b.up[2]];
}

export function unprojectToPlane(c: Camera, uv: [number, number], plane: Plane): Vec3 {
  const dir = rayDir(c, uv);
  const denom = dot(plane.normal, dir);
  const t = (plane.d - dot(plane.normal, c.position)) / denom;
  if (!Number.isFinite(t) || Math.abs(denom) < 1e-9 || t <= 0) throw new Error(`the ray through (${uv[0]}, ${uv[1]}) doesn't meet the plane in front of the camera`);
  return [c.position[0] + dir[0] * t, c.position[1] + dir[1] * t, c.position[2] + dir[2] * t];
}

type Trace = [number, number, number, number, number][];
const pack = (c: Camera): number[] => [...c.position, c.yaw, c.pitch, c.roll, c.fovY, c.shiftY ?? 0];
const unpack = (x: number[], like: Camera): Camera => ({ ...like, position: [x[0]!, x[1]!, x[2]!], yaw: x[3]!, pitch: x[4]!, roll: x[5]!, fovY: x[6]!, shiftY: x[7]! });
/** The fitted parameters, in `pack`'s order. */
export const CAMERA_PARAMS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'fovY', 'shiftY'] as const;
export type CameraParam = (typeof CAMERA_PARAMS)[number];
/** What fitCamera solves for when it isn't told: everything but the lens shift. */
export const DEFAULT_FREE: CameraParam[] = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'fovY'];

function residualVector(trace: Trace, c: Camera): number[] {
  const out: number[] = [];
  for (const [u, v, X, Y, Z] of trace) {
    const [pu, pv] = project(c, [X, Y, Z]);
    out.push(Number.isFinite(pu) ? pu - u : 1e4, Number.isFinite(pv) ? pv - v : 1e4);
  }
  return out;
}
const sumSq = (r: number[]): number => r.reduce((a, b) => a + b * b, 0);

/** Solves a small dense system by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r]![i]!) > Math.abs(m[p]![i]!)) p = r;
    [m[i], m[p]] = [m[p]!, m[i]!];
    const piv = m[i]![i]!;
    if (Math.abs(piv) < 1e-14) throw new Error('the traced points do not determine the camera (singular fit)');
    for (let r = i + 1; r < n; r++) {
      const f = m[r]![i]! / piv;
      for (let k = i; k <= n; k++) m[r]![k]! -= f * m[i]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!;
    for (let k = i + 1; k < n; k++) s -= m[i]![k]! * x[k]!;
    x[i] = s / m[i]![i]!;
  }
  return x;
}

/**
 * Levenberg-Marquardt over position, yaw, pitch, roll and vertical FOV (Gauss-Newton with a damping that falls as the fit improves).
 * `trace` rows are [u, v, X, Y, Z]. The rms is over the 2D reprojection distances, in pixels.
 */
export function fitCamera(trace: Trace, start: Camera, free: CameraParam[] = DEFAULT_FREE): { camera: Camera; rms: number; residuals: number[] } {
  if (trace.length < 4) throw new Error(`fitCamera needs at least 4 traced points, got ${trace.length}`);
  const idx = free.map(f => CAMERA_PARAMS.indexOf(f));
  let x = pack(start);
  let r = residualVector(trace, unpack(x, start));
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let iter = 0; iter < 400; iter++) {
    const jac: number[][] = [];
    for (const k of idx) {
      const h = k < 3 ? 1e-6 : 1e-8;
      const xp = [...x];
      xp[k]! += h;
      const rp = residualVector(trace, unpack(xp, start));
      jac.push(rp.map((v, i) => (v - r[i]!) / h));
    }
    const jtj = jac.map(a => jac.map(b => a.reduce((s, v, i) => s + v * b[i]!, 0)));
    const jtr = jac.map(a => a.reduce((s, v, i) => s + v * r[i]!, 0));
    let improved = false;
    for (let tries = 0; tries < 20; tries++) {
      const damped = jtj.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      let step: number[];
      try {
        step = solve(damped, jtr.map(v => -v));
      } catch {
        lambda *= 10;
        continue;
      }
      const xn = [...x];
      idx.forEach((k, i) => (xn[k]! += step[i]!));
      xn[6] = Math.min(Math.max(xn[6]!, 0.1), 2.5);
      const rn = residualVector(trace, unpack(xn, start));
      const cn = sumSq(rn);
      if (cn < cost) {
        const gain = cost - cn;
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 5, 1e-12);
        improved = gain > 1e-14 * (1 + cost);
        break;
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  const residuals: number[] = [];
  for (let i = 0; i < trace.length; i++) residuals.push(Math.hypot(r[2 * i]!, r[2 * i + 1]!));
  return { camera: unpack(x, start), rms: Math.sqrt(sumSq(r) / trace.length), residuals };
}
