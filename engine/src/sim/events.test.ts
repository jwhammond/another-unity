// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef } from '../content/types';
import * as engine from '../index';
import { makeWorld } from '../testing/fixture';
import { runConversation } from './conversation';
import { runEffect } from './effects';
import { EventBus, type SimEvent } from './events';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const lever: ObjectDef = {
  id: 'lever', name: 'Lever', screen: 'room',
  on: { use: [{ do: [{ alter: { object: 'lever', state: 1 } }, { say: { who: 'picard', text: 'Done.' } }] }] },
};
const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('EventBus', () => {
  it('keeps telling the other subscribers when one throws, and hands the error on', () => {
    const errors: unknown[] = [];
    const bus = new EventBus(err => errors.push(err));
    const seen: string[] = [];
    bus.on(() => { throw new Error('bad subscriber'); });
    bus.on(e => seen.push(e.type));
    bus.emit({ type: 'screenChanged', screen: 'hall' });
    expect(seen).toEqual(['screenChanged']);
    expect((errors[0] as Error).message).toBe('bad subscriber');
  });

  it('lets an action carry on when a subscriber throws, and records the error', async () => {
    const w = makeWorld([lever]);
    w.bus.on(e => { if (e.type === 'objectChanged') throw new Error('view broke'); });
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.obj('lever').state).toBe(1);
    expect(log(w)).toContain('say picard: Done.');
    expect(w.errors.map(e => (e as Error).message)).toEqual(['view broke']);
  });
});

describe('Clock guard', () => {
  it('refuses to wait a number of ticks that is not a number', () => {
    const w = makeWorld([]);
    expect(() => w.clock.wait(NaN)).toThrow('cannot wait NaN ticks');
    expect(() => w.clock.wait(Infinity)).toThrow('cannot wait Infinity ticks');
  });

  it('fails an action that waits NaN ticks instead of hanging the queue', async () => {
    const w = makeWorld([]);
    void w.enqueue(() => w.clock.wait(NaN));
    await settle(w);
    expect(w.busy).toBe(false);
    expect(w.errors[0]).toBeInstanceOf(RangeError);
  });
});

describe('choices', () => {
  it('does nothing when the presenter answers neither option', async () => {
    for (const bad of [2, -1, NaN]) {
      const w = makeWorld([]);
      (w.presenter as HeadlessPresenter).answer(bad as 0 | 1);
      void w.enqueue(async () => {
        await runEffect(w, {
          choose: {
            question: 'Go?',
            options: [
              { text: 'Yes', do: [{ do: [{ say: { who: 'picard', text: 'Yes!' } }] }] },
              { text: 'No', do: [{ do: [{ say: { who: 'picard', text: 'No!' } }] }] },
            ],
          },
        }, { verb: 'use', target: null, who: 'picard', other: null, walked: false }, 'k');
      });
      await settle(w);
      expect(log(w)).toEqual(['choose Go?']);
      expect(w.errors).toEqual([]);
    }
  });
});

describe('events for the view', () => {
  it('announces a response that only turns the speaker', async () => {
    const w = makeWorld([], {
      conversations: { chat: { id: 'chat', responses: [{ situation: 1, key: 0, state: 'enabled', who: ['$anyone'], text: '', turn: 'right' }] } },
    });
    const events: SimEvent[] = [];
    w.bus.on(e => { if (e.type === 'turned') events.push(e); });
    void w.enqueue(async () => { await runConversation(w, 'chat', 1, 'picard'); });
    await settle(w);
    expect(events).toEqual([{ type: 'turned', who: 'picard', side: 'right' }]);
  });

  it('announces the speaker facing whoever replies, once a conversation', async () => {
    const w = makeWorld([{ id: 'guard', name: 'Guard', screen: 'room', at: 'panel' }], {
      conversations: {
        chat: {
          id: 'chat',
          responses: [
            { situation: 1, key: 0, state: 'enabled', who: ['$anyone'], text: 'Hello.', replier: { object: 'guard' }, replies: [{ text: 'Hm.' }], next: 2 },
            { situation: 2, key: 0, state: 'enabled', who: ['$anyone'], text: 'Bye.', replier: { object: 'guard' }, replies: [{ text: 'Go.' }] },
          ],
        },
      },
    });
    const events: SimEvent[] = [];
    w.bus.on(e => { if (e.type === 'faced') events.push(e); });
    void w.enqueue(async () => { await runConversation(w, 'chat', 1, 'picard'); });
    await settle(w);
    expect(events).toEqual([{ type: 'faced', who: 'picard', toward: 'guard' }]);
  });

  it('announces an object a reaction brings to this screen', async () => {
    const w = makeWorld([{ id: 'cargo', name: 'Cargo', screen: 'hall' }]);
    const changed: string[] = [];
    w.bus.on(e => { if (e.type === 'objectChanged') changed.push(e.id); });
    void w.enqueue(async () => {
      await runEffect(w, { react: { who: { object: 'cargo' }, do: 'stun' } }, { verb: 'use', target: null, who: 'picard', other: null, walked: false }, 'k');
    });
    await settle(w);
    expect(w.obj('cargo').screen).toBe('room');
    expect(changed).toEqual(['cargo']);
  });

  it("doesn't export the bare screen change, which skips dropping the queued walks", () => {
    expect(Object.keys(engine)).not.toContain('applyScreenChange');
    expect(Object.keys(engine)).toContain('requestScreen');
  });
});

describe('World.selectMember', () => {
  it('selects a member who is here and on their feet, and nobody else', () => {
    const w = makeWorld([{ id: 'panel', name: 'Panel', screen: 'room' }]);
    expect(w.selectMember('data')).toBe(true);
    expect(w.state.currentActor).toBe('data');
    expect(w.selectMember('panel')).toBe(false);
    w.state.phaser.picard.health = 2;
    expect(w.selectMember('picard')).toBe(false);
    w.state.phaser.picard.health = 10;
    w.obj('picard').screen = 'hall';
    expect(w.selectMember('picard')).toBe(false);
    expect(w.state.currentActor).toBe('data');
  });
});
