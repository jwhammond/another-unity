// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { BridgeStrip } from './bridgeanim';
import { cellOf, grid, overPlate, ticks } from './bridgetrial';
import type { Rgba } from './image';

const solid = (w: number, h: number, rgba: number[]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};
/** Two 4x8 cells side by side: red, then green, at scale 4. */
function strip(): BridgeStrip {
  const s = solid(8, 8, [0, 0, 0, 0]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s.data.set(x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 8 + x) * 4);
  return { scale: 4, strip: s, frames: 2, columns: 2, cell: [4, 8], anchor: [0.5, 1], delays: [100, 300], loop: true };
}

describe('the bridge trial', () => {
  it('cuts a strip into its cells', () => {
    expect([...cellOf(strip(), 1).data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  });

  it("sets a cell over the plate with its anchor on the crew member's place", () => {
    // (a 2560-wide plate is 4 to the original's pixel, as the strip is)
    const plate = solid(2560, 1920, [10, 10, 10, 255]);
    const out = overPlate(plate, strip(), 0, [100, 100], [90, 90, 20, 20]);
    expect([out.width, out.height]).toEqual([80, 80]);
    // (the cell is 1x2 original pixels, its foot's middle at (100, 100): x 99.5-100.5, y 98-100)
    const at = (x: number, y: number) => [...out.data.subarray((y * 80 + x) * 4, (y * 80 + x) * 4 + 4)];
    expect(at(40, 35)).toEqual([255, 0, 0, 255]);
    expect(at(10, 10)).toEqual([10, 10, 10, 255]);
  });

  it('shows each frame for its delay, at a video rate', () => {
    expect(ticks([100, 300], 10, 1)).toEqual([0, 1, 1, 1]);
    expect(ticks([100, 300], 10, 2)).toHaveLength(8);
  });

  it('lays frames out in a grid', () => {
    const g = grid([solid(2, 2, [1, 1, 1, 255]), solid(2, 2, [2, 2, 2, 255]), solid(2, 2, [3, 3, 3, 255])], 2);
    expect([g.width, g.height]).toEqual([4, 4]);
    expect(g.data[(2 * 4 + 0) * 4]).toBe(3);
  });
});
