// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../../content/tactics';
import { miniBattle, miniBattleContext, tacticScript } from '../../testing/combat';
import { assembleTactics, type TacticArg } from '../../testing/tactics';
import { compareRelation, condition, speedSubject, subjectShip } from './conditions';
import { v3 } from './math';
import { newRandom } from './random';
import { tokenArg } from './script';
import { SHIP_STATE, type BattleContext } from './types';

const FOE = TACTIC.foe, FRIEND = TACTIC.friend;
/** One WHEN per case, each labelled: tests look them up by name. */
const CASES: Record<string, [number, TacticArg[]]> = {
  fired: [TACTIC.fired, []],
  delta: [TACTIC.delta, [291, 0]],
  'near <6000': [TACTIC.proximity, [4, { float: 6000 }]],
  'near >6000': [TACTIC.proximity, [1, { float: 6000 }]],
  'near !=': [TACTIC.proximity, [6, { float: 6000 }]],
  'speed >=100': [TACTIC.speed, [100, 0, 2]],
  'speed >foe': [TACTIC.speed, [0, FOE, 1]],
  'speed >-foe': [TACTIC.speed, [0, -FOE, 1]],
  'speed !=': [TACTIC.speed, [100, 0, 6]],
  'way <1000': [TACTIC.way, [6, 0, { float: 1000 }, 4]],
  'way x': [TACTIC.way, [1, 0, { float: 1000 }, 4]],
  'way y==400': [TACTIC.way, [2, 0, { float: 400 }, 3]],
  'way y==400.001': [TACTIC.way, [2, 0, { float: 400.001 }, 3]],
  'way y==400.0004': [TACTIC.way, [2, 0, { float: 400.0004 }, 3]],
  'way y!=400': [TACTIC.way, [2, 0, { float: 400 }, 6]],
  'way y!=400.0004': [TACTIC.way, [2, 0, { float: 400.0004 }, 6]],
  'way max>=400': [TACTIC.way, [4, 0, { float: 400 }, 2]],
  'way min<1': [TACTIC.way, [5, 0, { float: 1 }, 4]],
  'heading >100': [TACTIC.heading, [1, TACTIC.heading, 0, 100]],
  'heading <100': [TACTIC.heading, [4, TACTIC.heading, 0, 100]],
  'heading <foe': [TACTIC.heading, [4, TACTIC.heading, FOE, 0]],
  'heading >-foe': [TACTIC.heading, [1, TACTIC.heading, -FOE, 0]],
  'climb ==friend': [TACTIC.climb, [3, TACTIC.climb, FRIEND, 0]],
  'climb >=40 foe': [TACTIC.climb, [2, TACTIC.climb, FOE, 40]],
  'heading bad axis': [TACTIC.heading, [4, 0xe, 0, 100]],
  'heading !=': [TACTIC.heading, [6, TACTIC.heading, 0, 100]],
  'y <4000': [TACTIC.pos, [2, 0, { float: 4000 }, 4]],
  'z <foe': [TACTIC.pos, [3, FOE, { float: 0 }, 4]],
  'z >-foe': [TACTIC.pos, [3, -FOE, { float: 0 }, 1]],
  'pos bad axis': [TACTIC.pos, [4, 0, { float: 1 }, 4]],
  'unit 13 damage==0': [TACTIC.system, [13, 0, 0, 3]],
  'unit 13 target==100': [TACTIC.system, [13, 1, 100, 3]],
  'unit 13 target==2^24': [TACTIC.system, [13, 1, 16777216, 3]],
  'unit 35': [TACTIC.system, [35, 0, 0, 3]],
  'unit -1': [TACTIC.system, [-1, 0, 0, 3]],
  random: [TACTIC.random, [3]],
  unknown: [0x30, []],
};
const FILE = assembleTactics([
  { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] },
  ...Object.entries(CASES).flatMap(([label, [opcode, args]]) => [{ label }, { cls: TOKEN.when, opcode, args }]),
]);
const at = (name: string) => FILE.labels[name]!;

/** miniCombat's battle: the Enterprise at the origin heading 0, the chodak at (1000, 0, 5000) heading 180 (8192), 5099 off. */
function battle() {
  const sites: string[] = [];
  const ctx: BattleContext = { ...miniBattleContext(), onDraw: (site, n, value) => { sites.push(`${site} ${n} ${value}`); } };
  const { b } = miniBattle({ ctx });
  const e = b.ships[0]!;
  const s = tacticScript(FILE.bin);
  const test = (name: string) => condition(ctx, b, s, e, at(name));
  return { ctx, b, e, chodak: b.ships[1]!, s, test, sites };
}

describe('compare, subjectShip and speedSubject (tactics.cpp:558-610)', () => {
  it('compare by relations 1-6, and nothing else', () => {
    expect([1, 2, 3, 4, 5, 6, 0, 7].map(r => compareRelation(r, 2, 2))).toEqual([false, true, true, false, true, false, false, false]);
    expect([1, 2, 3, 4, 5, 6].map(r => compareRelation(r, 1, 2))).toEqual([false, false, false, true, true, true]);
    // (compare takes floats: 2^24 + 1 rounds to 2^24)
    expect([3, 6].map(r => compareRelation(r, 16777217, 16777216))).toEqual([true, false]);
  });

  it('take the ship itself for FRIEND, its target for FOE or TARGET, either sign; a speed truncated, negated for a negative subject, never -0', () => {
    const { b, e, chodak } = battle();
    expect([subjectShip(b, e, FRIEND), subjectShip(b, e, -FOE), subjectShip(b, e, TACTIC.target), subjectShip(b, e, 7)]).toEqual([e, chodak, chodak, null]);
    e.target = null;
    expect(subjectShip(b, e, FOE)).toBeNull();
    chodak.targetSpeed = 200.7;
    expect([speedSubject(b, chodak, FRIEND, 5), speedSubject(b, chodak, -FRIEND, 5), speedSubject(b, chodak, 0, -5), speedSubject(b, e, FOE, 5)]).toEqual([200, -200, -5, 0]);
    expect(Object.is(speedSubject(b, e, -FOE, 5), 0)).toBe(true);
  });
});

describe('Combat::condition (tactics.cpp:612-719)', () => {
  it('FIRED: whether the ship has been fired on', () => {
    const { e, test } = battle();
    expect(test('fired')).toBe(false);
    e.flags |= SHIP_STATE.firedUpon;
    expect(test('fired')).toBe(true);
  });

  it('DELTA: sets its deadline in the token, in the original\'s 291 ticks a second, and clears it once due', () => {
    const { b, s, test } = battle();
    // (_now 10000 ms is tick 2910: the deadline 291 on is 3201)
    expect(test('delta')).toBe(false);
    expect(tokenArg(s, at('delta'), 1)).toBe(3201);
    b.now = 10996;
    expect(test('delta')).toBe(false);
    b.now = 11000;
    expect(test('delta')).toBe(true);
    expect(tokenArg(s, at('delta'), 1)).toBe(0);
    expect(test('delta')).toBe(false);
    expect(tokenArg(s, at('delta'), 1)).toBe(3201 + 291);
  });

  it('PROXIMITY: the distance to the target (5099), and with none, infinitely far', () => {
    const { e, test } = battle();
    expect(['near <6000', 'near >6000', 'near !='].map(test)).toEqual([true, false, false]);
    e.target = null;
    expect(['near <6000', 'near >6000'].map(test)).toEqual([false, true]);
  });

  it('SPEED: the target speed against a literal or the subject\'s, relations 1-5 only', () => {
    const { e, chodak, test } = battle();
    e.targetSpeed = 150;
    chodak.targetSpeed = 200.7;
    expect(['speed >=100', 'speed >foe', 'speed >-foe', 'speed !='].map(test)).toEqual([true, false, true, false]);
  });

  it('WAY: the waypoint\'s distance, by y, the largest, the smallest or all, within 0.0005 for == and !=; X compares nothing', () => {
    const { e, test } = battle();
    const all = ['way <1000', 'way x', 'way y==400', 'way y==400.001', 'way y==400.0004', 'way y!=400', 'way y!=400.0004', 'way max>=400', 'way min<1'];
    expect(all.map(test)).toEqual(all.map(() => false));
    // (from (0, 0, 0) to (300, 400, 0): 500 away, 400 in y, the smallest 0)
    e.waypoint = v3(300, 400, 0);
    e.waypointActive = true;
    expect(all.map(test)).toEqual([true, false, true, false, true, false, false, true, true]);
  });

  it('HEADING, CLIMB and BANK: an angle against a literal or the subject\'s (negated for a negative one), relations 1-5 only', () => {
    const { e, test } = battle();
    e.angles = [0, 30, 0];
    // (a literal wins over the subject: 30 >= 40, not the chodak's climb 0)
    expect(['heading >100', 'heading <100', 'heading <foe', 'heading >-foe', 'climb ==friend', 'climb >=40 foe', 'heading bad axis', 'heading !='].map(test))
      .toEqual([false, true, true, true, true, false, false, false]);
  });

  it('POS: a coordinate against a literal or the subject\'s, negated for a negative one', () => {
    const { test } = battle();
    expect(['y <4000', 'z <foe', 'z >-foe', 'pos bad axis'].map(test)).toEqual([true, true, true, false]);
  });

  it('SYSTEM: a unit\'s damage or target, and nothing for a unit the ship hasn\'t', () => {
    const { e, test } = battle();
    expect(['unit 13 damage==0', 'unit 13 target==100', 'unit 35', 'unit -1'].map(test)).toEqual([true, true, false, false]);
    // (compared as floats, tactics.cpp:558: 2^24 + 1 is 2^24)
    e.systems.units[13]!.target = 16777217;
    expect(test('unit 13 target==2^24')).toBe(true);
    e.systems.units[13]!.damage = 4;
    expect(test('unit 13 damage==0')).toBe(false);
  });

  it('RANDOM: a roll of rnd(n) that is 1, rolled every time it is tested (tactics.cpp:715); anything else is false', () => {
    const { b, test, sites } = battle();
    b.random = newRandom(1);
    // (seed 1's low bytes 198, 126, 129, 107: rnd(3) = (byte * 3 + 0x80) >> 8 is 2, 1, 2, 1)
    expect(['random', 'random', 'random', 'random', 'unknown'].map(test)).toEqual([false, true, false, true, false]);
    expect(sites).toEqual(['tactics.cpp:715 3 2', 'tactics.cpp:715 3 1', 'tactics.cpp:715 3 2', 'tactics.cpp:715 3 1']);
  });
});
