// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { shipRecipe, type ShipRecipe } from './recipe';
import { project, type Camera, type Vec3 } from './shipcam';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeLayout, idColour, type ShipYaml } from './shiplayout';
import { spritePositions } from './shipbuild';

const TRUTH: Camera = { position: [0, 2, 5], yaw: 0, pitch: 0, roll: 0, fovY: (60 * Math.PI) / 180, shiftY: 135, width: 640, height: 480 };
const PTS: Vec3[] = [[-4, 0, -6], [3, 0, -6], [-5, 0, -3], [5, 0, -3], [-1, 1, 2], [2, 1, 1], [-2, 0, -1], [0, 1.2, -2.5]];
const trace = PTS.map(p => [...project(TRUTH, p), ...p]);
const recipeObj = {
  id: 'ship.test',
  kind: 'ship',
  station: 'bridge',
  script: 'ship/bridge.py',
  start: { position: [0, 1.8, 6], fovY: 55, shiftY: 100 },
  free: ['x', 'y', 'z', 'yaw', 'fovY', 'shiftY'],
  trace,
  support: { '0': { axis: 'z', at: -3 }, '1': { axis: 'y', at: 1 }, '2': { axis: 'z', at: -1 }, '3': { ui: true } },
  design: { floor: 1 },
};
const recipe = (over: Record<string, unknown> = {}): ShipRecipe => shipRecipe.parse({ ...recipeObj, ...over });
const SHIP: ShipYaml = {
  bridge: {
    items: [
      { object: 'picard', x: 0, y: 70, width: 50, height: 140, action: 48, depth: -100, description: 'Door' },
      { object: 'picard', x: 165, y: 212, width: 195, height: 34, action: 4, depth: -100, description: 'Console' },
      { object: 'ship.troi', x: 368, y: 181, width: 25, height: 30, action: 52, depth: -140, description: 'Crew' },
      { object: 'picard', x: 58, y: 423, width: 52, height: 48, action: 50, depth: -100, description: 'Ui' },
    ],
    objects: [{ object: 'troi', x: 380, y: 235, depth: -90, file: 'brdgtroi.spr' }],
  },
};
const R = (): ShipRecipe => recipe({ support: { ...recipeObj.support, '2': { axis: 'z', at: -1 } } });

describe('shiplayout', () => {
  it('fits the camera from the trace and reports the fit', () => {
    const l = bridgeLayout(R(), SHIP);
    expect(l.fit.rms).toBeLessThan(0.05);
    expect(l.camera.shiftY).toBeCloseTo(135, 1);
  });
  it('each item proxy quad projects onto its rect within 1 px', () => {
    const l = bridgeLayout(R(), SHIP);
    for (const it of l.items.filter(i => i.quad)) {
      const [x, y, w, h] = it.rect;
      const want = [[x, y + h], [x + w, y + h], [x + w, y], [x, y]];
      it.quad!.forEach((p, k) => {
        const [u, v] = project(l.camera, p);
        expect(Math.abs(u - want[k]![0]!)).toBeLessThan(1);
        expect(Math.abs(v - want[k]![1]!)).toBeLessThan(1);
      });
    }
  });
  it('an item on a horizontal support lies in that plane; one on a z support in that plane', () => {
    const l = bridgeLayout(R(), SHIP);
    for (const p of l.items[1]!.quad!) expect(p[1]).toBeCloseTo(1, 6);
    for (const p of l.items[0]!.quad!) expect(p[2]).toBeCloseTo(-3, 6);
  });
  it('each bridge sprite stands on the floor where its feet project, naming its object, depth and file', () => {
    const l = bridgeLayout(R(), SHIP);
    expect(l.crew).toHaveLength(1);
    const c = l.crew[0]!;
    expect(c.object).toBe('troi');
    expect(c.file).toBe('brdgtroi.spr');
    expect(c.index).toBe(2);
    expect(c.depth).toBe(-90);
    expect(c.foot[1]).toBeCloseTo(0, 6);
    const [u, v] = project(l.camera, c.foot);
    expect(Math.abs(u - 380)).toBeLessThan(1);
    expect(Math.abs(v - 235)).toBeLessThan(1);
    expect(c.objectXY).toEqual([380, 235]);
  });
  it('a bridge sprite with no talk button (the captain) still gets an anchor', () => {
    const s: ShipYaml = { bridge: { ...SHIP.bridge, objects: [...SHIP.bridge.objects, { object: 'picard', x: 265, y: 365, depth: 0, file: 'brdgpica.spr' }] } };
    const l = bridgeLayout(R(), s);
    expect(l.crew.map(c => [c.object, c.index])).toEqual([['troi', 2], ['picard', -1]]);
  });
  it('a bridge sprite stands where its own POSN says when it sets one, else at the object\'s x, y', () => {
    const own = bridgeLayout(R(), SHIP, { 'brdgtroi.spr': [383, 281] }).crew[0]!;
    const [u, v] = project(bridgeLayout(R(), SHIP).camera, own.foot);
    expect(Math.abs(u - 383)).toBeLessThan(1);
    expect(Math.abs(v - 281)).toBeLessThan(1);
    expect(own.objectXY).toEqual([383, 281]);
    expect(bridgeLayout(R(), SHIP, { 'brdgtroi.spr': [0, 0] }).crew[0]!.objectXY).toEqual([380, 235]);
  });
  it('reads each sprite file\'s first position block from the images export, and nothing for a file it lacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spr-'));
    mkdirSync(join(dir, 'images', 'sprites', 'brdgtroi.spr'), { recursive: true });
    writeFileSync(join(dir, 'images', 'sprites', 'brdgtroi.spr', 'sprite.json'), JSON.stringify({ entries: [{ type: 'sprite' }, { type: 'position', x: 383, y: 281 }, { type: 'position', x: 9, y: 9 }] }));
    expect(await spritePositions(SHIP, dir)).toEqual({ 'brdgtroi.spr': [383, 281] });
    expect(await spritePositions(SHIP, undefined)).toEqual({});
  });
  it('a ui item gets no geometry and is flagged', () => {
    const l = bridgeLayout(R(), SHIP);
    expect(l.items[3]!.role).toBe('ui');
    expect(l.items[3]!.quad).toBeUndefined();
  });
  it('gives every item its own ID colour from a fixed table', () => {
    const l = bridgeLayout(R(), SHIP);
    expect(new Set(l.items.map(i => i.colour)).size).toBe(l.items.length);
    expect(l.items[0]!.colour).toBe(idColour(0));
  });
  it('refuses a fit that is worse than the recipe allows', () => {
    const bad = trace.map((r, i) => (i === 0 ? [r[0]! + 40, r[1]!, r[2]!, r[3]!, r[4]!] : r));
    expect(() => bridgeLayout(recipe({ trace: bad }), SHIP)).toThrow(/rms/);
  });
  it('refuses an item with no support entry', () => {
    const s = { ...recipeObj.support } as Record<string, unknown>;
    delete s['1'];
    expect(() => bridgeLayout(recipe({ support: s }), SHIP)).toThrow(/support/);
  });
  it('the recipe schema refuses rects or items keys (they come from the lift)', () => {
    expect(() => shipRecipe.parse({ ...recipeObj, rects: [[0, 0, 1, 1]] })).toThrow();
    expect(() => shipRecipe.parse({ ...recipeObj, items: [] })).toThrow();
    expect(() => shipRecipe.parse({ ...recipeObj, trace: trace.slice(0, 3) })).toThrow();
  });
  it('the committed bridge recipe parses and has no lifted rectangles in it', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../../art/recipes/ship.bridge.yaml', import.meta.url), 'utf8');
    const r = shipRecipe.parse(parseYaml(text));
    expect(r.trace.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(r)).not.toMatch(/"rect|"width"|"height"/);
  });
});
