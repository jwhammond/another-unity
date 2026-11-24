// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, ObjectDef, TriggerDef } from '../content/types';
import { makeWorld } from '../testing/fixture';
import { advance } from './settle';
import type { World } from './world';

const mark = (n: string): Effect => ({ call: { hook: 'mark', args: { n } } });

function setup(objects: ObjectDef[], triggers: TriggerDef[] = []): { w: World; seen: string[]; ticks: number[] } {
  const w = makeWorld(objects, { triggers });
  const seen: string[] = [];
  const ticks: number[] = [];
  w.hooks.register('mark', (world, _ctx, args) => {
    seen.push(String(args.n));
    ticks.push(world.clock.now);
    return 0;
  });
  return { w, seen, ticks };
}

const alarm = (over: Partial<ObjectDef> = {}): ObjectDef =>
  ({ id: 'alarm', name: 'Alarm', screen: 'room', timer: 1, on: { timer: [{ do: [mark('alarm')] }] }, ...over });

describe('object timers', () => {
  it('repeat while the object is active on the current screen', async () => {
    const { w, ticks } = setup([alarm()]);
    await advance(w, 3.5);
    expect(ticks).toEqual([60, 120, 180]);
  });

  it('stop when the object becomes inactive', async () => {
    const { w, seen } = setup([alarm()]);
    await advance(w, 1.5);
    w.obj('alarm').active = false;
    await advance(w, 3);
    expect(seen).toEqual(['alarm']);
    expect(w.obj('alarm').timerDue).toBe(0);
  });

  it('do not run on other screens', async () => {
    const { w, seen } = setup([alarm({ screen: 'hall' })]);
    await advance(w, 3);
    expect(seen).toEqual([]);
  });

  it('are dropped once queued if a timer before them re-enters the same screen', async () => {
    const { w, seen } = setup([
      alarm({ id: 'a', on: { timer: [{ do: [{ screen: { to: 'room', entrance: 'door' } }] }] } }),
      alarm({ id: 'b', on: { timer: [{ do: [mark('b')] }] } }),
    ]);
    await advance(w, 1.5);
    expect(w.state.screen).toBe('room');
    expect(seen).toEqual([]);
  });

  it('wait while an action is running', async () => {
    const { w, ticks } = setup([
      alarm({ timer: 0.5 }),
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [{ say: { who: 'picard', text: 'Wait.' } }] }] } },
    ]);
    void w.act('use', { target: 'panel' });
    await advance(w, 1.2);
    expect(ticks[0]).toBeGreaterThanOrEqual(60);
  });
});

describe('triggers', () => {
  const panel = (n: string, id = 'panel', extra: Effect[] = []): ObjectDef =>
    ({ id, name: id, screen: 'room', on: { use: [{ do: [mark(n), ...extra] }] } });

  it('fire a timer trigger every so many seconds', async () => {
    const { w, ticks } = setup([panel('t')], [{ id: 't', type: 'timer', context: 'away', target: 'panel', enabled: true, seconds: 2 }]);
    await advance(w, 5);
    expect(ticks).toEqual([121, 241]);
  });

  it('fire a normal trigger every tick until it is disabled', async () => {
    const { w, seen } = setup(
      [panel('n', 'panel', [{ trigger: { id: 'n', enabled: false } }])],
      [{ id: 'n', type: 'normal', context: 'away', target: 'panel', enabled: true }],
    );
    await advance(w, 1);
    expect(seen).toEqual(['n']);
  });

  it('fire only one trigger per tick', async () => {
    const { w, seen } = setup(
      [panel('a', 'a', [{ trigger: { id: 'a', enabled: false } }]), panel('b', 'b', [{ trigger: { id: 'b', enabled: false } }])],
      [
        { id: 'a', type: 'normal', context: 'away', target: 'a', enabled: true },
        { id: 'b', type: 'normal', context: 'away', target: 'b', enabled: true },
      ],
    );
    await advance(w, 1 / 60);
    expect(seen).toEqual(['a']);
    await advance(w, 1 / 60);
    expect(seen).toEqual(['a', 'b']);
  });

  it('act as the leader', async () => {
    const { w } = setup(
      [{ id: 'panel', name: 'panel', screen: 'room', on: { use: [{ when: { who: 'picard' }, do: [{ trigger: { id: 'n', enabled: false } }] }] } }],
      [{ id: 'n', type: 'normal', context: 'away', target: 'panel', enabled: true }],
    );
    w.state.currentActor = 'data';
    await advance(w, 1 / 60);
    expect(w.state.triggers.n.enabled).toBe(false);
  });

  it('fire before object timers, in the same tick', async () => {
    const { w, seen, ticks } = setup(
      [alarm({ timer: 1 / 60 }), panel('n', 'panel', [{ trigger: { id: 'n', enabled: false } }])],
      [{ id: 'n', type: 'normal', context: 'away', target: 'panel', enabled: true }],
    );
    await advance(w, 1 / 60);
    expect(seen).toEqual(['n', 'alarm']);
    expect(ticks).toEqual([1, 1]);
  });

  it('leave ship triggers alone during an away mission', async () => {
    const { w, seen } = setup([panel('s')], [{ id: 's', type: 'normal', context: 'ship', target: 'panel', enabled: true }]);
    await advance(w, 1);
    expect(seen).toEqual([]);
  });
});

describe('proximity triggers', () => {
  it('never fire, even switched on for the away team: the starship modes run them (M3 Decision 5)', async () => {
    const beacon: ObjectDef = { id: 'beacon', name: 'Beacon', screen: 'room', on: { use: [{ do: [mark('beacon')] }] } };
    const { w, seen } = setup([beacon], [{
      id: 't9', type: 'proximity', context: 'away', target: 'beacon', enabled: true,
      proximity: { dist: 5, from: '5f0100', to: '5f0101', reversed: false, instant: true },
    }]);
    await advance(w, 2);
    expect(seen).toEqual([]);
  });
});
