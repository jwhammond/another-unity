// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { denoiseMask, MASK_DEFAULTS, maskToRgba } from './maskdenoise';

function flat(w: number, h: number, v: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([v, v, v, 255], i * 4);
  return { width: w, height: h, data };
}
const at = (g: { width: number; data: Float32Array }, x: number, y: number): number => g.data[y * g.width + x]!;

describe('denoiseMask', () => {
  const o = { ...MASK_DEFAULTS, protect: 0.4 };
  it('leaves a flat image with no hotspots fully open', () => {
    const m = denoiseMask(flat(160, 120, 90), { rects: [], polygons: [] }, [160, 120], o);
    expect(Math.min(...m.data)).toBeCloseTo(1, 5);
  });
  it('protects a small rect whole and the corners and outline of a large one, but not its interior', () => {
    const geom = { rects: [[20, 20, 40, 40] as [number, number, number, number], [200, 100, 560, 400] as [number, number, number, number]], polygons: [] };
    const m = denoiseMask(flat(640, 480, 90), geom, [640, 480], o);
    expect(at(m, 30, 30)).toBeCloseTo(0.4, 1);
    expect(at(m, 200, 100)).toBeCloseTo(0.4, 1);
    expect(at(m, 380, 100)).toBeLessThan(0.5);
    expect(at(m, 380, 250)).toBeGreaterThan(0.99);
    expect(at(m, 620, 450)).toBeGreaterThan(0.99);
  });
  it('protects floor polygon edges and strong edges of the original', () => {
    const img = flat(640, 480, 40);
    for (let y = 0; y < 480; y++) for (let x = 400; x < 640; x++) img.data.set([220, 220, 220, 255], (y * 640 + x) * 4);
    const geom = { rects: [], polygons: [[{ x: 20, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 460 }, { x: 20, y: 460 }]] };
    const m = denoiseMask(img, geom, [640, 480], o);
    expect(at(m, 160, 300)).toBeLessThan(0.45);
    expect(at(m, 160, 380)).toBeGreaterThan(0.99);
    expect(at(m, 400, 100)).toBeLessThan(0.45);
    expect(at(m, 100, 100)).toBeGreaterThan(0.99);
  });
  it('is made at the work size and written as 8-bit grey', () => {
    const m = denoiseMask(flat(64, 48, 90), { rects: [[10, 10, 20, 20]], polygons: [] }, [128, 96], o);
    expect([m.width, m.height]).toEqual([128, 96]);
    const rgba = maskToRgba(m);
    expect(rgba.data[3]).toBe(255);
    expect(rgba.data[0]).toBe(rgba.data[1]);
  });
});

describe('emissive regions', () => {
  it('protects saturated and very bright pixels of the original, and nothing in a dull grey room', () => {
    const img = flat(640, 480, 90);
    for (let y = 200; y < 230; y++) for (let x = 100; x < 140; x++) img.data.set([20, 220, 60, 255], (y * 640 + x) * 4);
    for (let y = 100; y < 110; y++) for (let x = 400; x < 420; x++) img.data.set([250, 250, 250, 255], (y * 640 + x) * 4);
    const o = { ...MASK_DEFAULTS, protect: 0.2, feather: 0 };
    const m = denoiseMask(img, { rects: [], polygons: [] }, [640, 480], o);
    expect(at(m, 120, 215)).toBeCloseTo(0.2, 1);
    expect(at(m, 410, 105)).toBeCloseTo(0.2, 1);
    expect(at(m, 300, 300)).toBeGreaterThan(0.99);
    const off = denoiseMask(img, { rects: [], polygons: [] }, [640, 480], { ...o, emissiveSat: 2, emissiveLum: 2, edgeLow: 0.99, edgeHigh: 1 });
    expect(at(off, 120, 215)).toBeGreaterThan(0.99);
  });
});

describe('denoiseMask keep rects', () => {
  it('keep rects are 0 in the mask even where the original is emissive or edged', () => {
    const img = flat(640, 480, 40);
    // a bright emissive block and a hard edge inside the kept strip
    for (let y = 380; y < 440; y++) for (let x = 100; x < 300; x++) img.data.set([255, 200, 0, 255], (y * 640 + x) * 4);
    const geom = { rects: [[10, 10, 60, 60] as [number, number, number, number]], polygons: [], keep: [[0, 364, 640, 116] as [number, number, number, number]] };
    const m = denoiseMask(img, geom, [1152, 864], { ...MASK_DEFAULTS, protect: 0.2 });
    const s = 1152 / 640;
    const px = (x: number, y: number): number => at(m, Math.floor(x * s), Math.floor(y * s));
    expect(px(150, 400)).toBe(0);
    expect(px(10, 366)).toBe(0);
    expect(px(639, 479)).toBe(0);
    expect(at(m, 0, Math.ceil(364 * s))).toBe(0);
    expect(at(m, 600, Math.floor(364 * s) - 1)).toBeGreaterThan(0.5);
    expect(px(300, 100)).toBeGreaterThan(0.99);
    // without keep the same pixel is protected, but not 0
    const free = denoiseMask(img, { ...geom, keep: undefined }, [1152, 864], { ...MASK_DEFAULTS, protect: 0.2 });
    expect(at(free, Math.floor(150 * s), Math.floor(400 * s))).toBeCloseTo(0.2, 1);
  });
});

describe('denoiseMask keepMask (the viewscreen window)', () => {
  it('is 0 where the window mask is 1, and open elsewhere', () => {
    const img = flat(640, 480, 40);
    const mask = new Uint8Array(640 * 480);
    for (let y = 100; y < 260; y++) for (let x = 100; x < 500; x++) mask[y * 640 + x] = 1;
    const m = denoiseMask(img, { rects: [], polygons: [], keepMask: { mask, width: 640, height: 480 } }, [1152, 864], { ...MASK_DEFAULTS, protect: 0.2 });
    const s = 1152 / 640;
    expect(at(m, Math.floor(300 * s), Math.floor(180 * s))).toBe(0);
    expect(at(m, Math.floor(50 * s), Math.floor(180 * s))).toBeGreaterThan(0.99);
    expect(at(m, Math.floor(300 * s), Math.floor(300 * s))).toBeGreaterThan(0.99);
  });
});
