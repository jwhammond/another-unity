// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liftObject } from './objects';
import { HOTSPOT_DEPTH, loadSpriteBounds, roomFile } from './room';
import { miniRaw, type J } from './testing/mini';
import { rawFromMini, testCtx } from './testing/ctx';

describe('roomFile', () => {
  it('projects the regions and places a hotspot for each object on the screen', () => {
    const ctx = testCtx();
    const hotspots = ['070103', '070104'].map(id => liftObject(ctx.raw.objects.get(id)!, ctx, false).hotspot!);
    const room = roomFile(ctx, ctx.raw.screens.get('s_0701')!, hotspots, ['picard']);
    const p = ctx.markers.projection('horst3.s01')!;
    expect(room).toMatchObject({
      generated: 'tools/lift', screen: 'horst3.s01', world: 'horst3',
      background: { png: 'images/backgrounds/s_0701.png', original: 'sb007001.scr' },
      camera: { kind: 'perspective' },
    });
    expect(room.regions.map(r => [r.name, r.walkable, r.points.length])).toEqual([['r23', true, 4], ['r24', false, 4]]);
    expect(room.regions[0].points[3]).toEqual(p.toWorld(40, 399));
    expect(room.hotspots).toEqual([
      { object: 'horst3.rubble', at: p.toWorld(208, 336), width: p.distance(70, 336), height: p.distance(70, 336), depth: HOTSPOT_DEPTH, pickable: true, kind: 'object', rect: [173, 266, 243, 336], order: 336 },
      { object: 'horst3.door', at: p.toWorld(330, 300), width: p.distance(40, 300), height: p.distance(80, 300), depth: HOTSPOT_DEPTH, pickable: true, kind: 'transition', rect: [310, 220, 350, 300], order: 300 },
    ]);
  });

  it('stands each hotspot up as a thin panel on its ground row, as the original\'s is a flat rectangle drawn there', () => {
    // (a box as deep as it is wide reaches toward the camera, over whoever stands just in front of the object)
    expect(HOTSPOT_DEPTH).toBeGreaterThan(0);
    expect(HOTSPOT_DEPTH).toBeLessThanOrEqual(0.05);
  });

  it('sizes a sprite\'s hotspot from its first frame, pickable only with a verb flag', () => {
    const ctx = testCtx();
    const rubble = { ...liftObject(ctx.raw.objects.get('070103')!, ctx, false).hotspot!, spriteId: 0, flags: 0x20 };
    const room = roomFile(ctx, ctx.raw.screens.get('s_0701')!, [rubble], ['picard'], file => (file === 'picard.spr' ? { width: 20, height: 100 } : undefined));
    const p = ctx.markers.projection('horst3.s01')!;
    expect(room.hotspots[0]).toMatchObject({ width: p.distance(20, 336), height: p.distance(100, 336), pickable: false });
  });

  it('a hotspot carries the pixel rect objectAt tests; a sprite\'s is its first frame\'s size', () => {
    const ctx = testCtx();
    const base = liftObject(ctx.raw.objects.get('070103')!, ctx, false).hotspot!;
    const plain = roomFile(ctx, ctx.raw.screens.get('s_0701')!, [base], ['picard']);
    // left = x - width/2, top = y - height, bottom = y (unity.cpp:248-249)
    expect(plain.hotspots[0].rect).toEqual([base.x - 35, base.y - 70, base.x + 35, base.y]);
    const sprite = { ...base, spriteId: 0, flags: 0x20 };
    const room = roomFile(ctx, ctx.raw.screens.get('s_0701')!, [sprite], ['picard'], file => (file === 'picard.spr' ? { width: 21, height: 100 } : undefined));
    expect(room.hotspots[0].rect).toEqual([base.x - 10, base.y - 100, base.x + 11, base.y]);
  });

  it('orders a hotspot by its y_adjust, or its own y without one or for a walker (DrawOrderComparison)', () => {
    const ctx = testCtx();
    const base = liftObject(ctx.raw.objects.get('070103')!, ctx, false).hotspot!;
    const order = (h: Partial<typeof base>) => roomFile(ctx, ctx.raw.screens.get('s_0701')!, [{ ...base, ...h }], ['picard']).hotspots[0].order;
    expect(order({ yAdjust: -1, objwalktype: 0 })).toBe(base.y);
    expect(order({ yAdjust: 176, objwalktype: 0 })).toBe(176);
    expect(order({ yAdjust: 176, objwalktype: 1 })).toBe(base.y);
  });

  it('a sprite\'s own position replaces the object\'s on each axis where it isn\'t 0, as drawSprite and spriteContains do', () => {
    const ctx = testCtx();
    const base = liftObject(ctx.raw.objects.get('070103')!, ctx, false).hotspot!;
    const sprite = { ...base, spriteId: 0, flags: 0x20 };
    const at = (position: { x: number; y: number }) => roomFile(ctx, ctx.raw.screens.get('s_0701')!, [sprite], ['picard'],
      file => (file === 'picard.spr' ? { width: 21, height: 100, position } : undefined)).hotspots[0].rect;
    expect(at({ x: 300, y: 250 })).toEqual([290, 150, 311, 250]);
    expect(at({ x: 300, y: 0 })).toEqual([290, base.y - 100, 311, base.y]);
    expect(at({ x: 0, y: 250 })).toEqual([base.x - 10, 150, base.x + 11, 250]);
  });

  it('stands the pick box at the sprite\'s own position too, so a click picks the object where it is drawn', () => {
    const ctx = testCtx();
    const base = liftObject(ctx.raw.objects.get('070103')!, ctx, false).hotspot!;
    const sprite = { ...base, spriteId: 0, flags: 0x20 };
    const p = ctx.markers.projection('horst3.s01')!;
    const spot = (position: { x: number; y: number }) => roomFile(ctx, ctx.raw.screens.get('s_0701')!, [sprite], ['picard'],
      file => (file === 'picard.spr' ? { width: 21, height: 100, position } : undefined)).hotspots[0];
    const moved = spot({ x: 300, y: 250 });
    expect(moved.at).toEqual(p.toWorld(300, 250));
    expect(moved).toMatchObject({ width: p.distance(21, 250), height: p.distance(100, 250) });
    // (its foot projects to the middle of the rect's bottom edge)
    const [x0, , x1, y1] = moved.rect;
    const foot = p.toWorld((x0 + x1) / 2, y1);
    expect(Math.hypot(foot.x - moved.at.x, foot.z - moved.at.z)).toBeLessThan(p.distance(1, 250));
    expect(spot({ x: 300, y: 0 }).at).toEqual(p.toWorld(300, base.y));
  });
});

describe('roomFile floors', () => {
  /** s_0702 with a second region 2 px above its floor, and one that crosses itself. */
  function gappedCtx() {
    return testCtx(rawFromMini(miniRaw(files => {
      const s = files['screens/s_0702.json'] as { polygons: J[] };
      const pt = (x: number, y: number) => ({ x, y });
      s.polygons.push(
        { id: 6, type: 1, points: [pt(100, 250), pt(540, 250), pt(540, 298), pt(100, 298)], distances: [150, 150, 198, 198] },
        { id: 7, type: 0, points: [pt(10, 310), pt(30, 330), pt(30, 310), pt(10, 330)], distances: [200, 220, 200, 220] },
      );
    })));
  }

  it('welds near-miss gaps in pixels before projecting, so neighbours share their corners', () => {
    const ctx = gappedCtx();
    const room = roomFile(ctx, ctx.raw.screens.get('s_0702')!, [], []);
    const p = ctx.markers.projection('horst3.s02')!;
    const [floor, upper] = room.regions;
    expect(upper.points).toEqual([p.toWorld(100, 250), p.toWorld(540, 250), p.toWorld(540, 300), p.toWorld(100, 300)]);
    expect(floor.points).toEqual([p.toWorld(0, 300), p.toWorld(100, 300), p.toWorld(540, 300), p.toWorld(640, 300), p.toWorld(640, 399), p.toWorld(0, 399)]);
  });

  it('triangulates each region by ear clipping in pixels, and warns where the original can\'t', () => {
    const ctx = gappedCtx();
    const room = roomFile(ctx, ctx.raw.screens.get('s_0702')!, [], []);
    // (the floor's two welded corners are on a straight edge, so they add no triangles)
    expect(room.regions.map(r => [r.name, r.triangles.length])).toEqual([['r5', 2], ['r6', 2], ['r7', 1]]);
    expect(ctx.problems.warnings).toContain("s_0702#/polygons/2: can't triangulate region r7 (it crosses itself): ear clipping stops with 3 corners left");
  });
});

describe('loadSpriteBounds', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads each sprite\'s first frame size from Plan 3\'s images export', async () => {
    dir = await mkdtemp(join(tmpdir(), 'images-'));
    await mkdir(join(dir, 'images/sprites/PICARD.SPR'), { recursive: true });
    await writeFile(join(dir, 'images/manifest.json'), JSON.stringify({
      backgrounds: [], sprites: [{ file: 'PICARD.SPR', json: 'images/sprites/PICARD.SPR/sprite.json', palette: 'standard', frames: 1 }],
    }));
    await writeFile(join(dir, 'images/sprites/PICARD.SPR/sprite.json'), JSON.stringify({
      file: 'PICARD.SPR', palette: 'standard', anims: [0],
      entries: [{ type: 'wait' }, { type: 'sprite', png: 'x.png', width: 31, height: 120 }, { type: 'sprite', png: 'y.png', width: 5, height: 5 }],
    }));
    const bounds = await loadSpriteBounds(dir);
    expect(bounds('picard.spr')).toEqual({ width: 31, height: 120 });
    // a sprite with its own position carries it
    await writeFile(join(dir, 'images/sprites/PICARD.SPR/sprite.json'), JSON.stringify({
      entries: [{ type: 'sprite', png: 'x.png', width: 31, height: 120 }, { type: 'position', x: 186, y: 365 }],
    }));
    expect((await loadSpriteBounds(dir))('picard.spr')).toEqual({ width: 31, height: 120, position: { x: 186, y: 365 } });
    expect(bounds('nothing.spr')).toBeUndefined();
  });
});
