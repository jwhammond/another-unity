// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { imageColours, kmeansPalette, nearestResize, pixelate, pixelGrid, pixelOptions, quantise } from './pixel';

function make(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...f(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}
const ramp = make(64, 64, (x, y) => [x * 4, y * 4, 128]);
const game = make(4, 4, (x, y) => ((x + y) % 2 ? [200, 30, 30] : [20, 20, 160]));
const opts = (o: object) => pixelOptions.parse({ grid: [16, 16], palette: 'game', ...o });
const colours = (img: Rgba) => imageColours(img).length;

describe('pixel step', () => {
  it('makes the grid, on the game palette only', () => {
    const g = pixelGrid(ramp, game, opts({}));
    expect([g.width, g.height]).toEqual([16, 16]);
    for (const c of imageColours(g)) expect([[200, 30, 30], [20, 20, 160]]).toContainEqual(c);
  });
  it('limits k-means to k colours, and is deterministic', () => {
    const g = pixelGrid(ramp, game, opts({ palette: { kmeans: 6 } }));
    expect(colours(g)).toBeLessThanOrEqual(6);
    expect(colours(g)).toBeGreaterThan(2);
    expect(pixelGrid(ramp, game, opts({ palette: { kmeans: 6 } })).data).toEqual(g.data);
    expect(kmeansPalette(ramp, 4)).toEqual(kmeansPalette(ramp, 4));
  });
  it('upscales with square-edged pixels: every output pixel is one grid pixel', () => {
    const out = pixelate(ramp, game, opts({ palette: { kmeans: 8 } }), [128, 128]);
    const g = pixelGrid(ramp, game, opts({ palette: { kmeans: 8 } }));
    expect([out.width, out.height]).toEqual([128, 128]);
    expect(colours(out)).toBe(colours(g));
    for (const [x, y] of [[0, 0], [7, 7], [8, 8], [127, 127], [64, 33]] as const) {
      const s = ((y >> 3) * 16 + (x >> 3)) * 4;
      expect([...out.data.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)]).toEqual([...g.data.subarray(s, s + 4)]);
    }
  });
  it('dithers a flat mid-tone into a mix of the two nearest colours, and not without the option', () => {
    const flat = make(8, 8, () => [119, 119, 119]);
    const two: [number, number, number][] = [[0, 0, 0], [255, 255, 255]];
    expect(colours(quantise(flat, two, 'none'))).toBe(1);
    expect(colours(quantise(flat, two, 'bayer'))).toBe(2);
    expect(quantise(flat, two, 'bayer').data).toEqual(quantise(flat, two, 'bayer').data);
  });
  it('the mode filter keeps a small dark feature that the area mean washes out', () => {
    const img = make(8, 8, (x, y) => (x < 3 && y < 3 ? [0, 0, 0] : [230, 230, 230]));
    const area = pixelGrid(img, game, opts({ grid: [8, 8], filter: 'area', palette: { kmeans: 2 } }));
    const mode = pixelGrid(img, game, opts({ grid: [2, 2], filter: 'mode', palette: { kmeans: 2 } }));
    expect(area.data[0]).toBe(0);
    // the top-left 4x4 cell is 9 dark pixels of 16, so the mode is dark; the other cells are light
    expect(mode.data[0]).toBeLessThan(40);
    expect(mode.data[4]).toBeGreaterThan(200);
  });
  it('resizes by nearest neighbour without blending', () => {
    const img = make(2, 1, x => (x ? [255, 0, 0] : [0, 0, 255]));
    const out = nearestResize(img, 5, 2);
    expect([...out.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect(colours(out)).toBe(2);
  });
  it('refuses unknown keys and a missing palette', () => {
    expect(() => pixelOptions.parse({ grid: [16, 16], palette: 'game', x: 1 })).toThrow();
    expect(() => pixelOptions.parse({ grid: [16, 16] })).toThrow();
  });
});
