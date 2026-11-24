// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { clearView, relayoutSheet } from './spacesheet';

/** A sheet of `frames` frames, each w x h, filled with its frame's number; frame f's first pixel clear. */
function sheet(frames: number, columns: number, w: number, h: number): Rgba {
  const rows = Math.ceil(frames / columns);
  const img: Rgba = { width: columns * w, height: rows * h, data: new Uint8Array(columns * w * rows * h * 4) };
  for (let f = 0; f < frames; f++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (((Math.floor(f / columns) * h + y) * img.width) + (f % columns) * w + x) * 4;
    img.data.set([f, f, f, x === 0 && y === 0 ? 0 : 255], i);
  }
  return img;
}
const up = (img: Rgba, k: number): Rgba => {
  const out: Rgba = { width: img.width * k, height: img.height * k, data: new Uint8Array(img.width * k * img.height * k * 4) };
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(img.data.subarray(((Math.floor(y / k)) * img.width + Math.floor(x / k)) * 4, ((Math.floor(y / k)) * img.width + Math.floor(x / k)) * 4 + 3), (y * out.width + x) * 4);
  return out;
};

describe('an effect\'s upscaled sheet (Plan 30 R11)', () => {
  it('lays ten 320-wide frames, four times as big, in rows of three under 4096, in order, with the original\'s clear pixels', () => {
    const s = sheet(10, 10, 320, 2);
    const r = relayoutSheet(up(s, 4), { frames: 10, columns: 10, cell: [320, 2] }, 4, s);
    expect([r.columns, r.cell, r.picture.width, r.picture.height]).toEqual([3, [1280, 8], 3840, 32]);
    // (frame 4: row 1, column 1; its first pixel's 4 x 4 block clear, the rest opaque)
    const at = (x: number, y: number) => [...r.picture.data.subarray((y * r.picture.width + x) * 4, (y * r.picture.width + x) * 4 + 4)];
    expect([at(1280, 8), at(1283, 11), at(1284, 8)]).toEqual([[4, 4, 4, 0], [4, 4, 4, 0], [4, 4, 4, 255]]);
    expect(at(0, 24)).toEqual([9, 9, 9, 0]);
  });

  it('refuses an upscale that isn\'t the sheet\'s scale', () => {
    expect(() => relayoutSheet(sheet(2, 2, 4, 4), { frames: 2, columns: 2, cell: [4, 4] }, 4, sheet(2, 2, 4, 4))).toThrow('isn\'t 4 times the sheet');
  });
});

describe('the console\'s published plate (Plan 30 R7)', () => {
  it('clears the view\'s rectangle at the plate\'s scale and nothing else', () => {
    const plate: Rgba = { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(200) };
    const c = clearView(plate, [2, 1, 1, 1], 4);
    const alpha = (x: number, y: number) => c.data[(y * 16 + x) * 4 + 3];
    expect([alpha(8, 4), alpha(11, 7), alpha(7, 4), alpha(12, 4), alpha(8, 3)]).toEqual([0, 0, 200, 200, 200]);
  });
});
