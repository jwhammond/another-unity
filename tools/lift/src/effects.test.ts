// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EntryT } from '@another-unity/rawcheck/ir';
import { conversationOwner, objectOwner, setLenient, type LiftCtx } from './context';
import { liftAnim, liftEntry, liftGroups } from './effects';
import {
  alter, beam, command, communicate, cond, convBlock, general, miniRaw, NONE, pathBlock, reaction, screenBlock, triggerBlock, type J,
} from './testing/mini';
import { rawFromMini, testCtx } from './testing/ctx';

const owner = (ctx: LiftCtx, id = '070103') => objectOwner(ctx, ctx.raw.objects.get(id)!);
const entry = (ctx: LiftCtx, e: J, id = '070103') => liftEntry(e as unknown as EntryT, ctx, owner(ctx, id), `o_${id}#/use_entries/0/1`);
const lists = (ctx: LiftCtx, id: string, list: 'use_entries' | 'get_entries' | 'timer_entries') =>
  liftGroups(ctx.raw.objects.get(id)![list], ctx, owner(ctx, id), `o_${id}#/${list}`);

describe('liftGroups', () => {
  it('runs results by _order, stably, after the condition', () => {
    const ctx = testCtx();
    expect(lists(ctx, '070100', 'use_entries')).toEqual([{ do: [
      { trigger: { id: 't3', enabled: true } },
      { alter: { object: 'horst3.rubble', state: 1 } },
      { play: { movie: 'arrive' } },
      { call: { hook: 'unity.general.g5', args: { value: 12 } } },
      { act: { verb: 'look', object: 'horst3.rubble', who: '$actor' } },
    ] }]);
    expect(ctx.hooks.list()[0]).toMatchObject({ name: 'unity.general.g5', usedBy: ['o_070100#/use_entries/0/3'] });
  });

  it('keeps a stop on the entry\'s last effect, and lifts a choice\'s branches as lists', () => {
    const ctx = testCtx();
    const dist = ctx.markers.projection('horst3.s01')!.distance(40, 336);
    expect(lists(ctx, '070103', 'use_entries')).toEqual([
      {
        when: { who: 'data', near: { dist, px: 40 }, skill: 0x300 },
        do: [{
          choose: {
            question: 'Clear the rubble?',
            options: [{ text: 'Yes', do: [{ do: [{ alter: { object: 'horst3.rubble', active: false } }] }] }, { text: 'No', do: [] }],
          },
          stop: true,
        }],
      },
      { do: [{ alter: { object: '$anyone', at: 'p250_340' } }] },
    ]);
  });

  it('lifts a ScreenBlock into its parts, in the order the original runs them', () => {
    const ctx = testCtx();
    expect(lists(ctx, '070104', 'use_entries')).toEqual([{
      when: { checks: [{ object: 'horst3.rubble', state: 1 }] },
      do: [
        { screen: { to: 'horst3.s02', entrance: 'entrance_0', stepIn: true } },
        { awayFlags: {} },
        { path: { enable: ['r24'] } },
      ],
    }]);
    expect(ctx.problems.warnings).toEqual([
      'o_070104#/use_entries/0/1: entrance 1 is beyond the 1 of s_0702; the original uses entrance 0 (awayteam.cpp:358-363)',
    ]);
    expect(lists(ctx, '070201', 'use_entries')).toEqual([{ do: [
      { communicate: { conversation: 'ship.c034', situation: 3, type: 7 } },
      { screen: { to: '$ship', gameOver: 2 } },
      { advice: { id: 'horst3.a1', every: 30, screen: 'horst3.s01' } },
      { startup: { screen: 'horst3.s02', action: { verb: 'talk', target: 'horst3.guard' } } },
      { awayFlags: { inputBlocked: false, combadge: true } },
    ] }]);
  });

  it('lifts conversations, beams, triggers and reactions', () => {
    const ctx = testCtx();
    expect(lists(ctx, '070104', 'get_entries')).toEqual([{ do: [
      { converse: { conversation: 'horst3.c000', situation: 1, key: 0, to: 'disabled' } },
      { beam: { to: 'horst3.s02' } },
      { trigger: { id: 't4', enabled: false } },
    ] }]);
    expect(lists(ctx, '070201', 'timer_entries')).toEqual([{ do: [{ react: { who: 'team', do: { damage: 3 }, shot: true }, stop: true }] }]);
  });

  it('lifts a beam to world 8 as world 5\'s screen with the original\'s world number', () => {
    const r = rawFromMini();
    const frigis = { id: 's_0501', world: 5, screen: 1, objects: null, location: null, polygons: [] };
    const ctx = testCtx({ ...r, screens: new Map([...r.screens, ['s_0501', frigis]]) });
    expect(entry(ctx, beam({ world_id: 8, screen_id: 1 }))).toEqual([{ beam: { to: 'frigis.s01', world: 8 } }]);
    expect(entry(ctx, beam({ world_id: 5, screen_id: 1 }))).toEqual([{ beam: { to: 'frigis.s01' } }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('keeps an entry that does nothing as a no-op, so the group still did something', () => {
    const ctx = testCtx();
    const groups = liftGroups([[general() as unknown as EntryT]], ctx, owner(ctx), 'o_070103#/use_entries');
    expect(groups).toEqual([{ do: [{ wait: { seconds: 0 } }] }]);
    expect(ctx.stats.for('o_070103').noops).toBe(1);
  });

  it('fails on a condition that is not first, or not alone', () => {
    const ctx = testCtx();
    liftGroups([[alter({ target: '070103' }), cond()] as unknown as EntryT[]], ctx, owner(ctx), 'o_070103#/use_entries');
    liftGroups([[cond(), cond()] as unknown as EntryT[]], ctx, owner(ctx), 'o_070103#/get_entries');
    expect(ctx.problems.errors).toEqual([
      'o_070103#/use_entries/0/1: a ConditionBlock that is not first in its group',
      'o_070103#/get_entries/0: a group with more than one ConditionBlock',
    ]);
  });

  it('drops a ScreenBlock part for a screen the export lacks: its startup record is never read (M3 Decision 4)', () => {
    const ctx = testCtx();
    expect(entry(ctx, screenBlock({
      flags_screen: 0, combadge: 1, input_blocked: 0, advice_screen: 0, new_advice_id: 1,
      startup_screen: 0, startup_target: '070201', startup_action: 5,
    }), '070104')).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toEqual(['advice', 'startup action', 'flags'].map(what =>
      `o_070104#/use_entries/0/1: s_0700 isn't in the export, so its startup record (${what}) is never read and this changes nothing (getScreenStartup, data.cpp:1163-1192)`));
    expect(entry(ctx, screenBlock({ flags_screen: 2, combadge: 1 }), '070104')).toEqual([{ awayFlags: { combadge: true, screen: 'horst3.s02' } }]);
  });

  it('takes 000010 as a command\'s object to be the current member (M3 Decision 6)', () => {
    const ctx = testCtx();
    expect(entry(ctx, command({ target: ['000010', '000010', NONE], command_id: 4, target_x: 250, target_y: 340 })))
      .toEqual([{ act: { verb: 'walk', object: '$anyone', at: 'p250_340' } }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('records a conversation, movie or object the export lacks as missing, with a warning (M3 Decision 3)', () => {
    const ctx = testCtx();
    expect(entry(ctx, alter({ target: '070103', alter_hail: '1@9,1' }))).toEqual([
      { alter: { object: 'horst3.rubble' } }, { missing: { kind: 'conversation', id: 'w007c009' } },
    ]);
    expect(entry(ctx, alter({ target: '070103', alter_hail: '@9,1' }))).toEqual([
      { alter: { object: 'horst3.rubble' } }, { missing: { kind: 'conversation', id: 'w007c009' } },
    ]);
    expect(entry(ctx, alter({ target: '070103', alter_hail: '1@0,1' }))).toEqual([{ alter: { object: 'horst3.rubble', converseNow: '@horst3.c000,1' } }]);
    expect(entry(ctx, general({ movie_id: 42 }))).toEqual([{ missing: { kind: 'movie', id: '42' } }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toEqual([
      'o_070103#/use_entries/0/1: no conversation w007c009 in the export: the original would fail opening it (conversation.cpp:246-263), so this records it as missing',
      'o_070103#/use_entries/0/1: no conversation w007c009 in the export: the original would fail opening it (conversation.cpp:246-263), so this records it as missing',
      'o_070103#/use_entries/0/1: no movie 42 in movie.map: ScummVM asserts on it (object.cpp:1736), so this records it as missing',
    ]);
  });
});

describe('AlterBlock', () => {
  it('maps every field, in the order AlterBlock::execute applies them', () => {
    const ctx = testCtx();
    expect(entry(ctx, alter({
      target: '070103', alter_flags: 0x08 | 0x04 | 0x80 | 0x01 | 0x40 | 0x20 | 0x10, alter_reset: 1, alter_timer: 0,
      alter_anim: 30003, alter_name: 'rocks', alter_state: 4, play_description: 255, x_pos: 200, y_pos: 300,
      voice_id: 0x10, voice_group: 7, voice_subgroup: 1, alter_hail: 'Move along -use-on-',
    }))).toEqual([{ alter: {
      object: 'horst3.rubble', at: 'p200_300', get: true, drop: true, active: false, talkTo: true, halt: true,
      stunned: false, voice: '07t1@10', timer: 0, anim: { play: 3, wait: true }, talk: 'Move along', name: 'rocks',
      state: 4, describe: true,
    } }]);
  });

  it('lifts a hail said now, or a conversation now', () => {
    const ctx = testCtx();
    expect(entry(ctx, alter({ target: '070201', alter_hail: '1@0,2' }))).toEqual([{ alter: { object: 'horst3.guard', converseNow: '@horst3.c000,2' } }]);
    expect(entry(ctx, alter({ target: '070201', alter_hail: '1Stop!', alter_reset: 1 }))).toEqual([{ alter: { object: 'horst3.guard', active: true, sayNow: 'Stop!' } }]);
  });

  it('reads a talk string in its object\'s world when the conversation that alters it can run in any (a ship conversation)', () => {
    const ctx = testCtx();
    const anywhere = { ...owner(ctx), talkWorld: null };
    const lift = (e: J) => liftEntry(e as unknown as EntryT, ctx, anywhere, 'w05fc999#/responses/0/results/0/0/0');
    expect(lift(alter({ target: '070201', alter_hail: '@0,2' }))).toEqual([{ alter: { object: 'horst3.guard', talk: '@horst3.c000,2' } }]);
    expect(ctx.problems.errors).toEqual([]);
    // (a conversation started now has no world of its own to fall back on, so it is still refused)
    lift(alter({ target: '070201', alter_hail: '1@0,2' }));
    expect(ctx.problems.errors).toHaveLength(1);
  });

  it('reads animations as the original does', () => {
    expect([30003, 5, 31010, 29500, 0x8000].map(liftAnim)).toEqual([
      { play: 3, wait: true }, { play: 5 }, { sprite: 10 }, { stop: true }, { stop: true },
    ]);
  });
});

describe('ReactionBlock', () => {
  it('lifts revive, damage, beams up, in and to an entrance', () => {
    const ctx = testCtx();
    expect(entry(ctx, reaction({ target_type: 1, damage_amount: 0x7f }))).toEqual([{ react: { who: 'actor', do: 'revive' } }]);
    expect(entry(ctx, reaction({ target_type: 1, damage_amount: 0xfe }))).toEqual([{ react: { who: 'actor', do: { damage: -2 } } }]);
    expect(entry(ctx, reaction({ target_type: 3, action_type: 3, dest_world: 0, beam_type: 1 })))
      .toEqual([{ react: { who: 'team', do: 'beamUp', chodak: true } }]);
    expect(entry(ctx, reaction({ target_type: 7, action_type: 2, dest_x: 300, dest_y: 380 })))
      .toEqual([{ react: { who: 'random', do: { beamIn: 'p300_380' } } }]);
    expect(entry(ctx, reaction({ target_type: 6, target: '070201', action_type: 3, dest_screen: 2, dest_entrance: 0 })))
      .toEqual([{ react: { who: { object: 'horst3.guard' }, do: { beamTo: { screen: 'horst3.s02', entrance: 'entrance_0' } } } }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('does nothing where the original does nothing, with a warning', () => {
    const ctx = testCtx();
    expect(entry(ctx, reaction({ target_type: 255 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(entry(ctx, reaction({ target_type: 1, action_type: 3, dest_world: 5, dest_entrance: 0 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(entry(ctx, reaction({ target_type: 1, action_type: 3, dest_entrance: 7 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.warnings).toEqual([
      'o_070103#/use_entries/0/1: reaction target type 255 picks nobody, so it does nothing (object.cpp:1509-1512)',
      "o_070103#/use_entries/0/1: the original won't beam to another world (object.cpp:1611-1613)",
      'o_070103#/use_entries/0/1: no entrance 7 on s_0701 to beam to',
    ]);
  });
});

describe('GeneralBlock, PathBlock, TriggerBlock, CommandBlock and CommunicateBlock', () => {
  it('lifts every general command ScummVM knows', () => {
    const ctx = testCtx();
    const cmd = (command: number) => entry(ctx, general({ command }))[0];
    expect([3002, 4000, 1000, 2005, 7000, 8003, 9003, 10003].map(cmd)).toEqual([
      { wait: { seconds: 2 } }, { restartTimers: true }, { ship: { newWarpMovie: true } }, { ship: { reveal: 5 } },
      { ship: { repair: true } }, { ship: { computer: 'record', entry: 3 } }, { ship: { computer: 'hide', entry: 3 } },
      { ship: { computer: 'show', entry: 3 } },
    ]);
    expect(entry(ctx, general({ sound_id: 1 }))).toEqual([{ play: { sound: 'beep7' } }]);
    expect(entry(ctx, general({ sound_id: 9 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.warnings).toEqual(['o_070103#/use_entries/0/1: no preset sound 9, so the original plays nothing']);
  });

  it('sets each region to its last state, as the original\'s loop leaves it', () => {
    const ctx = testCtx();
    expect(entry(ctx, pathBlock({ regions_on: [24, 255, 23, 255], regions_off: [255, 24, 255, 255] })))
      .toEqual([{ path: { enable: ['r23'], disable: ['r24'] } }]);
    expect(entry(ctx, pathBlock({ regions_on: [99, 255, 255, 255] }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.warnings).toEqual(['o_070103#/use_entries/0/1: no region 99 on horst3.s01 (setRegionType only warns)']);
  });

  it('turns an unused trigger into a no-op, and switches a proximity trigger like any other', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['triggers.json'] as J[]).push({ ...(files['triggers.json'] as J[])[1], id: 5, type: 3 });
    })));
    expect(entry(ctx, triggerBlock({ trigger_id: 5 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(entry(ctx, triggerBlock({ trigger_id: 9, enable_trigger: false }))).toEqual([{ trigger: { id: 't9', enabled: false } }]);
    expect(ctx.problems.warnings).toEqual(['o_070103#/use_entries/0/1: trigger 5 is unused (type 3) and can never fire, so turning it on or off does nothing']);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('beams to world 5 for world 8, as beamDown does (awayteam.cpp:112-113; M3 Decision 9)', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      files['screens/s_0502.json'] = { id: 's_0502', world: 5, screen: 2, objects: null, location: null, polygons: [] };
    })));
    expect(entry(ctx, beam({ world_id: 8, screen_id: 2 }))).toEqual([{ beam: { to: 'frigis.s02', world: 8 } }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('records a beam to a screen the export lacks as missing, with a warning (M3 Decision 3)', () => {
    const ctx = testCtx();
    expect(entry(ctx, beam({ world_id: 1, screen_id: 0 }))).toEqual([{ missing: { kind: 'screen', id: 's_0100' } }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(1);
  });

  it('lets any object act, and calls a hook for an unknown command', () => {
    const ctx = testCtx();
    expect(entry(ctx, command({ target: ['070201', '000002', '007001'], command_id: 6, target_x: 10, target_y: 390 })))
      .toEqual([{ act: { verb: 'use', object: 'horst3.guard', who: 'data', other: 'tricorder', at: 'p10_390' } }]);
    expect(entry(ctx, command({ target: ['070201', '070100', NONE], command_id: 5 })))
      .toEqual([{ act: { verb: 'talk', object: 'horst3.guard', who: 'horst3.setup_world' } }]);
    expect(entry(ctx, command({ command_id: 9 }))).toEqual([{ call: { hook: 'unity.command.c9' } }]);
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('lifts no actor (ffffff) as $none, quietly, in a command and a startup action: only 0x10 is the current member', () => {
    // (CommandBlock::execute, object.cpp:1650-1657, and startAwayTeam, awayteam.cpp:334-336, map only 0x10 to the
    // current member; ffffff acts as nobody, though getWalker walks the current member for it)
    const ctx = testCtx();
    expect(entry(ctx, command({ target: ['070201', NONE, NONE], command_id: 5 })))
      .toEqual([{ act: { verb: 'talk', object: 'horst3.guard', who: '$none' } }]);
    expect(entry(ctx, command({ target: ['070201', '000010', NONE], command_id: 5 }))).toEqual([{ act: { verb: 'talk', object: 'horst3.guard' } }]);
    expect(entry(ctx, screenBlock({ startup_screen: 2, startup_target: '070201', startup_action: 5, startup_who: NONE }))[0])
      .toEqual({ startup: { screen: 'horst3.s02', action: { verb: 'talk', target: 'horst3.guard', who: '$none' } } });
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('ends the game with entrance 0xff as reason 0 from world 0, but keeps 0xff from world 0x5f', () => {
    const ctx = testCtx();
    expect(entry(ctx, screenBlock({ new_world: 0, new_screen: 0xfe }))[0]).toEqual({ screen: { to: '$ship', gameOver: 0 } });
    expect(entry(ctx, screenBlock({ new_world: 0x5f, new_screen: 0xfe }))[0]).toEqual({ screen: { to: '$ship', gameOver: 0xff } });
  });

  it('lifts hails: cleared, from a hailer\'s talk string, and the misread three-field form', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['objects/o_070201.json'] as J).talk_string = '@34,1';
      (files['objects/o_070104.json'] as J).talk_string = '@34,1,5';
    })));
    expect(entry(ctx, communicate({ hail_type: 255 }))).toEqual([{ communicate: { type: 255 } }]);
    for (const hail_type of [0xa, 0xb, 0x10, 0x11]) {
      // a battle hail names a scenario, not a ship conversation (dispatchPendingHail)
      expect(entry(ctx, communicate({ target: 'ff0000', conversation_id: 7, hail_type }))).toEqual([{ communicate: { scenario: 7, type: hail_type } }]);
    }
    expect(entry(ctx, communicate({ target: '070201', hail_type: 5 }))).toEqual([{ communicate: { from: 'horst3.guard', type: 5 } }]);
    expect(entry(ctx, communicate({ target: '070104', hail_type: 5 }))).toEqual([{ communicate: { conversation: 'ship.c034', situation: 1, type: 5 } }]);
    expect(ctx.problems.warnings).toEqual([
      'o_070103#/use_entries/0/1: 070104\'s talk string "@34,1,5" has three fields, which sscanf("@%d,%d") reads as conversation 34, situation 1 (object.cpp:1858)',
    ]);
    expect(ctx.ids.need.conversations.has('w05fc034')).toBe(true);
  });

  it('lifts the hails that open no ship conversation, and records an absent one as missing', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['objects/o_070201.json'] as J).talk_string = '@34,1';
    })));
    // type 7 with 99 is the target's own talk string, and 0xffff on a type that opens no conversation is just the type
    expect(entry(ctx, communicate({ target: '070201', conversation_id: 99, hail_type: 7 }))).toEqual([{ communicate: { from: 'horst3.guard', type: 7 } }]);
    expect(entry(ctx, communicate({ target: 'ffffff', conversation_id: 99, hail_type: 7 }))).toEqual([{ communicate: { type: 7 } }]);
    for (const hail_type of [9, 0xc, 0xd, 0xf]) {
      expect(entry(ctx, communicate({ target: 'ffffff', conversation_id: 0xffff, situation_id: 0xffff, hail_type }))).toEqual([{ communicate: { type: hail_type } }]);
    }
    // a conversation the export lacks (the game-over one, 95) is missing; one it has is lifted
    expect(entry(ctx, communicate({ target: 'ffffff', conversation_id: 95, situation_id: 0, hail_type: 4 }))).toEqual([{ missing: { kind: 'conversation', id: 'w05fc095' } }]);
    expect(entry(ctx, communicate({ target: 'ffffff', conversation_id: 34, situation_id: 2, hail_type: 4 }))).toEqual([{ communicate: { conversation: 'ship.c034', situation: 2, type: 4 } }]);
    expect(ctx.problems.warnings).toHaveLength(1);
  });

  it('lifts a ScreenBlock\'s screen-specific advice off, and flags for a screen', () => {
    const ctx = testCtx();
    expect(entry(ctx, screenBlock({ advice_screen: 2, new_advice_id: 0xfffe, flags_screen: 3, closeup: 1, combadge: 0 }))).toEqual([
      { advice: { off: true, screen: 'horst3.s02' } },
      { awayFlags: { combadge: false, closeup: true, screen: 'horst3.s03' } },
    ]);
    // (no id and an interval of 0xfffe: only the id is cleared, as the original's startup record is)
    expect(entry(ctx, screenBlock({ advice_screen: 2, new_advice_timer: 0xfffe }))[0]).toEqual({ advice: { screen: 'horst3.s02' } });
  });

  it('warns about a conversation change that names no response, and an action it has no "set" for', () => {
    const ctx = testCtx();
    expect(entry(ctx, convBlock({ conversation_id: 0, response_id: 9, state_id: 0, action_id: 2 })))
      .toEqual([{ converse: { conversation: 'horst3.c000', situation: 9, key: 0, to: 'enabled' } }]);
    expect(entry(ctx, convBlock({ conversation_id: 0, response_id: 1, action_id: 1 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.warnings).toEqual([
      'o_070103#/use_entries/0/1: w007c000 has no response 9/0, so this changes nothing',
      'o_070103#/use_entries/0/1: conversation action 1 is none of enable, disable and lock, so it does nothing here',
    ]);
    expect(ctx.problems.errors).toEqual([]);
  });
});

describe('secondary content', () => {
  it('drops what it can\'t lift, with warnings, instead of failing', () => {
    const ctx = testCtx();
    setLenient(ctx, true);
    const owner = conversationOwner(ctx, ctx.raw.conversations.get('w05fc034')!);
    const group = [cond({ how_close_dist: 5, how_close_x: 1, how_close_y: 390 }), convBlock({ world_id: 0xffff })];
    expect(liftGroups([group as unknown as EntryT[]], ctx, owner, 'w05fc034#/responses/0/results/0')).toEqual([
      { when: { counter: { mode: 'until', value: 0 } }, do: [{ wait: { seconds: 0 } }] },
    ]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(3);
    expect(ctx.problems.warnings[1]).toMatch(/refers to the current world.*\(in closure-only content, so it is dropped\)$/);
  });
});

describe('missing objects', () => {
  it('lifts a reaction on, or a hail from, a missing object as a no-op with a warning', () => {
    const ctx = testCtx();
    expect(entry(ctx, reaction({ target_type: 6, target: '070199', action_type: 0 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(entry(ctx, communicate({ target: '070199', hail_type: 5 }))).toEqual([{ wait: { seconds: 0 } }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toEqual([
      "o_070103#/use_entries/0/1: reaction target 070199 isn't in the export, so it does nothing (object.cpp:1492-1495, 1515-1516)",
      "o_070103#/use_entries/0/1: hailer 070199 isn't in the export, so the original warns and does nothing (object.cpp:1855-1861)",
    ]);
  });

  it('ends the group at an alter of a missing object, as RESULT_FAILOTHER does, but lifts the next group', () => {
    const ctx = testCtx();
    const groups = liftGroups([
      [cond({ skill_check: 0x0300 }), alter({ _order: 1, target: '070199', alter_state: 1 }), alter({ _order: 2, target: '070103', alter_state: 2, _stopHere: 1 })],
      [alter({ target: '070103', alter_state: 3 })],
    ] as unknown as EntryT[][], ctx, owner(ctx), 'o_070103#/use_entries');
    expect(groups).toEqual([
      { when: { skill: 0x300 }, do: [{ wait: { seconds: 0 } }] },
      { do: [{ alter: { object: 'horst3.rubble', state: 3 } }] },
    ]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toEqual([
      'o_070103#/use_entries/0/1: no object 070199 to alter, so the original skips the rest of this group (object.cpp:1291-1297)',
    ]);
  });
});

describe('close-up returns (Plan 6)', () => {
  it('lifts entrance 0xff as staying where the team was, with no warning', () => {
    const ctx = testCtx();
    expect(entry(ctx, screenBlock({ new_screen: 2, new_entrance: 0xff }))[0])
      .toEqual({ screen: { to: 'horst3.s02', entrance: 'entrance_0', stay: true } });
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('still lifts a plain entrance with its flags, and no stay', () => {
    const ctx = testCtx();
    expect(entry(ctx, screenBlock({ new_screen: 2, new_entrance: 0xc0 }))[0])
      .toEqual({ screen: { to: 'horst3.s02', entrance: 'entrance_0', gather: true, stepIn: true } });
  });
});

describe('a list with no screen of its own: a world\'s conversation (M3 Decision 2)', () => {
  const conv = (ctx: LiftCtx, id = 'w007c000') => conversationOwner(ctx, ctx.raw.conversations.get(id)!);
  const run = (ctx: LiftCtx, e: J, id = 'w007c000') => liftEntry(e as unknown as EntryT, ctx, conv(ctx, id), `${id}#/responses/0/results/0/0/0`);

  it('changes to $current, keeping the entrance\'s flags, or staying put for 0xff', () => {
    const ctx = testCtx();
    expect(run(ctx, screenBlock({ new_world: 7, new_screen: 0xff, new_entrance: 0xc1 }))).toEqual([
      { screen: { to: '$current', entrance: 'entrance_1', gather: true, stepIn: true } }, { awayFlags: {} },
    ]);
    expect(run(ctx, screenBlock({ new_world: 7, new_screen: 0xff, new_entrance: 0xff }))[0]).toEqual({ screen: { to: '$current', entrance: 'entrance_0', stay: true } });
    expect(ctx.problems.errors).toEqual([]);
  });

  it('puts a position on every located screen of its world under one name, without warnings', () => {
    const ctx = testCtx();
    expect(run(ctx, command({ target: ['070103', '000010', NONE], command_id: 4, target_x: 250, target_y: 100 })))
      .toEqual([{ act: { verb: 'walk', object: 'horst3.rubble', at: 'p250_100' } }]);
    expect(run(ctx, reaction({ target_type: 1, action_type: 2, dest_x: 200, dest_y: 380 })))
      .toEqual([{ react: { who: 'actor', do: { beamIn: 'p200_380' } } }]);
    for (const s of ['horst3.s01', 'horst3.s02']) expect(Object.keys(ctx.markers.screenMarkers(s))).toEqual(expect.arrayContaining(['p250_100', 'p200_380']));
    // (row 100 is above both floors' back edges, but where the team will be isn't known: no warning)
    expect(ctx.problems.warnings).toEqual([]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('beams to an entrance of the current screen, which the sim checks when it runs', () => {
    const ctx = testCtx();
    expect(run(ctx, reaction({ target_type: 3, action_type: 3, dest_entrance: 3 })))
      .toEqual([{ react: { who: 'team', do: { beamTo: { entrance: 'entrance_3' } } } }]);
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('switches any region a screen of its world has, and warns about one none has', () => {
    const ctx = testCtx();
    expect(run(ctx, pathBlock({ regions_on: [24, 5, 99, 255] }))).toEqual([{ path: { enable: ['r24', 'r5'] } }]);
    expect(ctx.problems.warnings).toEqual(['w007c000#/responses/0/results/0/0/0: no region 99 on any screen this list can run on (setRegionType only warns)']);
  });

  it('still fails in a ship conversation, which can run in any world', () => {
    const ctx = testCtx();
    run(ctx, command({ target: ['070103', '000010', NONE], command_id: 4, target_x: 250, target_y: 340 }), 'w05fc034');
    expect(ctx.problems.errors).toHaveLength(1);
    expect(ctx.problems.errors[0]).toMatch(/refers to the current world/);
  });
});

describe('AlterBlock position of an item that moves between screens', () => {
  it('is a marker of the screen the effect belongs to as well as of the object\'s own screen', () => {
    const ctx = testCtx();
    // o_070103 belongs to horst3.s01; the effect is on o_070201 (another screen)
    const ownerScreen = ctx.markers.screenMarkers;
    entry(ctx, alter({ target: '070103', x_pos: 211, y_pos: 322 }), '070201');
    const onOwn = Object.keys(ownerScreen.call(ctx.markers, 'horst3.s01'));
    const onEffects = Object.keys(ownerScreen.call(ctx.markers, 'horst3.s02'));
    expect(onOwn).toContain('p211_322');
    expect(onEffects).toContain('p211_322');
  });
});

describe('effects aimed at what the export lacks (the space world)', () => {
  it('records a conversation block naming no conversation, and a screen change to a battle, as missing', () => {
    const ctx = testCtx();
    expect(entry(ctx, convBlock({ world_id: 7, conversation_id: 0xffff, response_id: 0xffff, state_id: 0xffff })))
      .toEqual([{ missing: { kind: 'conversation', id: 'w007c65535' } }]);
    expect(entry(ctx, screenBlock({ new_world: 0x10, new_screen: 0xfe, new_entrance: 0 })))
      .toEqual([{ missing: { kind: 'screen', id: 's_10fe' } }, { awayFlags: {} }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(2);
  });
});
