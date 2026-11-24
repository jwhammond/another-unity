// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { triangulate, weldFloor } from './floor';

const px = (x: number, y: number) => ({ x, y });
const square = [px(0, 0), px(10, 0), px(10, 10), px(0, 10)];

describe('weldFloor', () => {
  it('closes a 1.5 px gap by placing each corner within reach on the neighbour\'s edge, and adding it there', () => {
    const tall = [px(11.5, -5), px(20, -5), px(20, 15), px(11.5, 15)];
    expect(weldFloor([{ id: 1, points: square }, { id: 2, points: tall }])).toEqual([
      { id: 1, points: [px(0, 0), px(11.5, 0), px(11.5, 10), px(0, 10)] },
      { id: 2, points: [px(11.5, -5), px(20, -5), px(20, 15), px(11.5, 15), px(11.5, 10), px(11.5, 0)] },
    ]);
  });

  it('makes a point contact where only one corner is within reach (s_0204 r25 and r21)', () => {
    const r25 = [px(304, 155), px(344, 159), px(348, 154), px(333, 152), px(316, 151)];
    const r21 = [px(328, 161), px(309, 157), px(305, 161), px(318, 163)];
    const [a, b] = weldFloor([{ id: 25, points: r25 }, { id: 21, points: r21 }]);
    // r21's corner (309, 157), 1.49 px below r25's edge, moves onto it, and r25 gets it as a corner
    const contact = b.points[1];
    expect(contact.x).toBeCloseTo(309.149, 3);
    expect(contact.y).toBeCloseTo(155.515, 3);
    expect(a.points).toHaveLength(6);
    expect(a.points.some(p => Math.hypot(p.x - contact.x, p.y - contact.y) === 0)).toBe(true);
    expect([b.points[0], b.points[2], b.points[3]]).toEqual([r21[0], r21[2], r21[3]]);
  });

  it('never moves a corner already shared with a neighbour onto the end of its own edge (s_0402 r34, r18 and r24)', () => {
    const r34 = [px(308, 217), px(396, 253), px(396, 255), px(304, 218)];
    const r24 = [px(352, 267), px(396, 255), px(424, 269)];
    const r18 = [px(424, 269), px(404, 243), px(396, 253), px(396, 255)];
    const polygons = [{ id: 34, points: r34 }, { id: 24, points: r24 }, { id: 18, points: r18 }];
    const welded = weldFloor(polygons);
    // (396, 253) is 2 px from r24's corner (396, 255), the other end of the edge r34 and r18 share
    expect(welded).toEqual(polygons);
    for (const { points } of welded) {
      points.forEach((p, i) => expect(p).not.toEqual(points[(i + 1) % points.length]));
    }
  });

  it('never welds a corner onto an edge its own region shares with the neighbour (s_0501 r32 and r31)', () => {
    const r32 = [px(209, 120), px(216, 116), px(213, 115), px(207, 119)];
    const r31 = [px(209, 120), px(216, 116), px(220, 125), px(210, 128)];
    const polygons = [{ id: 32, points: r32 }, { id: 31, points: r31 }];
    // (213, 115) is 2.36 px from the edge (209, 120)-(216, 116), but that edge is r32's own
    expect(weldFloor(polygons)).toEqual(polygons);
  });

  it('leaves a 3 px gap open, as the original does', () => {
    const polygons = [{ id: 1, points: square }, { id: 2, points: [px(13, -5), px(20, -5), px(20, 15), px(13, 15)] }];
    expect(weldFloor(polygons)).toEqual(polygons);
  });

  it('places each side\'s corner on the other\'s edge when two edges run side by side', () => {
    const offset = [px(3, 11.5), px(14, 11.5), px(14, 20), px(3, 20)];
    const [a, b] = weldFloor([{ id: 1, points: square }, { id: 2, points: offset }]);
    // A's corner (10, 10) moves up onto B's edge, and B's corner (3, 11.5) down onto A's, and each is added to the other
    expect(a.points).toEqual([px(0, 0), px(10, 0), px(10, 11.5), px(3, 10), px(0, 10)]);
    expect(b.points).toEqual([px(3, 10), px(10, 11.5), px(14, 11.5), px(14, 20), px(3, 20)]);
  });

  it('adds a corner lying exactly on another region\'s edge to that edge, and leaves overlapping corners alone', () => {
    const touching = [px(10, 4), px(20, 4), px(20, 6)];
    const overlapping = [px(-5, 5), px(1, 5), px(-5, 6)];
    const [a, b, c] = weldFloor([{ id: 1, points: square }, { id: 2, points: touching }, { id: 3, points: overlapping }]);
    expect(a.points).toEqual([px(0, 0), px(10, 0), px(10, 4), px(10, 10), px(0, 10)]);
    expect(b.points).toEqual(touching);
    expect(c.points).toEqual(overlapping);
  });
});

describe('triangulate', () => {
  it('clips ears, never a fan, from a concave polygon', () => {
    const ell = [px(0, 0), px(2, 0), px(2, 1), px(1, 1), px(1, 2), px(0, 2)];
    const { triangles, left } = triangulate(ell);
    expect(left).toBe(0);
    expect(triangles).toHaveLength(4);
    // a fan from corner 0 would cover the missing quarter; no triangle here reaches it
    for (const t of triangles) {
      const cx = t.reduce((s, i) => s + ell[i].x, 0) / 3;
      const cy = t.reduce((s, i) => s + ell[i].y, 0) / 3;
      expect(cx > 1 && cy > 1).toBe(false);
    }
  });

  it('drops corners on a straight line first, such as welded ones', () => {
    expect(triangulate(square).triangles).toHaveLength(2);
    const welded = [px(0, 0), px(5, 0), px(10, 0), px(10, 10), px(0, 10)];
    expect(triangulate(welded)).toEqual({ triangles: [[4, 0, 2], [4, 2, 3]], left: 0 });
  });

  it('reports the corners it can\'t clip from a polygon that crosses itself', () => {
    expect(triangulate([px(0, 0), px(10, 10), px(10, 0), px(0, 10)]).left).toBeGreaterThan(0);
  });
});
