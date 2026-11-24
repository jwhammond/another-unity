// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Projection } from '../content/projection';
import type { ObjectDef, PixelPolygon } from '../content/types';
import { DEEP_FLOOR, makeGame, makeWorld } from '../testing/fixture';
import { pixelWalk } from './pixels';
import { settle } from './settle';
import type { World } from './world';

/** An action square (objwalktype 3) runs its use rules for whoever arrives within 20 px of it (ScummVM runActionSquares). */
const fit = new Projection(DEEP_FLOOR);
const at = (x: number, y: number) => fit.toWorld(x, y);
const floor: PixelPolygon[] = [{
  region: 'deck',
  points: [{ x: 100, y: 200, scale: 100 }, { x: 600, y: 200, scale: 100 }, { x: 600, y: 300, scale: 100 }, { x: 100, y: 300, scale: 100 }],
}];

let order = 0;
const square = (id: string, x: number, y: number, extra: Partial<ObjectDef> = {}): ObjectDef => ({
  id, name: id, screen: 'room', pos: at(x, y), actionSquare: ++order, ...extra,
});
const bump = (to: string) => ({ do: [{ alter: { object: to, state: 7 } }] });

function build(objects: ObjectDef[]): World {
  const base = makeGame([]);
  const w = makeWorld([{ id: 'flag', name: 'Flag', screen: 'room', pos: at(10, 10) }, ...objects], {
    screens: { ...base.screens, room: { ...base.screens.room, pixelMetric: { ...DEEP_FLOOR, floor }, regions: { deck: true } } },
  });
  w.obj('picard').pos = at(150, 250);
  return w;
}

describe('action squares', () => {
  it('runs the nearest square within 20 px of where a walker arrives, and not those further off', async () => {
    const w = build([
      square('near', 400, 250, { on: { use: [bump('flag')] } }),
      square('edge', 415, 250, { on: { use: [{ do: [{ alter: { object: 'far', state: 7 } }] }] } }),
      square('far', 460, 250, { on: { use: [bump('flag')] } }),
    ]);
    w.walkTo('picard', at(400, 250));
    await settle(w);
    expect(w.obj('flag').state).toBe(7);
    // (neither the one 15 px off nor the one 60 px off ran)
    expect(w.obj('far').state).not.toBe(7);
  });

  it('runs squares at the same spot together, and nothing when the nearest square is deactivated (Frigis\'s tiles)', async () => {
    const twins = build([
      square('a', 400, 250, { on: { use: [bump('flag')] } }),
      square('b', 400, 250, { on: { use: [{ do: [{ alter: { object: 'a', state: 3 } }] }] } }),
    ]);
    twins.walkTo('picard', at(400, 250));
    await settle(twins);
    expect(twins.obj('flag').state).toBe(7);
    expect(twins.obj('a').state).toBe(3);
    // (the safe tile is the nearest; the armed one 14 px off must not go off)
    const tiles = build([
      square('safe', 400, 250),
      square('armed', 400, 264, { on: { use: [bump('flag')] } }),
    ]);
    tiles.obj('safe').active = false;
    tiles.walkTo('picard', at(400, 250));
    await settle(tiles);
    expect(tiles.obj('flag').state).not.toBe(7);
  });

  it('does not run a square that the walker did not arrive near', async () => {
    const w = build([square('sq', 400, 250, { on: { use: [bump('flag')] } })]);
    w.walkTo('picard', at(200, 250));
    await settle(w);
    expect(w.obj('flag').state).not.toBe(7);
  });

  it('ignores a square whose object is on another screen, and ordinary objects', async () => {
    const w = build([
      square('gone', 400, 250, { screen: 'hall', on: { use: [bump('flag')] } }),
      { id: 'plain', name: 'plain', screen: 'room', pos: at(400, 250), on: { use: [bump('flag')] } },
    ]);
    w.walkTo('picard', at(400, 250));
    await settle(w);
    expect(w.obj('flag').state).not.toBe(7);
  });

  it('skips a square that a script has deactivated', async () => {
    const w = build([square('sq', 400, 250, { on: { use: [bump('flag')] } })]);
    w.obj('sq').active = false;
    w.walkTo('picard', at(400, 250));
    await settle(w);
    expect(w.obj('flag').state).not.toBe(7);
  });

  it('runs squares in the original id order, whatever the content order', async () => {
    const w = build([
      square('late', 400, 250, { actionSquare: 9, on: { use: [{ do: [{ alter: { object: 'flag', state: 6 } }] }] } }),
      square('early', 400, 250, { actionSquare: 3, on: { use: [{ do: [{ alter: { object: 'flag', state: 5 } }] }] } }),
    ]);
    w.walkTo('picard', at(400, 250));
    await settle(w);
    expect(w.obj('flag').state).toBe(6);
  });

  it('runs a square before the walk-then-act action', async () => {
    const w = build([
      square('sq', 400, 250, { on: { use: [{ do: [{ alter: { object: 'flag', state: 5 } }] }] } }),
      { id: 'lever', name: 'Lever', screen: 'room', pos: at(400, 250), on: { use: [{ do: [{ alter: { object: 'flag', state: 6 } }] }] } },
    ]);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.obj('flag').state).toBe(6);
  });
});

describe('a walk that ends short of an unreachable point', () => {
  it('acts if it got within the stop distance of the point (ScummVM walkToThenAct), and not otherwise', () => {
    const w = build([]);
    // (a second floor the first doesn't join: the point is on it, and the walk gets to the first one's edge)
    const metric = w.content.screens.room.pixelMetric!;
    metric.floor = [{ region: 'deck', points: [{ x: 100, y: 200, scale: 100 }, { x: 300, y: 200, scale: 100 }, { x: 300, y: 300, scale: 100 }, { x: 100, y: 300, scale: 100 }] }, { region: 'island', points: [{ x: 500, y: 200, scale: 100 }, { x: 600, y: 200, scale: 100 }, { x: 600, y: 300, scale: 100 }, { x: 500, y: 300, scale: 100 }] }];
    w.state.regions.room = { deck: true, island: true };
    const to = at(550, 250);
    const from = at(150, 250);
    expect(pixelWalk(w, from, to)?.acts).toBe(false);
    expect(pixelWalk(w, from, to, 1, 60)?.acts).toBe(false);
    expect(pixelWalk(w, from, to, 1, 500)?.acts).toBe(true);
  });
});
