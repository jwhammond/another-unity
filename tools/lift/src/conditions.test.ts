// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftCondition } from './conditions';
import { conversationOwner, objectOwner, type LiftCtx } from './context';
import type { ConditionBlockT } from './conditions';
import { cond, NONE } from './testing/mini';
import { testCtx } from './testing/ctx';

function lift(ctx: LiftCtx, fields: Record<string, unknown>, ownerId = '070103') {
  const owner = objectOwner(ctx, ctx.raw.objects.get(ownerId)!);
  return liftCondition(cond(fields) as unknown as ConditionBlockT, ctx, owner, `o_${ownerId}#/use_entries/0/0`);
}

describe('liftCondition', () => {
  it('lifts who, distance (at the owner\'s row) and skill', () => {
    const ctx = testCtx();
    const dist = ctx.markers.projection('horst3.s01')!.distance(40, 336);
    expect(lift(ctx, { WhoCan: '000002', how_close_dist: 40, skill_check: 0x0300 })).toEqual({ who: 'data', near: { dist, px: 40 }, skill: 0x300 });
    expect(ctx.problems.errors).toEqual([]);
  });

  it('lifts the other object, and leaves out anyone', () => {
    const ctx = testCtx();
    expect(lift(ctx, { target: 'fffffe', WhoCan: '000010' })).toEqual({ other: '$none' });
    expect(lift(ctx, { target: '007001', skill_check: 0 })).toEqual({ other: 'tricorder' });
  });

  it('walks to an explicit point, measured at that point\'s row', () => {
    const ctx = testCtx();
    const dist = ctx.markers.projection('horst3.s01')!.distance(30, 340);
    expect(lift(ctx, { how_close_dist: 30, how_close_x: 250, how_close_y: 340 })).toEqual({ near: { dist, at: 'p250_340', px: 30 } });
    expect(ctx.markers.screenMarkers('horst3.s01').p250_340).toBeDefined();
  });

  it('lifts both counters', () => {
    const ctx = testCtx();
    expect(lift(ctx, { counter_when: 1, counter_value: 3 })).toEqual({ counter: { mode: 'when', value: 3 } });
    expect(lift(ctx, { counter_when: 0, counter_value: 2 })).toEqual({ counter: { mode: 'until', value: 2 } });
  });

  it('lifts every kind of check', () => {
    const ctx = testCtx();
    const c = lift(ctx, {
      condition: ['070103', '000002', '007001', NONE],
      check_state: [1, 255, 255, 255],
      check_status: [255, 1, 1, 255],
      check_x: [208, 65535, 65535, 100],
      check_y: [336, 65535, 65535, 380],
      check_screen: [1, 254, 255, 255],
    });
    expect(c.checks).toEqual([
      { object: 'horst3.rubble', state: 1, at: 'p208_336', screen: 'horst3.s01' },
      { object: 'data', status: 'inTeam', passIfInactive: true },
      { object: 'tricorder', status: 'inInventory' },
      { emptyAt: 'p100_380' },
    ]);
    expect(lift(ctx, { condition: ['000010', '007001', NONE, NONE], check_status: [1, 0, 255, 255] }).checks).toEqual([
      { object: '$anyone', status: 'inTeam' },
      { object: 'tricorder', status: 'notInInventory' },
    ]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('fails on a universe check, and on a position in a list that can run on any screen', () => {
    const ctx = testCtx();
    lift(ctx, { condition: ['070103', NONE, NONE, NONE], check_univ_x: [1, 65535, 65535, 65535] });
    lift(ctx, { how_close_dist: 30, how_close_x: 250, how_close_y: 340 }, '000000');
    expect(ctx.problems.errors).toEqual([
      'o_070103#/use_entries/0/0: check 0 compares positions in space, which the content model can\'t express',
      'o_000000#/use_entries/0/0: refers to the current screen, but o_000000\'s lists can run on any screen (give it a screen in overrides/contexts.yaml)',
    ]);
  });

  it('skips a check on an object missing from the export, with a warning, as the original does', () => {
    const ctx = testCtx();
    expect(lift(ctx, { condition: ['02041a', '000002', NONE, NONE], check_status: [1, 1, 255, 255] }).checks)
      .toEqual([{ object: 'data', status: 'inTeam' }]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(1);
    expect(ctx.problems.warnings[0]).toContain('object.cpp:1192-1197');
  });

  it('skips a missing object before looking at its universe position', () => {
    const ctx = testCtx();
    expect(lift(ctx, { condition: ['02041a', NONE, NONE, NONE], check_univ_x: [1, 65535, 65535, 65535] })).toEqual({});
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(1);
  });

  it('ignores universe fields unless the check names an object and sets x', () => {
    const ctx = testCtx();
    expect(lift(ctx, { condition: [NONE, NONE, NONE, NONE], check_univ_x: [1, 1, 1, 1] })).toEqual({});
    expect(lift(ctx, { condition: ['000002', NONE, NONE, NONE], check_univ_y: [1, 65535, 65535, 65535] }).checks)
      .toEqual([{ object: 'data' }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('checks positions on the current screen in a world\'s conversation, at full scale (M3 Decision 2)', () => {
    const ctx = testCtx();
    const owner = conversationOwner(ctx, ctx.raw.conversations.get('w007c000')!);
    const c = liftCondition(cond({
      how_close_dist: 40, how_close_x: 300, how_close_y: 350,
      condition: [NONE, '070103', NONE, NONE], check_x: [310, 320, 65535, 65535], check_y: [360, 370, 65535, 65535],
    }) as unknown as ConditionBlockT, ctx, owner, 'w007c000#/responses/0/results/0/0/0');
    expect(c).toEqual({
      near: { dist: ctx.markers.distance(null, 40, 350, 'x'), at: 'p300_350', px: 40 },
      checks: [{ emptyAt: 'p310_360' }, { object: 'horst3.rubble', at: 'p320_370' }],
    });
    expect(ctx.problems.errors).toEqual([]);
  });
});
