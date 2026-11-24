// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { alignCheck } from './align';
import type { Rgba } from './image';
import type { CheckPoint } from './points';
import { applyWarp, warpPlate } from './warp';

/** The align test's kind of scene: a gentle gradient and rectangles whose corners are the points to check. */
function scene(): Rgba {
  const w = 640;
  const h = 480;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([60 + x / 16, 70 + y / 16, 80, 255], (y * w + x) * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...c, 255], (y * w + x) * 4);
  };
  rect(100, 100, 220, 200, [220, 210, 190]);
  rect(300, 60, 380, 260, [30, 30, 40]);
  rect(420, 300, 560, 400, [250, 240, 60]);
  rect(60, 320, 180, 420, [90, 160, 110]);
  rect(140, 140, 180, 170, [20, 20, 20]);
  return { width: w, height: h, data };
}
const corners: CheckPoint[] = [
  [100, 100], [220, 100], [100, 200], [220, 200], [300, 60], [380, 260], [420, 300], [560, 400], [60, 320], [180, 420],
].map(([x, y], i) => ({ x: x!, y: y!, source: `corner ${i}` }));

/** The plate's content around (x, y) moved by (dx, dy) pixels, smoothly, nothing beyond `radius`. */
const displaced = (img: Rgba, x: number, y: number, dx: number, dy: number): Rgba => applyWarp(img, 1, [{ x, y, dx: -dx, dy: -dy }], 24);

function upscale(img: Rgba, k: number): Rgba {
  const w = img.width * k;
  const h = img.height * k;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(img.data.subarray((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4 + 4), (y * w + x) * 4);
  return { width: w, height: h, data: out };
}
function shifted(img: Rgba, dx: number, dy: number): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x - dx));
      const sy = Math.min(img.height - 1, Math.max(0, y - dy));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
    }
  }
  return { width: img.width, height: img.height, data: out };
}

describe('warpPlate', () => {
  const original = scene();

  it('fixes a local 4 px displacement near one point, and the plate then passes the check', () => {
    const plate = displaced(original, 220, 200, 4, 0);
    expect(alignCheck(original, plate, corners).ok).toBe(false);
    const { plate: fixed, report } = warpPlate(original, plate, corners);
    expect(report.changed).toBe(true);
    expect(report.refused).toBeUndefined();
    expect(report.passes[0]!.warped.map(p => p.source)).toEqual(['corner 3']);
    expect(report.passes[0]!.warped[0]!.dx).toBeGreaterThan(3);
    expect(alignCheck(original, fixed, corners).ok).toBe(true);
  });

  it('fixes the same on a 4x plate, and leaves the pixels far from the point as they were', () => {
    const big = upscale(original, 4);
    const plate = applyWarp(big, 4, [{ x: 220, y: 200, dx: -4, dy: 3 }], 24);
    expect(alignCheck(original, plate, corners).ok).toBe(false);
    const { plate: fixed } = warpPlate(original, plate, corners);
    expect(alignCheck(original, fixed, corners).ok).toBe(true);
    // beyond the radius (24 original = 96 plate pixels) nothing moved
    const i = (400 * big.width + 2000) * 4;
    expect(Array.from(fixed.data.subarray(i, i + 4))).toEqual(Array.from(plate.data.subarray(i, i + 4)));
  });

  it('leaves a plate with no shift bit-identical', () => {
    const { plate, report } = warpPlate(original, original, corners);
    expect(report.changed).toBe(false);
    expect(plate).toBe(original);
    expect(report.passes[0]!.warped).toEqual([]);
  });

  it('does not warp a point it cannot measure (a flat window)', () => {
    const flat: Rgba = { width: 640, height: 480, data: new Uint8Array(640 * 480 * 4).fill(128) };
    const { report } = warpPlate(flat, shifted(flat, 3, 0), [{ x: 320, y: 240, source: 'flat' }]);
    expect(report.changed).toBe(false);
  });

  it('refuses a global 3 px shift (not papered over): the plate is returned as it was and the check still fails it', () => {
    const plate = shifted(original, 3, 0);
    const { plate: out, report } = warpPlate(original, plate, corners);
    expect(report.refused).toMatch(/not a local touch-up/);
    expect(report.changed).toBe(false);
    expect(out).toBe(plate);
    expect(alignCheck(original, out, corners).ok).toBe(false);
  });

  it('does not warp a point further off than maxWarp (a 9 px displacement stays a failure)', () => {
    const plate = displaced(original, 220, 200, 9, 0);
    const { plate: out, report } = warpPlate(original, plate, corners);
    expect(report.changed).toBe(false);
    expect(report.passes[0]!.skipped.some(s => /beyond the 5 px/.test(s.why))).toBe(true);
    expect(alignCheck(original, out, corners).ok).toBe(false);
  });
});
