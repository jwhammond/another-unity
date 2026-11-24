// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { layerMode, layerResident, RING_FRAMES } from './layerMemory';

describe('layerResident', () => {
  const cells = [[0, 0, 0, 100, 50, 0, 0], [0, 100, 0, 40, 80, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 60, 10, 10, 0, 0]];
  it('sizes the texture to the largest width and height, and the ring to three of the largest cell', () => {
    const r = layerResident([{ cells }]);
    expect(r.texture).toEqual([100, 80]);
    expect(r.surface).toBe(2 * 100 * 80 * 4);
    expect(r.ring).toBe(RING_FRAMES * 100 * 50 * 4);
    expect(r.grid).toBe(0);
  });
  it('shares one texture across the layer\'s animations, and counts a grid strip whole', () => {
    const r = layerResident([{ cells: [[0, 0, 0, 10, 10, 0, 0]] }, { cells: [[0, 0, 0, 20, 5, 0, 0]] }, { gridBytes: 1000 }]);
    expect(r.texture).toEqual([20, 10]);
    expect(r.grid).toBe(1000);
    // (two cells: the ring never holds more than there is)
    expect(r.ring).toBe(2 * 100 * 4);
  });
  it('is nothing for a layer of clear cells', () => {
    expect(layerResident([{ cells: [[0, 0, 0, 0, 0, 0, 0]] }])).toMatchObject({ ring: 0, surface: 0 });
  });
});

describe('layerMode', () => {
  const big = (n: number, side: number) => ({ cells: Array.from({ length: n }, (_, i) => [0, 0, i * side, side, side, 0, 0]), pages: [[side, side * n]], files: ['p.webp'] });
  it('uploads the pages whole when a few big cells cost more streamed (horst3.glow: 4 of 1088x760)', () => {
    const glow = { cells: [0, 1, 2, 3].map(i => [0, 0, i * 760, 1088, 760, 0, 0]), pages: [[1088, 3040]], files: ['g.webp'] };
    const stream = layerResident([glow], 'stream');
    const whole = layerResident([glow], 'whole');
    expect(layerMode([glow])).toBe('whole');
    expect(whole.ring + whole.surface).toBe(0);
    expect([...whole.pages]).toEqual([['g.webp', 1088 * 3040 * 4]]);
    expect(stream.ring + stream.surface).toBeGreaterThan(1088 * 3040 * 4);
    expect(layerResident([glow]).mode).toBe('whole');
  });
  it('streams many cells (the hologram) and a layer with no atlas, and a tie', () => {
    expect(layerMode([big(119, 100)])).toBe('stream');
    expect(layerMode([{ gridBytes: 100 }])).toBe('stream');
    // 2 cells: ring 2 + surface 2 = 4 cells' worth against a page of exactly 4
    expect(layerMode([{ cells: [[0, 0, 0, 10, 10, 0, 0], [0, 0, 10, 10, 10, 0, 0]], pages: [[10, 20], [10, 20]], files: ['a', 'b'] }])).toBe('stream');
  });
  it('counts a page two animations share once, and decides for the whole layer', () => {
    const s = { cells: [[0, 0, 0, 10, 10, 0, 0], [0, 0, 10, 10, 10, 0, 0]], pages: [[10, 20]], files: ['a'] };
    const r = layerResident([s, s], 'whole');
    expect([...r.pages.values()]).toEqual([800]);
  });
});
