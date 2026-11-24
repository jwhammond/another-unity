// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef } from '../content/types';
import { makeWorld } from '../testing/fixture';
import type { SimEvent } from './events';
import { R } from './result';
import { settle } from './settle';

const lever: ObjectDef = {
  id: 'lever', name: 'Lever', screen: 'room',
  on: {
    use: [
      { when: { other: 'tricorder' }, do: [{ say: { who: 'picard', text: 'Scanned.' } }] },
      { do: [{ alter: { object: 'lever', state: 1 } }, { say: { who: 'picard', text: 'Pulled.' } }] },
    ],
  },
};

describe('rule events', () => {
  it('announces a skipped group with its result, and each effect that ran with its own', async () => {
    const w = makeWorld([lever]);
    const events: SimEvent[] = [];
    w.bus.on(e => { if (e.type === 'ruleSkipped' || e.type === 'effectRan') events.push(e); });
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(events).toEqual([
      { type: 'ruleSkipped', target: 'lever', verb: 'use', group: 'lever/use/0', result: R.FAILOTHER },
      { type: 'effectRan', group: 'lever/use/1', effect: 'alter', result: 0 },
      { type: 'effectRan', group: 'lever/use/1', effect: 'say', result: 0 },
    ]);
  });
});

describe('World.jump', () => {
  it('goes to a screen as a screen change would, and only while nothing runs', async () => {
    const w = makeWorld([lever]);
    w.jump('hall', 'entry');
    expect(w.state.screen).toBe('hall');
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(() => w.jump('nowhere', 'entry')).toThrow('unknown screen: nowhere');
    expect(() => w.jump('room', 'nowhere')).toThrow('unknown marker "nowhere" on screen "room"');
    void w.enqueue(() => w.clock.wait(10));
    expect(() => w.jump('room', 'door')).toThrow('cannot jump while an action is running');
    await settle(w);
    expect(w.state.screen).toBe('hall');
  });
});
