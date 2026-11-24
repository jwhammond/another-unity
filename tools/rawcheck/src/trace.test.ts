// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { combatSim } from '@another-unity/engine';
import { checkCombatRolls, checkRng, checkTrace, parseTrace } from './trace';

const begin = { seq: 0, ev: 'begin', version: 1, engine: 'scummvm', seed: 42 };
const action = { seq: 1, ev: 'action', verb: 'look', target: '070103', who: '000000', other: 'ffffff', x: 65535, y: 65535, depth: 1 };
const group = { seq: 2, ev: 'group', list: 'o_070103#/look_entries', index: 0, passed: true, flags: 0 };
const obj = { seq: 3, ev: 'obj', id: '070103', field: 'state', from: 0, to: 1 };
const end = { seq: 4, ev: 'end' };
const text = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

describe('parseTrace and checkTrace', () => {
  it('accept a well-formed trace', () => {
    const { events, problems } = parseTrace(text([begin, action, group, obj, end]));
    expect(problems).toEqual([]);
    expect(checkTrace(events)).toEqual([]);
  });

  it('accept the away-mission state: z, sprite_id, beam, pendingHail and newWarpMovie', () => {
    const { problems } = parseTrace(text([
      { ...obj, field: 'z', from: 0, to: 5 },
      { ...obj, field: 'sprite_id', from: 3, to: 4 },
      { seq: 3, ev: 'global', key: 'beam', from: '0,0', to: '7,1' },
      { seq: 3, ev: 'global', key: 'pendingHail', from: '000000,0,0,255', to: '070100,5,2,1' },
      { seq: 3, ev: 'global', key: 'newWarpMovie', from: false, to: true },
    ]));
    expect(problems).toEqual([]);
  });

  it('accept a load', () => {
    const { events, problems } = parseTrace(text([begin, { seq: 1, ev: 'load' }, { ...end, seq: 2 }]));
    expect(problems).toEqual([]);
    expect(checkTrace(events)).toEqual([]);
  });

  it('report a line that isn\'t JSON, or isn\'t an event', () => {
    const { problems } = parseTrace('{"seq":0,"ev":"nope"}\nnot json\n');
    expect(problems[0]).toMatch(/^line 1: /);
    expect(problems[1]).toBe('line 2: not JSON');
  });

  it('reject a list path the tracer couldn\'t resolve', () => {
    const { problems } = parseTrace(text([{ ...group, list: '?' }]));
    expect(problems[0]).toMatch(/^line 1: list: /);
  });

  it('report gaps, a missing begin or end, no-op changes and errors', () => {
    const { events } = parseTrace(text([
      { ...action, seq: 0 }, { ...obj, seq: 2, from: 1, to: 1 }, { seq: 3, ev: 'error', what: 'stuck' },
    ]));
    expect(checkTrace(events)).toEqual([
      'event 1: seq 2',
      'event 2: seq 3',
      "the first event isn't begin",
      "the last event isn't end",
      "seq 2: 070103.state didn't change",
      'seq 3: error: stuck',
    ]);
  });
});

describe('checkRng', () => {
  const rng = (seq: number, value: number) => ({ seq, ev: 'rng', site: 'skill', max: 255, value });
  const traceOf = (seed: number, ...rest: object[]) => parseTrace(text([{ ...begin, seed }, ...rest])).events;

  it('accepts the draws the TypeScript Rng makes from the same seed', () => {
    // (Plan 1's Rng test: seed 12345 gives 186, 111, 189 for max 255)
    expect(checkRng(traceOf(12345, rng(1, 186), rng(2, 111), rng(3, 189)))).toEqual([]);
  });

  it('reports a draw that differs', () => {
    expect(checkRng(traceOf(12345, rng(1, 187)))).toEqual(['seq 1: skill drew 187, the TypeScript Rng 186']);
  });

  it('starts again at a reseed', () => {
    expect(checkRng(traceOf(1, { seq: 1, ev: 'seed', seed: 12345 }, rng(2, 186)))).toEqual([]);
  });
});

describe('a battle\'s events (docs/trace-format.md, "Space combat")', () => {
  /** A made-up battle: its start, its seed 1234, the ships, two draws, a snapshot after them and the end. */
  function battle(): object[] {
    const r = combatSim.newRandom(1234);
    const a = combatSim.rnd(r, 3);
    const b = combatSim.nextRandom(r);
    const ship = { index: 0, pos: [1.5, -2, 3e3], velocity: [0, 0, 0], angles: [0, 16383, 8], speed: 0.25, condition: 100, flags: 56832, destroyed: false, removed: false, target: -1, engaged: true, removeTime: 0, units: [[800, 800, 800, 0, 0]], pool: 1625, torpedoes: 275 };
    return [
      { ev: 'combat', scenario: 1, difficulty: 0, delegate: false, lastDifficulty: 255, astrogation: [3, -4, 5], enterprise: { units: [[600, 600, 800, 0, 0, 2141, 3141]], pool: 1625, torpedoes: 275, matterAntimatterOutput: 0, fusionOutput: 0, lastReactorTick: 2141, lastTick: 2141 }, objects: [{ id: '100100', active: true, state: 0 }] },
      { ev: 'rng', site: 'combatSeed', max: 0x7fffffff, value: 1234 },
      { ev: 'ships', now: 3212, ships: [{ index: 0, type: 2, id: '100100' }] },
      { ev: 'roll', step: 1, site: 'ai.cpp:367', n: 3, value: a },
      { ev: 'roll', step: 1, site: 'damage.cpp:431', n: -1, value: b },
      { ev: 'hails', step: 1, site: 'damage.cpp:672', type: 255 },
      { ev: 'hailsEnd', step: 1, result: false, type: 255, exit: 65535, redAlert: true, removeTimes: [0] },
      { ev: 'standDown', step: 1, site: 'tactical.cpp:486' },
      { ev: 'atan2', step: 1, site: 'combat.cpp:651', s: 0.080446966, c: 0.996758878, angle: 210, rounded: 209 },
      { ev: 'input', step: 1, line: 'steer 1 0 0 1' },
      { ev: 'warp', step: 1, wait: 2999 },
      { ev: 'snap', step: 1, now: 3278, exit: 65535, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: false, random: r.state, camera: { pos: [0, -84.3949432, -594.034912], axes: [1, 0, 0, 0, 0.990058243, -0.140657991, 0, 0.140657991, 0.990058243], view: 0 }, ships: [ship], torpedoes: [{ slot: 0, pos: [0, 0, 0], angles: [0, 0, 0], shooter: 0, target: -1, expiry: 9000 }] },
      { ev: 'leave', step: 1, code: 510 },
      { ev: 'combatEnd', step: 1, reason: 'leave' },
    ];
  }
  const numbered = (events: object[]) => [begin, ...events, { ev: 'end' }].map((e, seq) => ({ ...e, seq }));

  it('parses, and its draws replay from the seed, each snapshot holding the generator\'s state', () => {
    const { events, problems } = parseTrace(text(numbered(battle())));
    expect(problems).toEqual([]);
    expect(checkTrace(events)).toEqual([]);
    expect(checkCombatRolls(events)).toEqual([]);
  });

  it('finds a draw with the wrong value, a draw the trace missed (the state is off), and a draw before the seed', () => {
    const first = battle()[3] as { value: number };
    const wrong = battle().map((e, i) => (i === 3 ? { ...first, value: first.value + 1 } : e));
    expect(checkCombatRolls(parseTrace(text(numbered(wrong))).events)).toEqual([`seq 4: ai.cpp:367 drew ${first.value + 1}, random.ts ${first.value}`]);
    const missed = battle().filter(e => !('site' in e && e.site === 'damage.cpp:431'));
    expect(checkCombatRolls(parseTrace(text(numbered(missed))).events)[0]).toMatch(/^seq 11: step 1's state is \d+, the draws give \d+$/);
    const unseeded = battle().filter(e => !('site' in e && e.site === 'combatSeed'));
    expect(checkCombatRolls(parseTrace(text(numbered(unseeded))).events)[0]).toBe('seq 3: a roll before the battle\'s seed');
  });

  it('replays each battle from its own seed: two battles are clean, and a second battle\'s roll before its seed is one', () => {
    expect(checkCombatRolls(parseTrace(text(numbered([...battle(), ...battle()]))).events)).toEqual([]);
    // (seq 15 is the second battle's combat event: without its seed, its first roll can't follow the first battle's draws)
    const second = battle().filter(e => !('site' in e && e.site === 'combatSeed'));
    expect(checkCombatRolls(parseTrace(text(numbered([...battle(), ...second]))).events)[0]).toBe('seq 17: a roll before the battle\'s seed');
  });

  it('refuses a site that isn\'t file.cpp:line, a reason it doesn\'t know, and a NaN (the export writes null)', () => {
    const bad = battle();
    bad[3] = { ...bad[3], site: 'ai.cpp' };
    bad[13] = { ev: 'combatEnd', step: 1, reason: 'peace' };
    (bad[11] as { ships: { speed: unknown }[] }).ships[0]!.speed = null;
    expect(parseTrace(text(numbered(bad))).problems.map(p => p.split(':')[0])).toEqual(['line 5', 'line 13', 'line 15']);
  });
});
