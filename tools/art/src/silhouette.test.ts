// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { AXES, silhouette, silhouetteCheck } from './silhouette';
import type { SpaceModelArt } from './spacemodel';
import { withAlphaOf } from './spacemodel';

/** A 10 x 10 square in z = 0 on a keyed 2 x 2 texture whose top-left texel is clear. */
const square = (): SpaceModelArt => ({
  triangles: [
    { texture: 'q', material: 0, keyed: true, positions: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], uvs: [[0, 0], [1, 0], [1, 1]] },
    { texture: 'q', material: 0, keyed: true, positions: [[0, 0, 0], [10, 10, 0], [0, 10, 0]], uvs: [[0, 0], [1, 1], [0, 1]] },
  ],
  textures: new Map(),
});
const tex = (clear: number[], w = 2, h = 2): Rgba => {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (const i of clear) data[i * 4 + 3] = 0;
  return { width: w, height: h, data };
};

describe('the silhouette check (M8 spec §7; Plan 30 R10)', () => {
  it('leaves a keyed texel\'s quarter of the square uncovered, seen along z', () => {
    const m = silhouette(square(), new Map([['q', { picture: tex([0]), scale: 1 }]]), '+z', 12);
    // (the square fills 10 x 10 pixels inside a pixel's margin; its texel (0, 0), u and v under 0.5, is the quarter at x 1-5 and,
    // y flipped (y up is down on the screen), rows 6-10)
    expect(m.reduce((n, v) => n + v, 0)).toBe(75);
    expect([m[8 * 12 + 2], m[2 * 12 + 2], m[8 * 12 + 8]]).toEqual([0, 1, 1]);
  });

  it('passes a repaint whose alpha is the original\'s at 4x, from every axis, and fails one that fills the clear texel', () => {
    const original = new Map([['q', { picture: tex([0]), scale: 1 }]]);
    const painted = withAlphaOf({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(90) }, tex([0]), 4);
    expect(silhouetteCheck(square(), original, new Map([['q', { picture: painted, scale: 4 }]]), 64).ok).toBe(true);
    const filled = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) };
    const r = silhouetteCheck(square(), original, new Map([['q', { picture: filled, scale: 4 }]]), 64);
    expect(r.ok).toBe(false);
    // (edge-on, along x and y, the square is a line either way; face-on, along z, the clear quarter shows)
    expect([r.differ['+x'], r.differ['+y']]).toEqual([0, 0]);
    expect(r.differ['+z']).toBeGreaterThan(0);
    expect(AXES.length).toBe(6);
  });

  it('draws a flat or unkeyed material whole, whatever its texture', () => {
    const flat = square();
    flat.triangles.forEach(t => { t.keyed = false; });
    expect(silhouette(flat, new Map([['q', { picture: tex([0, 1, 2, 3]), scale: 1 }]]), '+z', 12).reduce((n, v) => n + v, 0)).toBe(100);
  });

  it('throws for a keyed triangle whose texture is not in the map, rather than drawing it whole', () => {
    expect(() => silhouette(square(), new Map(), '+z', 12)).toThrow('triangle 0 is keyed and its texture is absent');
  });
});
