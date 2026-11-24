// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { EDGE_POINTS } from './points';
import { parseRecipe, type RepaintRecipe } from './recipe';
import { keepComposite, shipInputs, type ShipLift } from './shipscreen';

const KEEP = '[[0, 364, 640, 116]]';
const recipeText = (id: string, stem: string, extra = ''): string => `id: ${id}
kind: repaint
source: { ship: ${stem} }
sampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a room
denoise: 0.6
keep: ${KEEP}
${extra}`;
const recipe = (id: string, stem: string, extra = ''): RepaintRecipe => parseRecipe(recipeText(id, stem, extra), `/x/${id}.yaml`, new Set()) as RepaintRecipe;

/** 640x480: flat scene with a grid of bright blocks (edges everywhere), plus a very busy kept strip. */
function original(): Rgba {
  const data = new Uint8Array(640 * 480 * 4);
  for (let i = 0; i < 640 * 480; i++) data.set([60, 60, 60, 255], i * 4);
  for (let by = 20; by < 340; by += 80) for (let bx = 20; bx < 620; bx += 100) for (let y = by; y < by + 40; y++) for (let x = bx; x < bx + 50; x++) data.set([220, 220, 220, 255], (y * 640 + x) * 4);
  for (let y = 364; y < 480; y++) for (let x = 0; x < 640; x++) {
    const v = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? 250 : 5;
    data.set([v, v, v, 255], (y * 640 + x) * 4);
  }
  return { width: 640, height: 480, data };
}
const LIFT: ShipLift = {
  bridge: {
    items: [
      { object: 'a', x: 0, y: 70, width: 50, height: 140, action: 48 },
      { object: 'b', x: 165, y: 212, width: 195, height: 34, action: 4 },
      { object: 'c', x: 58, y: 423, width: 52, height: 48, action: 50 },
    ],
    objects: [],
  },
  transporter: { pads: [{ rect: [225, 85, 276, 231], stand: [250, 231], scale: 240 }, { rect: [378, 85, 429, 231], stand: [404, 231], scale: 240 }] },
};
const inKeep = (x: number, y: number): boolean => y >= 364;

describe('shipInputs', () => {
  it("bridge points are every item's corners, the area corners, and at most 16 edge points, none chosen inside a keep rect", () => {
    const { points } = shipInputs('bridge', recipe('plate.bridge', 'bridge', 'areas: { rail: [100, 300, 40, 20] }'), LIFT, original());
    const src = (s: string): number => points.filter(p => p.source.startsWith(s)).length;
    // 3 items x 4 corners, minus the corners the picture clips away (x = 640 is not inside; corners are clamped to the picture)
    expect(src('item 0')).toBe(4);
    expect(src('item 1')).toBe(4);
    expect(src('item 2')).toBe(4);
    expect(src('area rail')).toBe(4);
    expect(points.find(p => p.source === 'item 1 bottom-right')).toMatchObject({ x: 360, y: 246 });
    const edges = points.filter(p => p.source.startsWith('edge '));
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.length).toBeLessThanOrEqual(EDGE_POINTS);
    for (const e of edges) expect(inKeep(e.x, e.y), `${e.source} is in the kept strip`).toBe(false);
    // item 2 (the strip's own button) still counts, and passes trivially
    expect(points.some(p => p.source === 'item 2 top-left')).toBe(true);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(639);
      expect(p.y).toBeLessThanOrEqual(479);
    }
  });

  it("transporter points add each pad's corners and stand point; geometry rects are items, pads and areas; keep passes through", () => {
    const r = recipe('plate.transporter', 'transp', 'areas: { panel: [10, 20, 100, 50] }');
    const { points, geometry } = shipInputs('transporter', r, LIFT, original());
    expect(points.filter(p => p.source.startsWith('pad 0 ')).map(p => p.source).sort()).toEqual(['pad 0 bottom-left', 'pad 0 bottom-right', 'pad 0 stand', 'pad 0 top-left', 'pad 0 top-right']);
    expect(points.find(p => p.source === 'pad 1 stand')).toMatchObject({ x: 404, y: 231 });
    expect(points.some(p => p.source.startsWith('item '))).toBe(false);
    // the mask's rects are [x0, y0, x1, y1]
    expect(geometry.rects).toContainEqual([225, 85, 276, 231]);
    expect(geometry.rects).toContainEqual([10, 20, 110, 70]);
    expect(geometry.polygons).toEqual([]);
    expect(geometry.keep).toEqual([[0, 364, 640, 116]]);
    const bridge = shipInputs('bridge', recipe('plate.bridge', 'bridge'), LIFT, original());
    expect(bridge.geometry.rects).toContainEqual([165, 212, 360, 246]);
  });

  it('a viewscreen window is the key region at the seed: 8 outline points from its centroid, and the mask in the geometry', () => {
    // a key-coloured ellipse-ish window on the grid picture
    const img = original();
    for (let y = 100; y < 260; y++) for (let x = 180; x < 460; x++) if (((x - 320) / 140) ** 2 + ((y - 180) / 80) ** 2 <= 1) img.data.set([92, 136, 64, 255], (y * 640 + x) * 4);
    const r = recipe('plate.viewscreen', 'viewscr', 'window: { at: [320, 180] }');
    const { points, geometry } = shipInputs('viewscreen', r, LIFT, img);
    const outline = points.filter(p => p.source.startsWith('window outline '));
    expect(outline.map(p => p.source)).toEqual([0, 45, 90, 135, 180, 225, 270, 315].map(a => `window outline ${a}deg`));
    // 0 degrees is the right end, 90 the top (y goes down)
    expect(outline[0]).toMatchObject({ x: 459, y: 180 });
    expect(outline[2]!.y).toBeLessThanOrEqual(101);
    expect(outline[2]!.y).toBeGreaterThanOrEqual(99);
    expect(outline[4]!.x).toBeLessThanOrEqual(181);
    expect(geometry.keepMask?.mask[180 * 640 + 320]).toBe(1);
    expect(geometry.keepMask?.mask[50 * 640 + 50]).toBe(0);
    // a seed off the key region is refused, and the other stations take no window
    expect(() => shipInputs('viewscreen', recipe('plate.viewscreen', 'viewscr', 'window: { at: [20, 20] }'), LIFT, img)).toThrow(/flat key-coloured/);
    expect(shipInputs('bridge', recipe('plate.bridge', 'bridge'), LIFT, img).geometry.keepMask).toBeUndefined();
  });
});

describe('keepComposite', () => {
  const S = 8; // plate px per original px: an 80x60 plate of a 10x7.5 picture
  const solid = (v: number): Rgba => {
    const d = new Uint8Array(80 * 60 * 4);
    for (let i = 0; i < 80 * 60; i++) d.set([v, v, v, 255], i * 4);
    return { width: 80, height: 60, data: d };
  };
  const at = (img: Rgba, x: number, y: number): number => img.data[(y * img.width + x) * 4]!;
  it('the interior of a keep rect equals the upscale exactly, outside equals the repaint, the 2 px band blends', () => {
    const out = keepComposite(solid(100), solid(200), [[1, 1, 8, 5]], 2, 10);
    expect(at(out, 0, 0)).toBe(100);
    expect(at(out, 1 * S - 1, 3 * S)).toBe(100);
    expect(at(out, 9 * S, 3 * S)).toBe(100);
    expect(at(out, 5 * S, 6 * S)).toBe(100);
    // 2 original px inside every edge and deeper: the upscale exactly
    expect(at(out, 5 * S, 3 * S)).toBe(200);
    expect(at(out, 3 * S, 3 * S)).toBe(200);
    expect(at(out, 3 * S, 3 * S + 4)).toBe(200);
    // the band: strictly between, rising inward
    const a = at(out, 5 * S, 1 * S + 2);
    const b = at(out, 5 * S, 1 * S + S);
    expect(a).toBeGreaterThanOrEqual(100);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(200);
  });
  it('an edge on the picture border does not feather', () => {
    const out = keepComposite(solid(100), solid(200), [[0, 1, 10, 5]], 2, 10);
    expect(at(out, 0, 3 * S)).toBe(200);
    expect(at(out, 79, 3 * S)).toBe(200);
    expect(at(out, 40, 1 * S + 1)).toBeLessThan(200);
  });
});
