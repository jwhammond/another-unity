// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { GameContent, ObjectDef } from '../content/types';
import { lineConversation, makeGame, makeWorld } from '../testing/fixture';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import { reportFailure } from './failures';
import { say } from './talk';
import { talking } from './talkLog';
import type { World } from './world';

const guard: ObjectDef = { id: 'guard', name: 'Guard', screen: 'room', at: 'panel' };

function world(extra: Partial<GameContent> = {}): World {
  return makeWorld([guard], {
    conversations: {
      chat: lineConversation('chat', { 0: 'Zero.', 1: 'One.', 2: 'Two.', 3: 'Three.' }),
      ship: lineConversation('ship', { 42: 'No advice.' }),
      probe: {
        id: 'probe',
        responses: [{ situation: 0, key: 0, state: 'enabled', who: ['$anyone'], results: [[{ do: [{ call: { hook: 'see' } }] }]] }],
      },
    },
    rules: { items: {}, lines: { noAdvice: { conversation: 'ship', situation: 42 } } },
    advice: {
      hint: {
        easy: { picard: 'Easy for Picard.', $anyone: 'Easy for anyone.' },
        hard: { picard: 'Hard for Picard.' },
      },
    },
    ...extra,
  });
}

async function speak(w: World, str: string, who = 'picard', obj: string | null = 'guard'): Promise<boolean> {
  let said = false;
  void w.enqueue(async () => {
    said = await say(w, obj, who, str);
  });
  await settle(w);
  return said;
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('say', () => {
  it('says a plain line, and a description without its bar', async () => {
    const w = world();
    expect(await speak(w, 'Hello.')).toBe(true);
    expect(await speak(w, '|A guard.')).toBe(true);
    expect(log(w)).toEqual(['say picard: Hello.', 'say picard: A guard.']);
  });

  it('drops a stray "say it now" marker, with a warning', async () => {
    const w = world();
    const warnings: string[] = [];
    w.bus.on(e => { if (e.type === 'warning') warnings.push(e.message); });
    expect(await speak(w, '1Hello.')).toBe(true);
    expect(log(w)).toEqual(['say picard: Hello.']);
    expect(warnings).toEqual(['unexpected immediate talk string "1Hello."']);
  });

  it('starts a conversation, at a random situation for ?n', async () => {
    const w = world();
    expect(await speak(w, '@chat,1')).toBe(true);
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(3);
    await speak(w, '@chat,?3');
    expect(roll).toHaveBeenCalledWith(3, 'situation');
    expect(log(w)).toEqual(['say picard: One.', 'say picard: Three.']);
  });

  it('shows screen text', async () => {
    const w = world();
    expect(await speak(w, '^7')).toBe(true);
    expect(log(w)).toEqual(['screenText 7']);
  });

  it('records tricorder readings: shown, silent, or only shown', async () => {
    const w = world();
    const groups: number[] = [];
    w.bus.on(e => { if (e.type === 'reading') groups.push(e.group); });
    expect(await speak(w, '~12')).toBe(true);
    expect(await speak(w, '~-5')).toBe(true);
    expect(await speak(w, '~32768')).toBe(true);
    expect(await speak(w, '~12')).toBe(true);
    expect(w.state.readings).toEqual([{ world: 'test', group: 12 }, { world: 'test', group: 5 }]);
    expect(groups).toEqual([12, 5]);
    expect(log(w)).toEqual(['tricorder 12', 'tricorder 32768', 'tricorder 12']);
  });

  it('records readings by the world they were taken in', async () => {
    const base = makeGame([]);
    const w = world({ screens: { ...base.screens, hall: { ...base.screens.hall, world: 'moon' } } });
    await speak(w, '~12');
    w.state.screen = 'hall';
    await speak(w, '~12');
    expect(w.state.readings).toEqual([{ world: 'test', group: 12 }, { world: 'moon', group: 12 }]);
  });

  it('says nothing once a screen change is pending, or for an empty string', async () => {
    const w = world();
    expect(await speak(w, '')).toBe(false);
    w.state.pendingScreen = { to: 'hall', entrance: 'entry' };
    expect(await speak(w, 'Hello.')).toBe(false);
    expect(log(w)).toEqual([]);
  });

  it('makes the speaker the talk target while it speaks, outside an action', async () => {
    const w = world();
    const targets: unknown[] = [];
    w.hooks.register('see', (_w, ctx) => {
      targets.push(ctx.target);
      return 0;
    });
    await speak(w, '@probe,0', 'data');
    expect(targets).toEqual(['data']);
    expect(w.talkTarget).toBeNull();
  });

  it('gives advice from whoever is asked, at the level asked for', async () => {
    const w = world();
    w.state.advice.id = 'hint';
    await speak(w, '!', 'data', 'picard');
    await speak(w, '!0', 'data', 'picard');
    await speak(w, '!1', 'data', 'guard');
    expect(log(w)).toEqual(['say picard: Hard for Picard.', 'say picard: Easy for Picard.', 'say $anyone: Easy for anyone.']);
  });

  it('falls back to the no-advice line, except at level 0', async () => {
    const w = world();
    await speak(w, '!0', 'data', 'picard');
    expect(log(w)).toEqual([]);
    await speak(w, '!', 'data', 'picard');
    w.state.advice.id = 'hint';
    await speak(w, '!3', 'data', 'picard');
    await speak(w, '!', 'data', 'guard');
    expect(log(w)).toEqual(['say data: No advice.', 'say data: No advice.', 'say data: No advice.']);
  });
});

describe('the conversation log (R7)', () => {
  it('logs each outermost conversation, newest first, and nested talk joins the outer one', async () => {
    const w = world();
    await speak(w, '@chat,1');
    await speak(w, 'Hello.');
    expect(w.state.conversationLog).toEqual([
      [{ speaker: 'picard', text: 'Hello.' }],
      [{ speaker: 'picard', text: 'One.' }],
    ]);
    // (talk inside talk: the inner conversations' lines go in the outer entry)
    const nested = world();
    void nested.enqueue(() => talking(nested, async () => {
      await say(nested, 'guard', 'picard', '@chat,2');
      await say(nested, 'guard', 'picard', 'Three.');
    }));
    await settle(nested);
    expect(nested.state.conversationLog).toEqual([[{ speaker: 'picard', text: 'Two.' }, { speaker: 'picard', text: 'Three.' }]]);
  });

  it('drops a conversation that said nothing', async () => {
    const w = world();
    await speak(w, '^7');
    expect(w.state.conversationLog).toEqual([]);
    expect(w.talkDepth).toBe(0);
  });

  it('keeps the last 10, so the 11th pushes out the oldest', async () => {
    const w = world();
    for (let i = 0; i < 11; i++) await speak(w, `Line ${i}.`);
    expect(w.state.conversationLog).toHaveLength(10);
    expect(w.state.conversationLog[0][0].text).toBe('Line 10.');
    expect(w.state.conversationLog[9][0].text).toBe('Line 1.');
  });

  it("doesn't log a failure line, or advice", async () => {
    const w = world({ rules: { items: {}, lines: { noAdvice: { conversation: 'ship', situation: 42 }, failLook: { conversation: 'chat', situation: 0 } } } });
    void w.enqueue(() => reportFailure(w, { verb: 'look', target: 'guard', who: 'picard', other: null, walked: false }, 0));
    await settle(w);
    expect(log(w)).toEqual(['say picard: Zero.']);
    expect(w.state.conversationLog).toEqual([]);
    expect(w.logging).toBe(true);
    await speak(w, '!2');
    expect(w.state.conversationLog).toEqual([]);
  });
});
