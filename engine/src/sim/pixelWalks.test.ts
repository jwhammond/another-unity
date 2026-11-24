// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { Projection } from '../content/projection';
import type { GameContent, ObjectDef, PixelPolygon, ScreenDef } from '../content/types';
import { DEEP_FLOOR, lineConversation, makeGame, makeWorld } from '../testing/fixture';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

/**
 * Walks on a screen with a pixel metric end where the original's do: over its polygons, through its path finder
 * (walk.cpp). The three cases are the ones Horst III's walkthroughs showed (Task 11b's residual differences).
 */
const fit = new Projection(DEEP_FLOOR);
const at = (x: number, y: number) => fit.toWorld(x, y);
const log = (w: World) => (w.presenter as HeadlessPresenter).log;

const rect = (region: string, x0: number, y0: number, x1: number, y1: number, scale: number): PixelPolygon => ({
  region,
  points: [{ x: x0, y: y0, scale }, { x: x1, y: y0, scale }, { x: x1, y: y1, scale }, { x: x0, y: y1, scale }],
});

/** A screen on the DEEP_FLOOR fit, with these polygons for its floor, every region open. */
function floorScreen(floor: PixelPolygon[], markers: Record<string, [number, number]>): Pick<ScreenDef, 'pixelMetric' | 'regions' | 'markers'> {
  return {
    pixelMetric: { ...DEEP_FLOOR, floor },
    regions: Object.fromEntries(floor.map(p => [p.region, true])),
    markers: Object.fromEntries(Object.entries(markers).map(([k, [x, y]]) => [k, at(x, y)])),
  };
}

describe('stepping in on a screen with a pixel metric', () => {
  const lever: ObjectDef = { id: 'lever', name: 'Lever', screen: 'room', on: { use: [{ do: [{ screen: { to: 'hall', entrance: 'entry', stepIn: true } }] }] } };
  function arrive(hall: Pick<ScreenDef, 'pixelMetric' | 'regions' | 'markers'>, rolls: number[]): World {
    const base = makeGame([]);
    const w = makeWorld([lever], {
      screens: { ...base.screens, hall: { ...base.screens.hall, ...hall } },
      // (30 px at full scale)
      rules: { stepIn: 0.375, items: {}, lines: {} },
    });
    vi.spyOn(w.rng, 'next').mockImplementation(() => rolls.shift() ?? 1);
    void w.act('use', { target: 'lever', who: 'picard' });
    return w;
  }

  it('ends a step off the floor at the nearest walkable point (canonical line 23, Picard)', async () => {
    // the slot is 7 rows below the floor's back edge; a 10 px step up (scale 91) would leave it
    const w = arrive(floorScreen([rect('deck', 500, 223, 620, 260, 91)], { entry: [559, 230] }), [1, 0, 1, 1]);
    await settle(w);
    expect(w.obj('picard').pos).toEqual(at(559, 223));
  });

  it('ends a step past a floor\'s corner on its nearest edge (conversations line 29, Data)', async () => {
    // a step of 12 px (scale 107) left and down, from a slot near the floor's bottom corner
    const w = arrive(floorScreen([rect('deck', 500, 223, 600, 247, 107)], { entry: [584, 245] }), [0, 2, 1, 1]);
    await settle(w);
    expect(w.obj('picard').pos).toEqual(at(572, 247));
  });

  it('sizes the step from the polygons\' corner scales, not the fit (canonical line 23, Riker)', async () => {
    // the fit says 101.76 at row 240, so 102 and an 11 px step; the corners say 105, so 12 px
    expect(Math.round(fit.scaleAt(240))).toBe(102);
    const w = arrive(floorScreen([rect('deck', 500, 223, 620, 260, 105)], { entry: [565, 240] }), [1, 2, 1, 1]);
    await settle(w);
    expect(w.obj('picard').pos).toEqual(at(565, 252));
  });

  it('walks only over open regions', async () => {
    // the near half is closed, so the step down ends on the open half's edge
    const w = arrive(floorScreen([rect('back', 500, 223, 620, 240, 105), rect('front', 500, 240, 620, 260, 105)], { entry: [565, 235] }), [1, 2, 1, 1]);
    w.state.regions.hall.front = false;
    await settle(w);
    expect(w.obj('picard').pos).toEqual(at(565, 240));
  });
});

describe('walking up to act on a screen with a pixel metric', () => {
  // An L of floor: a strip along the front, a corner, and an arm up the right to the panel. The straight line from
  // the strip's far end to the panel crosses no floor, so the original goes round the inside corner (240, 300).
  const L = [rect('strip', 0, 300, 230, 340, 160), rect('corner', 230, 300, 300, 340, 160), rect('arm', 240, 220, 300, 300, 120)];
  const panelUse = (dist: number): ObjectDef => ({
    id: 'panel', name: 'Panel', screen: 'room', at: 'panel', description: { text: 'A panel.' },
    // (a near distance of `dist` px, lifted at the panel's row as the lifter does)
    on: { use: [{ when: { near: { dist: fit.distance(dist, 230) } }, do: [{ say: { who: 'picard', text: 'Done.' } }] }] },
  });
  function lWorld(objects: ObjectDef[], extra: Partial<GameContent> = {}): World {
    const base = makeGame([]);
    const w = makeWorld(objects, {
      screens: { ...base.screens, room: { ...base.screens.room, ...floorScreen(L, { door: [20, 320], panel: [280, 230], post: [80, 220] }) } },
      ...extra,
    });
    w.obj('picard').pos = at(20, 320);
    return w;
  }

  it('stops within the near distance along the path finder\'s route, not along the straight line (canonical line 37)', async () => {
    const w = lWorld([panelUse(50)]);
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    // the route's second leg, (240, 300) to (280, 230), at the first whole pixel within 50 px of the panel
    expect(w.obj('picard').pos).toEqual(at(255, 273));
    expect(log(w).at(-1)).toBe('say picard: Done.');
  });

  it('measures the next talk from where the route ended (canonical line 47)', async () => {
    // the guard is 183 px from the route's end at (255, 273), past the 180 px talk distance, so Picard walks up;
    // from where the straight line stops, about (254, 239), he is 175 px away and would talk at once
    const guard: ObjectDef = { id: 'guard', name: 'Guard', screen: 'room', at: 'post', width: fit.distance(10, 220), talk: '@chat,1' };
    const w = lWorld([panelUse(50), guard], {
      conversations: { chat: lineConversation('chat', { 1: 'Can I help?' }) },
      rules: { talkDistance: 2.25, items: {}, lines: {} },
    });
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    log(w).length = 0;
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)[0]).toMatch(/^walk picard -> /);
  });

  it('walks as close as it can to a point it can\'t reach, and doesn\'t act (walkToThenAct)', async () => {
    // with the corner closed, a 10 px gap parts the strip from the arm: the walk gets as near as the strip goes
    const w = lWorld([panelUse(50)]);
    w.state.regions.room.corner = false;
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    expect(w.obj('picard').pos).toEqual(at(230, 300));
    expect(log(w)).not.toContain('say picard: Done.');
  });
});
