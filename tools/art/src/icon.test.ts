// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { cutOut, flatSquare, iconPixels, iconRecipe, iconSquare, mrgIcon, parseMrg } from './icon';
import type { Rgba } from './image';

/** An MRG of the given entries (count, offsets, then width, height and indices each). */
function mrgOf(entries: { width: number; height: number; pixels: number[] }[]): Uint8Array {
  const size = 2 + entries.length * 4 + entries.reduce((n, e) => n + 4 + e.pixels.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, entries.length, true);
  let off = 2 + entries.length * 4;
  entries.forEach((e, i) => {
    dv.setUint32(2 + i * 4, off, true);
    dv.setUint16(off, e.width, true);
    dv.setUint16(off + 2, e.height, true);
    out.set(e.pixels, off + 4);
    off += 4 + e.pixels.length;
  });
  return out;
}

describe('art icon', () => {
  it('the five standard-kit recipes parse, each on its game icon', () => {
    const src: Record<string, string> = { tricorder: 'tricrdr.spr', med_tricorder: 'meditric.spr', med_kit: 'medkit.spr', phaser: 'phaser2.spr', communicator: 'awayteam.mrg' };
    for (const [item, file] of Object.entries(src)) {
      const r = iconRecipe.parse(parseYaml(readFileSync(new URL(`../../../art/recipes/icon.${item}.yaml`, import.meta.url), 'utf8')));
      expect(r.object).toBe(item);
      expect('sprite' in r.source ? r.source.sprite : r.source.mrg).toBe(file);
      expect(r.variants.map(v => v.name)).toContain(r.pick);
    }
  });
  it('reads MRG entries and colours a crop from standard.pal (upper half), index 0 transparent', () => {
    const mrg = mrgOf([
      { width: 1, height: 1, pixels: [5] },
      { width: 3, height: 2, pixels: [0, 128, 129, 130, 5, 0] },
    ]);
    const e = parseMrg(mrg);
    expect(e.map(x => [x.width, x.height])).toEqual([[1, 1], [3, 2]]);
    const pal = new Uint8Array(128 * 3);
    pal.set([63, 0, 0], 0);
    pal.set([0, 10, 0], 3);
    pal.set([0, 0, 20], 6);
    const img = mrgIcon(mrg, pal, 1, [1, 0, 2, 2]);
    expect([...img.data]).toEqual([252, 0, 0, 255, 0, 40, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0]);
  });
  it('centres the icon on a square, cuts it back out with its alpha, and pixelates on the opaque cells only', () => {
    const icon: Rgba = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };
    for (let i = 0; i < 8; i++) icon.data.set(i % 4 === 0 ? [0, 0, 0, 0] : [200, 100, 50, 255], i * 4);
    expect(iconSquare(icon)).toEqual({ side: 4, x: 0, y: 1 });
    const flat = flatSquare(icon, [10, 20, 30]);
    expect([...flat.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...flat.data.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([200, 100, 50, 255]);
    // the work picture at 4x: the icon's rows are 4..11
    const work: Rgba = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) work.data.set(y >= 4 && y < 12 ? [x * 10, 0, 0, 255] : [0, 255, 0, 255], (y * 16 + x) * 4);
    const cut = cutOut(work, icon);
    expect([cut.width, cut.height]).toEqual([16, 8]);
    expect(cut.data[1]).toBe(0);
    const grid = iconPixels(cut, icon, { kmeans: 2, scale: 1 });
    expect([grid.width, grid.height]).toEqual([4, 2]);
    expect(grid.data[3]).toBe(0);
    expect(grid.data[4 + 3]).toBe(255);
  });
});
