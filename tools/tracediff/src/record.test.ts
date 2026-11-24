// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { Clock, createInitialState, HeadlessPresenter, World } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import type { Value } from './model';
import { snapshot, TraceRecorder, TracingPresenter } from './record';
import { loadGameHooks, runTs } from './run';
import { normalizeScummvm } from './scummvm';
import { testMaps } from './testing/maps';

describe('the TypeScript side of the trace', () => {
  it('records content the export lacks, as the sim reports it (M3 Decision 3)', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    world.bus.emit({ type: 'missing', kind: 'movie', id: '42' });
    expect(rec.events.at(-1)).toEqual({ k: 'missing', kind: 'movie', id: '42' });
  });

  it('records the model the ScummVM trace is mapped to, with the state at each step\'s end', async () => {
    const { events, error } = await runTs('', 'seed 42\nstart 7 1 0\nuse 000000 070104\nend\n', { maps: testMaps() });
    expect(error).toBeNull();
    // (whether Picard steps up to the lever is the sim's business: his position isn't what this test is about)
    const shown = events
      .filter(e => !(e.k === 'set' && e.key === 'obj:picard.pos'))
      .map(e => (e.k === 'baseline' ? { k: 'baseline' } : e));
    expect(shown).toEqual([
      { k: 'step', line: 1, text: 'seed 42' },
      { k: 'seed', seed: 42 },
      { k: 'step', line: 2, text: 'start 7 1 0' },
      { k: 'baseline' },
      { k: 'screen', screen: 'room' },
      { k: 'step', line: 3, text: 'use 000000 070104' },
      { k: 'action', verb: 'use', target: 'lever', who: 'picard', other: null, depth: 1 },
      { k: 'group', key: 'lever/use/0', passed: true },
      { k: 'actionEnd', verb: 'use', target: 'lever', flags: expect.any(Number), depth: 1 },
      { k: 'set', key: 'obj:lever.state', value: 2 },
      { k: 'step', line: 4, text: 'end' },
      { k: 'end' },
    ]);
    const baseline = events.find(e => e.k === 'baseline');
    expect(baseline?.k === 'baseline' && baseline.values['obj:lever.state']).toBe(0);
    expect(baseline?.k === 'baseline' && baseline.values['obj:lever.pos']).toBe('5,5');
  });

  it('stops recording what happens once the team is back on the ship, as the ScummVM side does', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    // (what the mission changed before it was left still counts)
    world.state.objects.lever.state = 3;
    world.bus.emit({ type: 'leftAwayMission', gameOver: null });
    world.state.objects.lever.state = 4;
    world.bus.emit({ type: 'triggerFired', id: 't1', target: 'lever' });
    rec.push({ k: 'step', line: 9, text: 'advance 12' });
    world.bus.emit({ type: 'triggerFired', id: 't2', target: 'lever' });
    rec.push({ k: 'end' });
    expect(rec.events.slice(2)).toEqual([{ k: 'set', key: 'obj:lever.state', value: 3 }, { k: 'ship' }, { k: 'step', line: 9, text: 'advance 12' }, { k: 'end' }]);
  });

  it('flags an away screen entered after the team is back on the ship', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    world.bus.emit({ type: 'leftAwayMission', gameOver: null });
    world.bus.emit({ type: 'screenChanged', screen: 'other' });
    expect(rec.events.at(-1)).toMatchObject({ k: 'error' });
  });

  it('records lines with the speaker\'s voice, choices, cancelled menus and movies', async () => {
    const rec = new TraceRecorder(testMaps());
    const p = new TracingPresenter(new Clock({ tick: 0 }), rec);
    p.answer(0);
    p.pick(1);
    p.pick(null);
    // (say and play wait on the clock, which no one moves here: they record before waiting)
    void p.say('data', ' Fascinating,\n  Captain. ', 'fe@00e6');
    expect(await p.choose('Clear it?', ['Yes', 'No'])).toBe(0);
    expect(await p.menu(['a', 'b'])).toBe(1);
    expect(await p.menu(['a', 'b'])).toBeNull();
    void p.play({ movie: 'HO3ARRIV' });
    void p.play({ sound: 'beep7' });
    expect(rec.events).toEqual([
      { k: 'say', who: 'data', voice: 'fe0100e6', text: 'Fascinating, Captain.' },
      { k: 'choice', kind: 'box', options: 2, picked: 0 },
      { k: 'choice', kind: 'menu', options: 2, picked: 1 },
      { k: 'choice', kind: 'menu', options: 2, picked: -1 },
      { k: 'movie', file: 'ho3arriv' },
    ]);
  });

  it('turns off the ship\'s triggers the harness turns off, before the world starts', async () => {
    const { events } = await runTs('', 'start 7 1 0\nend\n', { maps: testMaps() });
    const baseline = events.find(e => e.k === 'baseline');
    expect(baseline?.k === 'baseline' && baseline.values['trigger:t3']).toBe(false);
  });

  it('registers a game\'s hooks before it starts, loading them from the game at run time', async () => {
    const registered: string[] = [];
    await runTs('', 'start 7 1 0\nend\n', {
      maps: testMaps(),
      registerHooks: hooks => {
        hooks.register('unity.test', () => 0);
        registered.push('unity.test');
      },
    });
    expect(registered).toEqual(['unity.test']);
    expect(await loadGameHooks('/nowhere')).toBeUndefined();
    const unity = fileURLToPath(new URL('../../../games/unity', import.meta.url));
    expect(typeof (await loadGameHooks(unity))).toBe('function');
  });

  it('spells every state key as the ScummVM side does, with values of the same kind', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const ts = snapshot(world);
    // (one change of every kind the ScummVM side writes, to objects and screens the shared fixture has)
    const trace = [
      { ev: 'begin', version: 1, engine: 'scummvm', seed: 42 },
      { ev: 'step', line: 1, text: 'start 7 1 0' },
      { ev: 'screen', world: 7, screen: 1, entrance: 0 },
      { ev: 'obj', id: '070104', field: 'curr_screen', from: 1, to: 2 },
      { ev: 'obj', id: '070104', field: 'state', from: 0, to: 1 },
      { ev: 'obj', id: '070104', field: 'flags', from: 0, to: 0xa0 },
      { ev: 'obj', id: '070104', field: 'inventory', from: 0, to: 1 },
      { ev: 'obj', id: '070104', field: 'x', from: 720, to: 400, walking: false },
      { ev: 'obj', id: '070104', field: 'timer', from: 0xffff, to: 30 },
      { ev: 'obj', id: '070104', field: 'name', from: 'a', to: 'b' },
      { ev: 'obj', id: '000001', field: 'talk_string', from: '', to: '@0,1' },
      { ev: 'obj', id: '070103', field: 'health', from: 10, to: 6 },
      { ev: 'obj', id: '070103', field: 'stunned', from: 0, to: 1 },
      { ev: 'response', conv: 'w007c000', index: 0, id: 1, state: 0, from: 2, to: 3 },
      { ev: 'triggerState', id: 3, enabled: false },
      { ev: 'startup', world: 7, screen: 2, field: 'closeup', from: 0, to: 1 },
      // (255 leaves a startup flag alone; the original reads closeup as `== 1`, awayteam.cpp:284)
      { ev: 'startup', world: 7, screen: 1, field: 'closeup', from: 0, to: 255 },
      // (in the inventory, the rubble is on no screen: neither side has its position)
      { ev: 'obj', id: '070103', field: 'curr_screen', from: 1, to: 0xff },
      { ev: 'obj', id: '070103', field: 'x', from: 1120, to: 400, walking: false },
      { ev: 'startup', world: 7, screen: 2, field: 'combadge', from: 255, to: 1 },
      { ev: 'startup', world: 7, screen: 2, field: 'input_blocked', from: 255, to: 0 },
      { ev: 'startup', world: 7, screen: 2, field: 'advice_id', from: 65535, to: 1 },
      { ev: 'global', key: 'adviceId', from: 65535, to: 1 },
      { ev: 'global', key: 'adviceInterval', from: 0, to: 30000 },
      { ev: 'global', key: 'combadge', from: 0, to: 1 },
      { ev: 'global', key: 'inputBlocked', from: 0, to: 1 },
      { ev: 'global', key: 'closeup', from: 0, to: 1 },
      { ev: 'global', key: 'member', from: '000000', to: '000001' },
      { ev: 'global', key: 'team', from: '', to: '000000,000001' },
      { ev: 'global', key: 'phaserIndex', from: 0, to: 9 },
      { ev: 'global', key: 'beam', from: '0,0', to: '7,2' },
      { ev: 'global', key: 'pendingHail', from: '0,0,0,255', to: '1,95,34,0' },
      { ev: 'end' },
    ].map((e, seq) => JSON.stringify({ seq, ...e })).join('\n');
    const { events, problems } = normalizeScummvm(trace, maps);
    expect(problems).toEqual([]);
    const scummvm = new Map<string, Value>();
    for (const e of events) if (e.k === 'set') scummvm.set(e.key, e.value);

    const kind = (v: Value) => (v === null ? 'null' : typeof v);
    // (the keys whose sim state can be null: a screen, a startup flag left alone, an advice id, nobody, no target)
    const NULLABLE = /^(obj:[^.]+\.screen|startup:[^.]+\.(combadge|inputBlocked|advice)|global:(adviceId|member|beam|pendingHail))$/;
    for (const [key, value] of scummvm) {
      expect(ts.has(key), key).toBe(true);
      const tsValue = ts.get(key)!;
      if (value === null || tsValue === null) expect(NULLABLE.test(key), `${key} is null on one side`).toBe(true);
      if (value !== null && tsValue !== null) expect(kind(tsValue), key).toBe(kind(value));
    }
    expect(scummvm.get('startup:room.closeup')).toBe(false);
    expect(scummvm.has('obj:rubble.pos')).toBe(false);
    world.state.objects.rubble.screen = null;
    expect(snapshot(world).has('obj:rubble.pos')).toBe(false);
    // every kind of key the snapshot has, the ScummVM side writes too (counters and regions apart: below)
    const family = (key: string) => key.replace(/^(obj|phaser):[^.]+/, '$1:*').replace(/^(resp|trigger|startup):[^.]*/, '$1:*');
    const written = new Set([...scummvm.keys()].map(family));
    const families = new Set([...ts.keys()].filter(k => !/^(counter|region):/.test(k)).map(family));
    expect([...families].filter(f => !written.has(f)).sort()).toEqual([]);
  });

  it('keeps an object\'s position while it is on no screen, as ScummVM logs none there', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    const lever = world.state.objects.lever;
    const sets = () => rec.events.filter(e => e.k === 'set').map(e => e.k === 'set' && [e.key, e.value]);

    // picked up, then dropped where it was: only its screen changes
    lever.screen = null;
    rec.checkpoint();
    lever.screen = 'room';
    rec.checkpoint();
    expect(sets()).toEqual([['obj:lever.screen', null], ['obj:lever.screen', 'room']]);

    // picked up, then dropped elsewhere: one position
    rec.events.length = 0;
    lever.screen = null;
    rec.checkpoint();
    lever.screen = 'room';
    lever.pos = { x: 1, z: 2 };
    rec.checkpoint();
    expect(sets()).toEqual([['obj:lever.screen', null], ['obj:lever.screen', 'room'], ['obj:lever.pos', '1,2']]);
  });

  it('writes a screen before the step-in draws of the team\'s arrival, as ScummVM logs it on arriving', () => {
    // (traceScreen opens startAwayTeam, awayteam.cpp:243; placeAwayTeam draws after it; the sim's
    // screenChanged comes once the team is placed)
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    rec.events.length = 0;
    world.bus.emit({ type: 'rng', site: 'reply', max: 1, value: 0 });
    world.bus.emit({ type: 'rng', site: 'stepInX', max: 2, value: 1 });
    world.bus.emit({ type: 'rng', site: 'stepInY', max: 2, value: 0 });
    world.bus.emit({ type: 'screenChanged', screen: 'hall' });
    expect(rec.events).toEqual([
      { k: 'rng', site: 'reply', max: 1, value: 0 },
      { k: 'screen', screen: 'hall' },
      { k: 'rng', site: 'stepInX', max: 2, value: 1 },
      { k: 'rng', site: 'stepInY', max: 2, value: 0 },
    ]);
  });

  it('writes an error before the state its step changed, then the end, as ScummVM does', () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    const rec = new TraceRecorder(maps);
    rec.attach(world);
    rec.events.length = 0;
    rec.walkEvent({ kind: 'step', line: 3, text: 'use 000000 070104' });
    world.state.objects.lever.state = 2;
    rec.walkEvent({ kind: 'error', what: 'line 3: it broke' });
    rec.finish();
    expect(rec.events).toEqual([
      { k: 'step', line: 3, text: 'use 000000 070104' },
      { k: 'error', what: 'line 3: it broke' },
      { k: 'set', key: 'obj:lever.state', value: 2 },
      { k: 'end' },
    ]);
  });

  it('keys counters by their group and regions as the lifter names them, as the ScummVM side does', async () => {
    const maps = testMaps();
    const world = new World(maps.content, createInitialState(maps.content), w => new HeadlessPresenter(w.clock));
    world.state.counters['rubble/use/0'] = 1;
    world.state.regions.room.r23 = true;
    const ts = snapshot(world);
    const trace = [
      { ev: 'begin', version: 1, engine: 'scummvm', seed: 42 },
      { ev: 'step', line: 1, text: 'start 7 1 0' },
      { ev: 'counter', entry: 'o_070103#/use_entries/0/0', from: 2, to: 1 },
      { ev: 'region', world: 7, screen: 1, region: 23, type: 1 },
      { ev: 'end' },
    ].map((e, seq) => JSON.stringify({ seq, ...e })).join('\n');
    const sets = normalizeScummvm(trace, maps).events.filter(e => e.k === 'set');
    expect(sets.map(e => e.k === 'set' && [e.key, ts.get(e.key)])).toEqual([
      ['counter:rubble/use/0', 1],
      ['region:room/r23', true],
    ]);
  });
});
