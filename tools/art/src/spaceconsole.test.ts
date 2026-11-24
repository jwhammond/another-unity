// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { IndexedImage } from '../../../engine/src/view/indexed';
import { ATLAS, colourPicture, cutPicture, notArt, pagesAtlas, REPAINTED, shelfPack } from './spaceconsole';

const pic = (width: number, height: number, fill: number): IndexedImage => ({ width, height, pixels: new Uint8Array(width * height).fill(fill) });
/** A made-up palette: entry i is (i, 255 - i, 7). */
const palette = Uint8Array.from({ length: 768 }, (_, k) => (k % 3 === 0 ? Math.floor(k / 3) : k % 3 === 1 ? 255 - Math.floor(k / 3) : 7));

describe('the console\'s pictures for the art (Plan 30 R5)', () => {
  it('repaints the pages\' pictures, the tabs, the buttons\' states and their stand-ins: 81 of space.mrg\'s entries, none twice', () => {
    expect(REPAINTED.length).toBe(81);
    expect(new Set(REPAINTED).size).toBe(81);
    // (a lamp, a salvo mark, a maneuver row, a digit and the decimal point are upscaled only)
    expect([49, 97, 112, 115, 128].filter(i => REPAINTED.includes(i))).toEqual([]);
    expect([106, 73, 41, 83, 65].every(i => REPAINTED.includes(i))).toBe(true);
  });

  it('colours a picture, clearing what a blit skips and the live entries the console draws itself (R6, R12)', () => {
    const p = colourPicture({ width: 3, height: 1, pixels: Uint8Array.from([13, 200, 250]) }, palette, notArt);
    expect([...p.data]).toEqual([13, 242, 7, 0, 200, 55, 7, 255, 250, 5, 7, 0]);
    expect([notArt(0), notArt(0xac), notArt(245), notArt(255), notArt(13), notArt(128)]).toEqual([true, true, true, true, true, false]);
  });

  it('shelves pictures tallest first, a gutter apart, and refuses what doesn\'t fit', () => {
    expect(shelfPack([[10, 5], [20, 8], [30, 8]], 70, 40, 4)).toEqual([[4, 16], [38, 4], [4, 4]]);
    expect(() => shelfPack([[60, 5], [60, 5]], 70, 12, 4)).toThrow('don\'t fit a 70 x 12 atlas');
  });

  it('lays the repainted pictures on an 800 x 600 atlas on colour 0, and cuts each back at 4x with its clear pixels', () => {
    const images = Array.from({ length: 138 }, (_, i) => pic(10 + (i % 5), 6, 130));
    images[73]!.pixels[0] = 13;
    const { atlas, places } = pagesAtlas(images, palette);
    expect([atlas.width, atlas.height, places.length]).toEqual([...ATLAS, 81]);
    expect([...atlas.data.subarray(0, 4)]).toEqual([0, 255, 7, 255]);
    const at = places.find(p => p.image === 73)!;
    const big = { width: 3200, height: 2400, data: new Uint8Array(3200 * 2400 * 4).fill(90) };
    const cut = cutPicture(big, 4, at, images[73]!);
    expect([cut.width, cut.height, cut.data[3], cut.data[4 * 4 + 3]]).toEqual([4 * images[73]!.width, 24, 0, 90]);
  });
});
