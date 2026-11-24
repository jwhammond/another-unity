// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWANCES } from './allowances';
import { atan2Oracle } from './combat';
import { diffBattle } from './combatDiff';
import type { Norm } from './model';
import { diffTraces } from './diff';
import { testMaps } from './testing/maps';
import { diff, run } from './testing/runs';

const timer = (object: string, ...inside: Norm[]): Norm[] => [
  { k: 'timer', object },
  { k: 'action', verb: 'timer', target: object, who: 'picard', other: null, depth: 1 },
  ...inside,
  { k: 'actionEnd', verb: 'timer', target: object, flags: 0, depth: 1 },
];

describe('the allowances', () => {
  it('advice-timing: forgives an advisor\'s draw and its one line, then compares values again from the next seed', () => {
    const advice: Norm[] = [{ k: 'rng', site: 'advisor', max: 2, value: 1 }, { k: 'say', who: 'data', voice: 'fe0100e6', text: 'Advice.' }];
    const reply = (value: number): Norm[] => [{ k: 'rng', site: 'reply', max: 3, value }];
    const s = run(['advance 30', advice], ['talk 000000 000001', reply(0)], ['seed 7', [{ k: 'seed', seed: 7 }]], ['talk 000000 000001', reply(0)]);
    const t = run(['advance 30', []], ['talk 000000 000001', reply(2)], ['seed 7', [{ k: 'seed', seed: 7 }]], ['talk 000000 000001', reply(1)]);
    const report = diff(s, t);
    expect(report.allowances.get('advice-timing')).toBe(1);
    expect(report.steps.map(d => [d.line, d.rng])).toEqual([[4, ['reply/3: ScummVM 0, TypeScript 1']]]);
  });

  it('advice-timing: does not cover a second line after the advisor\'s, or a line with no draw before it', () => {
    const say = (text: string): Norm => ({ k: 'say', who: 'data', voice: '', text });
    const twice = run(['advance 30', [{ k: 'rng', site: 'advisor', max: 2, value: 1 }, say('Advice.'), say('More.')]]);
    expect(diff(twice, run(['advance 30', []])).steps[0].onlyScummvm).toEqual(['data says "More."']);
    expect(diff(run(['advance 30', [say('Advice.')]]), run(['advance 30', []])).steps[0].onlyScummvm).toEqual(['data says "Advice."']);
  });

  it('phaser-regen-timing: forgives health on the same side of the down threshold, not across it, nor in a step that fires the phaser', () => {
    const at = (text: string, health: number) => run([text, [{ k: 'set', key: 'phaser:rubble.health', value: health }]]);
    const same = diff(at('advance 10', 6), at('advance 10', 7));
    expect(same.clean).toBe(true);
    expect(same.allowances.get('phaser-regen-timing')).toBe(1);
    expect(diff(at('advance 10', 4), at('advance 10', 5)).steps[0].state).toEqual([{ key: 'phaser:rubble.health', scummvm: 4, ts: 5 }]);
    expect(diff(at('use 000000 070103 007003', 6), at('use 000000 070103 007003', 7)).clean).toBe(false);
  });

  it('timer-cadence: pairs a firing with one the other engine made in the next step, comparing its state there', () => {
    const set: Norm = { k: 'set', key: 'obj:lever.state', value: 2 };
    // (ScummVM fires in step 1 and logs the change inside the firing; the sim fires in step 2, and its change shows at step 2's end)
    const s = run(['advance 5', timer('lever', set)], ['advance 5', []]);
    const t = run(['advance 5', []], ['advance 5', [...timer('lever'), set]]);
    const report = diff(s, t);
    expect(report.clean).toBe(true);
    expect(report.allowances.get('timer-cadence')).toBe(1);
  });

  it('advice-timing: does not drop a line by someone the advice entry doesn\'t name as an advisor', () => {
    const other: Norm[] = [{ k: 'rng', site: 'advisor', max: 2, value: 1 }, { k: 'say', who: 'picard', voice: '', text: 'Not advice.' }];
    const r = diff(run(['advance 30', other]), run(['advance 30', []]));
    expect(r.allowances.get('advice-timing')).toBe(1);
    expect(r.steps[0].onlyScummvm).toEqual(['picard says "Not advice."']);
  });

  it('sprite-state: forgives state keys of animated objects when nothing else in the step differs, one count per key', () => {
    const maps = testMaps();
    // (the lever has a lifted rule that plays an animation on it; the rubble has none, and nothing switches it)
    (maps.content.objects.lever.on!.use![0] as { do: unknown[] }).do.push({ alter: { object: 'lever', anim: { play: 1 } } });
    const set = (key: string, value: number): Norm => ({ k: 'set', key, value });
    const go = (s: Norm[], t: Norm[]) => diffTraces(run(['advance 5', s]), run(['advance 5', t]), maps);
    const ok = go([set('obj:lever.state', 3)], []);
    expect(ok.clean).toBe(true);
    expect(ok.allowances.get('sprite-state')).toBe(1);
    expect(go([set('obj:lever.state', 3), set('obj:lever.timer', 4)], []).allowances.get('sprite-state')).toBe(undefined);
    expect(go([set('obj:lever.state', 3), set('obj:picard.state', 1)], []).clean).toBe(false);
    // not over-reaching: an object with no animation, another kind of key, and a step with any other difference
    expect(go([set('obj:rubble.state', 3)], []).clean).toBe(false);
    const say: Norm = { k: 'say', who: 'data', voice: '', text: 'Hi.' };
    const other = go([set('obj:lever.state', 3), say], []);
    expect(other.clean).toBe(false);
    expect(other.steps[0].state).toEqual([{ key: 'obj:lever.state', scummvm: 3, ts: 0 }]);
  });

  it('timer-cadence: forgives a pair\'s timing, not a difference inside it, which shows at the later step', () => {
    const say: Norm = { k: 'say', who: 'data', voice: '', text: 'Tick.' };
    const s = run(['advance 5', timer('lever', say)], ['advance 5', []]);
    const t = run(['advance 5', []], ['advance 5', timer('lever')]);
    const report = diff(s, t);
    expect(report.allowances.get('timer-cadence')).toBe(1);
    expect(report.clean).toBe(false);
    expect(report.steps.map(d => [d.line, d.onlyScummvm, d.onlyTs])).toEqual([
      [2, ['data says "Tick." (in timer lever, paired across lines 1 and 2)'], []],
    ]);
  });

  it('timer-cadence: counts firings, and does not cover a surplus or a firing the other engine never made', () => {
    const extra = diff(run(['advance 5', [...timer('lever'), ...timer('lever')]], ['advance 5', []]), run(['advance 5', []], ['advance 5', timer('lever')]));
    expect(extra.allowances.get('timer-cadence')).toBe(1);
    expect(extra.steps[0].onlyScummvm).toEqual(['timer lever', 'timer lever by picard (depth 1)', 'end of timer lever: flags 0x0 (depth 1)']);
    const never = diff(run(['advance 5', timer('rubble')]), run(['advance 5', []]));
    expect(never.steps[0].onlyScummvm).toEqual(['timer rubble', 'timer rubble by picard (depth 1)', 'end of timer rubble: flags 0x0 (depth 1)']);
  });

  it('idle-timer-firing: drops a surplus firing whose groups all failed, not one that passed, set something or said something', () => {
    const failed = (object: string, ...more: Norm[]): Norm[] => timer(object, { k: 'group', key: `${object}/timer/0`, passed: false }, ...more);
    const idle = diff(run(['advance 5', failed('lever')]), run(['advance 5', []]));
    expect(idle.clean).toBe(true);
    expect(idle.allowances.get('idle-timer-firing')).toBe(1);
    const passed = diff(run(['advance 5', timer('lever', { k: 'group', key: 'lever/timer/0', passed: true })]), run(['advance 5', []]));
    expect(passed.clean).toBe(false);
    const said = diff(run(['advance 5', failed('lever', { k: 'say', who: 'data', voice: '', text: 'Tick.' })]), run(['advance 5', []]));
    expect(said.clean).toBe(false);
    const set = diff(run(['advance 5', failed('lever', { k: 'set', key: 'obj:lever.state', value: 2 })]), run(['advance 5', []]));
    expect(set.clean).toBe(false);
  });

  it('idle-timer-firing: a timer\'s action run again after the sim\'s walk-up matches ScummVM\'s one firing', () => {
    const pass: Norm = { k: 'group', key: 'lever/timer/0', passed: true };
    const failed: Norm[] = timer('lever', { k: 'group', key: 'lever/timer/0', passed: false });
    const rerun: Norm[] = [
      { k: 'action', verb: 'timer', target: 'lever', who: 'picard', other: null, depth: 1 }, pass,
      { k: 'actionEnd', verb: 'timer', target: 'lever', flags: 0, depth: 1 },
    ];
    const r = diff(run(['advance 5', timer('lever', pass)]), run(['advance 5', [...failed, ...rerun]]));
    expect(r.clean).toBe(true);
    expect(r.allowances.get('idle-timer-firing')).toBe(1);
  });

  it('arrival-order: forgives the same members arriving in another order, not a missing member or a different target', () => {
    const arrive = (target: string, ...who: string[]): Norm[] => who.map(w => ({ k: 'action', verb: 'use', target, who: w, other: null, depth: 1 }) as Norm);
    const r = diff(run(['advance 5', arrive('door', 'troi', 'picard', 'data')]), run(['advance 5', arrive('door', 'picard', 'data', 'troi')]));
    expect(r.clean).toBe(true);
    expect(r.allowances.get('arrival-order')).toBe(3);
    expect(diff(run(['advance 5', arrive('door', 'troi', 'picard')]), run(['advance 5', arrive('door', 'picard', 'data')])).clean).toBe(false);
  });

  it('arrival-order: forgives walkers interleaving their action-square uses differently, not a missing arrival', () => {
    const use = (target: string, who: string): Norm[] => [
      { k: 'action', verb: 'use', target, who, other: null, depth: 1 }, { k: 'actionEnd', verb: 'use', target, flags: 0, depth: 1 },
    ];
    const r = diff(run(['advance 5', [...use('sq1', 'npc.a'), ...use('sq2', 'npc.a'), ...use('sq1', 'npc.b')]]), run(['advance 5', [...use('sq1', 'npc.b'), ...use('sq1', 'npc.a'), ...use('sq2', 'npc.a')]]));
    expect(r.clean).toBe(true);
    expect(r.allowances.get('arrival-order')).toBe(3);
    // (a missing arrival)
    expect(diff(run(['advance 5', [...use('sq1', 'npc.a'), ...use('sq1', 'npc.b')]]), run(['advance 5', [...use('sq1', 'npc.b'), ...use('sq2', 'npc.a')]])).clean).toBe(false);
  });

  it('same-tick-screen-timers: forgives a timer only ScummVM ran in a step that left its object\'s screen, not one in a step that stayed', () => {
    const leave: Norm[] = [{ k: 'screen', screen: 'hall' }, { k: 'set', key: 'obj:picard.screen', value: 'hall' }];
    const left = diff(run(['use 000000 070104', [...timer('rubble'), ...leave]]), run(['use 000000 070104', leave]));
    expect(left.clean).toBe(true);
    expect(left.allowances.get('same-tick-screen-timers')).toBe(1);
    expect(diff(run(['use 000000 070104', timer('rubble')]), run(['use 000000 070104', []])).clean).toBe(false);
  });

  it('walk-end-position: forgives where the step\'s actor\'s walk ends, within the talk distance, and nobody else\'s', () => {
    const at = (text: string, key: string, pos: string, more: Norm[] = []) => run([text, [{ k: 'set', key, value: pos }, ...more]]);
    const near = diff(at('walk 000000 070104', 'obj:picard.pos', '1,0'), at('walk 000000 070104', 'obj:picard.pos', '2,0'));
    expect(near.clean).toBe(true);
    expect(near.allowances.get('walk-end-position')).toBe(1);
    // (within 5 cm is the same place, with no allowance)
    expect(diff(at('walk 000000 070104', 'obj:picard.pos', '1,0'), at('walk 000000 070104', 'obj:picard.pos', '1.03,0')).allowances.size).toBe(0);
    expect(diff(at('walk 000000 070104', 'obj:picard.pos', '1,0'), at('walk 000000 070104', 'obj:picard.pos', '4,0')).clean).toBe(false);
    expect(diff(at('advance 2', 'obj:picard.pos', '1,0'), at('advance 2', 'obj:picard.pos', '2,0')).clean).toBe(false);
    expect(diff(at('walk 000000 070104', 'obj:data.pos', '1,0'), at('walk 000000 070104', 'obj:data.pos', '2,0')).clean).toBe(false);
    const moved: Norm[] = [{ k: 'screen', screen: 'hall' }];
    expect(diff(at('walk 000000 070104', 'obj:picard.pos', '1,0', moved), at('walk 000000 070104', 'obj:picard.pos', '2,0', moved)).clean).toBe(false);
  });

  it('walk-end-position: forgives the walk\'s end in a step that goes on to a close-up, where nobody is placed', () => {
    // (startAwayTeam places no one on a close-up, awayteam.cpp:307-309: the team stays where its walk ended)
    const maps = testMaps();
    maps.content.screens.hall.startup = { ...maps.content.screens.hall.startup, closeup: true };
    const at = (pos: string): Norm[] => run(['use 000000 070104', [{ k: 'set', key: 'obj:picard.pos', value: pos }, { k: 'screen', screen: 'hall' }]]);
    const closeup = diffTraces(at('1,0'), at('2,0'), maps);
    expect(closeup.clean).toBe(true);
    expect(closeup.allowances.get('walk-end-position')).toBe(1);
    // (but not someone else, and not past the talk distance)
    expect(diffTraces(at('1,0'), at('4,0'), maps).clean).toBe(false);
    const data = (pos: string): Norm[] => run(['use 000000 070104', [{ k: 'set', key: 'obj:data.pos', value: pos }, { k: 'screen', screen: 'hall' }]]);
    expect(diffTraces(data('1,0'), data('2,0'), maps).clean).toBe(false);
  });

  it('unlifted-triggers: forgives a change to an unlifted trigger triggers.json calls unused or the ship\'s, not to any other', () => {
    const change = (key: string) => run(['advance 2', [{ k: 'set', key, value: true }]]);
    const ok = diff(change('trigger:?64'), run(['advance 2', []]));
    expect(ok.clean).toBe(true);
    expect(ok.allowances.get('unlifted-triggers')).toBe(1);
    expect(diff(change('trigger:?70'), run(['advance 2', []])).clean).toBe(true);
    expect(diff(change('trigger:?99'), run(['advance 2', []])).steps[0].state).toEqual([{ key: 'trigger:?99', scummvm: true, ts: null }]);
    const lifted = diff(run(['advance 2', [{ k: 'set', key: 'trigger:t3', value: false }]]), run(['advance 2', []]));
    expect(lifted.steps[0].state).toEqual([{ key: 'trigger:t3', scummvm: false, ts: true }]);
  });

  it('proximity-threshold: names the cause of a near check passing in one engine only, and still reports it', () => {
    const g = (key: string, passed: boolean): Norm[] => [{ k: 'group', key, passed }];
    const near = diff(run(['use 000000 070103', g('rubble/use/0', true)]), run(['use 000000 070103', g('rubble/use/0', false)]));
    expect(near.clean).toBe(false);
    expect(near.steps[0].explained).toEqual([expect.stringMatching(/^rubble\/use\/0: proximity-threshold/)]);
    const plain = diff(run(['use 000000 070104', g('lever/use/0', true)]), run(['use 000000 070104', g('lever/use/0', false)]));
    expect(plain.steps[0].explained).toEqual([]);
  });

  it('talk-walkup-threshold: names the cause of a walk-up in a talk step, in the shape ScummVM logs it, and nothing else', () => {
    // (a TALK that walks up first returns WALKING, and the talk runs again on arrival: Plan 6 Task 11's horst3.walk)
    const walkUp = (target = 'data', flags = 0x8004): Norm[] => [
      { k: 'action', verb: 'talk', target, who: 'picard', other: null, depth: 1 },
      { k: 'actionEnd', verb: 'talk', target, flags, depth: 1 },
    ];
    const talked = walkUp('data', 0x8000);
    const talk = diff(run(['talk 000000 000001', [...walkUp(), ...talked]]), run(['talk 000000 000001', talked]));
    expect(talk.clean).toBe(false);
    expect(talk.steps[0].explained).toEqual([expect.stringMatching(/^talk data by picard \(depth 1\): talk-walkup-threshold \(only ScummVM/)]);
    const other = diff(run(['talk 000000 000001', talked]), run(['talk 000000 000001', [...walkUp(), ...talked]]));
    expect(other.steps[0].explained).toEqual([expect.stringMatching(/talk-walkup-threshold \(only the sim/)]);
    // not a talk to someone else, a talk that didn't walk, a walk action, or a step that isn't a talk
    const none = (s: Norm[], text = 'talk 000000 000001') => diff(run([text, [...s, ...talked]]), run([text, talked])).steps[0].explained;
    expect(none(walkUp('lever'))).toEqual([]);
    expect(none(walkUp('data', 0x8000))).toEqual([]);
    expect(none([
      { k: 'action', verb: 'walk', target: 'data', who: 'picard', other: null, depth: 1 },
      { k: 'actionEnd', verb: 'walk', target: 'data', flags: 0x8004, depth: 1 },
    ])).toEqual([]);
    expect(none(walkUp(), 'use 000000 000001')).toEqual([]);
  });

  it('alter-stops-walk: names the cause of an action ScummVM ran after an alter moved its walker, and only then', () => {
    const late: Norm[] = [{ k: 'action', verb: 'use', target: 'lever', who: 'data', other: null, depth: 1 }];
    const t = run(['use 000000 070103', [{ k: 'set', key: 'obj:data.pos', value: '1,0' }]]);
    const moved = diff(run(['use 000000 070103', [{ k: 'set', key: 'obj:data.pos', value: '1,0', tag: 'alter' }, ...late]]), t);
    expect(moved.clean).toBe(false);
    expect(moved.steps[0].explained).toEqual([expect.stringMatching(/^use lever by data \(depth 1\): alter-stops-walk/)]);
    const walked = diff(run(['use 000000 070103', [{ k: 'set', key: 'obj:data.pos', value: '1,0' }, ...late]]), t);
    expect(walked.steps[0].explained).toEqual([]);
  });

  it('reports a script\'s action by another actor (carry note 37 is fixed in the engine, so nothing forgives it)', () => {
    const act = (who: string): Norm[] => [{ k: 'action', verb: 'look', target: 'rubble', who, other: null, depth: 2 }];
    const r = diff(run(['use 000000 070104', act('lever')]), run(['use 000000 070104', act('picard')]));
    expect(r.steps[0]).toMatchObject({ onlyScummvm: ['look rubble by lever (depth 2)'], onlyTs: ['look rubble by picard (depth 2)'] });
  });

  it('libm-atan2f: ScummVM\'s angle is taken only for the inputs its trace logged, at that step, and counted by call site', () => {
    // (battle 1's first, measured for Plan 22: ScummVM's atan2f gives 210 units where atan2 rounded gives 209)
    const logged = { ev: 'atan2', step: 966, site: 'combat.cpp:651', s: 0.080446966, c: 0.996758878, angle: 210, rounded: 209 } as const;
    const taken: unknown[] = [];
    let step = 967;
    const oracle = atan2Oracle([logged], () => step, e => taken.push(e));
    const [s, c] = [Math.fround(0.080446966), Math.fround(0.996758878)];
    // (not at another step, nor for another angle or other inputs: each asked before the one it applies to, which takes it)
    expect(oracle(s, c, 209)).toBe(209);
    step = 966;
    expect([oracle(s, c, 208), oracle(s, Math.fround(0.9967), 209), oracle(s, c, 209)]).toEqual([208, 209, 210]);
    expect(taken).toEqual([logged]);
    const end = { ev: 'combatEnd', step: 966, reason: 'cap' } as const;
    expect(diffBattle([logged, end], [logged, end])).toMatchObject({ clean: true, atan2: { 'combat.cpp:651': 1 }, atan2Unused: {} });
    // (one the port never asked for: the stars' drift's call is listed apart; a simulation call's (the camera's too, since
    // M8) is a problem, before the first difference)
    const stars = { ...logged, site: 'combat.cpp:958' };
    expect(diffBattle([stars, end], [end])).toMatchObject({ clean: true, atan2: {}, atan2Unused: { 'combat.cpp:958': 1 }, problems: [] });
    const camera = { ...logged, site: 'combat.cpp:808' };
    expect(diffBattle([camera, end], [end]).problems).toEqual(['step 966: ScummVM\'s atan2f at combat.cpp:808 (a simulation call) was never asked by the port']);
    expect(diffBattle([logged, end], [end])).toMatchObject({
      clean: true, atan2: {}, atan2Unused: { 'combat.cpp:651': 1 },
      problems: ['step 966: ScummVM\'s atan2f at combat.cpp:651 (a simulation call) was never asked by the port'],
    });
    const late = { ev: 'roll', step: 900, site: 'ai.cpp:1', n: 3, value: 1 } as const;
    expect(diffBattle([late, logged, end], [{ ...late, value: 2 }, end]).problems).toEqual([]);
    // (two calls with the same inputs at the same step: each taken once, and counted twice)
    const twice: unknown[] = [];
    step = 966;
    const again = atan2Oracle([logged, logged], () => step, e => twice.push(e));
    expect([again(s, c, 209), again(s, c, 209), again(s, c, 209)]).toEqual([210, 210, 209]);
    expect(twice).toEqual([logged, logged]);
    expect(diffBattle([logged, logged, end], [logged, logged, end])).toMatchObject({ atan2: { 'combat.cpp:651': 2 }, atan2Unused: {} });
    expect(diffBattle([logged, logged, end], [logged, end])).toMatchObject({ atan2: { 'combat.cpp:651': 1 }, atan2Unused: { 'combat.cpp:651': 1 } });
  });

  it('lists every allowance in docs/tracediff.md, and tests every one that forgives or explains', () => {
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/tracediff.md', import.meta.url)), 'utf8');
    const tests = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(ALLOWANCES).toHaveLength(20);
    for (const a of ALLOWANCES) {
      expect(docs, a.id).toContain(`| \`${a.id}\` |`);
      if (a.kind === 'forgive' || a.kind === 'explain') expect(tests, a.id).toContain(`it('${a.id}: `);
    }
  });
});
