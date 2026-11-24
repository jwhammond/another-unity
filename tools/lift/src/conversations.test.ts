// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftConversation } from './conversations';
import { testCtx } from './testing/ctx';

describe('liftConversation', () => {
  it('lifts responses: who, voices, replier, replies, changes and results', () => {
    const ctx = testCtx();
    const conv = liftConversation(ctx.raw.conversations.get('w007c000')!, ctx);
    expect(conv).toEqual({
      id: 'horst3.c000', number: 0,
      responses: [
        {
          situation: 1, key: 0, text: 'What are these rocks?', voice: 'fe@00e7', state: 'enabled', who: ['picard'],
          replier: { crew: 'data' }, replies: [{ text: 'Fascinating.', voice: 'fe020001' }], next: 2,
          changes: [{ to: 'disabled', situation: 1, key: 0 }],
          results: [[{ do: [{ alter: { object: 'horst3.rubble', state: 3 } }] }]],
        },
        {
          situation: 2, key: 0, text: 'Anyone?', voices: { picard: 'fe000e70', data: 'fe020e71' }, state: 'set',
          who: ['$anyone'], replier: { object: 'horst3.guard' },
          replies: [{ text: 'Go ', voice: '0701ff02' }, { text: 'away.', voice: '0701ff03' }], joined: true,
        },
      ],
    });
    expect(ctx.ids.toYaml().lists['w007c000#/responses/0/results/0']).toBe('horst3.c000/0/results0');
    expect(ctx.problems.errors).toEqual([]);
  });

  it('marks the ship\'s conversations, with their numbers', () => {
    const ctx = testCtx();
    const conv = liftConversation(ctx.raw.conversations.get('w05fc034')!, ctx);
    expect(conv).toMatchObject({ id: 'ship.c034', ship: true, number: 34 });
    expect(conv.responses.map(r => r.situation)).toEqual([1, 2, 3, 4, 5, 42]);
  });

  it('turns a speaker, and says nothing, for voice groups 0xfb and 0xfc', () => {
    const ctx = testCtx();
    const raw = ctx.raw.conversations.get('w007c000')!;
    const turned = { ...raw, responses: [{ ...raw.responses[0], voice_group: 0xfb }, { ...raw.responses[0], voice_group: 0xfc }] };
    expect(liftConversation(turned, ctx).responses.map(r => [r.turn, r.voice])).toEqual([['right', undefined], ['left', undefined]]);
  });

  it('keeps a speaker\'s first voice tag, as the original stops at the first match', () => {
    const ctx = testCtx();
    const raw = ctx.raw.conversations.get('w007c000')!;
    const tagged = { ...raw, responses: [{ ...raw.responses[1], voice_tags: '0e702e710e99' }] };
    expect(liftConversation(tagged, ctx).responses[0].voices).toEqual({ picard: 'fe000e70', data: 'fe020e71' });
  });

  it('warns about a change naming a response the conversation lacks', () => {
    const ctx = testCtx();
    const raw = ctx.raw.conversations.get('w007c000')!;
    const changed = { ...raw, responses: [{ ...raw.responses[0], changeactions: [{ type: 0x32, response_id: 7, state_id: 0 }] }] };
    liftConversation(changed, ctx);
    expect(ctx.problems.warnings).toEqual(["w007c000#/responses/0: a change names response 7/0, which this conversation doesn't have"]);
  });
});
