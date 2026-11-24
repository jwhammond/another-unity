// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, ObjectDef } from '../content/types';
import { makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import { NotPorted } from './hooks';
import type { HeadlessPresenter } from './presenter';
import { R } from './result';
import { settle } from './settle';
import type { World } from './world';

const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room', at: 'panel', description: { text: 'A panel.' } };
const tricorder: ObjectDef = { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true };

function world(): World {
  return makeWorld([panel, tricorder], {
    triggers: [{ id: 't', type: 'timer', context: 'away', target: 'panel', enabled: false, seconds: 1 }],
  });
}

async function exec(w: World, fx: Effect): Promise<number> {
  let result = -1;
  void w.enqueue(async () => {
    result = await runEffect(w, fx, { verb: 'use', target: 'panel', who: 'picard', other: null, walked: false }, 'k');
  });
  await settle(w);
  return result;
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('runEffect', () => {
  it('records content the export lacks in the trace, and goes on (M3 Decision 3)', async () => {
    const w = world();
    const seen: string[] = [];
    w.bus.on(e => {
      if (e.type === 'warning') seen.push(e.message);
      if (e.type === 'missing') seen.push(`event ${e.kind} ${e.id}`);
    });
    expect(await exec(w, { missing: { kind: 'movie', id: '42' } })).toBe(0);
    expect(seen).toEqual(['missing: movie 42', 'event movie 42']);
  });

  it('acts on the current member when the act names $anyone as its object (getWalker, unity.cpp:876-886)', async () => {
    const w = world();
    const seen: (string | null)[] = [];
    w.bus.on(e => { if (e.type === 'actionStarted' && e.verb === 'look') seen.push(e.target); });
    await exec(w, { act: { verb: 'look', object: '$anyone' } });
    expect(seen).toEqual([w.state.currentActor]);
  });

  it('alters an object and announces it', async () => {
    const w = world();
    const changed: string[] = [];
    w.bus.on(e => { if (e.type === 'objectChanged') changed.push(e.id); });
    expect(await exec(w, { alter: { object: 'panel', state: 3, name: 'Broken Panel', active: false } })).toBe(0);
    expect(w.obj('panel')).toMatchObject({ state: 3, name: 'Broken Panel', active: false });
    expect(changed).toEqual(['panel']);
  });

  it('moves an object to a marker', async () => {
    const w = world();
    await exec(w, { alter: { object: 'panel', at: 'center' } });
    expect(w.obj('panel').pos).toEqual({ x: 5, z: 5 });
  });

  it('takes an object into the inventory', async () => {
    const w = world();
    await exec(w, { alter: { object: 'panel', get: true } });
    expect(w.obj('panel')).toMatchObject({ inventory: true, screen: null });
  });

  it('fails to alter an object that does not exist', async () => {
    expect(await exec(world(), { alter: { object: 'ghost' } })).toBe(R.FAILOTHER);
  });

  it('turns walk regions on and off on the current screen', async () => {
    const w = world();
    await exec(w, { path: { enable: ['bridge'] } });
    expect(w.state.regions.room.bridge).toBe(true);
    await exec(w, { path: { disable: ['bridge'] } });
    expect(w.state.regions.room.bridge).toBe(false);
  });

  it('enables a trigger and restarts its timer', async () => {
    const w = world();
    w.state.triggers.t.due = 99;
    await exec(w, { trigger: { id: 't', enabled: true } });
    expect(w.state.triggers.t).toEqual({ enabled: true, due: 0 });
  });

  it('requests a screen change without making it', async () => {
    const w = world();
    await exec(w, { screen: { to: 'hall', entrance: 'entry' } });
    expect(w.state.pendingScreen).toEqual({ to: 'hall', entrance: 'entry' });
    expect(w.state.screen).toBe('room');
  });

  it('speaks lines and descriptions through the presenter', async () => {
    const w = world();
    await exec(w, { say: { who: 'data', text: 'Hello.' } });
    await exec(w, { describe: { object: 'panel' } });
    expect(log(w)).toEqual(['say data: Hello.', 'say picard: A panel.']);
  });

  it('plays media through the presenter', async () => {
    const w = world();
    await exec(w, { play: { sound: 'beep' } });
    expect(log(w)).toEqual(['play beep']);
  });

  it('remembers a movie it plays for the holodeck, once, and a sound is no movie', async () => {
    const w = world();
    expect(w.state.ship.seenMovies).toEqual(['shiptour']);
    await exec(w, { play: { movie: 'Labarriv' } });
    await exec(w, { play: { movie: 'labarriv' } });
    await exec(w, { play: { sound: 'beep' } });
    expect(w.state.ship.seenMovies).toEqual(['shiptour', 'labarriv']);
  });

  it('calls a hook with its arguments and returns its flags', async () => {
    const w = world();
    const seen: unknown[] = [];
    w.hooks.register('test.hook', (_w, ctx, args) => {
      seen.push(ctx.target, args.n);
      return R.FAILSTATE;
    });
    expect(await exec(w, { call: { hook: 'test.hook', args: { n: 4 } } })).toBe(R.FAILSTATE);
    expect(seen).toEqual(['panel', 4]);
  });

  it('fails loudly on a hook that has not been ported', async () => {
    const w = world();
    await exec(w, { call: { hook: 'unity.commands.c99' } });
    expect(w.errors[0]).toBeInstanceOf(NotPorted);
    expect((w.errors[0] as NotPorted).hook).toBe('unity.commands.c99');
  });

  it('names the hook when one fails', async () => {
    const w = world();
    const err = new Error('kaboom');
    w.hooks.register('test.boom', () => { throw err; });
    await exec(w, { call: { hook: 'test.boom' } });
    expect((w.errors[0] as Error).message).toBe('hook test.boom failed: kaboom');
    expect((w.errors[0] as Error).cause).toBe(err);
  });

  it('passes on a not-ported error from inside a hook unchanged', async () => {
    const w = world();
    const err = new NotPorted('unity.inner');
    w.hooks.register('test.outer', () => { throw err; });
    await exec(w, { call: { hook: 'test.outer' } });
    expect(w.errors[0]).toBe(err);
  });

  it('asks a question through the presenter', async () => {
    const w = world();
    (w.presenter as HeadlessPresenter).answer(1);
    await exec(w, { choose: { question: 'Go?', options: [{ text: 'Yes', do: [] }, { text: 'No', do: [] }] } });
    expect(log(w)).toEqual(['choose Go?']);
  });
});
