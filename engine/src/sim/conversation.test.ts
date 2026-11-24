// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { checkRefs } from '../content/refs';
import { effectSchema } from '../content/schema';
import type { ConversationDef, Effect, ObjectDef, ResponseDef } from '../content/types';
import { makeGame, makeWorld } from '../testing/fixture';
import { runConversation } from './conversation';
import { runEffect } from './effects';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const guard: ObjectDef = { id: 'guard', name: 'Guard', screen: 'room', at: 'panel' };
const r = (over: Partial<ResponseDef>): ResponseDef => ({ situation: 1, key: 0, state: 'enabled', who: ['$anyone'], ...over });

function world(responses: ResponseDef[]): World {
  const chat: ConversationDef = { id: 'chat', responses };
  return makeWorld([guard], { conversations: { chat } });
}

async function talk(w: World, situation = 1, who = 'picard', conversation = 'chat'): Promise<boolean> {
  let said = false;
  void w.enqueue(async () => {
    said = await runConversation(w, conversation, situation, who);
  });
  await settle(w);
  return said;
}

async function exec(w: World, fx: Effect): Promise<number> {
  let result = -1;
  void w.enqueue(async () => {
    result = await runEffect(w, fx, { verb: 'use', target: 'guard', who: 'picard', other: null, walked: false }, 'k');
  });
  await settle(w);
  return result;
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;
const pick = (w: World, index: number | null) => (w.presenter as HeadlessPresenter).pick(index);

describe('runConversation', () => {
  it('runs a lone candidate without a menu: the line, then the reply', async () => {
    const w = world([r({ text: 'Who goes there?', replier: { object: 'guard' }, replies: [{ text: 'A guard.' }] })]);
    expect(await talk(w)).toBe(true);
    expect(log(w)).toEqual(['say picard: Who goes there?', 'say guard: A guard.']);
  });

  it('tells the presenter which conversation and situation asks a menu', async () => {
    const w = world([r({ key: 0, text: 'A' }), r({ key: 1, text: 'B' })]);
    const asked: unknown[] = [];
    const presenter = w.presenter as HeadlessPresenter;
    const menu = presenter.menu.bind(presenter);
    presenter.menu = (options, at) => { asked.push(at); return menu(options, at); };
    pick(w, 0);
    await talk(w);
    expect(asked).toEqual([{ conversation: 'chat', situation: 1 }]);
  });

  it('runs the rest of a result past a change to the current screen, which stays pending for the action to apply', async () => {
    const w = world([
      r({ text: 'Go', next: 2, results: [[{ do: [{ screen: { to: '$current', entrance: 'center' } }, { say: { who: 'data', text: 'After.' } }] }]] }),
      r({ situation: 2, text: 'Never said' }),
    ]);
    await talk(w);
    expect(log(w)).toEqual(['say picard: Go', 'say data: After.']);
    // (the screen change is applied once the outermost action is done, not by a bare runConversation)
    expect(w.state.pendingScreen).toEqual({ to: 'room', entrance: 'center' });
  });

  it('offers a menu of the candidates, the last in the file first', async () => {
    const w = world([r({ key: 0, text: 'First' }), r({ key: 1, text: 'Second' }), r({ key: 2, text: 'Third', next: 2 }), r({ situation: 2, text: 'Then' })]);
    pick(w, 0);
    await talk(w);
    expect(log(w)).toEqual(['menu Third | Second | First', 'say picard: Third', 'say picard: Then']);
  });

  it('ends at once when the menu is cancelled or answered out of range', async () => {
    const w = world([r({ key: 0, text: 'A', changes: [{ to: 'disabled', situation: 1, key: 1 }] }), r({ key: 1, text: 'B' })]);
    pick(w, null);
    expect(await talk(w)).toBe(false);
    pick(w, 5);
    expect(await talk(w)).toBe(false);
    expect(log(w)).toEqual(['menu B | A', 'menu B | A']);
    expect(w.state.conversations.chat).toEqual(['enabled', 'enabled']);
  });

  it('turns a set response on only in the first situation of a run, and it stays on', async () => {
    const w = world([r({ text: 'Go on', next: 2 }), r({ situation: 2, state: 'set', text: 'Later' })]);
    await talk(w);
    expect(log(w)).toEqual(['say picard: Go on']);
    expect(w.state.conversations.chat[1]).toBe('set');
    await talk(w, 2);
    expect(log(w)).toEqual(['say picard: Go on', 'say picard: Later']);
    expect(w.state.conversations.chat[1]).toBe('enabled');
  });

  it('lets only the crew listed say a line, and only while with the team', async () => {
    const w = world([r({ who: ['data'], text: 'Data only' })]);
    expect(await talk(w, 1, 'picard')).toBe(false);
    expect(await talk(w, 1, 'data')).toBe(true);
    w.obj('data').screen = 'hall';
    expect(await talk(w, 1, 'data')).toBe(false);
  });

  it("lets anyone start a silent line, even from off the team", async () => {
    const w = world([r({ replier: { object: 'guard' }, replies: [{ text: 'Halt!' }] })]);
    w.obj('data').screen = 'hall';
    expect(await talk(w, 1, 'data')).toBe(true);
    expect(log(w)).toEqual(['say guard: Halt!']);
  });

  it('needs an active object replier, or a crew replier with the team', async () => {
    const w = world([r({ key: 0, text: 'Guard?', replier: { object: 'guard' } }), r({ key: 1, text: 'Data?', replier: { object: 'data' } })]);
    w.obj('guard').active = false;
    w.obj('data').screen = 'hall';
    expect(await talk(w)).toBe(false);
    expect(log(w)).toEqual([]);
  });

  it('says a teamCrew reply only from the team, and a crew reply from anywhere', async () => {
    const w = world([
      r({ text: 'Q1', replier: { teamCrew: 'data' }, replies: [{ text: 'A1' }], next: 2 }),
      r({ situation: 2, text: 'Q2', replier: { crew: 'data' }, replies: [{ text: 'A2' }] }),
    ]);
    w.obj('data').screen = 'hall';
    await talk(w);
    expect(log(w)).toEqual(['say picard: Q1', 'say picard: Q2', 'say data: A2']);
  });

  it("doesn't say the text of a response that only turns the speaker", async () => {
    const w = world([r({ text: 'Unsaid', turn: 'left', replier: { object: 'guard' }, replies: [{ text: 'Hm?' }] })]);
    await talk(w);
    expect(log(w)).toEqual(['say guard: Hm?']);
  });

  it('picks one reply at random, or joins a continued pair', async () => {
    const w = world([
      r({ replier: { object: 'guard' }, replies: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }], next: 2 }),
      r({ situation: 2, replier: { object: 'guard' }, joined: true, replies: [{ text: 'Long ' }, { text: 'line.' }] }),
    ]);
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(2);
    await talk(w);
    expect(roll).toHaveBeenCalledTimes(1);
    expect(roll).toHaveBeenCalledWith(2, 'reply');
    expect(log(w)).toEqual(['say guard: Three', 'say guard: Long line.']);
  });

  it("says a joined reply as one line, in only the first block's voice (conversation.cpp:358-374)", async () => {
    const w = world([r({ replier: { object: 'guard' }, joined: true, replies: [{ text: 'Long ', voice: 'g@01' }, { text: 'line.', voice: 'g@02' }] })]);
    const say = vi.spyOn(w.presenter, 'say');
    await talk(w);
    expect(say.mock.calls).toEqual([['guard', 'Long line.', 'g@01']]);
  });

  it('applies changes by kind (disable, set, enable, lock) and never unlocks', async () => {
    const w = world([
      r({
        text: 'Go',
        changes: [
          { to: 'enabled', situation: 2, key: 0 },
          { to: 'disabled', situation: 2, key: 0 },
          { to: 'locked', situation: 2, key: 1 },
          { to: 'enabled', situation: 2, key: 1 },
          { to: 'enabled', situation: 2, key: 2 },
        ],
      }),
      r({ situation: 2, key: 0, state: 'disabled' }),
      r({ situation: 2, key: 1, state: 'disabled' }),
      r({ situation: 2, key: 2, state: 'locked' }),
    ]);
    await talk(w);
    expect(w.state.conversations.chat).toEqual(['enabled', 'enabled', 'locked', 'locked']);
  });

  it('runs each result list last, on the talk target, as the speaker', async () => {
    const w = world([r({ text: 'Hi', results: [[{ do: [{ call: { hook: 'see' } }] }], [{ do: [{ call: { hook: 'see' } }] }]] })]);
    const seen: unknown[] = [];
    w.hooks.register('see', (world, ctx) => {
      seen.push(ctx.verb, ctx.target, ctx.who, (world.presenter as HeadlessPresenter).log.length);
      return 0;
    });
    w.talkTarget = 'guard';
    await talk(w);
    w.talkTarget = null;
    await talk(w);
    expect(seen).toEqual([
      'use', 'guard', 'picard', 1, 'use', 'guard', 'picard', 1,
      'use', 'picard', 'picard', 2, 'use', 'picard', 'picard', 2,
    ]);
  });

  it('stops when a result asks for another screen', async () => {
    const w = world([
      r({ text: 'Go', next: 2, results: [[{ do: [{ screen: { to: 'hall', entrance: 'entry' } }] }]] }),
      r({ situation: 2, text: 'Never said' }),
    ]);
    await talk(w);
    expect(log(w)).toEqual(['say picard: Go']);
    expect(w.state.pendingScreen).toEqual({ to: 'hall', entrance: 'entry' });
  });

  it('warns about a conversation or a response that does not exist', async () => {
    const w = world([r({ text: 'Hi' })]);
    const warnings: string[] = [];
    w.bus.on(e => { if (e.type === 'warning') warnings.push(e.message); });
    expect(await talk(w, 1, 'picard', 'nope')).toBe(false);
    await exec(w, { converse: { conversation: 'chat', situation: 9, key: 0, to: 'disabled' } });
    expect(warnings).toEqual(['there is no conversation "nope"', 'no state 0 of situation 9 in conversation chat']);
  });
});

describe('the converse effect', () => {
  it('sets a response state', async () => {
    const w = world([r({ text: 'Hi' })]);
    expect(await exec(w, { converse: { conversation: 'chat', situation: 1, key: 0, to: 'disabled' } })).toBe(0);
    expect(w.state.conversations.chat).toEqual(['disabled']);
  });

  it('is checked at load time', () => {
    const fx: Effect = { converse: { conversation: 'nope', situation: 1, key: 0, to: 'enabled' } };
    const c = makeGame([{ id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [fx] }] } }]);
    expect(checkRefs(c)).toEqual(['objects/panel: on.use[0].do[0].converse.conversation: unknown conversation "nope"']);
    // (a ConversationBlock can only enable, disable or lock, object.cpp:606-607)
    expect(effectSchema.safeParse({ converse: { conversation: 'c', situation: 1, key: 0, to: 'set' } }).success).toBe(false);
  });
});
