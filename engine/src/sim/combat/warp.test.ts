// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { UNIT_FUSION, UNIT_IMPULSE, UNIT_MATTER_ANTIMATTER, UNIT_POWER_GRID, UNIT_WARP } from '../shipSystems';
import { miniBattle, miniBattleContext, recordingSeams } from '../../testing/combat';
import { v3 } from './math';
import { ASTROGATION_EXIT, outputPercent, retreat, unitsPercent, warpAway } from './warp';
import { NO_EXIT } from './types';

/**
 * miniCombat's Enterprise (testing/combat.ts): every unit 100 of 100 but the grid (32), 0 of 3000; warp 27-28,
 * impulse 29-31, fusion 33, matter/antimatter 34. The chodak is at (1000, 0, 5000).
 */
function battle(astro: [number, number, number] = [0, 0, 0]) {
  const log: string[] = [];
  const warps: number[][] = [];
  const ctx = miniBattleContext(recordingSeams(log, {
    astrogationPosition: () => astro,
    scriptedWarp: (_c, _b, code, speed) => { warps.push([code, speed]); },
  }));
  const { b } = miniBattle({ ctx });
  b.cues.length = 0;
  log.length = 0;
  return { ctx, b, e: b.ships[0]!, chodak: b.ships[1]!, log, warps };
}
/** Warp engines and the grid able to warp: 1000 of 1000 each, and the grid full. */
function ready(e: ReturnType<typeof battle>['e']): void {
  for (const i of [27, 28]) Object.assign(e.systems.units[i]!, { current: 1000, max: 1000 });
  e.systems.units[32]!.current = 3000;
}

describe('outputPercent and unitsPercent (ai.cpp:205-217, 269-277)', () => {
  it('sum the current and max of units by type, or by index, rounded halves away from zero; 0 when either sum is', () => {
    const { ctx, e } = battle();
    const units = e.systems.units;
    // (the grid's 0 of 3000 and the reactors' 200 of 200: 200 * 100 / 3200 = 6.25)
    expect(outputPercent(ctx.enterpriseUnits, units, [UNIT_POWER_GRID, UNIT_FUSION, UNIT_MATTER_ANTIMATTER])).toBe(6);
    expect(outputPercent(ctx.enterpriseUnits, units, [UNIT_WARP, UNIT_IMPULSE])).toBe(100);
    // (450 of 500, then 150 of 500)
    units[27]!.current = 50;
    expect(outputPercent(ctx.enterpriseUnits, units, [UNIT_WARP, UNIT_IMPULSE])).toBe(90);
    units[29]!.current = units[30]!.current = units[31]!.current = 0;
    expect(outputPercent(ctx.enterpriseUnits, units, [UNIT_WARP, UNIT_IMPULSE])).toBe(30);
    // (units 27-30: 150 of 400 is 37.5, rounded up; units past the ship's last are left out; none at all is 0)
    expect(unitsPercent(units, 27, 30)).toBe(38);
    expect(unitsPercent(units, 34, 40)).toBe(100);
    expect(unitsPercent(units, 29, 31)).toBe(0);
    expect(outputPercent(ctx.enterpriseUnits, units, [99])).toBe(0);
  });
});

describe('Combat::warpAway (ai.cpp:222-267)', () => {
  it('fails without both warp engines at 200 and a quarter of the reactors and drives, saying why', () => {
    const { ctx, b, e, log } = battle();
    warpAway(ctx, b, e);
    expect(e.log).toEqual(['Warp engage failed.', 'Combined reactor output inadequate.']);
    expect(b.cues).toEqual([{ cue: 0x81, delay: 1000, interrupt: false }, { cue: 0x82, delay: 2000, interrupt: true }]);
    expect([log, e.pos, b.console.warped]).toEqual([[], v3(), false]);
  });

  it('jumps as far as the engines and reactors give, along the heading, draining them; far from every enemy, red alert is over', () => {
    const { ctx, b, e, log } = battle();
    ready(e);
    b.console.redAlert = true;
    warpAway(ctx, b, e);
    // (s = 1000 * 30 + 1000 * 30 + 100 * 100 + 100 * 300 = 100000; d = s + s / 4)
    expect(e.pos).toEqual(v3(0, 125000, 0));
    expect([27, 28, 29, 32, 33, 34].map(i => e.systems.units[i]!.current)).toEqual([0, 0, 100, 0, 0, 0]);
    expect([b.console.warped, b.console.redAlert, log, b.cues]).toEqual([true, false, ['showWarp'], [{ cue: 0x71, delay: 0, interrupt: false }]]);
    expect(e.log).toEqual([]);
  });

  it('jumps along a quarter turn\'s heading, and stays at red alert within 110000 of an enemy', () => {
    const { ctx, b, e, chodak } = battle();
    ready(e);
    e.angles[0] = 0x1000;
    chodak.pos = v3(120000, 0, 0);
    b.console.redAlert = true;
    warpAway(ctx, b, e);
    // (sinf and cosf of (float)M_PI / 2: 1 and -4.371139e-8)
    expect(e.pos).toEqual(v3(125000, -0.005463923327624798, 0));
    expect(b.console.redAlert).toBe(true);
  });

  it('takes only the Enterprise', () => {
    const { ctx, b, chodak, log } = battle();
    warpAway(ctx, b, chodak);
    expect([chodak.pos, chodak.log, b.cues, log]).toEqual([v3(1000, 0, 5000), [], [], []]);
  });
});

describe('Combat::retreat (ai.cpp:279-300)', () => {
  it('fails at red alert, or with units 15-19 or the warp engines short, as it checks the other ships\' units (ai.cpp:281-283)', () => {
    const { ctx, b, e, warps } = battle();
    ready(e);
    b.console.redAlert = true;
    retreat(ctx, b, e);
    expect(e.log).toEqual(['Warp engage failed.']);
    b.console.redAlert = false;
    // (phasers 15 and 16 down: half of units 15-16 is the bar, though they're the Enterprise's phasers, not its engines)
    e.systems.units[15]!.current = e.systems.units[16]!.current = 0;
    retreat(ctx, b, e);
    e.systems.units[15]!.current = e.systems.units[16]!.current = 100;
    e.systems.units[28]!.current = 749;
    retreat(ctx, b, e);
    expect(e.log).toEqual(['Warp engage failed.', 'Warp engage failed.', 'Warp engage failed.']);
    expect(b.cues.map(c => c.cue)).toEqual([0x81, 0x82, 0x81, 0x82, 0x81, 0x82]);
    expect([warps, b.exitCode, b.console.warped]).toEqual([[], NO_EXIT, false]);
  });

  it('warps astrogation to the nearer starbase and leaves the battle for it', () => {
    // (from (10, 80, 100): 6698 to (38, 63, 25), 249 to (3, 90, 110): the second, scripted warp 1, at 0x2da)
    const near = battle([10, 80, 100]);
    ready(near.e);
    retreat(near.ctx, near.b, near.e);
    expect([near.warps, near.b.exitCode, near.b.console.warped, near.b.console.redAlert, near.e.log]).toEqual([[[1, 0x2da]], ASTROGATION_EXIT, true, false, []]);
    // (from (0, 0, 0): 6038 against 20209, the first)
    const far = battle();
    ready(far.e);
    retreat(far.ctx, far.b, far.e);
    expect(far.warps).toEqual([[0, 0x2da]]);
  });
});

describe('warpAway and retreat at their edges', () => {
  it('percentages: a unit with nothing to its max counts as 0, not a division by zero', () => {
    const { e } = battle();
    Object.assign(e.systems.units[30]!, { current: 5, max: 0 });
    expect(unitsPercent(e.systems.units, 30, 30)).toBe(0);
  });

  it('warpAway refuses below a quarter of the reactors or the drives, or an engine below 200, and goes at exactly those', () => {
    const fails = (set: (e: ReturnType<typeof battle>['e']) => void) => {
      const t = battle();
      ready(t.e);
      set(t.e);
      warpAway(t.ctx, t.b, t.e);
      return t.b.console.warped ? t.e.log : t.e.log[0];
    };
    // (the reactors 24.47% and 24.5%, rounded to 24 and 25: 783 and 784 of 3200, the grid's 583 and 584 and the two reactors' 200)
    expect(fails(e => { e.systems.units[32]!.current = 583; })).toBe('Warp engage failed.');
    expect(fails(e => { e.systems.units[32]!.current = 584; })).toEqual([]);
    // (the drives 24% and 25%: the warp engines 1000 of 1000 each as ready leaves them, and the impulse units' 300 of
    // 300 but one's max raised: 2300 of 9500 is 24.2%, of 9200 is 25%)
    expect(fails(e => { e.systems.units[29]!.max = 7300; })).toBe('Warp engage failed.');
    expect(fails(e => { e.systems.units[29]!.max = 7000; })).toEqual([]);
    expect(fails(e => { e.systems.units[27]!.current = 199; })).toBe('Warp engage failed.');
    expect(fails(e => { e.systems.units[28]!.current = 199; })).toBe('Warp engage failed.');
    expect(fails(e => { e.systems.units[27]!.current = e.systems.units[28]!.current = 200; })).toEqual([]);
  });

  it('warpAway stays at red alert with an enemy at exactly 110000 (ai.cpp:262)', () => {
    const { ctx, b, e, chodak } = battle();
    ready(e);
    chodak.pos = v3(0, 235000, 0);
    b.console.redAlert = true;
    warpAway(ctx, b, e);
    expect([e.pos, b.console.redAlert]).toEqual([v3(0, 125000, 0), true]);
  });

  it('retreat refuses below three quarters of units 17-19, or warp engine 27 below 750', () => {
    const { ctx, b, e, warps } = battle();
    ready(e);
    // (222 of 300 is 74%)
    e.systems.units[17]!.current = 22;
    retreat(ctx, b, e);
    e.systems.units[17]!.current = 100;
    e.systems.units[27]!.current = 749;
    retreat(ctx, b, e);
    expect([e.log, warps]).toEqual([['Warp engage failed.', 'Warp engage failed.'], []]);
    // (225 of 300 is 75%, and 750: it goes)
    e.systems.units[17]!.current = 25;
    e.systems.units[27]!.current = 750;
    retreat(ctx, b, e);
    expect([e.log.length, warps]).toEqual([2, [[0, 0x2da]]]);
  });

  it('retreat takes the first starbase by one (42725 against 42726, from (2, 265, 0))', () => {
    const { ctx, b, e, warps } = battle([2, 265, 0]);
    ready(e);
    retreat(ctx, b, e);
    expect(warps).toEqual([[0, 0x2da]]);
  });
});
