// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { crop, windowAlpha, windowMask } from './window';

const KEY: [number, number, number] = [92, 136, 64];

/** A synthetic 64x48 frame: grey metal with a key-coloured rounded window from (12, 8) to (51, 31), and a lookalike patch elsewhere. */
function frame(): Rgba {
  const w = 64;
  const h = 48;
  const data = new Uint8Array(w * h * 4);
  // (metal with a gradient, as the original's frame has: no flat 3x3 patch)
  for (let i = 0; i < w * h; i++) data.set([100 + ((i * 7) % 40), 110 + ((i * 13) % 30), 120 + (i % 9), 255], i * 4);
  const inside = (x: number, y: number): boolean => {
    if (x < 12 || x > 51 || y < 8 || y > 31) return false;
    // rounded corners, radius 4
    const cx = x < 16 ? 16 : x > 47 ? 47 : x;
    const cy = y < 12 ? 12 : y > 27 ? 27 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= 16;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) data.set([...KEY, 255], (y * w + x) * 4);
  // the same colour in a separate spot (a lit panel): not connected, so not the window
  for (let y = 38; y < 42; y++) for (let x = 4; x < 8; x++) data.set([...KEY, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('windowMask', () => {
  it('returns exactly the key region (4-connected from the seed) and its box; a seed on the frame throws', () => {
    const img = frame();
    const { mask, bbox } = windowMask(img, [32, 20]);
    expect(bbox).toEqual([12, 8, 40, 24]);
    let n = 0;
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      const key = img.data[(y * 64 + x) * 4] === KEY[0] && img.data[(y * 64 + x) * 4 + 1] === KEY[1];
      const inPatch = x < 8 && y >= 38;
      expect(mask[y * 64 + x] === 1).toBe(key && !inPatch);
      n += mask[y * 64 + x]!;
    }
    expect(n).toBeGreaterThan(900);
    expect(() => windowMask(img, [5, 5])).toThrow(/flat key-coloured/);
    // a seed at the window's rim has a neighbour that is the frame
    expect(() => windowMask(img, [12, 20])).toThrow(/flat key-coloured/);
  });
});

describe('windowAlpha', () => {
  const img = frame();
  const { mask } = windowMask(img, [32, 20]);
  const a = windowAlpha(mask, 64, 48, 4, 1);
  const at = (x: number, y: number): number => a.data[(Math.floor(y * 4) * a.width + Math.floor(x * 4)) * 4 + 3]!;

  it('is 255 well inside, 0 beyond grow + 1 px outside, and smooth between', () => {
    expect(a.width).toBe(256);
    expect(at(32, 20)).toBe(255);
    expect(at(14, 10)).toBe(255);
    // left edge is at x = 12: one original pixel of growth, then one more of falloff
    expect(at(12.5, 20)).toBe(255);
    expect(at(9.5, 20)).toBe(0);
    expect(at(4, 20)).toBe(0);
    // monotonic across the edge, with intermediate values
    const row = [];
    for (let x = 8; x <= 13; x += 0.25) row.push(at(x, 20));
    for (let i = 1; i < row.length; i++) expect(row[i]!).toBeGreaterThanOrEqual(row[i - 1]!);
    expect(row.some(v => v > 0 && v < 255)).toBe(true);
  });

  it('grows the window by `grow` pixels (more growth, more opaque outside)', () => {
    const none = windowAlpha(mask, 64, 48, 4, 0);
    const i = (Math.floor(20 * 4) * 256 + Math.floor(11.5 * 4)) * 4 + 3;
    expect(none.data[i]).toBeLessThan(a.data[i]!);
    expect(a.data[i]).toBe(255);
  });

  it('crops a box out of a picture', () => {
    const c = crop(img, [12, 8, 40, 24]);
    expect([c.width, c.height]).toEqual([40, 24]);
    expect([...c.data.slice((12 * 40 + 20) * 4, (12 * 40 + 20) * 4 + 3)]).toEqual(KEY);
  });
});
