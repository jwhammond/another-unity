// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IdTable } from './ids';
import { Problems } from './problems';
import { convertTalk, hailNumbers, parseTalk, stripUseWords, talkVoiceType } from './talk';

function ids(problems: Problems) {
  return new IdTable(new Map(), {
    objects: new Set(), conversations: new Set(['w007c000', 'w05fc034']), screens: new Set(), triggers: new Set(),
  }, problems);
}

describe('talk strings', () => {
  it('reads a situation as atoi does, ignoring what follows it, with a warning (talk.cpp:273-294; M3 Decision 6)', () => {
    const problems = new Problems();
    expect(convertTalk('@0,1      -Zap--', 7, ids(problems), problems, 'here')).toBe('@horst3.c000,1');
    expect(problems.errors).toEqual([]);
    expect(problems.warnings).toEqual(['here: "@0,1      -Zap--" has "-Zap--" after its situation, which atoi ignores (talk.cpp:273-294)']);
    expect(parseTalk('@95,34,?2', 7)).toEqual({ world: 95, id: 34, situation: '?2', tail: '' });
    expect(parseTalk('@x', 7)).toBeNull();
    expect(parseTalk('Halt!', 7)).toBeNull();
  });

  it('drops the "-verb-preposition-" suffix, as setTalkString does', () => {
    expect(stripUseWords('Hello -use-on-')).toBe('Hello');
    expect(stripUseWords('Halt!')).toBe('Halt!');
    expect(stripUseWords('-')).toBe('-');
  });

  it('names conversations by slug, in the string\'s own world unless it gives one (in decimal)', () => {
    const problems = new Problems();
    const t = ids(problems);
    expect(convertTalk('@0,1', 7, t, problems, 'o_070201')).toBe('@horst3.c000,1');
    expect(convertTalk('@95,34,42', 7, t, problems, 'here')).toBe('@ship.c034,42');
    expect(convertTalk('@ 0, ?3', 7, t, problems, 'here')).toBe('@horst3.c000,?3');
    expect(convertTalk('!', 7, t, problems, 'here')).toBe('!');
    expect(convertTalk('|A rock.', 7, t, problems, 'here')).toBe('|A rock.');
    expect(problems.errors).toEqual([]);
  });

  it('reports a conversation string it can\'t read, and keeps it', () => {
    const problems = new Problems();
    expect(convertTalk('@x', 7, ids(problems), problems, 'o_070201')).toBe('@x');
    expect(problems.errors).toEqual(['o_070201: bad conversation string "@x"']);
    convertTalk('@3,0', null, ids(problems), problems, 'w05fc034#/responses/0/results/0/0/0');
    expect(problems.errors[1]).toMatch(/^w05fc034#\/responses\/0\/results\/0\/0\/0: "@3,0" names a conversation in the talk target's world/);
  });

  it('says which voice type a string is said with', () => {
    expect([talkVoiceType('|A rock.'), talkVoiceType('Halt!')]).toEqual(['l', 't']);
  });

  it('reads a hailer\'s numbers as sscanf("@%d,%d") does, misreading three fields', () => {
    expect(hailNumbers('@10,1')).toEqual({ conversation: 10, situation: 1, threeFields: false });
    expect(hailNumbers('@7,10,1')).toEqual({ conversation: 7, situation: 10, threeFields: true });
    expect(hailNumbers('@10,?2')).toBeNull();
    expect(hailNumbers('Hi')).toBeNull();
  });
});
