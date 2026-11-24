// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FOCAL_PX } from '@another-unity/engine';
import { fitProjection, fitRows, MAX_BACK_DEPTH, type ScalePolygon } from './projection';

// scale 128 at row 250, 256 at row 399: the horizon is at row 101
const floor = { type: 1, points: [{ x: 100, y: 250 }, { x: 540, y: 250 }, { x: 600, y: 399 }, { x: 40, y: 399 }], distances: [128, 128, 256, 256] };

describe('fitProjection', () => {
  it('fits a level camera to the polygons\' scales', () => {
    const p = fitProjection([floor]);
    expect(p.params).toMatchObject({ kind: 'perspective', horizonY: 101, topY: 250, samples: 4, rms: 0 });
    expect(p.params.slope).toBeCloseTo(128 / 149, 5);
    // a pixel at full scale is METERS_PER_PIXEL wide; at half scale, twice that, and further away
    expect(p.toWorld(320, 399)).toEqual({ x: 0, z: 0 });
    expect(p.toWorld(420, 399)).toEqual({ x: 1.25, z: 0 });
    expect(p.toWorld(420, 250)).toEqual({ x: 2.5, z: -6.925 });
    expect(p.distance(40, 250)).toBe(1);
  });

  it('puts the camera at the height and distance the fit implies', () => {
    const c = fitProjection([floor]).camera();
    expect(c.kind).toBe('perspective');
    expect(c.position[0]).toBe(0);
    expect(c.position[1]).toBeCloseTo(3.725, 3);
    expect(c.position[2]).toBeCloseTo(6.925, 3);
    expect(c.yfov).toBeCloseTo(2 * Math.atan(240 / 554), 3);
    expect(c.horizonY).toBe(101);
  });

  it('falls back to a flat projection without polygons, or with equal scales', () => {
    const none = fitProjection([]);
    expect(none.params).toMatchObject({ kind: 'flat', meanScale: 256, samples: 0, topY: 0 });
    expect(none.toWorld(420, 399)).toEqual({ x: 1.25, z: 0 });
    expect(none.toWorld(320, 299)).toEqual({ x: 0, z: -2.5 });
    const level = fitProjection([{ ...floor, distances: [200, 200, 200, 200] }]);
    expect(level.params).toMatchObject({ kind: 'flat', meanScale: 200 });
    expect(level.unitsPerPixel(10)).toBeCloseTo(0.016, 6);
  });

  it('places rows above the floor\'s back edge on that edge, never at NaN or Infinity', () => {
    const p = fitProjection([floor]);
    for (const y of [0, 50, 101, 102, 249]) {
      expect(p.toWorld(320, y)).toEqual(p.toWorld(320, 250));
      expect(p.behindFloor(y)).toBe(true);
    }
    expect(p.behindFloor(250)).toBe(false);
    // a sky object 100 columns right of centre stays on the back edge, 100 back-edge pixels across
    expect(p.toWorld(420, 114)).toEqual({ x: 2.5, z: -6.925 });
  });

  it('leaves types 3 and 4 out of the fit, as scaleAt does (the real s_0701)', () => {
    const pt = (x: number, y: number) => ({ x, y });
    const s0701 = [
      { type: 0, points: [pt(176, 321), pt(236, 347), pt(268, 341), pt(308, 316), pt(192, 317)], distances: [130, 160, 150, 140, 125] },
      { type: 1, points: [pt(432, 329), pt(308, 316), pt(388, 339)], distances: [130, 140, 150] },
      { type: 1, points: [pt(388, 339), pt(332, 349), pt(284, 345), pt(268, 341), pt(308, 316)], distances: [150, 160, 160, 150, 140] },
      { type: 1, points: [pt(268, 341), pt(236, 347), pt(260, 349), pt(284, 345)], distances: [150, 160, 160, 160] },
      { type: 1, points: [pt(260, 349), pt(280, 359), pt(264, 361), pt(236, 347)], distances: [160, 180, 185, 160] },
      { type: 1, points: [pt(388, 339), pt(432, 329), pt(464, 332), pt(412, 346)], distances: [150, 130, 140, 160] },
      { type: 4, points: [pt(0, 0), pt(636, 0), pt(636, 400), pt(0, 400)], distances: [256, 256, 256, 256] },
      { type: 1, points: [pt(192, 317), pt(176, 321), pt(132, 309), pt(132, 300)], distances: [125, 130, 70, 70] },
    ];
    const p = fitProjection(s0701);
    expect(p.params).toMatchObject({ kind: 'perspective', samples: 29, topY: 300 });
    expect(p.params.slope).toBeCloseTo(1.438, 3);
    expect(p.params.horizonY).toBeCloseTo(234.6, 1);
    expect(p.params.rms).toBeCloseTo(11.5, 1);
    expect(p.depthFactor(336)).toBeCloseTo(554 / (336 - p.params.horizonY), 6);
  });

  it('lets an override replace the fit, and the metres per pixel', () => {
    const p = fitProjection([floor], { kind: 'flat', meanScale: 128 }, 0.02);
    expect(p.params).toMatchObject({ kind: 'flat', meanScale: 128, metersPerPixel: 0.02 });
    expect(p.toWorld(330, 399)).toEqual({ x: 0.4, z: 0 });
    expect(fitProjection([floor], { topY: 0 }).behindFloor(200)).toBe(false);
  });
});

const wide = (top: number, topScale: number, bottomScale: number): ScalePolygon => ({
  type: 1,
  points: [{ x: 0, y: top }, { x: 639, y: top }, { x: 639, y: 399 }, { x: 0, y: 399 }],
  distances: [topScale, topScale, bottomScale, bottomScale],
});

describe('the depth cap (M3 Decision 7)', () => {
  it('moves a horizon too close to the back edge up, keeping the scale at the samples\' mean row', () => {
    // (scale = y - 95: the horizon 5 rows above the back edge, depth 111)
    const p = fitProjection([wide(100, 5, 304)]);
    expect(p.params.capped).toBe(true);
    expect(p.params.horizonY).toBeCloseTo(100 - FOCAL_PX / MAX_BACK_DEPTH, 3);
    expect(p.depthFactor(100)).toBeCloseTo(MAX_BACK_DEPTH, 2);
    expect(p.scaleAt(249.5)).toBeCloseTo(154.5, 2);
  });

  it('leaves a fit within the cap, and an override, as they are', () => {
    const within = fitProjection([wide(200, 100, 299)]);
    expect(within.params.capped).toBeUndefined();
    expect(within.params.horizonY).toBe(100);
    expect(within.params.slope).toBe(1);
    const told = fitProjection([wide(100, 5, 304)], { horizonY: 95 });
    expect(told.params.capped).toBeUndefined();
    expect(told.params.horizonY).toBe(95);
  });
});

describe('fitRows', () => {
  it('fits a line of scale over row, or says there is none', () => {
    expect(fitRows([[200, 100], [399, 299], [300, 200]])).toEqual({ slope: 1, horizonY: 100 });
    expect(fitRows([[300, 100], [300, 120]])).toBeNull();
    expect(fitRows([[200, 100], [399, 101]])).toBeNull();
  });
});
