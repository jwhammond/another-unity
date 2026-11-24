// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, ObjectDef } from '../content/types';
import { makeWorld } from '../testing/fixture';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const mark = (n: string): Effect => ({ call: { hook: 'mark', args: { n } } });

function setup(objects: ObjectDef[]): { w: World; seen: unknown[] } {
  const w = makeWorld(objects);
  const seen: unknown[] = [];
  w.hooks.register('mark', (world, _ctx, args) => {
    seen.push(args.n);
    return 0;
  });
  w.hooks.register('where', world => {
    seen.push(world.state.screen);
    return 0;
  });
  w.hooks.register('boom', () => {
    throw new Error('boom');
  });
  return { w, seen };
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('perform', () => {
  it('tries "use X with Y" the other way round when X never matched Y', async () => {
    const { w, seen } = setup([
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [mark('panel')] }] } },
      { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true, on: { use: [{ when: { other: 'panel' }, do: [mark('tricorder')] }] } },
    ]);
    void w.act('use', { target: 'panel', other: 'tricorder' });
    await settle(w);
    expect(seen).toEqual(['panel', 'tricorder']);
  });

  it('does not swap when X matched Y', async () => {
    const { w, seen } = setup([
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ when: { other: 'tricorder' }, do: [mark('panel')] }] } },
      { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true, on: { use: [{ do: [mark('tricorder')] }] } },
    ]);
    void w.act('use', { target: 'panel', other: 'tricorder' });
    await settle(w);
    expect(seen).toEqual(['panel']);
  });

  it('speaks the description when there are no look rules', async () => {
    const { w } = setup([{ id: 'panel', name: 'Panel', screen: 'room', description: { text: 'A panel.' } }]);
    void w.act('look', { target: 'panel', who: 'data' });
    await settle(w);
    expect(log(w)).toEqual(['say data: A panel.']);
    expect(w.state.currentActor).toBe('data');
  });

  it('runs get and look rules', async () => {
    const { w, seen } = setup([
      { id: 'panel', name: 'Panel', screen: 'room', on: { get: [{ do: [mark('get')] }], look: [{ do: [mark('look')] }] } },
    ]);
    void w.act('get', { target: 'panel' });
    void w.act('look', { target: 'panel' });
    await settle(w);
    expect(seen).toEqual(['get', 'look']);
  });

  it('walks to a transition and uses it', async () => {
    const { w, seen } = setup([
      { id: 'door', name: 'Door', screen: 'room', at: 'center', transition: 'square' },
      { id: 'square', name: 'Doorway', screen: 'room', at: 'panel', on: { use: [{ do: [mark('square')] }] } },
    ]);
    void w.act('walk', { target: 'door' });
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 10, z: 0 });
    expect(seen).toEqual(['square']);
  });

  it('walks to a point', async () => {
    const { w } = setup([]);
    void w.act('walk', { who: 'data', to: { x: 3, z: 4 } });
    await settle(w);
    expect(w.obj('data').pos).toEqual({ x: 3, z: 4 });
  });

  it('changes the screen only after the whole action is done', async () => {
    const { w, seen } = setup([
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [{ screen: { to: 'hall', entrance: 'entry' } }, { call: { hook: 'where' } }] }] } },
    ]);
    const screens: string[] = [];
    w.bus.on(e => { if (e.type === 'screenChanged') screens.push(e.screen); });
    void w.act('use', { target: 'panel' });
    await settle(w);
    expect(seen).toEqual(['room']);
    expect(screens).toEqual(['hall']);
    expect(w.state.screen).toBe('hall');
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(w.obj('data')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
  });

  it('recovers from a failing action', async () => {
    const { w } = setup([
      { id: 'bomb', name: 'Bomb', screen: 'room', on: { use: [{ do: [{ call: { hook: 'boom' } }] }] } },
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [{ screen: { to: 'hall', entrance: 'entry' } }] }] } },
    ]);
    void w.act('use', { target: 'bomb' });
    void w.act('use', { target: 'panel' });
    await settle(w);
    expect(w.errors).toHaveLength(1);
    expect(w.actionDepth).toBe(0);
    expect(w.state.screen).toBe('hall');
  });

  it('refuses act() from inside an action', async () => {
    const { w } = setup([{ id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [{ call: { hook: 'nested' } }] }] } }]);
    w.hooks.register('nested', world => {
      void world.act('look', { target: 'panel' });
      return 0;
    });
    void w.act('use', { target: 'panel' });
    await settle(w);
    expect(w.errors.map(e => (e as Error).message)).toEqual(['hook nested failed: act() called inside an action; use perform()']);
  });

  it('does nothing for a verb without a target', async () => {
    const { w } = setup([]);
    void w.act('use', {});
    await settle(w);
    expect(w.errors).toEqual([]);
  });
});
