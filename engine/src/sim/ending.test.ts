// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ResponseDef } from '../content/types';
import { makeGame } from '../testing/fixture';
import { ending } from './ending';

const line = (key: number, text: string): ResponseDef => ({ situation: 43, key, state: 'disabled', who: ['$anyone'], replies: [{ text }] });
const game = makeGame([], {
  conversations: { log: { id: 'log', responses: [line(0, '-First-'), line(1, '-Second-')] } },
  rules: { items: {}, lines: { gameOver: { conversation: 'log', situation: 43 } } },
});

describe('ending (endGame, unity.cpp)', () => {
  it('wins on 3 and 0x20', () => {
    expect(ending(game, 3)).toEqual({ won: true });
    expect(ending(game, 0x20)).toEqual({ won: true });
  });

  it('says the reason\'s line otherwise, reading 4 as 1', () => {
    expect(ending(game, 2)).toEqual({ won: false, text: '-Second-' });
    expect(ending(game, 4)).toEqual({ won: false, text: '-First-' });
  });

  it('has no line for a reason the conversation lacks, or without the rule', () => {
    expect(ending(game, 10)).toEqual({ won: false });
    expect(ending(game, 0)).toEqual({ won: false });
    expect(ending(makeGame([]), 2)).toEqual({ won: false });
  });
});
