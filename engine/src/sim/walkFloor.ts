// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The original's walkable floor, in its pixels: a port of ScummVM's walk.cpp (Screen::scaleAt, nearestWalkable,
 * isSegmentWalkable, findPath), data.cpp's ear clipping, and the walk itself (updateWalking, unity.cpp:1024-1077).
 * The sim uses it on a screen with a pixel metric, so a walk ends exactly where the original's does.
 */

export interface Px {
  x: number;
  y: number;
}

/** A walkable polygon's corner, with the scale (out of 256) of someone standing there. */
export interface ScaledPx extends Px {
  scale: number;
}

interface Triangle {
  points: [Px, Px, Px];
  scales: [number, number, number];
}

/** How far (in pixels) a point may be outside a triangle and still count (walk.cpp kEdgeTolerance). */
const EDGE_TOLERANCE = 0.5;

const cross = (a: Px, b: Px, c: Px) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** data.cpp's triangulate: ear clipping, dropping corners on a straight line. Stops (as the original warns) when no ear is left. */
export function earClip(points: ScaledPx[]): Triangle[] {
  const left = points.map((_, i) => i);
  let area = 0;
  for (let i = 0; i < points.length; i++) area += cross({ x: 0, y: 0 }, points[i], points[(i + 1) % points.length]);
  const out: Triangle[] = [];
  while (left.length > 2) {
    let clipped = false;
    for (let i = 0; i < left.length && !clipped; i++) {
      const a = left[(i + left.length - 1) % left.length];
      const b = left[i];
      const c = left[(i + 1) % left.length];
      const turn = cross(points[a], points[b], points[c]);
      if (turn === 0) {
        left.splice(i, 1);
        clipped = true;
        break;
      }
      if (turn > 0 !== area > 0) continue;
      let ear = true;
      for (let j = 0; j < left.length && ear; j++) {
        const p = left[j];
        if (p === a || p === b || p === c) continue;
        const ab = cross(points[a], points[b], points[p]);
        const bc = cross(points[b], points[c], points[p]);
        const ca = cross(points[c], points[a], points[p]);
        if (turn > 0 ? ab >= 0 && bc >= 0 && ca >= 0 : ab <= 0 && bc <= 0 && ca <= 0) ear = false;
      }
      if (!ear) continue;
      const [pa, pb, pc] = [points[a], points[b], points[c]];
      out.push({ points: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }, { x: pc.x, y: pc.y }], scales: [pa.scale, pb.scale, pc.scale] });
      left.splice(i, 1);
      clipped = true;
    }
    if (!clipped) break;
  }
  return out;
}

function insideTriangle(tri: Triangle, x: number, y: number): boolean {
  const p = tri.points;
  const area = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x);
  if (area === 0) return false;
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    const a = p[i];
    const b = p[(i + 1) % 3];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const c = ex * (y - a.y) - ey * (x - a.x);
    const len = Math.sqrt(ex * ex + ey * ey);
    if ((c * sign) / len < -EDGE_TOLERANCE) return false;
  }
  return true;
}

function closestPointOnSegment(a: Px, b: Px, x: number, y: number): Px {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const lenSq = ex * ex + ey * ey;
  let t = 0;
  if (lenSq > 0) t = Math.min(1, Math.max(0, ((x - a.x) * ex + (y - a.y) * ey) / lenSq));
  return { x: a.x + t * ex, y: a.y + t * ey };
}

/** The original's rounding of a double to a pixel: floor(v + 0.5). */
const roundPx = (v: number) => Math.floor(v + 0.5);
const samePx = (a: Px, b: Px) => a.x === b.x && a.y === b.y;
const pointDistance = (a: Px, b: Px) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

/** A screen's walkable polygons (its open regions, in the screen's order), as walk.cpp walks them. */
export class WalkFloor {
  private readonly triangles: Triangle[];
  private readonly nodes: Px[] = [];
  private visible: boolean[] | undefined;

  constructor(polygons: ScaledPx[][]) {
    this.triangles = polygons.flatMap(earClip);
    for (const poly of polygons) {
      for (const p of poly) if (!this.nodes.some(n => samePx(n, p))) this.nodes.push({ x: p.x, y: p.y });
    }
  }

  /** Whether no polygon is open: there is no floor to stand on. */
  get empty(): boolean {
    return this.triangles.length === 0;
  }

  private triangleAt(x: number, y: number): Triangle | undefined {
    return this.triangles.find(t => insideTriangle(t, x, y));
  }

  private nearestTriangle(x: number, y: number): { tri: Triangle; at: Px } | undefined {
    const inside = this.triangleAt(x, y);
    if (inside) return { tri: inside, at: { x, y } };
    let best: { tri: Triangle; at: Px } | undefined;
    let bestDist = -1;
    for (const tri of this.triangles) {
      for (let k = 0; k < 3; k++) {
        const p = closestPointOnSegment(tri.points[k], tri.points[(k + 1) % 3], x, y);
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (bestDist < 0 || d < bestDist) {
          bestDist = d;
          best = { tri, at: p };
        }
      }
    }
    return best;
  }

  isWalkable(p: Px): boolean {
    return this.triangleAt(p.x, p.y) !== undefined;
  }

  /** Screen::scaleAt: the corners' scales interpolated at the nearest point on the floor, rounded, 1-256. */
  scaleAt(pos: Px): number {
    const near = this.nearestTriangle(pos.x, pos.y);
    if (!near) return 256;
    const { tri, at: { x, y } } = near;
    const v = tri.points;
    const area = (v[1].x - v[0].x) * (v[2].y - v[0].y) - (v[1].y - v[0].y) * (v[2].x - v[0].x);
    if (area === 0) return tri.scales[0];
    const w0 = ((v[1].x - x) * (v[2].y - y) - (v[1].y - y) * (v[2].x - x)) / area;
    const w1 = ((v[2].x - x) * (v[0].y - y) - (v[2].y - y) * (v[0].x - x)) / area;
    const w = [w0, w1, 1 - w0 - w1];
    let total = 0;
    let scale = 0;
    for (let i = 0; i < 3; i++) {
      w[i] = Math.min(1, Math.max(0, w[i]));
      total += w[i];
      scale += w[i] * tri.scales[i];
    }
    if (total > 0) scale /= total;
    return Math.min(256, Math.max(1, Math.trunc(scale + 0.5)));
  }

  /** Screen::nearestWalkable: the point itself, or the nearest point on the floor, nudged in until it is walkable. */
  nearestWalkable(p: Px): Px {
    if (this.isWalkable(p)) return { ...p };
    const near = this.nearestTriangle(p.x, p.y);
    if (!near) return { ...p };
    const { tri, at: { x, y } } = near;
    // (rounding can land just outside, so move in towards the middle)
    const midX = (tri.points[0].x + tri.points[1].x + tri.points[2].x) / 3;
    const midY = (tri.points[0].y + tri.points[1].y + tri.points[2].y) / 3;
    const length = Math.sqrt((midX - x) ** 2 + (midY - y) ** 2);
    for (let t = 0; t <= length; t += 0.5) {
      const f = length > 0 ? t / length : 0;
      const q = { x: roundPx(x + f * (midX - x)), y: roundPx(y + f * (midY - y)) };
      if (this.isWalkable(q)) return q;
    }
    return { x: roundPx(x), y: roundPx(y) };
  }

  /** Screen::isSegmentWalkable: every point along it, a pixel apart, is on the floor. */
  isSegmentWalkable(a: Px, b: Px): boolean {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      if (!this.triangleAt(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y))) return false;
    }
    return true;
  }

  private seen(i: number, j: number): boolean {
    const n = this.nodes.length;
    if (!this.visible) {
      // (buildWalkCache)
      this.visible = new Array<boolean>(n * n).fill(false);
      for (let a = 0; a < n; a++) {
        this.visible[a * n + a] = true;
        for (let b = a + 1; b < n; b++) {
          const v = this.isSegmentWalkable(this.nodes[a], this.nodes[b]);
          this.visible[a * n + b] = v;
          this.visible[b * n + a] = v;
        }
      }
    }
    return this.visible[i * n + j];
  }

  /**
   * Screen::findPath: the points to walk through, from `from` (left out unless it is off the floor) to the nearest
   * walkable point to `to`, or as close as the floor gets; undefined when there is no floor at all.
   */
  findPath(from: Px, to: Px): Px[] | undefined {
    const path: Px[] = [];
    const start = this.nearestWalkable(from);
    const goal = this.nearestWalkable(to);
    if (!this.isWalkable(start) || !this.isWalkable(goal)) return undefined;
    if (!samePx(start, from)) path.push(start);
    if (this.isSegmentWalkable(start, goal)) {
      path.push(goal);
      return path;
    }

    // Dijkstra over the polygon corners, plus the start (index count) and the goal (index count + 1)
    const count = this.nodes.length;
    const startNode = count;
    const goalNode = count + 1;
    const nodes = [...this.nodes, start, goal];
    const startVisible = this.nodes.map(n => this.isSegmentWalkable(start, n));
    const goalVisible = this.nodes.map(n => this.isSegmentWalkable(n, goal));
    const dist = new Array<number>(count + 2).fill(-1);
    const prev = new Array<number>(count + 2).fill(-1);
    const done = new Array<boolean>(count + 2).fill(false);
    dist[startNode] = 0;

    let target = goalNode;
    for (;;) {
      let current = -1;
      for (let i = 0; i < count + 2; i++) {
        if (!done[i] && dist[i] >= 0 && (current === -1 || dist[i] < dist[current])) current = i;
      }
      if (current === -1) {
        // the goal can't be reached, so get as close as we can
        target = startNode;
        for (let i = 0; i < count; i++) {
          if (dist[i] >= 0 && pointDistance(nodes[i], goal) < pointDistance(nodes[target], goal)) target = i;
        }
        if (target === startNode) return path.length > 0 ? path : undefined;
        break;
      }
      if (current === goalNode) break;
      done[current] = true;
      for (let next = 0; next < count + 2; next++) {
        if (done[next] || next === startNode) continue;
        let visible: boolean;
        if (current === startNode) visible = next === goalNode ? false : startVisible[next];
        else if (next === goalNode) visible = goalVisible[current];
        else visible = this.seen(current, next);
        if (!visible) continue;
        const d = dist[current] + pointDistance(nodes[current], nodes[next]);
        if (dist[next] < 0 || d < dist[next]) {
          dist[next] = d;
          prev[next] = current;
        }
      }
    }

    const waypoints: Px[] = [];
    for (let node = target; node !== startNode; node = prev[node]) waypoints.unshift(nodes[node]);
    return [...path, ...waypoints];
  }
}

/**
 * Where a walk along `path` from `from` ends (updateWalking, unity.cpp:1024-1077): its last point, or, with a stop
 * distance, the first whole-pixel position within it of the stop point. The original moves on by its walking speed
 * each frame; this moves `step` pixels a frame.
 */
export function walkEnd(from: Px, path: Px[], stop?: { point: Px; dist: number }, step = 1): Px {
  // (a step that doesn't move on would never get anywhere)
  if (!(step > 0)) throw new RangeError(`walkEnd: a step must be positive, not ${step}`);
  const left = path.map(p => ({ ...p }));
  let wx = from.x;
  let wy = from.y;
  let at = { ...from };
  while (left.length > 0) {
    let remaining = step;
    while (left.length > 0) {
      const next = left[0];
      const dx = next.x - wx;
      const dy = next.y - wy;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length > remaining) {
        wx += (dx * remaining) / length;
        wy += (dy * remaining) / length;
        break;
      }
      wx = next.x;
      wy = next.y;
      remaining -= length;
      left.shift();
    }
    at = { x: Math.trunc(wx + 0.5), y: Math.trunc(wy + 0.5) };
    if (stop && stop.dist > 0) {
      const dx = stop.point.x - at.x;
      const dy = stop.point.y - at.y;
      if (dx * dx + dy * dy <= stop.dist * stop.dist) break;
    }
  }
  return at;
}
