// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { makeTileable } from './tileable';
import { seamRatio, seamRatioCoarse } from './texture';

/** A diagonal gradient with a little deterministic grain: it doesn't wrap, so it has a hard seam at both edges. */
function gradient(n: number): Rgba {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const grain = ((x * 7919 + y * 104729) % 13) - 6;
      const v = Math.max(0, Math.min(255, Math.round(((x + y) / (2 * n - 2)) * 220 + 15 + grain)));
      data.set([v, v, v, 255], (y * n + x) * 4);
    }
  return { width: n, height: n, data };
}

describe('makeTileable', () => {
  it('makes a non-tiling gradient pass seamRatio and seamRatioCoarse (<= 1.5) and leaves the centre quarter unchanged', () => {
    const n = 256;
    const g = gradient(n);
    expect(seamRatio(g)).toBeGreaterThan(3);
    const t = makeTileable(g, 128);
    expect(seamRatio(t)).toBeLessThanOrEqual(1.5);
    expect(seamRatioCoarse(t)).toBeLessThanOrEqual(1.5);
    for (let y = n / 4; y < (3 * n) / 4; y++) for (let x = n / 4; x < (3 * n) / 4; x++) for (let c = 0; c < 4; c++) expect(t.data[(y * n + x) * 4 + c]).toBe(g.data[(y * n + x) * 4 + c]);
  });
  it('is the identity for a band of 0 and keeps the size', () => {
    const g = gradient(64);
    const t = makeTileable(g, 0);
    expect(t.width).toBe(64);
    expect(Array.from(t.data)).toEqual(Array.from(g.data));
  });
});
