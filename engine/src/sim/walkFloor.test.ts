// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { earClip, WalkFloor, walkEnd, type ScaledPx } from './walkFloor';

const quad = (x0: number, y0: number, x1: number, y1: number, scales = [100, 100, 100, 100]): ScaledPx[] => [
  { x: x0, y: y0, scale: scales[0] }, { x: x1, y: y0, scale: scales[1] }, { x: x1, y: y1, scale: scales[2] }, { x: x0, y: y1, scale: scales[3] },
];

describe('earClip (data.cpp triangulate)', () => {
  it('cuts a concave polygon into corners minus two triangles', () => {
    const L: ScaledPx[] = [[0, 0], [10, 0], [10, 10], [20, 10], [20, 20], [0, 20]].map(([x, y]) => ({ x, y, scale: 1 }));
    const tris = earClip(L);
    expect(tris).toHaveLength(4);
    const area = tris.reduce((s, { points: [a, b, c] }) => s + Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2, 0);
    expect(area).toBe(300);
  });

  it('drops a corner it finds on a straight line', () => {
    // (the first corner looked at, between the last and the second, is on the top edge)
    const square: ScaledPx[] = [[5, 0], [10, 0], [10, 10], [0, 10], [0, 0]].map(([x, y]) => ({ x, y, scale: 1 }));
    expect(earClip(square)).toHaveLength(2);
  });

  it('keeps each corner\'s scale with it', () => {
    const [tri] = earClip([{ x: 0, y: 0, scale: 10 }, { x: 9, y: 0, scale: 20 }, { x: 0, y: 9, scale: 30 }]);
    expect(tri.points.map((p, i) => `${p.x},${p.y}:${tri.scales[i]}`).sort()).toEqual(['0,0:10', '0,9:30', '9,0:20']);
  });
});

describe('WalkFloor', () => {
  it('counts a point up to half a pixel outside an edge as on the floor (kEdgeTolerance)', () => {
    const f = new WalkFloor([quad(10, 10, 20, 20)]);
    expect(f.isWalkable({ x: 15, y: 15 })).toBe(true);
    expect(f.isWalkable({ x: 20, y: 15 })).toBe(true);
    expect(f.isWalkable({ x: 21, y: 15 })).toBe(false);
  });

  it('interpolates the corners\' scales, rounding half up (scaleAt)', () => {
    const f = new WalkFloor([quad(0, 0, 100, 100, [80, 80, 121, 121])]);
    expect(f.scaleAt({ x: 50, y: 0 })).toBe(80);
    expect(f.scaleAt({ x: 50, y: 50 })).toBe(101);
    expect(f.scaleAt({ x: 30, y: 100 })).toBe(121);
  });

  it('takes the scale at the nearest point on the floor for a point off it, and 256 with no floor', () => {
    const f = new WalkFloor([quad(0, 0, 100, 100, [80, 80, 120, 120])]);
    expect(f.scaleAt({ x: 50, y: 300 })).toBe(120);
    expect(new WalkFloor([]).scaleAt({ x: 1, y: 1 })).toBe(256);
  });

  it('moves a point off the floor to the nearest point on it (nearestWalkable)', () => {
    const f = new WalkFloor([quad(10, 10, 20, 20)]);
    expect(f.nearestWalkable({ x: 15, y: 15 })).toEqual({ x: 15, y: 15 });
    expect(f.nearestWalkable({ x: 15, y: 2 })).toEqual({ x: 15, y: 10 });
    expect(f.nearestWalkable({ x: 30, y: 30 })).toEqual({ x: 20, y: 20 });
  });

  it('checks a segment a pixel at a time, so a gap of a pixel or two breaks it', () => {
    const f = new WalkFloor([quad(0, 0, 10, 10), quad(12, 0, 22, 10)]);
    expect(f.isSegmentWalkable({ x: 1, y: 5 }, { x: 9, y: 5 })).toBe(true);
    expect(f.isSegmentWalkable({ x: 1, y: 5 }, { x: 21, y: 5 })).toBe(false);
    // (touching polygons join)
    expect(new WalkFloor([quad(0, 0, 10, 10), quad(10, 0, 20, 10)]).isSegmentWalkable({ x: 1, y: 5 }, { x: 19, y: 5 })).toBe(true);
  });

  describe('findPath', () => {
    // an L: a strip along the bottom and an arm up the right, as two polygons
    const L = new WalkFloor([quad(0, 100, 100, 120), quad(80, 0, 100, 100)]);

    it('heads straight for the goal when it can, leaving out the start', () => {
      expect(L.findPath({ x: 10, y: 110 }, { x: 60, y: 115 })).toEqual([{ x: 60, y: 115 }]);
    });

    it('goes round a corner where the straight line leaves the floor', () => {
      expect(L.findPath({ x: 10, y: 110 }, { x: 90, y: 10 })).toEqual([{ x: 80, y: 100 }, { x: 90, y: 10 }]);
    });

    it('starts from the nearest walkable point when the walker is off the floor, and ends at the goal\'s', () => {
      expect(L.findPath({ x: 10, y: 130 }, { x: 60, y: 140 })).toEqual([{ x: 10, y: 120 }, { x: 60, y: 120 }]);
    });

    it('gets as close as it can to a goal it can\'t reach: the reachable corner nearest it', () => {
      const parted = new WalkFloor([quad(0, 100, 70, 120), quad(80, 0, 100, 120)]);
      expect(parted.findPath({ x: 10, y: 110 }, { x: 90, y: 10 })).toEqual([{ x: 70, y: 100 }]);
    });

    it('finds no path with no floor at all', () => {
      expect(new WalkFloor([]).findPath({ x: 0, y: 0 }, { x: 5, y: 5 })).toBeUndefined();
    });
  });
});

describe('walkEnd (updateWalking)', () => {
  it('refuses a step that never moves on, rather than looping forever', () => {
    for (const step of [0, -1, Number.NaN]) expect(() => walkEnd({ x: 0, y: 0 }, [{ x: 5, y: 0 }], undefined, step)).toThrow(RangeError);
  });

  const path = [{ x: 80, y: 100 }, { x: 80, y: 0 }];

  it('ends at the path\'s last point', () => {
    expect(walkEnd({ x: 0, y: 100 }, path)).toEqual({ x: 80, y: 0 });
  });

  it('stops at the first whole pixel within the stop distance of the stop point, along the route', () => {
    // 30 px from (80, 0) is on the second leg, at (80, 30)
    expect(walkEnd({ x: 0, y: 100 }, path, { point: { x: 80, y: 0 }, dist: 30 })).toEqual({ x: 80, y: 30 });
    // the stop point needn't be on the route: the first leg (row 100) stays 60 rows from (40, 40); the second leg
    // comes within 50 px at (80, 70), as 40² + 30² = 50²
    expect(walkEnd({ x: 0, y: 100 }, path, { point: { x: 40, y: 40 }, dist: 50 })).toEqual({ x: 80, y: 70 });
  });
});
