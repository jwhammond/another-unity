// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConversationDef, GameContent } from '../content/types';
import { lineConversation, makeGame } from '../testing/fixture';
import { deserializeState, SaveError, serializeState } from './save';
import { createInitialState } from './state';

const chat: ConversationDef = {
  id: 'chat',
  responses: [...lineConversation('chat', { 1: 'Hello.' }).responses, { situation: 2, key: 0, state: 'set', who: ['$anyone'] }],
};

function game(): GameContent {
  const base = makeGame([]);
  return makeGame(
    [
      { id: 'guard', name: 'Guard', screen: 'room', talk: '@chat,1', talkVoice: 'g1', phaser: { health: 3, threshold: 1, damageFrom: 1, gtpFrom: 4 } },
      { id: 'panel', name: 'Panel', screen: 'room' },
    ],
    {
      conversations: { chat },
      advice: { a1: {} },
      screens: {
        ...base.screens,
        room: { ...base.screens.room, startup: { combadge: true, advice: { id: 'a1', every: 30 }, action: { verb: 'look', target: 'guard' } } },
      },
    },
  );
}

describe('createInitialState, version 2', () => {
  it('gives each object its talk string', () => {
    const s = createInitialState(game());
    expect(s.objects.guard).toMatchObject({ talk: '@chat,1', talkVoice: 'g1' });
    expect(s.objects.panel).toMatchObject({ talk: '', talkVoice: null });
  });

  it('starts phaser data at full health, for objects that have it', () => {
    const s = createInitialState(game());
    expect(s.phaser.guard).toEqual({ health: 3, stunned: false, regenAt: 0, destroyed: false });
    expect(s.phaser.picard).toEqual({ health: 10, stunned: false, regenAt: 0, destroyed: false });
    expect(s.phaser.panel).toBeUndefined();
  });

  it('copies the response states and the screen startups', () => {
    const s = createInitialState(game());
    expect(s.conversations).toEqual({ chat: ['enabled', 'set'] });
    expect(s.startups.room).toEqual({
      advice: { id: 'a1', every: 30 }, closeup: false, combadge: true, inputBlocked: null,
      action: { verb: 'look', target: 'guard' },
    });
    expect(s.startups.hall).toEqual({ advice: {}, closeup: false, combadge: null, inputBlocked: null, action: null });
  });

  it('starts everything else empty', () => {
    expect(createInitialState(game())).toMatchObject({
      version: 4, phaserSetting: 0, advice: { id: null, every: 0, due: 0 },
      onCloseup: false, pendingHail: null,
      beamTarget: null, readings: [], computer: { hidden: [], readings: [] }, adviceMode: 0, conversationLog: [], beamWorld: null, onShip: null,
    });
  });

  it('starts with input open and the combadge on, as a new engine does (unity.cpp:104-105)', () => {
    // a screen whose startup leaves the combadge alone (0xff) keeps it on
    expect(createInitialState(game()).awayFlags).toEqual({ inputBlocked: false, combadge: true });
  });
});

describe('saves, version 2', () => {
  it('round-trips the new state', () => {
    const c = game();
    const s = createInitialState(c);
    s.conversations.chat[0] = 'locked';
    s.phaser.guard.health = -1;
    s.pendingHail = { from: 'guard', conversation: 'chat', situation: 1, type: 8 };
    s.readings.push({ world: 'test', group: 3 });
    s.onShip = { gameOver: 2 };
    // (a save never has a screen change pending: Plan 1 refuses one)
    expect(deserializeState(serializeState(s), c)).toEqual(s);
  });

  it('rejects a version 1 save', () => {
    const c = game();
    const text = JSON.stringify({ ...createInitialState(c), version: 1 });
    expect(() => deserializeState(text, c)).toThrow(new SaveError('save version 1 is older than any this engine reads'));
  });

  it('rejects a save whose conversations have changed', () => {
    const c = game();
    const text = serializeState(createInitialState(c));
    const changed = { ...c, conversations: { chat: { ...chat, responses: [...chat.responses, ...chat.responses] } } };
    expect(() => deserializeState(text, changed)).toThrow('save does not match this game: conversations differ: chat');
    // (the same number of responses, with other keys)
    const rekeyed = { ...c, conversations: { chat: { ...chat, responses: chat.responses.map(r => ({ ...r, key: r.key + 1 })) } } };
    expect(() => deserializeState(text, rekeyed)).toThrow('save does not match this game: conversations differ: chat');
  });

  it('rejects ids that the game does not have', () => {
    const c = game();
    const bad = (change: (s: ReturnType<typeof createInitialState>) => void) => {
      const s = createInitialState(c);
      change(s);
      return () => deserializeState(serializeState(s), c);
    };
    expect(bad(s => { s.advice.id = 'nope'; })).toThrow('save does not match this game: unknown advice "nope"');
    expect(bad(s => { s.startups.hall.action = { verb: 'look', target: 'ghost' }; }))
      .toThrow('save does not match this game: the startup of screen "hall" names unknown object "ghost"');
    expect(bad(s => { s.pendingHail = { from: null, conversation: 'nope', situation: 1, type: 8 }; }))
      .toThrow('save does not match this game: the pending hail names unknown conversation "nope"');
    expect(bad(s => { s.beamTarget = 'moon'; })).toThrow('save does not match this game: unknown transporter target "moon"');
    expect(bad(s => { s.ship.bridgeUse = 'ghost'; })).toThrow('save does not match this game: the bridge uses unknown object "ghost"');
  });
});

describe('saves, every reference checked', () => {
  const bad = (change: (s: ReturnType<typeof createInitialState>) => void) => {
    const c = game();
    const s = createInitialState(c);
    change(s);
    return () => deserializeState(serializeState(s), c);
  };
  const m = (what: string) => `save does not match this game: ${what}`;

  it('rejects unknown startup advice', () => {
    expect(bad(s => { s.startups.room.advice = { id: 'nope' }; })).toThrow(m('the startup of screen "room" names unknown advice "nope"'));
  });
  it('rejects a hail from an unknown object', () => {
    expect(bad(s => { s.pendingHail = { from: 'ghost', conversation: 'chat', situation: 1, type: 8 }; }))
      .toThrow(m('the pending hail is from unknown object "ghost"'));
  });
  it('rejects a startup marker that is not on its screen', () => {
    expect(bad(s => { s.startups.room.action = { verb: 'walk', target: 'guard', at: 'nowhere' }; }))
      .toThrow(m('the startup of screen "room" names unknown marker "nowhere"'));
  });
  it('rejects a talk string naming an unknown conversation', () => {
    expect(bad(s => { s.objects.guard.talk = '@nope,1'; })).toThrow(m('object "guard" talks to unknown conversation "nope"'));
  });
  it('rejects a saved conversation the game does not have', () => {
    expect(bad(s => { s.conversations.extra = ['set']; s.conversationShapes.extra = '1.0'; })).toThrow(m('unknown conversations extra'));
  });
});
