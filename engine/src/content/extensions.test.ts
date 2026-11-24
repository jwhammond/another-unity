// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ContentError, parseGame, type SourceFile } from './parse';
import { parseConversationString } from './talkString';

const game = (rules = '') =>
  `id: demo\nstart: { screen: room, entrance: door, awayTeam: [picard], leader: picard }\n${rules}`;
const room = 'id: room\nmarkers: { door: { x: 0, z: 0 }, post: { x: 2, z: 0 } }\n';
const picard = 'id: picard\nname: Picard\nscreen: room\ncrew: true\n';
const guard = (extra = '') => `id: guard\nname: Guard\nscreen: room\nat: post\n${extra}`;
const chat = [
  'id: guard-chat',
  'responses:',
  '  - situation: 1',
  '    key: 0',
  '    state: enabled',
  "    who: ['$anyone']",
  '    text: Who goes there?',
  '    replier: { object: guard }',
  '    replies: [{ text: I keep the post. }]',
  '    changes: [{ to: disabled, situation: 1, key: 0 }]',
  '    results:',
  '      - - do: [{ alter: { object: guard, state: 1 } }]',
  '',
].join('\n');

function files(extra: Record<string, string>): SourceFile[] {
  const all: Record<string, string> = {
    'game.yaml': game(),
    'screens/room.yaml': room,
    'objects/picard.yaml': picard,
    ...extra,
  };
  return Object.entries(all).map(([path, text]) => ({ path, text }));
}

function problemsOf(f: SourceFile[]): string[] {
  try {
    parseGame(f);
  } catch (e) {
    if (e instanceof ContentError) return e.problems;
    throw e;
  }
  throw new Error('expected a ContentError');
}

describe('parseGame: Plan 2 content', () => {
  it('reads conversations, talk strings, phaser data and startups', () => {
    const c = parseGame(files({
      'objects/guard.yaml': guard(
        'talk: "@guard-chat,1"\nwidth: 1\npixelWidth: 60\nphaser: { health: 3, threshold: 1, damageFrom: 1, gtpFrom: 4, on: { stun: [{ do: [] }] } }\n',
      ),
      'conversations/guard.yaml': chat,
      'screens/room.yaml': `${room}startup: { combadge: true, action: { verb: talk, target: guard } }\n`,
    }));
    expect(c.objects.guard.talk).toBe('@guard-chat,1');
    expect(c.objects.guard.phaser?.threshold).toBe(1);
    expect(c.objects.guard.pixelWidth).toBe(60);
    expect(c.conversations['guard-chat'].responses[0])
      .toMatchObject({ situation: 1, key: 0, state: 'enabled', replier: { object: 'guard' } });
    expect(c.screens.room.startup?.action).toEqual({ verb: 'talk', target: 'guard' });
  });

  it('refuses a raw pixel width that isn\'t a whole number of pixels', () => {
    expect(problemsOf(files({ 'objects/guard.yaml': guard('pixelWidth: 1.5\n') })).join('\n')).toMatch(/pixelWidth/);
  });

  it('defaults to no rules, conversations or advice', () => {
    const c = parseGame(files({}));
    expect(c.rules).toEqual({ items: {}, lines: {} });
    expect(c.conversations).toEqual({});
    expect(c.advice).toEqual({});
  });

  it('reads the rules and the advice', () => {
    const c = parseGame(files({
      'game.yaml': game('rules:\n  talkDistance: 2\n  items: { tricorder: guard }\n  lines: { failTalk: { conversation: guard-chat, situation: 1 } }\n'),
      'objects/guard.yaml': guard(),
      'conversations/guard.yaml': chat,
      'advice.yaml': "hint-1:\n  easy: { picard: Look closer., '$anyone': Hmm. }\n",
    }));
    expect(c.rules).toEqual({
      talkDistance: 2,
      items: { tricorder: 'guard' },
      lines: { failTalk: { conversation: 'guard-chat', situation: 1 } },
    });
    expect(c.advice['hint-1'].easy?.picard).toBe('Look closer.');
  });

  it('reports a talk string that names an unknown conversation', () => {
    expect(problemsOf(files({ 'objects/guard.yaml': guard('talk: "@nobody,1"\n') })))
      .toEqual(['objects/guard.yaml: talk: unknown conversation "nobody"']);
  });

  it('reports a malformed conversation string', () => {
    expect(problemsOf(files({ 'objects/guard.yaml': guard('talk: "@guard-chat"\n'), 'conversations/guard.yaml': chat })))
      .toEqual(['objects/guard.yaml: talk: bad conversation string "@guard-chat"']);
  });

  it('reports a line for someone who is not crew', () => {
    const bad = chat.replace("who: ['$anyone']", 'who: [guard]');
    expect(problemsOf(files({ 'objects/guard.yaml': guard(), 'conversations/guard.yaml': bad })))
      .toEqual(['conversations/guard.yaml: responses[0].who[0]: "guard" is not a crew object']);
  });

  it('checks the rules in conversation results', () => {
    const bad = chat.replace('alter: { object: guard, state: 1 }', 'alter: { object: gaurd, state: 1 }');
    expect(problemsOf(files({ 'objects/guard.yaml': guard(), 'conversations/guard.yaml': bad })))
      .toEqual(['conversations/guard.yaml: responses[0].results[0][0].do[0].alter.object: unknown object "gaurd"']);
  });

  it('reports an unknown item', () => {
    expect(problemsOf(files({ 'game.yaml': game('rules:\n  items: { phaser: phasr }\n') })))
      .toEqual(['game.yaml: rules.items.phaser: unknown object "phasr"']);
  });

  it('reports unknown advice in a screen startup', () => {
    expect(problemsOf(files({ 'screens/room.yaml': `${room}startup: { advice: { id: nope } }\n` })))
      .toEqual(['screens/room.yaml: startup.advice.id: unknown advice "nope"']);
  });

  it('reports an unknown object as a screen startup\'s who', () => {
    expect(problemsOf(files({ 'objects/guard.yaml': guard(), 'screens/room.yaml': `${room}startup: { action: { verb: talk, target: guard, who: nobody } }\n` })))
      .toEqual(['screens/room.yaml: startup.action.who: unknown object "nobody"']);
  });

  it('reports duplicate conversation ids', () => {
    expect(problemsOf(files({ 'objects/guard.yaml': guard(), 'conversations/a.yaml': chat, 'conversations/b.yaml': chat })))
      .toEqual(['conversations/b.yaml: duplicate conversation id "guard-chat" (also in conversations/a.yaml)']);
  });

  it('reports a failure line that names an unknown conversation', () => {
    expect(problemsOf(files({ 'game.yaml': game('rules:\n  lines: { failTalk: { conversation: nope, situation: 2 } }\n') })))
      .toEqual(['game.yaml: rules.lines.failTalk.conversation: unknown conversation "nope"']);
  });

  it('checks the talk strings in advice', () => {
    expect(problemsOf(files({ 'advice.yaml': "hint-1:\n  hard: { picard: '@nope,1' }\n" })))
      .toEqual(['advice.yaml: hint-1.hard.picard: unknown conversation "nope"']);
  });

  it('reports two ship conversations with the same number', () => {
    const ship = (id: string) => `id: ${id}\nship: true\nnumber: 12\nresponses: []\n`;
    expect(problemsOf(files({ 'conversations/a.yaml': ship('a'), 'conversations/b.yaml': ship('b') })))
      .toEqual(['conversations/b.yaml: number: ship conversation 12 is also "a"']);
  });
});

describe('parseConversationString', () => {
  it('splits a conversation and a situation, which may be random', () => {
    expect(parseConversationString('@ship/34,2')).toEqual({ conversation: 'ship/34', situation: '2' });
    expect(parseConversationString('@chat,?4')).toEqual({ conversation: 'chat', situation: '?4' });
  });

  it('rejects anything else', () => {
    expect(parseConversationString('@chat')).toBeNull();
    expect(parseConversationString('@chat,x')).toBeNull();
    expect(parseConversationString('@,1')).toBeNull();
    expect(parseConversationString('Hello.')).toBeNull();
  });
});
