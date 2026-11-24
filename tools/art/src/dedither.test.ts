// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dedither, ditherScore, DEDITHER_DEFAULTS } from './dedither';
import type { Rgba } from './image';

const W = 48;
const H = 32;
/** A grey picture from a function of (x, y). */
const grey = (f: (x: number, y: number) => number): Rgba => {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = f(x, y);
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
};
const at = (img: Rgba, x: number, y: number): number => img.data[(y * W + x) * 4]!;
/** Left of x = 24 a checkerboard of 100 and 130 (the dithered surface), right of it flat 220 (a wall). */
const EDGE = 24;
const patch = (): Rgba => grey((x, y) => (x < EDGE ? ((x + y) % 2 === 0 ? 100 : 130) : 220));

describe('dedither', () => {
  it('removes a checkerboard dither: the surface comes out flat at the pattern\'s mean', () => {
    const out = dedither(patch(), DEDITHER_DEFAULTS);
    for (let y = 4; y < H - 4; y++)
      for (let x = 4; x < EDGE - 4; x++) expect(Math.abs(at(out, x, y) - 115)).toBeLessThanOrEqual(2);
  });

  it('keeps the hard edge beside it within 1 px', () => {
    const src = patch();
    const out = dedither(src, DEDITHER_DEFAULTS);
    for (let y = 2; y < H - 2; y++) {
      // where the row crosses half way between the surface (115) and the wall (220)
      let cross = -1;
      for (let x = 1; x < W; x++) if (at(out, x - 1, y) < 167.5 && at(out, x, y) >= 167.5) cross = x;
      expect(Math.abs(cross - EDGE)).toBeLessThanOrEqual(1);
      // and the wall is untouched from the edge on (no surface colour bleeds over it)
      for (let x = EDGE; x < W; x++) expect(at(out, x, y)).toBe(220);
    }
  });

  it('keeps a thin seam line across a finely dithered floor', () => {
    // floor: dots of 81 among 86 every other pixel of every other row; the seam is row 16 at 64
    const src = grey((x, y) => (y === 16 ? 64 : y % 2 === 0 && x % 2 === 0 ? 81 : 86));
    const out = dedither(src, DEDITHER_DEFAULTS);
    for (let x = 4; x < W - 4; x++) {
      expect(at(out, x, 16)).toBeLessThanOrEqual(68);
      // the dots are gone either side of it
      expect(Math.abs(at(out, x, 8) - at(out, x + 1, 8))).toBeLessThanOrEqual(1);
    }
  });

  it('scores a checkerboard and a lone dot as dither, a line and an edge not', () => {
    const s = ditherScore(patch());
    expect(s[10 * W + 10]).toBeGreaterThan(20);
    expect(s[10 * W + EDGE]).toBe(0);
    const line = ditherScore(grey((x, y) => (y === 10 ? 40 : 200)));
    expect(line[10 * W + 10]).toBe(0);
    const diagonal = ditherScore(grey((x, y) => (x === y ? 40 : 200)));
    expect(diagonal[10 * W + 10]).toBe(0);
    const dot = ditherScore(grey((x, y) => (x === 10 && y === 10 ? 160 : 200)));
    expect(dot[10 * W + 10]).toBeGreaterThan(30);
  });

  it('leaves the keep rectangles exactly as they were, and is deterministic', () => {
    const src = patch();
    const keep: [number, number, number, number][] = [[0, 0, 8, 8]];
    const a = dedither(src, DEDITHER_DEFAULTS, keep);
    const b = dedither(src, DEDITHER_DEFAULTS, keep);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(at(a, x, y)).toBe(at(src, x, y));
    expect(at(a, 12, 12)).not.toBe(at(src, 12, 12));
  });

  it('keeps a display\'s grid of 1 px lines (saturated green on a darker green) as it is', () => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) data.set(x % 2 === 0 || y % 3 === 0 ? [50, 150, 50, 255] : [30, 100, 30, 255], (y * W + x) * 4);
    const src: Rgba = { width: W, height: H, data };
    expect(Buffer.from(dedither(src, DEDITHER_DEFAULTS).data).equals(Buffer.from(data))).toBe(true);
    // without the glow test the filter would flatten it
    expect(Buffer.from(dedither(src, { ...DEDITHER_DEFAULTS, glowSat: 2 }).data).equals(Buffer.from(data))).toBe(false);
  });

  it('does nothing for method none', () => {
    const src = patch();
    expect(Buffer.from(dedither(src, { ...DEDITHER_DEFAULTS, method: 'none' }).data).equals(Buffer.from(src.data))).toBe(true);
  });
});
