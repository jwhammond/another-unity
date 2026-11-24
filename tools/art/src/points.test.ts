// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { checkPoints, edgePoints } from './points';

describe('checkPoints', () => {
  it('takes each hotspot rect\'s four corners and each floor vertex, clipped to the screen and deduplicated', () => {
    const room = {
      hotspots: [
        { object: 'a.box', rect: [10, 20, 50, 80] as [number, number, number, number] },
        { object: 'a.edge', rect: [600, 400, 700, 480] as [number, number, number, number] },
      ],
    };
    const screen = { pixelMetric: { floor: [{ region: 'r1', points: [{ x: 10, y: 80 }, { x: 300, y: 200 }, { x: -5, y: 10 }, { x: 639, y: 479 }] }] } };
    const pts = checkPoints(room, screen);
    expect(pts.map(p => [p.x, p.y, p.source])).toEqual([
      [10, 20, 'hotspot a.box top-left'],
      [50, 20, 'hotspot a.box top-right'],
      [10, 80, 'hotspot a.box bottom-left'],
      [50, 80, 'hotspot a.box bottom-right'],
      [600, 400, 'hotspot a.edge top-left'],
      [300, 200, 'floor r1 #1'],
      [639, 479, 'floor r1 #3'],
    ]);
  });
  it('leaves out unpickable hotspots (light and mask overlays), whose rect corners lie on no edge', () => {
    const room = { hotspots: [
      { object: 'a.light_mask', rect: [1, 2, 30, 40] as [number, number, number, number], pickable: false },
      { object: 'a.box', rect: [100, 120, 150, 180] as [number, number, number, number], pickable: true },
    ] };
    expect(checkPoints(room, {}).map(p => p.source.split(' ')[1])).toEqual(['a.box', 'a.box', 'a.box', 'a.box']);
  });
  it('a screen without a pixel metric has only its hotspots', () => {
    expect(checkPoints({ hotspots: [{ object: 'x', rect: [1, 1, 1, 1] }] }, {})).toHaveLength(1);
  });
});

function img(w: number, h: number, paint: (x: number, y: number) => number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([paint(x, y), paint(x, y), paint(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('edgePoints', () => {
  it('picks the strongest window per cell and skips flat cells', () => {
    // a bright block in cells (1,1) and (2,2) of the 4x4 grid; everything else flat
    const o = img(640, 480, (x, y) => ((x >= 220 && x < 260 && y >= 150 && y < 190) || (x >= 380 && x < 430 && y >= 270 && y < 320) ? 230 : 30));
    const pts = edgePoints(o, 16);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts.length).toBeLessThan(16);
    expect(pts.every(p => p.label === 'edge')).toBe(true);
    // every point sits on an edge of a block, and none is in a flat corner
    const near = (p: { x: number; y: number }): boolean => [[220, 150, 260, 190], [380, 270, 430, 320]].some(([x0, y0, x1, y1]) => p.x >= x0! - 14 && p.x <= x1! + 14 && p.y >= y0! - 14 && p.y <= y1! + 14);
    expect(pts.every(near)).toBe(true);
    expect(edgePoints(img(640, 480, () => 90), 16)).toEqual([]);
  });
  it('returns at most n, strongest first, with windows inside the image', () => {
    const o = img(640, 480, (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? 40 : 200));
    const pts = edgePoints(o, 5);
    expect(pts).toHaveLength(5);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(12);
      expect(p.x).toBeLessThanOrEqual(640 - 13);
      expect(p.y).toBeGreaterThanOrEqual(12);
      expect(p.y).toBeLessThanOrEqual(480 - 13);
    }
  });
});
