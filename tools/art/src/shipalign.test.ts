// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { alignIds, alignOverlay } from './shipalign';

const W = 64;
const H = 48;
function blank(bg = 0x282828): Rgba {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([(bg >> 16) & 255, (bg >> 8) & 255, bg & 255, 255], i * 4);
  return { width: W, height: H, data };
}
function fill(img: Rgba, x0: number, y0: number, x1: number, y1: number, colour: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([(colour >> 16) & 255, (colour >> 8) & 255, colour & 255, 255], (y * W + x) * 4);
}
const RED = 0xe6194b;
const GREEN = 0x3cb44b;

describe('shipalign', () => {
  it('coverage and spill per item; pass at >= 0.80 / <= 0.12', () => {
    const img = blank();
    fill(img, 10, 10, 30, 20, RED); // rect 10,10 20x10 = 200 px, fully covered
    fill(img, 40, 10, 50, 20, GREEN); // rect 40,10 10x10 = 100: 85 covered + 10 spill
    img.data.set([0x28, 0x28, 0x28, 255], (10 * W + 40) * 4);
    const fits = alignIds(img, [
      { index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED },
      { index: 1, action: '2', rect: [40, 10, 10, 10], colour: GREEN },
    ]);
    expect(fits[0]).toMatchObject({ index: 0, coverage: 1, spill: 0, pass: true });
    expect(fits[1]!.coverage).toBeCloseTo(0.99, 2);
    const half = blank();
    fill(half, 10, 10, 30, 14, RED); // 40% of the rect
    expect(alignIds(half, [{ index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED }])[0]!.pass).toBe(false);
    const spilled = blank();
    fill(spilled, 10, 10, 30, 20, RED);
    fill(spilled, 10, 20, 30, 24, RED); // 80 px below: spill 0.4
    const f = alignIds(spilled, [{ index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED }])[0]!;
    expect(f.spill).toBeCloseTo(0.4, 6);
    expect(f.pass).toBe(false);
  });
  it('an item tagged on three meshes counts their union', () => {
    const img = blank();
    fill(img, 10, 10, 15, 20, RED);
    fill(img, 15, 10, 22, 20, RED); // abutting meshes: one colour
    fill(img, 25, 10, 30, 20, RED);
    const f = alignIds(img, [{ index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED }])[0]!;
    expect(f.coverage).toBeCloseTo(0.85, 6);
    expect(f.pass).toBe(true);
  });
  it('matches a colour to within 3 levels a channel and no further', () => {
    const img = blank();
    fill(img, 10, 10, 30, 20, 0xe81b4d); // +2, +2, +2 from RED
    expect(alignIds(img, [{ index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED }])[0]!.coverage).toBe(1);
    const far = blank();
    fill(far, 10, 10, 30, 20, 0xee1f51);
    expect(alignIds(far, [{ index: 0, action: '1', rect: [10, 10, 20, 10], colour: RED }])[0]!.coverage).toBe(0);
  });
  it('clips a rectangle that leaves the frame', () => {
    const img = blank();
    fill(img, 0, 0, 10, 10, RED);
    const f = alignIds(img, [{ index: 0, action: '1', rect: [-10, 0, 20, 10], colour: RED }])[0]!;
    expect(f.coverage).toBeCloseTo(0.5, 6); // 100 of the rect's 200 px are inside the frame, and all are covered... of the full rect's area
  });
  it('the overlay draws failures in red and passes in yellow, over the dimmed original', () => {
    const img = blank();
    fill(img, 10, 10, 30, 20, RED);
    const orig = blank(0xffffff);
    const items = [
      { index: 0, action: '1', rect: [10, 10, 20, 10] as [number, number, number, number], colour: RED },
      { index: 1, action: '2', rect: [40, 30, 10, 10] as [number, number, number, number], colour: GREEN },
    ];
    const fits = alignIds(img, items);
    const o = alignOverlay(orig, img, items, fits);
    const px = (x: number, y: number): number[] => [...o.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
    expect(px(10, 10)).toEqual([255, 230, 0]); // pass: yellow outline
    expect(px(40, 30)).toEqual([255, 0, 0]); // fail: red outline
    expect(px(60, 45)[0]).toBeCloseTo(128, -1); // original at 50%
  });
});
