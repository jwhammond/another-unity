// SPDX-License-Identifier: GPL-3.0-or-later
import { describe as group, expect, it } from 'vitest';
import { checkRefs } from '../content/refs';
import type { Effect, ObjectDef } from '../content/types';
import { lineConversation, makeGame, makeWorld } from '../testing/fixture';
import { describe, runEffect } from './effects';
import { R } from './result';
import { runList } from './rules';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { ActionContext, World } from './world';

const guard: ObjectDef = {
  id: 'guard', name: 'Guard', screen: 'room', at: 'panel', talk: 'Halt.',
  description: { text: 'A guard.' }, descriptions: { data: { text: 'An armed guard.' } },
};
const crate: ObjectDef = { id: 'crate', name: 'Crate', screen: 'room' };

function world(): World {
  return makeWorld([guard, crate], {
    conversations: { fail: lineConversation('fail', { 1: 'Nothing special.' }) },
    rules: { items: {}, lines: { failLook: { conversation: 'fail', situation: 1 } } },
  });
}

const ctx: ActionContext = { verb: 'use', target: 'guard', who: 'data', other: null, walked: false };

async function exec(w: World, fx: Effect, c = ctx): Promise<number> {
  let r = -1;
  void w.enqueue(async () => {
    r = await runEffect(w, fx, c, 'k');
  });
  await settle(w);
  return r;
}

async function look(w: World, id: string, who: string): Promise<void> {
  void w.enqueue(() => describe(w, id, who));
  await settle(w);
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

group('describe', () => {
  it("uses the crew member's own description, then the shared one, then the look line", async () => {
    const w = world();
    await look(w, 'guard', 'data');
    await look(w, 'guard', 'picard');
    await look(w, 'crate', 'picard');
    expect(log(w)).toEqual(['say data: An armed guard.', 'say picard: A guard.', 'say picard: Nothing special.']);
  });

  it('says nothing once a screen change is pending', async () => {
    const w = world();
    w.state.pendingScreen = { to: 'hall', entrance: 'entry' };
    await look(w, 'guard', 'data');
    expect(log(w)).toEqual([]);
  });
});

group('act', () => {
  it('acts as the current member by default, and returns 0 whatever happens', async () => {
    const w = world();
    expect(await exec(w, { act: { verb: 'talk', object: 'guard' } })).toBe(0);
    expect(await exec(w, { act: { verb: 'use', object: 'crate' } })).toBe(0);
    expect(log(w)).toEqual(['say guard: Halt.']);
  });

  it('acts as whoever is acting for $actor, or as someone named', async () => {
    const w = world();
    await exec(w, { act: { verb: 'look', object: 'guard', who: '$actor' } });
    await exec(w, { act: { verb: 'look', object: 'guard', who: 'picard' } });
    expect(log(w)).toEqual(['say data: An armed guard.', 'say picard: A guard.']);
  });

  it('walks to a marker', async () => {
    const w = world();
    await exec(w, { act: { verb: 'walk', who: 'data', at: 'center' } });
    expect(w.obj('data').pos).toEqual({ x: 5, z: 5 });
  });

  it('is checked at load time', () => {
    const user: ObjectDef = { id: 'user', name: 'User', screen: 'room', on: { use: [{ do: [{ act: { verb: 'use', object: 'crat' } }] }] } };
    expect(checkRefs(makeGame([user]))).toEqual(['objects/user: on.use[0].do[0].act.object: unknown object "crat"']);
  });
});

group('choose', () => {
  it('does nothing for an answer that is neither button', async () => {
    const w = world();
    (w.presenter as HeadlessPresenter).answer(2 as 0 | 1);
    const fx: Effect = { choose: { question: 'Go?', options: [{ text: 'Yes', do: [{ do: [{ say: { who: 'data', text: 'Yes.' } }] }] }, { text: 'No', do: [] }] } };
    expect(await exec(w, fx)).toBe(0);
    expect(log(w)).toEqual(['choose Go?']);
  });

  it('passes only a stop out of the chosen branch, not its failures', async () => {
    const w = world();
    (w.presenter as HeadlessPresenter).answer(0);
    const fx: Effect = {
      choose: { question: 'Go?', options: [{ text: 'Yes', do: [{ when: { who: 'picard' }, do: [{ say: { who: 'data', text: 'Never.' } }] }] }, { text: 'No', do: [] }] },
    };
    // the branch fails its who check (AWAYTEAM) but the outer group carries on
    const r = await exec(w, { choose: fx.choose } as Effect);
    expect(r).toBe(0);
    (w.presenter as HeadlessPresenter).answer(0);
    let after = -1;
    void w.enqueue(async () => {
      after = await runList(w, [{ do: [fx, { say: { who: 'data', text: 'Next.' } }] }], ctx, 'k');
    });
    await settle(w);
    expect(after & ~R.DIDSOMETHING).toBe(0);
    expect(log(w)).toContain('say data: Next.');
    expect(log(w)).not.toContain('say data: Never.');
  });

  it('stops the outer list when the chosen branch stops', async () => {
    const w = world();
    (w.presenter as HeadlessPresenter).answer(0);
    const fx: Effect = { choose: { question: 'Go?', options: [{ text: 'Yes', do: [{ do: [{ say: { who: 'data', text: 'Yes.' }, stop: true }] }] }, { text: 'No', do: [] }] } };
    let r = -1;
    void w.enqueue(async () => {
      r = await runList(w, [{ do: [fx] }, { do: [{ say: { who: 'data', text: 'Late.' } }] }], ctx, 'k');
    });
    await settle(w);
    expect(r & R.STOPPED).toBeTruthy();
    expect(log(w)).not.toContain('say data: Late.');
  });
});
