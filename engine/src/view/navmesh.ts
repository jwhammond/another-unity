// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Walking routes, the original's way (Decision 2, revised after review).
 *
 * The first design linked triangles by shared edges and ran A* plus a funnel. On the real screens that
 * failed four ways: T-junctions did not link once room.ts had rounded coordinates, the funnel emitted the
 * far corner when the apex and both sides were collinear, centroid A* gave routes 3-4 times too long, and
 * small gaps that ScummVM bridges (1.5-2.5 px) were walls. So this follows ScummVM's walk.cpp findPath:
 *  - the walkable area is the UNION of the open regions' triangles: a point is walkable if it is inside
 *    any triangle (within EPS), so overlapping or duplicated regions are harmless and their order is moot;
 *  - an end off the floor is moved to the nearest walkable point;
 *  - if the straight segment is walkable the route is just the end;
 *  - otherwise a visibility graph over every triangle corner (plus the two ends) has an edge wherever the
 *    segment is walkable, and Dijkstra over exact Euclidean lengths gives the shortest corner path.
 * isSegmentWalkable here is exact (interval clipping against each triangle) rather than sampled, and, like
 * the original's whole-pixel sampling, it steps over a gap of up to GAP metres between regions.
 * (Gaps between regions in pixel space are welded by the lifter, Plan 4; GAP is a float-tolerance bridge, not a substitute for welding.)
 * The graph is built once, by prepare() (the stage calls it as a room loads, so the first blocked click
 * doesn't stall) or else on first need, and kept: toggling regions builds a new NavMesh.
 */
import type { Vec2 } from '../content/types';
import type { Triangle } from './room';

/** How far outside a triangle still counts as inside (metres). */
const EPS = 1e-3;
/** The widest gap between regions a straight segment may step over (metres; 2.5 px only at 1 cm/px). */
const GAP = 0.025;
const key = (p: Vec2) => `${Math.round(p.x * 1e4)},${Math.round(p.z * 1e4)}`;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const same = (a: Vec2, b: Vec2) => dist(a, b) < 1e-6;

/** Twice the signed area of a, b, c on the ground. */
export function triarea2(a: Vec2, b: Vec2, c: Vec2): number {
  const ax = b.x - a.x;
  const az = b.z - a.z;
  const bx = c.x - a.x;
  const bz = c.z - a.z;
  return bx * az - ax * bz;
}

/** The signed distance of p inside edge a->b of a triangle wound with `sign` (positive: inside). */
function inside(a: Vec2, b: Vec2, p: Vec2, sign: number): number {
  const len = dist(a, b);
  return len === 0 ? 0 : (triarea2(a, b, p) * sign) / len;
}

function contains(t: Triangle, p: Vec2): boolean {
  const s = Math.sign(triarea2(t[0], t[1], t[2]));
  return [0, 1, 2].every(k => inside(t[k], t[(k + 1) % 3], p, s) >= -EPS);
}

/** The part [lo, hi] of the segment a->b (as 0..1) that is inside t (within EPS), or null. */
function clip(t: Triangle, a: Vec2, b: Vec2): [number, number] | null {
  const s = Math.sign(triarea2(t[0], t[1], t[2]));
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 3; k++) {
    const f0 = inside(t[k], t[(k + 1) % 3], a, s) + EPS;
    const f1 = inside(t[k], t[(k + 1) % 3], b, s) + EPS;
    if (f0 < 0 && f1 < 0) return null;
    if (f0 < 0) lo = Math.max(lo, f0 / (f0 - f1));
    else if (f1 < 0) hi = Math.min(hi, f0 / (f0 - f1));
    if (lo > hi) return null;
  }
  return [lo, hi];
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = dx * dx + dz * dz;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len));
  return { x: a.x + t * dx, z: a.z + t * dz };
}

export interface Route {
  /** The corners to walk through, ending at `to`; the start isn't included (unless it was off the floor and moved). */
  points: Vec2[];
  /** False when the floor doesn't join the two ends (or is empty): the route is then a straight line. */
  reachable: boolean;
}

/** The open floor: the union of the open regions' triangles. */
export class NavMesh {
  private nodes: Vec2[] | null = null;
  private visible: number[][] | null = null;

  private constructor(readonly triangles: Triangle[]) {}

  static build(triangles: Triangle[]): NavMesh {
    return new NavMesh(triangles.filter(t => Math.abs(triarea2(t[0], t[1], t[2])) > 1e-9));
  }

  /** The first triangle under p, or -1. */
  locate(p: Vec2): number {
    return this.triangles.findIndex(t => contains(t, p));
  }

  /** The point of the floor nearest p (p itself when it is on the floor), or null for an empty floor. */
  nearest(p: Vec2): { point: Vec2; tri: number } | null {
    let best: { point: Vec2; tri: number } | null = null;
    let bestDist = Infinity;
    this.triangles.forEach((t, tri) => {
      const point = contains(t, p)
        ? { ...p }
        : [closestOnSegment(p, t[0], t[1]), closestOnSegment(p, t[1], t[2]), closestOnSegment(p, t[2], t[0])]
          .reduce((x, y) => (dist(p, x) <= dist(p, y) ? x : y));
      const d = dist(p, point);
      if (d < bestDist) {
        bestDist = d;
        best = { point, tri };
      }
    });
    return best;
  }

  /** Whether the straight segment a->b stays on the floor, stepping over gaps of up to GAP. */
  private walkable(a: Vec2, b: Vec2): boolean {
    const len = dist(a, b);
    const gap = len === 0 ? 1 : GAP / len;
    const spans: [number, number][] = [];
    for (const t of this.triangles) {
      const s = clip(t, a, b);
      if (s) spans.push(s);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let reach = 0;
    let first = true;
    for (const [lo, hi] of spans) {
      if (lo > reach + gap + 1e-12) break;
      if (first && lo > gap + 1e-12) break;
      first = false;
      reach = Math.max(reach, hi);
    }
    return !first && reach >= 1 - gap - 1e-12;
  }

  /** Builds the visibility graph now rather than on the first walk that needs it. */
  prepare(): void {
    this.graph();
  }

  private graph(): { nodes: Vec2[]; visible: number[][] } {
    if (!this.nodes || !this.visible) {
      const seen = new Map<string, Vec2>();
      for (const t of this.triangles) for (const p of t) if (!seen.has(key(p))) seen.set(key(p), p);
      const nodes = [...seen.values()];
      const visible: number[][] = nodes.map(() => []);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (this.walkable(nodes[i], nodes[j])) {
            visible[i].push(j);
            visible[j].push(i);
          }
        }
      }
      this.nodes = nodes;
      this.visible = visible;
    }
    return { nodes: this.nodes, visible: this.visible };
  }

  path(from: Vec2, to: Vec2): Route {
    const straight: Route = { points: [{ ...to }], reachable: false };
    const s = this.nearest(from);
    const g = this.nearest(to);
    if (!s || !g) return straight;
    const start = s.point;
    const goal = g.point;
    const points: Vec2[] = [];
    if (!same(start, from)) points.push({ ...start });
    // (the sim decides where a walk ends: an end off the floor gets a straight last leg, Decision 3)
    const finish = (): Route => {
      if (points.length === 0 || !same(points[points.length - 1], to)) points.push({ ...to });
      return { points, reachable: true };
    };
    if (this.walkable(start, goal)) {
      if (!same(goal, start)) points.push({ ...goal });
      return finish();
    }
    const { nodes, visible } = this.graph();
    const n = nodes.length;
    const all = [...nodes, start, goal];
    const startSees = nodes.map(p => this.walkable(start, p));
    const goalSees = nodes.map(p => this.walkable(p, goal));
    const d = new Array<number>(n + 2).fill(Infinity);
    const prev = new Array<number>(n + 2).fill(-1);
    const done = new Array<boolean>(n + 2).fill(false);
    d[n] = 0;
    const relax = (from_: number, to_: number) => {
      const nd = d[from_] + dist(all[from_], all[to_]);
      if (nd < d[to_] - 1e-9) {
        d[to_] = nd;
        prev[to_] = from_;
      }
    };
    for (;;) {
      let cur = -1;
      for (let i = 0; i < n + 2; i++) if (!done[i] && d[i] < Infinity && (cur < 0 || d[i] < d[cur])) cur = i;
      if (cur < 0) return straight;
      if (cur === n + 1) break;
      done[cur] = true;
      if (cur === n) {
        startSees.forEach((v, i) => v && relax(cur, i));
      } else {
        for (const j of visible[cur]) relax(cur, j);
        if (goalSees[cur]) relax(cur, n + 1);
      }
    }
    const corners: Vec2[] = [];
    for (let i = prev[n + 1]; i !== n; i = prev[i]) corners.unshift(all[i]);
    points.push(...corners.map(p => ({ ...p })), { ...goal });
    return finish();
  }
}
