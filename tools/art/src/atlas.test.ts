// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { atlasBytes, opaqueBounds, packAtlas, unpackCell, visibleDiff } from './atlas';
import type { Rgba } from './image';

/** A w x h cell, transparent, with an opaque block of the given colour at (bx, by) of size (bw, bh). */
function cell(w: number, h: number, block?: { x: number; y: number; w: number; h: number; c: number }): Rgba {
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  if (block) {
    for (let y = block.y; y < block.y + block.h; y++) {
      for (let x = block.x; x < block.x + block.w; x++) out.data.set([block.c, block.c / 2, 7, 255], (y * w + x) * 4);
    }
  }
  return out;
}

describe('opaqueBounds', () => {
  it('is the rectangle of the visible pixels, with a pixel of margin kept inside the cell', () => {
    expect(opaqueBounds(cell(20, 20, { x: 5, y: 6, w: 3, h: 4, c: 200 }))).toEqual({ x: 4, y: 5, w: 5, h: 6 });
    expect(opaqueBounds(cell(20, 20, { x: 0, y: 0, w: 2, h: 2, c: 200 }))).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(opaqueBounds(cell(20, 20, { x: 18, y: 19, w: 2, h: 1, c: 200 }))).toEqual({ x: 17, y: 18, w: 3, h: 2 });
  });
  it('is null for a cell with nothing in it, and counts any alpha above 0 as visible', () => {
    expect(opaqueBounds(cell(8, 8))).toBeNull();
    const faint = cell(8, 8);
    faint.data[(3 * 8 + 4) * 4 + 3] = 1;
    expect(opaqueBounds(faint, 0)).toEqual({ x: 4, y: 3, w: 1, h: 1 });
  });
});

describe('packAtlas', () => {
  const cells = [cell(100, 100, { x: 10, y: 10, w: 20, h: 30, c: 10 }), cell(100, 100, { x: 50, y: 40, w: 40, h: 10, c: 20 }), cell(100, 100), cell(100, 100, { x: 0, y: 0, w: 100, h: 100, c: 30 })];

  it('crops each cell to its own bounds (not the union) and lays them out without overlap', () => {
    const { atlas, pages } = packAtlas(cells);
    expect(atlas.cells).toHaveLength(4);
    expect(atlas.cells[0]!.slice(3)).toEqual([22, 32, 9, 9]);
    expect(atlas.cells[1]!.slice(3)).toEqual([42, 12, 49, 39]);
    expect(atlas.cells[2]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(atlas.cells[3]!.slice(3)).toEqual([100, 100, 0, 0]);
    // no rectangle of a page overlaps another, and a gutter of at least a pixel lies between neighbours
    const real = atlas.cells.filter(c => c[3] > 0);
    for (const a of real) for (const b of real) {
      if (a === b || a[0] !== b[0]) continue;
      const apart = a[1] + a[3] + 1 <= b[1] || b[1] + b[3] + 1 <= a[1] || a[2] + a[4] + 1 <= b[2] || b[2] + b[4] + 1 <= a[2];
      expect(apart).toBe(true);
    }
    for (const [i, [w, h]] of atlas.pages.entries()) expect([pages[i]!.width, pages[i]!.height]).toEqual([w, h]);
  });

  it('keeps every cell\'s pixels: unpacking gives the cell back, in the union, with the margin transparent', () => {
    const { atlas, pages } = packAtlas(cells);
    cells.forEach((c, i) => expect(Array.from(unpackCell(pages, atlas, i, [100, 100]).data)).toEqual(Array.from(c.data)));
  });

  it('costs less than the union cells it replaces', () => {
    const { atlas } = packAtlas(cells.slice(0, 2));
    expect(atlasBytes(atlas)).toBeLessThan(2 * 100 * 100 * 4);
  });

  it('starts another page when a page would pass 4096 on a side, and never makes one that does', () => {
    const many = Array.from({ length: 6 }, (_, i) => cell(3000, 3000, { x: 0, y: 0, w: 3000, h: 3000, c: 10 + i }));
    const { atlas } = packAtlas(many);
    expect(atlas.pages.length).toBeGreaterThan(1);
    for (const [w, h] of atlas.pages) {
      expect(w).toBeLessThanOrEqual(4096);
      expect(h).toBeLessThanOrEqual(4096);
    }
    for (const c of atlas.cells) expect(c[0]).toBeLessThan(atlas.pages.length);
  });

  it('refuses a cell that no page could hold', () => {
    expect(() => packAtlas([cell(5000, 10, { x: 0, y: 0, w: 5000, h: 10, c: 9 })])).toThrow(/over the 4096/);
  });

  it('makes a page near square for what is in it, so a long strip does not become one 4096-wide row', () => {
    const many = Array.from({ length: 16 }, (_, i) => cell(100, 100, { x: 0, y: 0, w: 100, h: 100, c: 1 + i }));
    const { atlas } = packAtlas(many);
    expect(atlas.pages).toHaveLength(1);
    const [w, h] = atlas.pages[0]!;
    expect(Math.max(w, h) / Math.min(w, h)).toBeLessThan(2);
  });

  it('has no pages for cells with nothing visible', () => {
    const { atlas, pages } = packAtlas([cell(10, 10), cell(10, 10)]);
    expect(atlas.pages).toEqual([]);
    expect(pages).toEqual([]);
  });
});

describe('visibleDiff', () => {
  it('measures only what can be seen', () => {
    const a = cell(4, 4, { x: 1, y: 1, w: 2, h: 2, c: 100 });
    const b = cell(4, 4, { x: 1, y: 1, w: 2, h: 2, c: 100 });
    expect(visibleDiff([a], [b])).toBe(0);
    b.data[(1 * 4 + 1) * 4] = 110;
    expect(visibleDiff([a], [b])).toBeCloseTo(10 / 16);
    // what lies under a transparent pixel is not counted
    const c = cell(4, 4, { x: 1, y: 1, w: 2, h: 2, c: 100 });
    c.data[0] = 99;
    expect(visibleDiff([a], [c])).toBe(0);
  });
});
