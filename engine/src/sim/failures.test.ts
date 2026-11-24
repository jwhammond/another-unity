// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef, Verb } from '../content/types';
import { lineConversation, makeWorld } from '../testing/fixture';
import { reportFailure } from './failures';
import type { HeadlessPresenter } from './presenter';
import { R } from './result';
import { settle } from './settle';
import type { World } from './world';

const fail = lineConversation('fail', {
  1: 'Nothing to see.', 2: 'No answer.', 3: 'That does nothing.', 4: "They don't go together.", 5: 'Not with a phaser.', 23: 'Nothing unusual.',
});
const guard: ObjectDef = { id: 'guard', name: 'Guard', screen: 'room', on: { look: [{ when: { who: 'data' }, do: [] }] } };
const tricorder: ObjectDef = { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true };
const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room' };

function world(): World {
  const line = (situation: number) => ({ conversation: 'fail', situation });
  return makeWorld([guard, tricorder, panel], {
    conversations: { fail },
    rules: {
      items: { tricorder: 'tricorder' },
      lines: { failLook: line(1), failTalk: line(2), failUse: line(3), failOther: line(4), failPhaser: line(5), tricorderNothing: line(23) },
    },
  });
}

async function report(w: World, verb: Verb, result: number, other: string | null = null): Promise<string[]> {
  const before = (w.presenter as HeadlessPresenter).log.length;
  void w.enqueue(() => reportFailure(w, { verb, target: 'guard', who: 'picard', other, walked: false }, result));
  await settle(w);
  return (w.presenter as HeadlessPresenter).log.slice(before);
}

describe('reportFailure', () => {
  it('says the look line when looking did nothing', async () => {
    const w = world();
    void w.act('look', { target: 'guard', who: 'picard' });
    await settle(w);
    expect((w.presenter as HeadlessPresenter).log).toEqual(['say picard: Nothing to see.']);
  });

  it('says the use line, or the line for two things that do not go together', async () => {
    const w = world();
    void w.act('use', { target: 'guard', who: 'picard' });
    void w.act('use', { target: 'guard', who: 'picard', other: 'panel' });
    await settle(w);
    expect((w.presenter as HeadlessPresenter).log).toEqual(['say picard: That does nothing.', "say picard: They don't go together."]);
  });

  it('says the tricorder line in place of the other-object line', async () => {
    const w = world();
    void w.act('use', { target: 'guard', who: 'picard', other: 'tricorder' });
    await settle(w);
    expect((w.presenter as HeadlessPresenter).log).toEqual(['say picard: Nothing unusual.']);
  });

  it('matches the use results exactly, with a phaser failure first', async () => {
    const w = world();
    expect(await report(w, 'use', R.FAILPHASER | R.FAILSTATE)).toEqual(['say picard: Not with a phaser.']);
    expect(await report(w, 'use', R.FAILSTATE, 'panel')).toEqual(['say picard: That does nothing.']);
    expect(await report(w, 'use', R.FAILPHASER, 'tricorder')).toEqual(['say picard: Not with a phaser.']);
    expect(await report(w, 'use', R.DIDSOMETHING, 'tricorder')).toEqual([]);
  });

  it('says the talk line only for a talk that did something wrong', async () => {
    const w = world();
    expect(await report(w, 'talk', 0)).toEqual([]);
    expect(await report(w, 'talk', R.EMPTYTALK)).toEqual(['say picard: No answer.']);
    expect(await report(w, 'talk', R.EMPTYTALK | R.DIDSOMETHING)).toEqual([]);
  });

  it('says nothing for get and walk', async () => {
    const w = world();
    expect(await report(w, 'get', 0)).toEqual([]);
    expect(await report(w, 'walk', 0)).toEqual([]);
  });

  it('speaks as the current member', async () => {
    const w = world();
    w.state.currentActor = 'data';
    expect(await report(w, 'use', 0)).toEqual(['say data: That does nothing.']);
  });
});
