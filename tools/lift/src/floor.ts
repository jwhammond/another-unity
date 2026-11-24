// SPDX-License-Identifier: GPL-3.0-or-later
/** Floor polygons in screen pixels, made ready for a mesh: near-miss gaps welded shut, then triangulated. */

export interface Px {
  x: number;
  y: number;
}

export interface FloorPolygon {
  id: number;
  points: Px[];
}

/**
 * How far apart (in pixels) two regions can be and still be walked between. The original's walk test
 * accepts points up to 0.5 px outside a triangle (kEdgeTolerance, walk.cpp:39) and steps a segment a pixel
 * at a time (isSegmentWalkable, walk.cpp:170-179), so findPath crosses gaps of a pixel or two. The real
 * export's near misses are 0.95 (s_0402), 1.49 (s_0204 r25/r21), 1.71 (s_0403 r20/r18) and 2.48 px
 * (s_0608 r27 to r28 and r29); the next gap is 3.0 px (s_0402 r20/r22), so 2.5 px closes every near miss
 * and nothing wider.
 */
export const WELD_PX = 2.5;
/** Closer than this, two positions are the same point. */
const SAME = 1e-9;
/** A corner whose two edges' cross product is smaller than this (in px²) is on a straight line. */
const STRAIGHT = 1e-6;

const cross = (a: Px, b: Px, c: Px) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** The point of segment a-b nearest p, and how far along the segment it is (0-1). */
function nearestOnSegment(p: Px, a: Px, b: Px): { at: Px; t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const at = { x: a.x + t * dx, y: a.y + t * dy };
  return { at, t, distance: Math.hypot(p.x - at.x, p.y - at.y) };
}

/** Strictly inside (even-odd); a point on an edge may go either way, so callers test edges first. */
function inside(p: Px, poly: Px[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Closes the near-miss gaps between regions, so a mesh connects what the original's findPath connects: a
 * corner within WELD_PX of another region's edge (and not on or inside that region) is placed on the
 * neighbour's edge, a point contact, and the point is added to that edge as a corner, so the contact is a
 * vertex of both. That is enough: the walk graph is the regions' corners and what they see (findPath), so a
 * path goes through the contact. Corners lying exactly inside another region's edge are added to it the
 * same way. A corner shared by several regions moves as one, so they stay joined; a corner already on
 * another region's edge stays put, so it keeps that contact; and no move may land on a neighbouring corner
 * of a region that has the corner (no zero-length edges). Everything is measured against the original
 * polygons, so the result doesn't depend on the order of the regions. Returns new polygons.
 */
export function weldFloor(polygons: FloorPolygon[], tolerance = WELD_PX): FloorPolygon[] {
  const same = (a: Px, b: Px) => Math.hypot(a.x - b.x, a.y - b.y) <= SAME;
  const edges = (poly: Px[]) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as const);

  // where each corner goes, decided once per position, so every region with that corner agrees
  const targets = new Map<string, Px | null>();
  const key = (p: Px) => `${p.x},${p.y}`;
  const targetOf = (v: Px): Px | null => {
    const k = key(v);
    if (targets.has(k)) return targets.get(k)!;
    const owners = polygons.map(p => p.points.some(q => same(q, v)));
    // an edge a region with the corner also has is already joined, so the corner never moves onto it
    const ownEdge = (p: Px, q: Px) => polygons.some((o, oi) => owners[oi]
      && edges(o.points).some(([a, b]) => (same(a, p) && same(b, q)) || (same(a, q) && same(b, p))));
    let best: { at: Px; distance: number } | undefined;
    let touching = false;
    polygons.forEach((b, bi) => {
      if (owners[bi]) return;
      let nearest: { at: Px; distance: number } | undefined;
      for (const [p, q] of edges(b.points)) {
        if (ownEdge(p, q)) continue;
        const n = nearestOnSegment(v, p, q);
        if (!nearest || n.distance < nearest.distance) nearest = n;
      }
      if (!nearest) return;
      if (nearest.distance <= SAME) touching = true;
      // (a corner inside another region already connects to it)
      else if (nearest.distance <= tolerance && !inside(v, b.points) && (!best || nearest.distance < best.distance)) best = nearest;
    });
    const at = touching || !best ? null : best.at;
    // no copy of the corner may land on the corner before or after it
    const collapses = at !== null && polygons.some((b, bi) => {
      if (!owners[bi]) return false;
      const pts = b.points;
      const i = pts.findIndex(q => same(q, v));
      return same(pts[(i + pts.length - 1) % pts.length], at) || same(pts[(i + 1) % pts.length], at);
    });
    const to = collapses ? null : at;
    targets.set(k, to);
    return to;
  };

  const moved = polygons.map(p => p.points.map(v => {
    const to = targetOf(v);
    return to ? { x: to.x, y: to.y } : { x: v.x, y: v.y };
  }));
  // per polygon, per edge: the points to add, with how far along the edge each is
  const added = polygons.map(p => p.points.map(() => [] as { at: Px; t: number }[]));
  moved.forEach((m, ai) => m.forEach(to => {
    // add the corner to every other region with an edge through it (two regions can share that edge)
    polygons.forEach((b, bi) => {
      if (bi === ai) return;
      edges(b.points).forEach(([p, q], i) => {
        const n = nearestOnSegment(to, p, q);
        if (n.distance > SAME || same(to, p) || same(to, q)) return;
        if (added[bi][i].some(e => same(e.at, to))) return;
        added[bi][i].push({ at: { x: to.x, y: to.y }, t: n.t });
      });
    });
  }));

  return polygons.map((p, pi) => ({
    id: p.id,
    points: moved[pi].flatMap((pt, i) => [pt, ...[...added[pi][i]].sort((x, y) => x.t - y.t).map(e => e.at)]),
  }));
}

/**
 * Ear clipping, as data.cpp's triangulate does it for the original's (sometimes concave) polygons; never a
 * fan, since some real walkable polygons are slightly concave. Corners on a straight line are dropped
 * first, so a straight edge's middle points (such as welded ones) make no sliver triangles. Returns
 * indices into `points`, and the corners left over if the polygon isn't simple.
 */
export function triangulate(points: Px[]): { triangles: [number, number, number][]; left: number } {
  const left = points.map((_, i) => i);
  for (let changed = true; changed && left.length > 3; ) {
    changed = false;
    for (let i = 0; i < left.length; i++) {
      const a = left[(i + left.length - 1) % left.length];
      const c = left[(i + 1) % left.length];
      if (Math.abs(cross(points[a], points[left[i]], points[c])) < STRAIGHT) {
        left.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  let area = 0;
  for (let i = 0; i < left.length; i++) area += cross({ x: 0, y: 0 }, points[left[i]], points[left[(i + 1) % left.length]]);
  const triangles: [number, number, number][] = [];
  while (left.length > 2) {
    let clipped = false;
    for (let i = 0; i < left.length && !clipped; i++) {
      const a = left[(i + left.length - 1) % left.length];
      const b = left[i];
      const c = left[(i + 1) % left.length];
      const turn = cross(points[a], points[b], points[c]);
      if (Math.abs(turn) < STRAIGHT) {
        left.splice(i, 1);
        clipped = true;
        break;
      }
      if (turn > 0 !== area > 0) continue;
      // an ear has no other corner inside it
      const ear = left.every(p => {
        if (p === a || p === b || p === c) return true;
        const ab = cross(points[a], points[b], points[p]);
        const bc = cross(points[b], points[c], points[p]);
        const ca = cross(points[c], points[a], points[p]);
        return !(turn > 0 ? ab >= 0 && bc >= 0 && ca >= 0 : ab <= 0 && bc <= 0 && ca <= 0);
      });
      if (!ear) continue;
      triangles.push([a, b, c]);
      left.splice(i, 1);
      clipped = true;
    }
    if (!clipped) break;
  }
  return { triangles, left: left.length > 2 ? left.length : 0 };
}
