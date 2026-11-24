// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, recordingSeams } from '../../testing/combat';
import { fr, v3 } from './math';
import { newRandom } from './random';
import { avoidCollision, directionTo, filterInputs, signedAngle, steerTowards } from './steering';

/** miniCombat's battle: the Enterprise at the origin heading 0 (ahead is +y, up +z), radius 200; the chodak at (1000, 0, 5000), radius 200. */
function battle() {
  const log: string[] = [];
  const ctx = miniBattleContext(recordingSeams(log));
  const { b } = miniBattle({ ctx });
  b.random = newRandom(1);
  log.length = 0;
  return { ctx, b, e: b.ships[0]!, chodak: b.ships[1]!, log };
}

describe('signedAngle and Combat::directionTo (ai.cpp:48-59)', () => {
  it('turns an angle into -0x2000 to 0x2000', () => {
    expect([0, 0x2000, 0x2001, 0x3fff, 0x4000, -1].map(signedAngle)).toEqual([0, 0x2000, -0x1fff, -1, 0, -1]);
  });

  it('gives the yaw and pitch to a point in the ship\'s frame: 0 ahead, 0x1000 right or up', () => {
    const { e } = battle();
    // (ahead; right; up; atan2(100, 5000) * 16384 / 2pi = 52.1; atan2(-900, 5000) = -464.4, as an angle 0x4000 - 464;
    // the chodak: atan2(1000, 0) right, atan2(5000, 1000) = 3581.3 up)
    const points: [number, number, number][] = [[0, 5000, 0], [5000, 0, 0], [0, 0, 5000], [100, 5000, 0], [-900, 5000, 0], [1000, 0, 5000]];
    expect(points.map(p => directionTo(e, v3(...p)))).toEqual([[0, 0], [0x1000, 0], [0, 0x1000], [52, 0], [0x4000 - 464, 0], [0x1000, 3581]]);
    // (sqrtf(l.x * l.x + l.z * l.z) fused as fma(l.x, l.x, l.z * l.z) (R9): 5397^2 + 11004^2 isn't a float, and the
    // pitch lands on 13829 (0x4000 - 2555); unfused, or fused the other way, fma(l.z, l.z, l.x * l.x), it is 13828)
    expect(directionTo(e, v3(-5397, -11004, -18282))).toEqual([9382, 13829]);
  });
});

describe('Combat::steerTowards (ai.cpp:61-77)', () => {
  it('turns toward the point at up to 128 a step, none under 32, and levels the wings to the line of sight at up to 64', () => {
    const { ctx, b, e } = battle();
    const steer = (p: [number, number, number]) => {
      steerTowards(ctx, b, e, v3(...p));
      return [e.controls.yaw, e.controls.pitch, e.controls.roll];
    };
    // (ahead: nothing; right: yaw 0x1000 clipped to 128; up: pitch 128; 52 off: 52; 26 off: under 32, none)
    expect([[0, 5000, 0], [5000, 0, 0], [0, 0, 5000], [100, 5000, 0], [50, 5000, 0]].map(p => steer(p as [number, number, number])))
      .toEqual([[0, 0, 0], [128, 0, 0], [0, 128, 0], [52, 0, 0], [0, 0, 0]]);
    // (the dead zone is ABS < 32: 62 off is a yaw (or pitch) of 32, kept; 61 off is 31, none)
    expect([[62, 5000, 0], [61, 5000, 0], [0, 5000, 62], [0, 5000, 61]].map(p => steer(p as [number, number, number])))
      .toEqual([[32, 0, 0], [0, 0, 0], [0, 32, 0], [0, 0, 0]]);
    // (rolled 20, the wings level by -20: under 32, none; rolled 32, -32)
    e.angles = [0, 0, 20];
    expect(steer([0, 5000, 0])).toEqual([0, 0, 0]);
    e.angles = [0, 0, 32];
    expect(steer([0, 5000, 0])).toEqual([0, 0, -32]);
    // (rolled 1000 one way or 384 the other, it rolls back, clipped to 64)
    e.angles = [0, 0, 1000];
    expect(steer([0, 5000, 0])).toEqual([0, 0, -64]);
    e.angles = [0, 0, 16000];
    expect(steer([0, 5000, 0])).toEqual([0, 0, 64]);
  });
});

describe('Combat::filterInputs (ai.cpp:79-99)', () => {
  it('smooths each control over the last four steps, and starts a change of direction at a quarter', () => {
    const { ctx, b, e } = battle();
    const filter = (yaw: number, roll: number) => {
      Object.assign(e.controls, { yaw, pitch: 0, roll });
      filterInputs(ctx, b, e);
      return [e.controls.yaw, e.controls.pitch, e.controls.roll];
    };
    // ((0 + 2 * 100) / 10 + 0) * 0.5 = 10; (-100 / 10) * 0.5 = -5
    expect(filter(100, -50)).toEqual([10, 0, -5]);
    // (sum 10 + 100: ((110 + 200) / 10 + 10) * 0.5 = 20.5; sum -55: ((-55 - 100) / 10 - 5) * 0.5 = -10.25)
    expect(filter(100, -50)).toEqual([20.5, 0, -10.25]);
    // (yaw turns about: -100 counts as -25; sum 120.5 + 110 = 230.5: ((230.5 - 50) / 10 + 20.5) * 0.5, in float)
    expect(filter(-100, -50)).toEqual([fr(fr(fr(180.5 / 10) + 20.5) * 0.5), 0, fr(fr(fr(-215.25 / 10) - 10.25) * 0.5)]);
    expect(e.inputHistory.map(h => [h[0], h[4]])).toEqual([[19.274999618530273, -100], [20.5, 100], [10, 100], [0, 0]]);
  });

  it('sums all four steps of the history, the oldest too', () => {
    const { ctx, b, e } = battle();
    for (const yaw of [100, 100, -100, -100]) {
      Object.assign(e.controls, { yaw, pitch: 0, roll: 0 });
      filterInputs(ctx, b, e);
    }
    // (the 4th: sum (19.275 - 100) + 120.5 + 110 = 149.775: ((149.775 - 200) / 10 + 19.275) * 0.5 = 7.12625, in float)
    expect(e.controls.yaw).toBe(7.126249313354492);
    Object.assign(e.controls, { yaw: -100, pitch: 0, roll: 0 });
    filterInputs(ctx, b, e);
    // (the 5th: the oldest step, 10 + 100, now in the sum: (7.126 - 100) + (19.275 - 100) + 120.5 + 110 = 56.901;
    // ((56.901 - 200) / 10 + 7.126) * 0.5 = -3.5918, in float)
    expect(e.controls.yaw).toBe(-3.591813087463379);
    expect(e.inputHistory.map(h => [h[0], h[4]])).toEqual([[-3.591813087463379, -100], [7.126249313354492, -100], [19.274999618530273, -100], [20.5, 100]]);
  });
});

describe('Combat::avoidCollision (ai.cpp:101-131)', () => {
  it('does nothing for a target far off, at rest apart, or not coming within a second', () => {
    const { ctx, b, e, chodak, log } = battle();
    avoidCollision(ctx, b, e);
    // (300 apart at rest: within the radii's 400, but the threshold is 0 * 4.5 + 200, and 300 then)
    chodak.pos = v3(0, 300, 0);
    avoidCollision(ctx, b, e);
    chodak.destroyed = true;
    chodak.pos = v3(0, 100, 0);
    avoidCollision(ctx, b, e);
    expect([e.log, e.holdTime, log, b.random.draws]).toEqual([[], 0, [], 0]);
  });

  it('lets two ships at rest (both under 2) and apart past their radii be, though within the threshold (ai.cpp:109-110)', () => {
    // (radius 5 and 200, 207 apart, the chodak drifting in at 1.9: the threshold 1.9 * 4.5 + 200 = 208.55 is past
    // them, but they are at rest and 207 > 205)
    const rest = battle();
    rest.e.radius = 5;
    rest.chodak.pos = v3(0, 207, 0);
    rest.chodak.velocity = v3(0, -1.9, 0);
    avoidCollision(rest.ctx, rest.b, rest.e);
    expect(rest.e.log).toEqual([]);
    // (at 2, not at rest: threshold 209, it warns; within the radii, 204 apart, too; neither touches (5 <= d): no rolls)
    const moving = battle();
    moving.e.radius = 5;
    moving.chodak.pos = v3(0, 207, 0);
    moving.chodak.velocity = v3(0, -2, 0);
    avoidCollision(moving.ctx, moving.b, moving.e);
    const near = battle();
    near.e.radius = 5;
    near.chodak.pos = v3(0, 204, 0);
    near.chodak.velocity = v3(0, -1.9, 0);
    avoidCollision(near.ctx, near.b, near.e);
    expect([moving.e.log, near.e.log, moving.b.random.draws + near.b.random.draws]).toEqual([['Collision Imminent'], ['Collision Imminent'], 0]);
  });

  it('looks no further than 8000, however fast they close', () => {
    const { ctx, b, e, chodak } = battle();
    // (9000 apart closing at 2000: the threshold 2000 * 4.5 + 200 = 9200 is past them, but 9000 > kCollisionRange)
    chodak.pos = v3(0, 9000, 0);
    chodak.velocity = v3(0, -2000, 0);
    avoidCollision(ctx, b, e);
    expect([e.log, e.holdTime]).toEqual([[], 0]);
    // (at 7900, within range and the threshold: it warns)
    chodak.pos = v3(0, 7900, 0);
    avoidCollision(ctx, b, e);
    expect(e.log).toEqual(['Collision Imminent']);
  });

  it('warns when they will be close a second on though they are not yet', () => {
    const { ctx, b, e, chodak } = battle();
    // (5000 apart, each at 1000 toward the other: the threshold 1000 * 4.5 + 200 = 4700 is under 5000, but a second
    // on they are 3000 apart)
    chodak.pos = v3(0, 5000, 0);
    chodak.velocity = v3(0, -1000, 0);
    e.velocity = v3(0, 1000, 0);
    avoidCollision(ctx, b, e);
    expect(e.log).toEqual(['Collision Imminent']);
    // (going apart instead, 7000 a second on: nothing)
    const far = battle();
    far.chodak.pos = v3(0, 5000, 0);
    far.chodak.velocity = v3(0, 1000, 0);
    far.e.velocity = v3(0, -1000, 0);
    avoidCollision(far.ctx, far.b, far.e);
    expect(far.e.log).toEqual([]);
    // (either is enough: 4000 apart and parting at 1000, 5000 a second on, but now within the threshold 4700: it warns)
    const parting = battle();
    parting.chodak.pos = v3(0, 4000, 0);
    parting.chodak.velocity = v3(0, 1000, 0);
    avoidCollision(parting.ctx, parting.b, parting.e);
    expect(parting.e.log).toEqual(['Collision Imminent']);
  });

  it('holds everything for 5 s, turns hard away and makes for 575, and they collide only if they touch', () => {
    const { ctx, b, e, chodak } = battle();
    // (1000 apart, closing at 500: the threshold 500 * 4.5 + 200 = 2450)
    chodak.pos = v3(0, 1000, 0);
    chodak.velocity = v3(0, -500, 0);
    e.controls.yaw = 20;
    avoidCollision(ctx, b, e);
    expect(e.log).toEqual(['Collision Imminent']);
    // (combatTicks(0x5af) is 5000 ms)
    expect([e.holdTime, e.scriptTime, e.strategyTime, e.freezeTime]).toEqual([15000, 15000, 15000, 15000]);
    expect([e.controls.yaw, e.controls.pitch, e.controls.roll]).toEqual([-100, 100, 100]);
    // (500.0f * kStepSeconds and 750.0f * kStepSeconds are 33 and 49.5; not touching (1000 > 200): no rolls)
    expect([e.speed, e.targetSpeed, b.random.draws]).toEqual([33, 49.5, 0]);
    e.speed = 600;
    e.targetSpeed = 600;
    avoidCollision(ctx, b, e);
    expect([e.speed, e.targetSpeed]).toEqual([567, 550.5]);
    e.speed = 575;
    avoidCollision(ctx, b, e);
    expect([e.speed, e.targetSpeed]).toEqual([575, 550.5]);
  });

  it('collides when they touch: damage.ts\'s collide rolls for both ships\' shields', () => {
    const { ctx, b, e, chodak } = battle();
    chodak.pos = v3(0, 150, 0);
    avoidCollision(ctx, b, e);
    // (avoidCollision's line, then collide's (damage.cpp:620-638), which rolls)
    expect(e.log.slice(0, 2)).toEqual(['Collision Imminent', 'Collision Imminent']);
    // (each ship's shield and hit, damage.cpp:630, 4 rolls; then phaserHit's and explode's own, Plan 20's: 118 in all, measured)
    expect(b.random.draws).toBe(118);
  });
});
