// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { frameAt, gridSheet } from './sheet';

const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};

describe('gridSheet', () => {
  it('lays four frames out 2x2', () => {
    const f = [solid(2, 2, [255, 0, 0]), solid(2, 2, [0, 255, 0]), solid(2, 2, [0, 0, 255]), solid(2, 2, [9, 9, 9])];
    const s = gridSheet(f, 2);
    expect([s.width, s.height]).toEqual([4, 4]);
    const px = (x: number, y: number) => [...s.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)];
    expect(px(0, 0)).toEqual([255, 0, 0]);
    expect(px(3, 0)).toEqual([0, 255, 0]);
    expect(px(0, 3)).toEqual([0, 0, 255]);
    expect(px(3, 3)).toEqual([9, 9, 9]);
  });
  it('leaves the unfilled cell black', () => {
    const s = gridSheet([solid(1, 1, [5, 5, 5]), solid(1, 1, [5, 5, 5]), solid(1, 1, [5, 5, 5])], 2);
    expect([...s.data.subarray((1 * 2 + 1) * 4, (1 * 2 + 1) * 4 + 4)]).toEqual([0, 0, 0, 255]);
  });
});

describe('frameAt', () => {
  it('cuts the i-th cell of a strip with `columns` per row', () => {
    const strip = gridSheet([solid(2, 2, [1, 1, 1]), solid(2, 2, [2, 2, 2]), solid(2, 2, [3, 3, 3]), solid(2, 2, [4, 4, 4])], 2);
    expect(frameAt(strip, [2, 2], 2, 3).data[0]).toBe(4);
    expect(frameAt(strip, [2, 2], 2, 1).data[0]).toBe(2);
  });
});
