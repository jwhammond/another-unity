// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeWorld } from '../testing/fixture';
import { NotPorted } from './hooks';
import { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import { World } from './world';

describe('World', () => {
  it('runs queued tasks one at a time, in order', async () => {
    const w = makeWorld([]);
    const log = (w.presenter as HeadlessPresenter).log;
    void w.enqueue(async () => {
      await w.presenter.say('picard', 'one-a');
      await w.presenter.say('picard', 'one-b');
    });
    void w.enqueue(async () => {
      await w.presenter.say('data', 'two');
    });
    expect(w.busy).toBe(true);
    await settle(w);
    expect(log).toEqual(['say picard: one-a', 'say picard: one-b', 'say data: two']);
    expect(w.busy).toBe(false);
  });

  it('records a failed task and keeps running later ones', async () => {
    const w = makeWorld([]);
    const failures: string[] = [];
    w.bus.on(e => { if (e.type === 'actionFailed') failures.push(e.error); });
    let ran = false;
    void w.enqueue(async () => { throw new NotPorted('unity.commands.c12'); });
    void w.enqueue(async () => { ran = true; });
    await settle(w);
    expect(ran).toBe(true);
    expect(w.errors[0]).toBeInstanceOf(NotPorted);
    expect(failures).toEqual(['hook not ported: unity.commands.c12']);
  });

  it('keeps running tasks when an actionFailed handler throws', async () => {
    const w = makeWorld([]);
    w.bus.on(() => { throw new Error('bad subscriber'); });
    let ran = false;
    void w.enqueue(async () => { throw new Error('boom'); });
    void w.enqueue(async () => { ran = true; });
    await settle(w);
    expect(ran).toBe(true);
    expect(w.errors.map(e => (e as Error).message)).toEqual(['boom', 'bad subscriber']);
  });

  it('refuses to save while an action is running, and round-trips when idle', async () => {
    const w = makeWorld([]);
    void w.enqueue(() => w.presenter.say('picard', 'hold on'));
    expect(() => w.save()).toThrow('cannot save while an action is running');
    await settle(w);
    const loaded = World.fromSave(w.content, w.save(), x => new HeadlessPresenter(x.clock));
    expect(loaded.state).toEqual(w.state);
  });

  it('reports a world stuck on something other than the clock', async () => {
    const w = makeWorld([]);
    void w.enqueue(() => new Promise<void>(() => {}));
    await expect(settle(w)).rejects.toThrow(/world is stuck/);
  });
});
