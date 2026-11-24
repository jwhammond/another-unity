// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { NavMesh } from './navmesh';
import type { Triangle } from './room';
import { Walker } from './walker';

/** A square fanned from its first corner into two triangles, as the greybox does. */
const square = (x: number, z: number, s: number): Triangle[] => [
  [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }],
  [{ x, z }, { x: x + s, z: z + s }, { x, z: z + s }],
];
/** Three 2 m squares in an L: A (0..2, 0..2), B east of it, C north of B. */
const L = [...square(0, 0, 2), ...square(2, 0, 2), ...square(2, 2, 2)];

describe('NavMesh', () => {
  it('walks straight inside one triangle, and across open floor', () => {
    const nav = NavMesh.build(L);
    expect(nav.path({ x: 0.5, z: 0.5 }, { x: 1.5, z: 1 })).toEqual({ points: [{ x: 1.5, z: 1 }], reachable: true });
    expect(nav.path({ x: 0.5, z: 0.5 }, { x: 3.5, z: 1 })).toEqual({ points: [{ x: 3.5, z: 1 }], reachable: true });
  });

  it('goes round an inside corner through the corner itself', () => {
    const nav = NavMesh.build(L);
    expect(nav.path({ x: 0.5, z: 1.5 }, { x: 3, z: 3.5 })).toEqual({ points: [{ x: 2, z: 2 }, { x: 3, z: 3.5 }], reachable: true });
  });

  it('walks a straight last leg to an end off the mesh, and a first leg onto it', () => {
    const nav = NavMesh.build(L);
    expect(nav.path({ x: 0.5, z: 0.5 }, { x: 5, z: 1 })).toEqual({ points: [{ x: 4, z: 1 }, { x: 5, z: 1 }], reachable: true });
    expect(nav.path({ x: -1, z: 1 }, { x: 1, z: 1 })).toEqual({ points: [{ x: 0, z: 1 }, { x: 1, z: 1 }], reachable: true });
  });

  it('joins regions that meet without sharing corners (a T-junction), through the overlap', () => {
    // a 2 m square, and east of it a taller strip whose west edge runs past the square's corners
    const strip: Triangle[] = [
      [{ x: 2, z: -1 }, { x: 4, z: -1 }, { x: 4, z: 3 }],
      [{ x: 2, z: -1 }, { x: 4, z: 3 }, { x: 2, z: 3 }],
    ];
    const nav = NavMesh.build([...square(0, 0, 2), ...strip]);
    expect(nav.path({ x: 1, z: 1 }, { x: 3, z: 2.5 })).toEqual({ points: [{ x: 3, z: 2.5 }], reachable: true });
    expect(nav.path({ x: 1, z: 1.8 }, { x: 3, z: 2.9 })).toEqual({ points: [{ x: 2, z: 2 }, { x: 3, z: 2.9 }], reachable: true });
  });

  it('says so, and goes straight, when nothing joins the two ends', () => {
    const apart = NavMesh.build([...square(0, 0, 1), ...square(5, 0, 1)]);
    expect(apart.path({ x: 0.5, z: 0.5 }, { x: 5.5, z: 0.5 })).toEqual({ points: [{ x: 5.5, z: 0.5 }], reachable: false });
    expect(NavMesh.build([]).path({ x: 0, z: 0 }, { x: 1, z: 1 })).toEqual({ points: [{ x: 1, z: 1 }], reachable: false });
  });

  it('finds the triangle under a point, or none', () => {
    const nav = NavMesh.build(L);
    expect(nav.locate({ x: 3, z: 3 })).toBeGreaterThanOrEqual(0);
    expect(nav.locate({ x: 1, z: 3 })).toBe(-1);
    expect(nav.nearest({ x: 1, z: 3 })?.point).toEqual({ x: 1, z: 2 });
  });
});

/** A polygon given in screen pixels, in metres (a pixel is 1 cm), fanned from its first corner. */
const poly = (px: number[][]): Triangle[] => {
  const pts = px.map(([x, z]) => ({ x: x / 100, z: z / 100 }));
  return pts.slice(1, -1).map((_, i) => [pts[0], pts[i + 1], pts[i + 2]] as Triangle);
};

describe('NavMesh on the real screens\' awkward floors (review round 1)', () => {
  it('joins a slanted T-junction whose coordinates were rounded to 1e-4', () => {
    // west region's east edge runs (3,0)-(4.2,3); the east region's west edge runs past both ends of it
    const west = poly([[0, 0], [300, 0], [420, 300], [0, 300]]);
    const east: Triangle[] = [
      [{ x: 2.6401, z: -0.9 }, { x: 6, z: -0.9 }, { x: 6, z: 3.9 }],
      [{ x: 2.6401, z: -0.9 }, { x: 6, z: 3.9 }, { x: 4.5599, z: 3.9 }],
    ];
    const nav = NavMesh.build([...west, ...east]);
    expect(nav.path({ x: 1, z: 1 }, { x: 5, z: 1.5 })).toEqual({ points: [{ x: 5, z: 1.5 }], reachable: true });
    expect(nav.path({ x: 1, z: 2.9 }, { x: 5, z: -0.5 }).reachable).toBe(true);
  });

  it('takes the near corner when the apex and both sides are collinear (s_0605)', () => {
    const nav = NavMesh.build([
      ...poly([[448, 312], [464, 310], [564, 337], [636, 359], [636, 384]]),
      ...poly([[401, 294], [448, 312], [636, 384], [636, 399], [447, 399], [331, 295]]),
    ]);
    const route = nav.path({ x: 4.242267838418484, z: 2.76943706035614 }, { x: 4.837394452095032, z: 3.176957882642746 });
    expect(route.reachable).toBe(true);
    // (the far corner, (6.36, 3.84), was the old route's)
    expect(route.points).toHaveLength(3);
    expect(route.points[0].x).toBeCloseTo(4.1556, 3);
    expect(route.points[0].z).toBeCloseTo(2.9958, 3);
    expect(route.points[1].x).toBeCloseTo(4.48, 3);
    expect(route.points[1].z).toBeCloseTo(3.12, 3);
  });

  it('walks the 40 px straight line, not a detour round the regions (s_020a)', () => {
    const nav = NavMesh.build([
      ...poly([[270, 314], [103, 339], [134, 359], [227, 338]]),
      ...poly([[227, 338], [134, 359], [146, 382], [279, 359]]),
      ...poly([[148, 399], [146, 382], [279, 359], [286, 370]]),
      ...poly([[270, 314], [316, 320], [318, 334], [279, 359], [227, 338]]),
      ...poly([[318, 334], [279, 359], [286, 370], [398, 348], [357, 331]]),
    ]);
    const to = { x: 1.984641, z: 3.842031 };
    expect(nav.path({ x: 1.873333, z: 3.456453 }, to)).toEqual({ points: [to], reachable: true });
  });

  it('connects regions with a 1.5 px gap between them, but not a wide one', () => {
    const near = NavMesh.build([...square(0, 0, 1), ...square(1.015, 0, 1)]);
    expect(near.path({ x: 0.5, z: 0.5 }, { x: 1.5, z: 0.5 })).toEqual({ points: [{ x: 1.5, z: 0.5 }], reachable: true });
    const far = NavMesh.build([...square(0, 0, 1), ...square(1.2, 0, 1)]);
    expect(far.path({ x: 0.5, z: 0.5 }, { x: 1.7, z: 0.5 }).reachable).toBe(false);
  });

  it('gives the same route whatever order overlapping or duplicated regions come in', () => {
    const regions = [...square(0, 0, 4), ...square(1, 1, 1), ...square(1, 1, 1), ...square(3, -1, 2)];
    const a = { x: 1.5, z: 1.5 };
    const b = { x: 3.5, z: -0.5 };
    const forward = NavMesh.build(regions).path(a, b);
    expect(forward.reachable).toBe(true);
    expect(NavMesh.build([...regions].reverse()).path(a, b)).toEqual(forward);
    expect(NavMesh.build([...regions].reverse()).path(b, a).reachable).toBe(true);
  });
});

describe('Walker', () => {
  it('walks the corners at its speed and stops on the last one', () => {
    const w = new Walker({ x: 0, z: 0 }, [{ x: 2, z: 0 }, { x: 2, z: 2 }], 2);
    w.advance(0.5);
    expect(w.position).toEqual({ x: 1, z: 0 });
    w.advance(1);
    expect(w.position).toEqual({ x: 2, z: 1 });
    expect(w.done).toBe(false);
    w.advance(5);
    expect(w.position).toEqual({ x: 2, z: 2 });
    expect(w.done).toBe(true);
    // (facing +z on the last leg)
    expect(w.heading).toBeCloseTo(0, 9);
  });

  it('is done at once with nowhere to go', () => {
    const w = new Walker({ x: 1, z: 1 }, []);
    expect(w.done).toBe(true);
    w.advance(1);
    expect(w.position).toEqual({ x: 1, z: 1 });
  });
});
