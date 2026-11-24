// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef } from '../content/types';
import { makeWorld } from '../testing/fixture';
import { alter } from './alter';
import { Clock } from './clock';
import type { HeadlessPresenter } from './presenter';
import { react } from './react';
import { flush, settle } from './settle';
import { StopSignal } from './stop';
import type { World } from './world';

const panel: ObjectDef = {
  id: 'panel', name: 'Panel', screen: 'room', at: 'panel', description: { text: 'A panel.' },
  on: { use: [{ do: [{ say: { who: 'picard', text: 'Done.' } }] }] },
};
const log = (w: World) => (w.presenter as HeadlessPresenter).log;
const use = { verb: 'use' as const, target: 'panel', who: 'picard', other: null, walked: false };

/** Starts Picard walking to (10, 0) at the headless 2 m/s, and lets a second of it pass. */
async function walkingASecond(w: World): Promise<void> {
  void w.act('walk', { to: { x: 10, z: 0 }, who: 'picard' });
  await flush();
  w.clock.advanceTo(w.clock.now + 60);
  await flush();
}

describe('StopSignal and Clock.wait', () => {
  it('ends a wait early and leaves nothing behind for the clock to jump to', async () => {
    const clock = new Clock({ tick: 0 });
    const stop = new StopSignal();
    let done = false;
    void clock.wait(100, stop).then(() => { done = true; });
    expect(clock.nextDue()).toBe(100);
    stop.stop();
    await flush();
    expect(done).toBe(true);
    expect(clock.nextDue()).toBeUndefined();
  });

  it('calls a listener added after the stop at once, and each listener once', () => {
    const stop = new StopSignal();
    let calls = 0;
    stop.onStop(() => calls++);
    stop.stop();
    stop.stop();
    stop.onStop(() => calls++);
    expect(calls).toBe(2);
    expect(stop.stopped).toBe(true);
  });
});

describe('stopping walks', () => {
  it('stops a walk in progress where the walker has got to, on a halt', async () => {
    const w = makeWorld([panel]);
    await walkingASecond(w);
    w.halt('picard');
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 2, z: 0 });
  });

  it('lets a new command stop the walk and run straight away', async () => {
    const w = makeWorld([panel]);
    await walkingASecond(w);
    expect(w.busy).toBe(true);
    expect(w.interruptible).toBe(true);
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.']);
    expect(w.obj('picard').pos).toEqual({ x: 2, z: 0 });
  });

  it("doesn't stop someone else's walk", async () => {
    const w = makeWorld([panel]);
    await walkingASecond(w);
    w.halt('data');
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 10, z: 0 });
  });

  it('keeps where an alter put the walker, and stops the walk', async () => {
    const w = makeWorld([panel]);
    await walkingASecond(w);
    // (as a rule running beside the walk would: walks run one at a time today, the original's don't)
    await alter(w, { object: 'picard', at: 'center' }, use);
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 5, z: 5 });
  });

  it('drops the action of a walk-then-act whose walk an alter stopped', async () => {
    const w = makeWorld([panel]);
    w.walkThenAct('picard', { x: 10, z: 0 }, use);
    await flush();
    await alter(w, { object: 'picard', at: 'center' }, use);
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0']);
    expect(w.obj('picard').pos).toEqual({ x: 5, z: 5 });
  });

  it("keeps a beam's placement over the walk it stops", async () => {
    const w = makeWorld([panel]);
    await walkingASecond(w);
    const beamed = react(w, { who: 'actor', do: { beamTo: { screen: 'hall', entrance: 'entry' } } }, use);
    await settle(w);
    await beamed;
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
  });

  it('cancels the queued actions without stopping the walk in progress', async () => {
    const w = makeWorld([panel]);
    w.walkThenAct('picard', { x: 10, z: 0 }, use);
    await flush();
    w.cancelQueuedActions('picard');
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 10, z: 0 });
    expect(log(w)).toEqual(['walk picard -> 10,0']);
  });

  it('is not interruptible while an action runs, only while plain walks do', async () => {
    const w = makeWorld([panel]);
    expect(w.interruptible).toBe(true);
    void w.act('look', { target: 'panel', who: 'picard' });
    await flush();
    expect(w.busy).toBe(true);
    expect(w.interruptible).toBe(false);
    await settle(w);
    expect(w.interruptible).toBe(true);
  });

  it('keeps a walk-then-act queued until its walk is over, as runQueuedActions does', async () => {
    const w = makeWorld([panel]);
    w.walkThenAct('picard', { x: 10, z: 0 }, use);
    await flush();
    expect(log(w)).toEqual(['walk picard -> 10,0']);
    // (the same action again while the first is still walking is dropped)
    w.walkThenAct('picard', { x: 10, z: 0 }, use);
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.']);
    // (and once it has run, it can be queued again)
    w.walkThenAct('picard', { x: 10, z: 0 }, use);
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.', 'say picard: Done.']);
  });
});
