// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle } from '../../testing/combat';
import { fly, STEP_SECONDS } from '../../sim/combat/flight';
import { fromAngles, v3 } from '../../sim/combat/math';
import { cameraPose, culled, shimmerAt, shipPose, shipShown, shipTier, stepFraction, teleported, viewDepth, SHIMMER_MS } from './draw';

describe('the view between two steps (M8 spec Decision 7)', () => {
  it('is the battle clock\'s place between the last step and the next, 0 to 1; 1 in the parity mode', () => {
    expect(stepFraction({ now: 10033, lastStep: 10000 }, false)).toBe(0.5);
    expect([stepFraction({ now: 10000, lastStep: 10000 }, false), stepFraction({ now: 10500, lastStep: 10000 }, false)]).toEqual([0, 1]);
    expect(stepFraction({ now: 10033, lastStep: 10000 }, true)).toBe(1);
  });

  it('draws a ship from the step before (its trail: the old position, the angles the step before turned to) towards this step\'s', () => {
    const { b } = miniBattle();
    const s = b.ships[0]!;
    // (battle x 0 to 10, a flight step's; yaw 0 to 0x800, an eighth of a turn)
    s.trail[0] = { pos: { x: 0, y: 0, z: 0 }, angles: [0x800, 0, 0] };
    s.trail[1] = { pos: { x: -5, y: 0, z: 0 }, angles: [0, 0, 0] };
    s.pos = { x: 10, y: 0, z: 0 };
    s.angles = [0x800, 0, 0];
    const half = shipPose(s, 0.5);
    expect(half.pos).toEqual({ x: 5, y: 0, z: 0 });
    // (half way round: a sixteenth of a turn, so the forward row is (sin, 0, cos) of 22.5 degrees)
    expect(half.m[6]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(half.m[8]).toBeCloseTo(Math.cos(Math.PI / 8), 6);
    expect(shipPose(s, 1)).toEqual({ pos: { x: 10, y: -0, z: 0 }, m: fromAngles(0x800, 0, 0) });
    // (at 0, the step before's: unturned)
    expect(shipPose(s, 0).m.map(n => Math.round(n * 1e6) / 1e6 + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('cuts to a ship moved outside flight (a starbase move, a warp) rather than sliding it in from where it was', () => {
    const { b } = miniBattle();
    const s = b.ships[0]!;
    s.trail[0] = { pos: { x: 0, y: 0, z: 0 }, angles: [0, 0, 0] };
    s.trail[1] = { pos: { x: 0, y: 0, z: 0 }, angles: [0, 0, 0] };
    // (24000 in one step: ai.cpp's starbase move; no flight step is longer than 2 * baseMaxSpeed * 66 ms)
    s.pos = { x: 24000, y: 0, z: 0 };
    expect(shipPose(s, 0.5).pos).toEqual({ x: 24000, y: -0, z: 0 });
    // (a flight step's worth still interpolates)
    s.pos = { x: s.baseMaxSpeed * STEP_SECONDS, y: 0, z: 0 };
    expect(shipPose(s, 0.5).pos.x).toBeCloseTo(s.baseMaxSpeed * STEP_SECONDS / 2, 3);
  });

  it('slides a ship flown at top speed on every step (the sim\'s own float32 steps reach the bound, rounding pushes them over)', () => {
    const { ctx, b } = miniBattle();
    const s = b.ships[1]!;
    s.angles = [0x0a3d, 0x0150, 0];
    s.speed = s.history[0] = s.history[1] = s.targetSpeed = s.maxSpeed = s.baseMaxSpeed;
    s.pos = { x: 1234.5, y: -6789.25, z: 321.125 };
    s.trail.fill({ pos: { ...s.pos }, angles: [...s.angles] as [number, number, number] });
    const snapped: number[] = [];
    for (let i = 0; i < 400; i++) {
      fly(ctx, s, true);
      const to = shipPose(s, 1).pos, half = shipPose(s, 0.5).pos;
      if (half.x === to.x && half.y === to.y && half.z === to.z) snapped.push(i);
    }
    expect(snapped).toEqual([]);
  });

  it('moves the camera from the step before\'s to this step\'s, but not across a cut (the first step of a view)', () => {
    const { b } = miniBattle();
    b.view.stepCamera = { pos: v3(0, 0, 0), axes: fromAngles(0, 0, 0) };
    b.view.camera = { pos: v3(100, 0, 0), axes: fromAngles(0x400, 0, 0) };
    b.view.viewFrame = 5;
    expect(cameraPose(b, 0.25).pos).toEqual({ x: 25, y: 0, z: 0 });
    b.view.viewFrame = 1;
    expect(cameraPose(b, 0.25)).toBe(b.view.camera);
  });

  it('draws a destroyed ship where it is (its trail stops with fly, so it would slide every step)', () => {
    const { b } = miniBattle();
    const s = b.ships[1]!;
    s.pos = { x: 0, y: 100, z: 0 };
    s.trail[0] = { pos: { x: 0, y: 90, z: 0 }, angles: [0, 0, 0] };
    s.trail[1] = { pos: { x: 0, y: 90, z: 0 }, angles: [0, 0, 0] };
    expect(shipPose(s, 0.5).pos.z).toBe(95);
    s.destroyed = true;
    expect(shipPose(s, 0.5).pos.z).toBe(100);
  });

  it('cuts the camera too when a ship jumped this step (a warp keeps the view, and the camera jumps with the ship)', () => {
    const { b } = miniBattle();
    b.view.stepCamera = { pos: v3(0, 0, 0), axes: fromAngles(0, 0, 0) };
    b.view.camera = { pos: v3(24000, 0, 0), axes: fromAngles(0, 0, 0) };
    b.view.viewFrame = 5;
    const s = b.ships[0]!;
    s.trail[0] = { pos: { x: 0, y: 0, z: 0 }, angles: [0, 0, 0] };
    s.pos = { x: 0, y: 24000, z: 0 };
    expect([teleported(s), teleported(b.ships[1]!)]).toEqual([true, false]);
    expect(cameraPose(b, 0.25)).toBe(b.view.camera);
    s.pos = { x: 0, y: 10, z: 0 };
    expect(cameraPose(b, 0.25).pos.x).toBe(6000);
  });
});

describe('what drawShip draws (combat.cpp:968-972, 1028-1056)', () => {
  it('draws a live ship that isn\'t cloaked: not destroyed, and not before its decloak time (Decision 8)', () => {
    const { b } = miniBattle();
    const s = b.ships[1]!;
    expect(shipShown(s, 5000)).toBe(true);
    s.decloakTime = 6000;
    expect([shipShown(s, 5999), shipShown(s, 6000)]).toEqual([false, true]);
    s.decloakTime = 0;
    s.destroyed = true;
    expect(shipShown(s, 5000)).toBe(false);
  });

  it('shimmers for 400 ms from the decloak time, never before', () => {
    expect([shimmerAt(6000, 5999), shimmerAt(6000, 6000), shimmerAt(6000, 6100), shimmerAt(6000, 6000 + SHIMMER_MS)]).toEqual([null, 0, 0.25, null]);
  });

  it('picks the detail, the reduced and the flat tier by the camera\'s distance, and nothing from 256000', () => {
    // (miniCombat's kinds: detail to 20000, reduced to 60000)
    const kind = { detailDistance: 20000, reducedDistance: 60000 };
    const both = { detail: 'mini.3dv', reduced: 'mini.3dr', damaged: null };
    expect([19999, 20000, 59999, 60000, 255999, 256000].map(d => shipTier(kind, both, d))).toEqual([
      { model: 'mini.3dv', flat: false }, { model: 'mini.3dr', flat: false }, { model: 'mini.3dr', flat: false },
      { model: 'mini.3dr', flat: true }, { model: 'mini.3dr', flat: true }, null,
    ]);
    // (without a reduced model, flat from detailDistance on)
    const one = { detail: 'mini.3dv', reduced: null, damaged: null };
    expect([19999, 20000].map(d => shipTier(kind, one, d))).toEqual([{ model: 'mini.3dv', flat: false }, { model: 'mini.3dv', flat: true }]);
    expect(shipTier(kind, { detail: null, reduced: null, damaged: null }, 100)).toBeNull();
  });

  it('low detail is the flat tier at every distance, the model still by distance, and nothing from 256000 (Plan 32 Task 9)', () => {
    const kind = { detailDistance: 20000, reducedDistance: 60000 };
    const both = { detail: 'mini.3dv', reduced: 'mini.3dr', damaged: null };
    expect([100, 20000, 60000, 256000].map(d => shipTier(kind, both, d, true))).toEqual([
      { model: 'mini.3dv', flat: true }, { model: 'mini.3dr', flat: true }, { model: 'mini.3dr', flat: true }, null,
    ]);
  });

  it('culls what is behind the camera by more than its size (view.z + size < 1)', () => {
    const cam = { pos: v3(0, 0, 0), axes: fromAngles(0, 0, 0) };
    expect(viewDepth(cam, v3(0, 0, -300))).toBe(-300);
    expect([culled(-300, 300), culled(-300, 301), culled(-300.5, 300)]).toEqual([true, false, true]);
  });
});
