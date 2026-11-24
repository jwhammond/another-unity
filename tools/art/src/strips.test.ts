// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { findFootShadow, fixFootShadow, mouthOver, overlayFrame, packAnim, scaleMask } from './strips';

function img(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const px = (i: Rgba, x: number, y: number): number[] => [...i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4)];

describe('packAnim', () => {
  const solid = (w: number, h: number, c: number): Rgba => img(w, h, () => [c, c, c, 255]);

  it('places frames at their offsets so the anchor is the same for every cell', () => {
    // frame a: 10x20 at (0, 0): left -5, top -20. frame b: 6x20 at (4, 3): left 1, top -17. The union runs x -5..7, y -20..3.
    const a = solid(10, 20, 10);
    const b = solid(6, 20, 200);
    const { strip, cell, anchor, delays } = packAnim([{ png: a, dx: 0, dy: 0, wait: 40 }, { png: b, dx: 4, dy: 3, wait: 80 }]);
    expect(cell).toEqual([12, 23]);
    expect(strip.width).toBe(24);
    expect(strip.height).toBe(23);
    // (the origin, in fractions of a cell: 5 px in, 20 down)
    expect(anchor[0]).toBeCloseTo(5 / 12);
    expect(anchor[1]).toBeCloseTo(20 / 23);
    expect(delays).toEqual([40, 80]);
    // (a's pixels are in cell 0 from x 0, y 0; b's in cell 1 from x 6 and y 3)
    expect(px(strip, 0, 0)).toEqual([10, 10, 10, 255]);
    expect(px(strip, 10, 19)).toEqual([0, 0, 0, 0]);
    expect(px(strip, 12 + 6, 3)).toEqual([200, 200, 200, 255]);
    expect(px(strip, 12 + 5, 3)).toEqual([0, 0, 0, 0]);
    // (the feet stay put: the origin pixel is the same in each cell, so a frame whose own bottom-centre is the origin has it at the anchor)
    const ox = Math.round(anchor[0] * cell[0]);
    const oy = Math.round(anchor[1] * cell[1]);
    expect(px(strip, ox, oy - 1)).toEqual([10, 10, 10, 255]);
  });

  it('wraps a strip wider than the limit into rows, every cell still at the same anchor', () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ png: solid(10, 20, 50 + i), dx: 0, dy: 0, wait: 30 }));
    const { strip, cell, columns } = packAnim(frames, 1, 25);
    // (a 10x20 cell, two to a row: three rows)
    expect(cell).toEqual([10, 20]);
    expect(columns).toBe(2);
    expect([strip.width, strip.height]).toEqual([20, 60]);
    expect(px(strip, 0, 0)).toEqual([50, 50, 50, 255]);
    expect(px(strip, 10, 0)).toEqual([51, 51, 51, 255]);
    expect(px(strip, 0, 20)).toEqual([52, 52, 52, 255]);
    expect(px(strip, 0, 40)).toEqual([54, 54, 54, 255]);
    expect(px(strip, 10, 40)).toEqual([0, 0, 0, 0]);
    // (a cell wider than the limit is one to a row)
    expect(packAnim(frames, 1, 4).columns).toBe(1);
  });

  it('works at a scale: offsets are in original pixels, the cell in the frames\' own', () => {
    const f = solid(40, 80, 9);
    const { cell, anchor } = packAnim([{ png: f, dx: -2, dy: 1, wait: 10 }], 4);
    // (10x20 original at (-2, 1): left -7, top -19; cell 10x20, 40x80 scaled)
    expect(cell).toEqual([40, 80]);
    expect(anchor[0]).toBeCloseTo(7 / 10);
    expect(anchor[1]).toBeCloseTo(19 / 20);
    expect(() => packAnim([{ png: solid(41, 80, 1), dx: 0, dy: 0, wait: 1 }], 4)).toThrow(/whole number/);
    expect(() => packAnim([], 1)).toThrow(/no frames/);
  });
});

describe('fixFootShadow', () => {
  const BLACK: [number, number, number] = [0, 0, 0];
  /** A 30x40 figure (a grey block, with a black outline along its bottom row) and a checkerboard of pure black under it. */
  const frame = () => img(30, 50, (x, y) => {
    if (y < 40 && x >= 8 && x < 22) return [120, 40, 40, 255];
    if (y === 39 && x >= 8 && x < 22) return [0, 0, 0, 255];
    if (y >= 41 && y < 48 && x >= 6 && x < 24 && (x + y) % 2 === 0) return [0, 0, 0, 255];
    return [0, 0, 0, 0];
  });

  it('turns a checkerboard of the shadow colour into smooth alpha (no 2 px period left) and leaves the figure', () => {
    const f = frame();
    const mask = findFootShadow(f, [BLACK]);
    // (the checkerboard's pixels, none of the figure's black line)
    let expected = 0;
    for (let y = 41; y < 48; y++) for (let x = 6; x < 24; x++) if ((x + y) % 2 === 0) expected++;
    expect(mask.reduce((a: number, b) => a + b, 0)).toBe(expected);
    expect(mask[39 * 30 + 10]).toBe(0);
    const out = fixFootShadow(f, [BLACK]);
    // the figure is untouched
    for (let y = 0; y < 40; y++) for (let x = 8; x < 22; x++) expect(px(out, x, y)).toEqual(px(f, x, y));
    // the middle of the shadow is translucent black, the same on neighbouring pixels (no checkerboard: alpha varies by at most a little)
    const row = Array.from({ length: 8 }, (_, i) => out.data[(44 * 30 + 11 + i) * 4 + 3]!);
    expect(Math.min(...row)).toBeGreaterThan(40);
    expect(Math.max(...row) - Math.min(...row)).toBeLessThanOrEqual(20);
    for (let x = 12; x < 20; x++) {
      expect(Math.abs(out.data[(44 * 30 + x) * 4 + 3]! - out.data[(44 * 30 + x + 1) * 4 + 3]!)).toBeLessThan(12);
      expect(Math.abs(out.data[(44 * 30 + x) * 4 + 3]! - out.data[(45 * 30 + x) * 4 + 3]!)).toBeLessThan(12);
    }
    // it is never fully opaque, and black, and fades out beyond the patch
    expect(Math.max(...row)).toBeLessThan(140);
    expect(px(out, 15, 44).slice(0, 3)).toEqual([0, 0, 0]);
    expect(out.data[(49 * 30 + 1) * 4 + 3]).toBe(0);
  });

  it('leaves a frame without a shadow as it was, and black pixels that touch the figure', () => {
    const noShadow = img(20, 30, (x, y) => (x >= 5 && x < 15 && y < 28 ? [30, 30, 30, 255] : [0, 0, 0, 0]));
    expect(fixFootShadow(noShadow, [BLACK]).data).toEqual(noShadow.data);
    // a lone black pixel up in the figure is not in the foot band; one beside the figure is part of it
    const f = img(20, 30, (x, y) => (x >= 5 && x < 15 && y < 28 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(findFootShadow(f, [BLACK]).every(v => v === 0)).toBe(true);
  });

  it('scaleMask repeats each pixel into a block', () => {
    const m = scaleMask(Uint8Array.from([1, 0, 0, 1]), 2, 2, 3);
    expect(m).toHaveLength(36);
    expect(m[0]).toBe(1);
    expect(m[2 * 6 + 2]).toBe(1);
    expect(m[3]).toBe(0);
    expect(m[3 * 6 + 3]).toBe(1);
  });
});

describe('overlayFrame', () => {
  it('draws the opaque pixels of the mouth over the frame', () => {
    const base = img(6, 6, () => [10, 10, 10, 255]);
    const mouth = img(2, 2, (x, y) => (x === y ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const out = overlayFrame(base, mouth, 2, 3);
    expect(px(out, 2, 3)).toEqual([255, 0, 0, 255]);
    expect(px(out, 3, 3)).toEqual([10, 10, 10, 255]);
    expect(px(out, 3, 4)).toEqual([255, 0, 0, 255]);
    // (off the edge is clipped)
    expect(() => overlayFrame(base, mouth, 5, 5)).not.toThrow();
  });
});

describe('mouthOver', () => {
  const cell = (w: number, h: number, px: [number, number, number, number][]): Rgba => ({ width: w, height: h, data: new Uint8Array(px.flat()) });
  it('puts the mouth\'s pixels back over the repaint of the frame without it, and nothing else', () => {
    const plain = cell(2, 2, [[10, 10, 10, 255], [20, 20, 20, 255], [30, 30, 30, 255], [0, 0, 0, 0]]);
    // the frame with its mouth differs in two pixels: one repainted colour, one that was clear
    const up = cell(2, 2, [[10, 10, 10, 255], [200, 0, 0, 255], [30, 30, 30, 255], [0, 0, 0, 255]]);
    const repainted = cell(2, 2, [[11, 12, 13, 255], [21, 22, 23, 255], [31, 32, 33, 255], [0, 0, 0, 0]]);
    const out = mouthOver(repainted, up, plain);
    expect([...out.data]).toEqual([11, 12, 13, 255, 200, 0, 0, 255, 31, 32, 33, 255, 0, 0, 0, 255]);
    // (the repaint itself is not touched)
    expect([...repainted.data.slice(0, 4)]).toEqual([11, 12, 13, 255]);
  });
  it('refuses cells of different sizes', () => {
    expect(() => mouthOver(cell(1, 1, [[0, 0, 0, 0]]), cell(2, 1, [[0, 0, 0, 0], [0, 0, 0, 0]]), cell(1, 1, [[0, 0, 0, 0]]))).toThrow(/not the same size/);
  });
});
