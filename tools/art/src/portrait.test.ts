// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { drawText, textSize } from './font';
import type { Rgba } from './image';
import { blur, cropPadded, gameBackdrop, labStats, labToRgb, polygonMask, reinhard, rgbToLab } from './portrait';

const solid = (w: number, h: number, rgb: [number, number, number]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};

describe('portrait pixels', () => {
  it('Lab round-trips sRGB', () => {
    for (const c of [[0, 0, 0], [255, 255, 255], [200, 120, 40], [30, 90, 200]] as [number, number, number][]) {
      const back = labToRgb(...rgbToLab(...c));
      back.forEach((v, i) => expect(Math.abs(v - c[i]!)).toBeLessThanOrEqual(1));
    }
  });
  it('fills a polygon at pixel centres', () => {
    const m = polygonMask(4, 4, [[1, 1], [3, 1], [3, 3], [1, 3]]);
    expect([...m]).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  });
  it('blurs without losing mass on a flat field', () => {
    const b = blur(new Float32Array(25).fill(0.5), 5, 5, 2);
    for (const v of b) expect(v).toBeCloseTo(0.5);
  });
  it('repeats edge pixels past the frame', () => {
    const img: Rgba = { width: 2, height: 1, data: new Uint8Array([10, 0, 0, 255, 20, 0, 0, 255]) };
    const c = cropPadded(img, [-1, 0, 4, 1]);
    expect([c.data[0], c.data[4], c.data[8], c.data[12]]).toEqual([10, 10, 20, 20]);
  });
  it('moves colours to the target statistics, and leaves them at amount 0', () => {
    const a = solid(2, 2, [200, 100, 50]);
    const b = solid(2, 2, [40, 80, 160]);
    expect(reinhard(a, labStats(a), labStats(b), 0).data).toEqual(a.data);
    const moved = reinhard(a, labStats(a), labStats(b), 1);
    [40, 80, 160].forEach((v, i) => expect(Math.abs(moved.data[i]! - v)).toBeLessThanOrEqual(1));
  });
  it('builds the backdrop from the portrait blue only', () => {
    const g = solid(4, 4, [20, 60, 140]);
    g.data.set([220, 120, 60, 255], (1 * 4 + 1) * 4);
    const back = gameBackdrop(g, 8, 1);
    for (let i = 0; i < 64; i++) expect(back.data[i * 4 + 2]! > back.data[i * 4]!).toBe(true);
  });
});

describe('labels', () => {
  it('draws glyph pixels inside its measured box', () => {
    const img = solid(40, 20, [0, 0, 0]);
    drawText(img, 'A1', 2, 2, { scale: 1 });
    const [w, h] = textSize('A1', 1);
    let lit = 0;
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 40; x++)
        if (img.data[(y * 40 + x) * 4] === 255) {
          lit++;
          expect(x >= 2 && x < 2 + w && y >= 2 && y < 2 + h).toBe(true);
        }
    expect(lit).toBeGreaterThan(10);
  });
});
