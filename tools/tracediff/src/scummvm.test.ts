// SPDX-License-Identifier: GPL-3.0-or-later
import { Rng } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { normalizeScummvm } from './scummvm';
import { testMaps } from './testing/maps';

/** A ScummVM trace: begin (seed 42), the events, end; seq numbered as the tracer does. */
function trace(events: Record<string, unknown>[]): string {
  return [{ ev: 'begin', version: 1, engine: 'scummvm', seed: 42 }, ...events, { ev: 'end' }]
    .map((e, seq) => JSON.stringify({ seq, ...e }))
    .join('\n');
}

describe('normalizeScummvm', () => {
  it('maps a step\'s action, groups, state and lines through the lifted ids, and pixels to metres', () => {
    const { events, problems } = normalizeScummvm(trace([
      { ev: 'step', line: 2, text: 'use 000000 070103' },
      { ev: 'action', verb: 'use', target: '070103', who: '000000', other: 'ffffff', x: 0, y: 0, depth: 1 },
      { ev: 'group', list: 'o_070103#/use_entries', index: 0, passed: true, flags: 0 },
      { ev: 'entry', list: 'o_070103#/use_entries', group: 0, index: 0, class: 'AlterBlock', flags: 0 },
      { ev: 'obj', id: '070103', field: 'state', from: 0, to: 1 },
      { ev: 'obj', id: '070104', field: 'x', from: 720, to: 400, walking: false },
      { ev: 'say', who: '000000', text: 'Hello  there.', voice: 'FE0000E6.VAC' },
      { ev: 'actionEnd', verb: 'use', target: '070103', flags: 0x8000, depth: 1 },
    ]), testMaps());
    expect(problems).toEqual([]);
    expect(events).toEqual([
      { k: 'step', line: 2, text: 'use 000000 070103' },
      { k: 'action', verb: 'use', target: 'rubble', who: 'picard', other: null, depth: 1 },
      { k: 'group', key: 'rubble/use/0', passed: true },
      { k: 'set', key: 'obj:rubble.state', value: 1 },
      // (the lever starts on "center", pixel (720, 599); x moves to 400)
      { k: 'set', key: 'obj:lever.pos', value: '1,5', tag: 'alter' },
      { k: 'say', who: 'picard', voice: 'fe0000e6', text: 'Hello there.' },
      { k: 'actionEnd', verb: 'use', target: 'rubble', flags: 0x8000, depth: 1 },
      { k: 'end' },
    ]);
  });

  it('maps choice branches, conversation results, counters, triggers, regions, startups and globals', () => {
    const draw = new Rng({ rngSeed: 42 }).next(2);
    const { events, notCompared, problems } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'start 7 1 0' },
      { ev: 'screen', world: 7, screen: 1, entrance: 0 },
      { ev: 'group', list: 'o_070103#/use_entries/1/0/_choice/1', index: 0, passed: false, flags: 2 },
      { ev: 'group', list: 'w007c000#/responses/0/results/0', index: 0, passed: true, flags: 0 },
      { ev: 'counter', entry: 'o_070103#/use_entries/0/0', from: 2, to: 1 },
      { ev: 'response', conv: 'w007c000', index: 0, id: 1, state: 0, from: 2, to: 3 },
      { ev: 'triggerState', id: 3, enabled: false },
      { ev: 'triggerState', id: 0x40, enabled: true },
      { ev: 'region', world: 7, screen: 1, region: 23, type: 1 },
      { ev: 'startup', world: 7, screen: 2, field: 'combadge', from: 0, to: 1 },
      { ev: 'startup', world: 7, screen: 2, field: 'advice_id', from: 65535, to: 1 },
      { ev: 'startup', world: 7, screen: 2, field: 'x', from: 65535, to: 10 },
      { ev: 'global', key: 'team', from: '', to: '000000,000001' },
      { ev: 'global', key: 'phaserIndex', from: 0, to: 9 },
      { ev: 'global', key: 'newWarpMovie', from: 0, to: 1 },
      { ev: 'obj', id: '000000', field: 'curr_screen', from: 0, to: 1 },
      { ev: 'obj', id: '070104', field: 'curr_screen', from: 1, to: 0xff },
      { ev: 'global', key: 'adviceInterval', from: 0, to: 30000 },
      { ev: 'obj', id: '070103', field: 'sprite_id', from: 1, to: 2 },
      { ev: 'trigger', id: 3, target: '070104' },
      { ev: 'rng', site: 'stepInX', max: 2, value: draw },
      { ev: 'choice', kind: 'menu', question: 'Say', options: ['a', 'b'], picked: 1, scripted: true },
      { ev: 'movie', id: 55, file: 'ZZ9MOVIE.FVF' },
      { ev: 'refused', who: '000001' },
      { ev: 'ship', code: 0 },
    ]), testMaps());
    expect(problems).toEqual([]);
    expect(events).toEqual([
      { k: 'step', line: 1, text: 'start 7 1 0' },
      { k: 'screen', screen: 'room' },
      { k: 'group', key: 'rubble/use/1/choice1/0', passed: false },
      { k: 'group', key: 'horst3.c000/0/results0/0', passed: true },
      { k: 'set', key: 'counter:rubble/use/0', value: 1 },
      { k: 'set', key: 'resp:horst3.c000/0', value: 'disabled' },
      { k: 'set', key: 'trigger:t3', value: false },
      { k: 'set', key: 'trigger:?64', value: true },
      { k: 'set', key: 'region:room/r23', value: true },
      { k: 'set', key: 'startup:hall.combadge', value: true },
      { k: 'set', key: 'startup:hall.advice', value: 'horst3.a1' },
      { k: 'set', key: 'global:team', value: 'picard,data' },
      { k: 'set', key: 'global:phaserSetting', value: 2 },
      { k: 'set', key: 'obj:picard.screen', value: 'room' },
      { k: 'set', key: 'obj:lever.screen', value: null },
      { k: 'set', key: 'global:adviceInterval', value: 30 },
      { k: 'trigger', id: 't3', target: 'lever' },
      { k: 'rng', site: 'stepInX', max: 2, value: draw },
      { k: 'choice', kind: 'menu', options: 2, picked: 1 },
      { k: 'movie', file: 'zz9movie' },
      { k: 'refused', who: 'data' },
      { k: 'ship' },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({
      'startup.x': 1,
      'global.newWarpMovie (the starship modes)': 1,
      'obj.sprite_id': 1,
    });
  });

  it('puts the away team on the screen a start moved them to, not on the screen the game starts on', () => {
    // (the crew's own curr_screen isn't traced at a start: a pixel on the new screen goes through its projection)
    const maps = testMaps();
    maps.coords.screens.hall.projection = { ...maps.coords.screens.hall.projection, metersPerPixel: 0.025 };
    const { events, problems } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'start 7 2 0' },
      { ev: 'screen', world: 7, screen: 2, entrance: 0 },
      { ev: 'obj', id: '000000', field: 'x', from: 0, to: 400, walking: false },
      { ev: 'obj', id: '000000', field: 'y', from: 0, to: 439, walking: false },
    ]), maps);
    expect(problems).toEqual([]);
    // (the hall is 0.025 m a pixel: pixel (400, 439) is the point (2, 2); on the room it would be (1, 1))
    expect(events.filter(e => e.k === 'set' && e.key === 'obj:picard.pos').at(-1)).toEqual({ k: 'set', key: 'obj:picard.pos', value: '2,2' });
  });

  it('takes a coordinate a start leaves unlogged to be the one on the entrance slot of the screen it started on', () => {
    // (ScummVM logs a coordinate only when it changes: the second member's x was already the slot's)
    const maps = testMaps();
    maps.content.screens.hall.markers.entrance_0 = { x: 0, z: 0 };
    maps.content.screens.hall.markers['entrance_0.1'] = { x: 1, z: 1 };
    maps.coords.screens.hall.markers.entrance_0 = [320, 399];
    maps.coords.screens.hall.markers['entrance_0.1'] = [400, 439];
    maps.content.start.awayTeam = ['picard', 'data'];
    const { events } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'start 7 2 0' },
      { ev: 'screen', world: 7, screen: 2, entrance: 0 },
      { ev: 'obj', id: '000001', field: 'y', from: 0, to: 439, walking: false },
    ]), maps);
    expect(events.filter(e => e.k === 'set' && e.key === 'obj:data.pos')).toEqual([{ k: 'set', key: 'obj:data.pos', value: '1,1' }]);
  });

  it('maps object flags, timers, names, talk, phaser state, inventory and the team globals', () => {
    const { events, notCompared, problems } = normalizeScummvm(trace([
      { ev: 'step', line: 3, text: 'advance 1' },
      { ev: 'screen', world: 7, screen: 1, entrance: 0 },
      { ev: 'obj', id: '070104', field: 'flags', from: 0, to: 0xa1 },
      { ev: 'obj', id: '070104', field: 'flags', from: 0xa1, to: 0x80 },
      { ev: 'obj', id: '070104', field: 'timer', from: 5, to: 0xffff },
      { ev: 'obj', id: '070104', field: 'timer', from: 0xffff, to: 30 },
      { ev: 'obj', id: '070104', field: 'name', from: 'a lever', to: 'a bent lever' },
      { ev: 'obj', id: '000001', field: 'talk_string', from: '', to: '@0,1' },
      { ev: 'obj', id: '070103', field: 'health', from: 10, to: 6 },
      { ev: 'obj', id: '070103', field: 'stunned', from: 0, to: 1 },
      { ev: 'obj', id: '070104', field: 'inventory', from: 0, to: 1 },
      { ev: 'global', key: 'adviceId', from: 65535, to: 1 },
      { ev: 'global', key: 'member', from: '000000', to: '000001' },
      { ev: 'global', key: 'member', from: '000001', to: 'ffffff' },
      { ev: 'global', key: 'beam', from: '0,0', to: '7,2' },
      { ev: 'global', key: 'pendingHail', from: '0,0,0,255', to: '1,95,34,0' },
      { ev: 'global', key: 'pendingHail', from: '1,95,34,0', to: '0,0,0,255' },
      { ev: 'global', key: 'combadge', from: 0, to: 1 },
      // (in the inventory, the lever is on no screen: its position isn't compared)
      { ev: 'obj', id: '070104', field: 'curr_screen', from: 1, to: 0xff },
      { ev: 'obj', id: '070104', field: 'x', from: 720, to: 400, walking: false },
      { ev: 'region', world: 7, screen: 0, region: 1, type: 0 },
      { ev: 'startup', world: 7, screen: 0, field: 'closeup', from: 0, to: 255 },
    ]), testMaps());
    expect(problems).toEqual([]);
    expect(events).toEqual([
      { k: 'step', line: 3, text: 'advance 1' },
      { k: 'screen', screen: 'room' },
      { k: 'set', key: 'obj:lever.active', value: true },
      { k: 'set', key: 'obj:lever.stunned', value: true },
      { k: 'set', key: 'obj:lever.active', value: false },
      { k: 'set', key: 'obj:lever.timer', value: 0 },
      { k: 'set', key: 'obj:lever.timer', value: 30 },
      { k: 'set', key: 'obj:lever.name', value: 'a bent lever' },
      { k: 'set', key: 'obj:data.talk', value: '@horst3.c000,1' },
      { k: 'set', key: 'phaser:rubble.health', value: 6 },
      { k: 'set', key: 'phaser:rubble.stunned', value: true },
      { k: 'set', key: 'obj:lever.inventory', value: true },
      { k: 'set', key: 'global:adviceId', value: 'horst3.a1' },
      { k: 'set', key: 'global:member', value: 'data' },
      { k: 'set', key: 'global:member', value: null },
      { k: 'set', key: 'global:beam', value: 'hall' },
      { k: 'set', key: 'global:pendingHail', value: 'pending' },
      { k: 'set', key: 'global:pendingHail', value: null },
      { k: 'set', key: 'global:combadge', value: true },
      { k: 'set', key: 'obj:lever.screen', value: null },
      { k: 'set', key: 'region:?/r1', value: false },
      { k: 'set', key: 'startup:?.closeup', value: false },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({
      'obj.flags verb and inventory bits (verbs pick the cursor; inventory is its own field)': 2,
      'positions on no screen (in the inventory, or nowhere)': 1,
    });
  });

  it('leaves out what it can\'t compare, and counts it', () => {
    const maps = testMaps();
    delete maps.content.objects.lever.at;
    const { events, notCompared } = normalizeScummvm(trace([
      { ev: 'triggerState', id: 3, enabled: false },
      { ev: 'step', line: 1, text: 'advance 2' },
      { ev: 'obj', id: '000000', field: 'x', from: 1, to: 5, walking: true },
      // (the lever, here, starts on no marker, so its y isn't known yet)
      { ev: 'obj', id: '070104', field: 'x', from: 1, to: 5, walking: false },
      { ev: 'error', what: "the game didn't settle within 60 seconds" },
    ]), maps);
    expect(events).toEqual([
      { k: 'step', line: 1, text: 'advance 2' },
      { k: 'error', what: "the game didn't settle within 60 seconds" },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({
      'events before the first step (the harness preamble)': 1,
      'positions while walking (the sim moves between markers)': 1,
      'positions with one coordinate still unknown': 1,
    });
  });

  it('places a teammate the content puts on no screen where the start puts the team, as the baseline does', () => {
    // (the lifter gives the crew a null screen: createInitialState puts the away team on the start's screen,
    // and ScummVM's crew are already there, so it logs their placement but no curr_screen)
    const maps = testMaps();
    maps.content.objects.data.screen = null;
    const { events, notCompared } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'start 7 1 0' },
      { ev: 'screen', world: 7, screen: 1, entrance: 0 },
      { ev: 'obj', id: '000001', field: 'x', from: 135, to: 400, walking: false },
      { ev: 'obj', id: '000001', field: 'y', from: 354, to: 439, walking: false },
    ]), maps);
    expect(events).toEqual([
      { k: 'step', line: 1, text: 'start 7 1 0' },
      { k: 'screen', screen: 'room' },
      { k: 'set', key: 'obj:data.pos', value: '1,0' },
      { k: 'set', key: 'obj:data.pos', value: '1,1' },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({});
  });

  it('composes a teammate\'s lone x or y update with where the start put them, as the baseline does', () => {
    // (the crew have no marker of their own: the start puts each on its entrance slot, createInitialState;
    // Data is the second to arrive, slot door.1 when the screen has it)
    const maps = testMaps();
    maps.content.objects.data.screen = null;
    maps.content.screens.room.markers['door.1'] = { x: -1, z: 0 };
    maps.coords.screens.room.markers['door.1'] = [240, 399];
    const { events, notCompared } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'start 7 1 0' },
      { ev: 'obj', id: '000001', field: 'y', from: 399, to: 439, walking: false },
      { ev: 'obj', id: '000000', field: 'x', from: 320, to: 400, walking: false },
    ]), maps);
    expect(events).toEqual([
      { k: 'step', line: 1, text: 'start 7 1 0' },
      { k: 'set', key: 'obj:data.pos', value: '-1,1' },
      { k: 'set', key: 'obj:picard.pos', value: '1,0' },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({});
  });

  it('keeps a coordinate logged while walking, so the other one at rest composes with it', () => {
    // (a step-in walks the team to new x and y, and only the coordinate that still changes is logged at rest)
    const { events, notCompared } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'walk 000000 070103' },
      { ev: 'obj', id: '000000', field: 'x', from: 320, to: 400, walking: true },
      { ev: 'obj', id: '000000', field: 'y', from: 399, to: 479, walking: true },
      { ev: 'obj', id: '000000', field: 'y', from: 479, to: 439, walking: false },
    ]), testMaps());
    expect(events).toEqual([
      { k: 'step', line: 1, text: 'walk 000000 070103' },
      { k: 'set', key: 'obj:picard.pos', value: '1,1' },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({ 'positions while walking (the sim moves between markers)': 2 });
  });

  it('names an action by nobody (ffffff) $none, as the content does', () => {
    const { events } = normalizeScummvm(trace([
      { ev: 'step', line: 1, text: 'walk 000000 070103' },
      { ev: 'action', verb: 'use', target: '070104', who: 'ffffff', other: 'ffffff', x: 65535, y: 65535, depth: 1 },
    ]), testMaps());
    expect(events[1]).toEqual({ k: 'action', verb: 'use', target: 'lever', who: '$none', other: null, depth: 1 });
  });

  it('keeps only steps, errors and the end once the team is back on the ship', () => {
    // (as Task 6's live run logs it: a ship trigger fires a use on a ship object, with its groups,
    // entries and state, and no screen event; ids are invented)
    const { events, notCompared } = normalizeScummvm(trace([
      { ev: 'step', line: 5, text: 'combadge 000000' },
      { ev: 'ship', code: 0 },
      { ev: 'obj', id: '000000', field: 'curr_screen', from: 1, to: 0 },
      { ev: 'global', key: 'team', from: '000000,000001', to: '' },
      { ev: 'trigger', id: 64, target: '5f0340' },
      { ev: 'action', verb: 'use', target: '5f0340', who: '000000', other: 'ffffff', x: 0, y: 0, depth: 1 },
      { ev: 'group', list: 'o_5f0340#/use_entries', index: 0, passed: true, flags: 0 },
      { ev: 'entry', list: 'o_5f0340#/use_entries', group: 0, index: 0, class: 'AlterBlock', flags: 0 },
      { ev: 'triggerState', id: 3, enabled: true },
      { ev: 'actionEnd', verb: 'use', target: '5f0340', flags: 0, depth: 1 },
      { ev: 'screen', world: 0x5f, screen: 1, entrance: 0 },
      { ev: 'obj', id: '070104', field: 'state', from: 0, to: 4 },
      { ev: 'step', line: 6, text: 'end' },
      { ev: 'error', what: 'an invented error' },
    ]), testMaps());
    expect(events).toEqual([
      { k: 'step', line: 5, text: 'combadge 000000' },
      { k: 'ship' },
      { k: 'step', line: 6, text: 'end' },
      { k: 'error', what: 'an invented error' },
      { k: 'end' },
    ]);
    expect(Object.fromEntries(notCompared)).toEqual({
      'everything after the team is back on the ship (the ship\'s screens)': 10,
    });
  });

  it('refuses a trace that has no end, spans a load, or breaks the schema', () => {
    const noEnd = [{ seq: 0, ev: 'begin', version: 1, engine: 'scummvm', seed: 42 }, { seq: 1, ev: 'step', line: 1, text: 'end' }]
      .map(e => JSON.stringify(e)).join('\n');
    expect(normalizeScummvm(noEnd, testMaps()).problems).toEqual([expect.stringMatching(/^the trace has no end/)]);
    expect(normalizeScummvm(trace([{ ev: 'load' }]), testMaps()).problems).toEqual([expect.stringMatching(/^the trace spans a load/)]);
    expect(normalizeScummvm(trace([{ ev: 'step', line: 'x' }]), testMaps()).problems[0]).toMatch(/^line 2: /);
  });

  it('names conversations in talk strings as the lifter does', () => {
    const maps = testMaps();
    expect(maps.talk('@7,0,?3', 7)).toBe('@horst3.c000,?3');
    expect(maps.talk('@0,1', 7)).toBe('@horst3.c000,1');
    expect(maps.talk('Nothing to say.', 7)).toBe('Nothing to say.');
  });
});
