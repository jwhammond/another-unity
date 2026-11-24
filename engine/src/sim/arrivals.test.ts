// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { effectSchema } from '../content/schema';
import type { ObjectDef, ScreenDef } from '../content/types';
import { makeGame, makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import { settle } from './settle';
import type { World } from './world';

const base = makeGame([]);
const riker: ObjectDef = { id: 'riker', name: 'Riker', screen: 'room', crew: true };

function world(hall: Partial<ScreenDef> = {}, objects: ObjectDef[] = [], room: Partial<ScreenDef> = {}): World {
  return makeWorld(objects, {
    screens: { room: { ...base.screens.room, ...room }, hall: { ...base.screens.hall, ...hall } },
  });
}

function change(w: World, to: string, entrance: string, stay = false): void {
  w.state.pendingScreen = { to, entrance, ...(stay ? { stay: true } : {}) };
  w.applyScreenChange();
}

describe('entrance slots', () => {
  it('puts each arriving member on their own slot, in crew order', () => {
    const w = world({ markers: { entry: { x: 1, z: 1 }, 'entry.1': { x: 2, z: 1 }, 'entry.2': { x: 3, z: 1 } } });
    change(w, 'hall', 'entry');
    expect(w.obj('picard').pos).toEqual({ x: 1, z: 1 });
    expect(w.obj('data').pos).toEqual({ x: 2, z: 1 });
  });

  it('uses the entrance itself for a slot the screen lacks', () => {
    const w = world();
    change(w, 'hall', 'entry');
    expect(w.obj('data').pos).toEqual({ x: 1, z: 1 });
  });

  it("starts a new game's team on the start entrance's slots", () => {
    const w = world({}, [], { markers: { ...base.screens.room.markers, 'door.1': { x: 0, z: 1 } } });
    expect(w.obj('picard').pos).toEqual({ x: 0, z: 0 });
    expect(w.obj('data').pos).toEqual({ x: 0, z: 1 });
  });

  it('beams a team onto the slots too', async () => {
    const w = world({ markers: { entry: { x: 1, z: 1 }, 'entry.1': { x: 2, z: 1 } } });
    void w.enqueue(async () => {
      await runEffect(w, { react: { who: 'team', do: { beamTo: { screen: 'hall', entrance: 'entry' } } } },
        { verb: 'use', target: null, who: 'picard', other: null, walked: false }, 'k');
    });
    await settle(w);
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(w.obj('data')).toMatchObject({ screen: 'hall', pos: { x: 2, z: 1 } });
  });
});

describe('coming back from a close-up', () => {
  it('leaves the team where it was when the change says to stay', () => {
    const w = world({ startup: { closeup: true } });
    w.obj('picard').pos = { x: 3, z: 4 };
    change(w, 'hall', 'entry');
    change(w, 'room', 'door', true);
    expect(w.obj('picard').pos).toEqual({ x: 3, z: 4 });
  });

  it('places the team at the entrance without stay, or when not coming from a close-up', () => {
    const w = world({ startup: { closeup: true } });
    w.obj('picard').pos = { x: 3, z: 4 };
    change(w, 'hall', 'entry');
    change(w, 'room', 'door');
    expect(w.obj('picard').pos).toEqual({ x: 0, z: 0 });

    const v = world();
    change(v, 'hall', 'entry', true);
    expect(v.obj('picard').pos).toEqual({ x: 1, z: 1 });
  });

  it('accepts stay in a screen effect, and passes it on to the change', async () => {
    expect(effectSchema.safeParse({ screen: { to: 'room', entrance: 'door', stay: true } }).success).toBe(true);
    const w = world();
    void w.enqueue(async () => {
      await runEffect(w, { screen: { to: 'hall', entrance: 'entry', stay: true } },
        { verb: 'use', target: null, who: 'picard', other: null, walked: false }, 'k');
    });
    await settle(w);
    expect(w.state.pendingScreen).toEqual({ to: 'hall', entrance: 'entry', stay: true });
  });
});

describe('arrival events', () => {
  it('announces crew who arrive unseen on a close-up, and crew left off the team', () => {
    const w = world({ startup: { closeup: true } }, [riker]);
    const changed: string[] = [];
    w.bus.on(e => { if (e.type === 'objectChanged') changed.push(e.id); });
    change(w, 'hall', 'entry');
    expect(changed).toEqual(['riker', 'picard', 'data']);
    expect(w.obj('riker').screen).toBeNull();
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 0, z: 0 } });
  });
});
