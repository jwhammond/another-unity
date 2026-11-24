// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, RuleGroup } from '../content/types';
import { makeWorld } from '../testing/fixture';
import { R } from './result';
import { runList } from './rules';
import { settle } from './settle';
import type { World } from './world';

const mark = (n: number, stop?: boolean): Effect => ({ call: { hook: 'mark', args: { n } }, ...(stop ? { stop } : {}) });
const fail: Effect = { call: { hook: 'fail' } };

function setup(groups: RuleGroup[]): { w: World; seen: unknown[] } {
  const w = makeWorld([
    { id: 'panel', name: 'Panel', screen: 'room', at: 'panel', on: { use: groups } },
    { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true },
  ]);
  const seen: unknown[] = [];
  w.hooks.register('mark', (_w, _ctx, args) => {
    seen.push(args.n);
    return 0;
  });
  w.hooks.register('fail', () => R.FAILSTATE);
  return { w, seen };
}

async function run(w: World, other: string | null = null): Promise<number> {
  let result = -1;
  const groups = w.content.objects.panel.on?.use ?? [];
  void w.enqueue(async () => {
    result = await runList(w, groups, { verb: 'use', target: 'panel', who: 'picard', other, walked: false }, 'panel/use');
  });
  await settle(w);
  return result;
}

describe('runList', () => {
  it('skips a group whose condition fails and runs the next', async () => {
    const { w, seen } = setup([{ when: { who: 'data' }, do: [mark(1)] }, { do: [mark(2)] }]);
    const r = await run(w);
    expect(seen).toEqual([2]);
    expect(r & R.DIDSOMETHING).toBeTruthy();
  });

  it('stops the group and the list at an effect marked stop', async () => {
    const { w, seen } = setup([{ do: [mark(1), mark(2, true), mark(3)] }, { do: [mark(4)] }]);
    const r = await run(w);
    expect(seen).toEqual([1, 2]);
    expect(r & R.STOPPED).toBeTruthy();
  });

  it('ends only the group when an effect fails', async () => {
    const { w, seen } = setup([{ do: [mark(1), fail, mark(2)] }, { do: [mark(3)] }]);
    await run(w);
    expect(seen).toEqual([1, 3]);
  });

  it('stops before any effects when the condition is marked stop', async () => {
    const { w, seen } = setup([{ when: { stop: true }, do: [mark(1)] }, { do: [mark(2)] }]);
    const r = await run(w);
    expect(seen).toEqual([]);
    expect(r & R.STOPPED).toBeTruthy();
  });

  it('skips every later group once a walk starts, then runs the list again in range', async () => {
    const { w, seen } = setup([
      { when: { near: { dist: 1 } }, do: [mark(1)] },
      { do: [mark(2)] },
      { when: {}, do: [mark(3)] },
    ]);
    const r = await run(w);
    expect(r & R.WALKING).toBeTruthy();
    // (run() settles, so the re-run after the walk has happened too)
    expect(seen).toEqual([1, 2, 3]);
    expect(w.obj('picard').pos).toEqual({ x: 9, z: 0 });
  });

  it('queues the re-run after a walk only once, however many groups ask for it', async () => {
    const { w, seen } = setup([
      { when: { near: { dist: 1 }, who: 'data' }, do: [mark(1)] },
      { when: { near: { dist: 1 } }, do: [mark(2)] },
    ]);
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    expect(seen).toEqual([2]);
    expect(w.errors).toEqual([]);
  });

  it('drops a queued walk when the screen changes', async () => {
    const { w, seen } = setup([
      { do: [mark(0), { screen: { to: 'hall', entrance: 'entry' } }] },
      { when: { near: { dist: 1 } }, do: [mark(1)] },
    ]);
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    expect(w.state.screen).toBe('hall');
    expect(seen).toEqual([0]);
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
  });

  it('reports a match on the other object', async () => {
    const { w } = setup([{ when: { other: 'tricorder' }, do: [] }]);
    expect((await run(w, 'tricorder')) & R.MATCHOTHER).toBeTruthy();
  });

  it('keeps a separate counter for each group', async () => {
    const { w, seen } = setup([
      { when: { counter: { mode: 'until', value: 1 } }, do: [mark(1)] },
      { when: { counter: { mode: 'until', value: 1 } }, do: [mark(2)] },
    ]);
    await run(w);
    await run(w);
    expect(seen).toEqual([1, 2]);
    expect(w.state.counters).toEqual({ 'panel/use/0': 0, 'panel/use/1': 0 });
  });

  it('runs the chosen option of a question', async () => {
    const { w, seen } = setup([{
      do: [{ choose: { question: 'Go?', options: [{ text: 'A', do: [{ do: [mark(1)] }] }, { text: 'B', do: [{ do: [mark(2)] }] }] } }],
    }]);
    (w.presenter as unknown as { answer(c: 0 | 1): void }).answer(1);
    await run(w);
    expect(seen).toEqual([2]);
  });

  it('announces each group that runs', async () => {
    const { w } = setup([{ when: { who: 'data' }, do: [mark(1)] }, { do: [mark(2)] }]);
    const ran: string[] = [];
    w.bus.on(e => { if (e.type === 'ruleRan') ran.push(e.group); });
    await run(w);
    expect(ran).toEqual(['panel/use/1']);
  });
});
