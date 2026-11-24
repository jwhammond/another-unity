// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEEP_FLOOR } from '../testing/fixture';
import { Projection } from './projection';

describe('Projection.toPixel', () => {
  it('inverts toWorld on a perspective floor, to well under a pixel', () => {
    const p = new Projection(DEEP_FLOOR);
    for (const [x, y] of [[559, 223], [596, 245], [0, 211], [639, 399], [320, 300]]) {
      const px = p.toPixel(p.toWorld(x, y));
      expect(px.x).toBeCloseTo(x, 0);
      expect(px.y).toBeCloseTo(y, 0);
      expect(Math.abs(px.x - x) + Math.abs(px.y - y)).toBeLessThan(0.2);
    }
  });

  it('inverts toWorld on a flat floor', () => {
    const p = new Projection({ ...DEEP_FLOOR, kind: 'flat', slope: 0, horizonY: 0, meanScale: 200, topY: 0 });
    for (const [x, y] of [[0, 0], [320, 399], [600, 123]]) {
      const px = p.toPixel(p.toWorld(x, y));
      expect(Math.round(px.x)).toBe(x);
      expect(Math.round(px.y)).toBe(y);
    }
  });

  it('gives a row above the floor\'s back edge back on that edge', () => {
    const p = new Projection(DEEP_FLOOR);
    expect(Math.round(p.toPixel(p.toWorld(320, 150)).y)).toBe(DEEP_FLOOR.topY);
  });

  it('fits Screen::scaleAt to the row', () => {
    const p = new Projection(DEEP_FLOOR);
    expect(p.scaleAt(230)).toBeCloseTo(92.59, 2);
    expect(new Projection({ ...DEEP_FLOOR, kind: 'flat' }).scaleAt(230)).toBe(DEEP_FLOOR.meanScale);
  });
});
