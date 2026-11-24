// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ANIM_STANDING, MAX_STEP_MS, newWalker, started, stepWalker, WALK_DELAY_MS, walkerAt, walkPath, type Waypoint } from './transporterWalk';

// the executable's own walk on and off (_transporterWalkOn, _transporterWalkOff)
const on: Waypoint[] = [
  { x: 38, y: 289, direction: 0, scale: 256 }, { x: 290, y: 277, direction: 3, scale: 256 }, { x: 326, y: 248, direction: 3, scale: 256 },
  { x: 326, y: 243, direction: 0, scale: 256 }, { x: 0, y: 0, direction: 0, scale: 244 }, { x: 0, y: 0, direction: 0, scale: 244 },
];
const off: Waypoint[] = [
  { x: 0, y: 0, direction: 0, scale: 0 }, { x: 326, y: 248, direction: 9, scale: 244 }, { x: 290, y: 277, direction: 9, scale: 256 }, { x: 38, y: 289, direction: 9, scale: 256 },
];
const pad0 = { stand: [250, 231] as [number, number], scale: 240 };
const pad1 = { stand: [404, 231] as [number, number], scale: 240 };

/** Runs a walker in 16 ms frames until it is done; returns the milliseconds it took. */
function run(w: ReturnType<typeof newWalker>, frame = 16): number {
  let t = w.start;
  while (!stepWalker(w, t += frame)) if (t > 60_000) throw new Error('never arrived');
  return t - w.start;
}

describe('walkPath', () => {
  it('walks on by the door, the middle of the room and the pad, facing as the pad\'s side', () => {
    const left = walkPath(on, off, 0, pad0, false);
    expect(left).toHaveLength(6);
    expect(left[3]).toEqual({ x: 326, y: 243, direction: 0, scale: 256 });
    // ((326 + 250) / 2, (243 + 231) / 2 - 5), walking left
    expect(left[4]).toEqual({ x: 288, y: 232, direction: 9, scale: 244 });
    expect(left[5]).toEqual({ x: 250, y: 231, direction: 9, scale: 240 });
    const right = walkPath(on, off, 1, pad1, false);
    expect(right[3]!.direction).toBe(3);
    expect(right[4]).toMatchObject({ x: 365, y: 232, direction: 3 });
    expect(right[5]).toMatchObject({ x: 404, y: 231, direction: 3, scale: 240 });
    // (the executable's own waypoints are not changed)
    expect(on[4]).toEqual({ x: 0, y: 0, direction: 0, scale: 244 });
  });

  it('walks off from the pad by the same way back to the door', () => {
    const path = walkPath(on, off, 2, { stand: [300, 229], scale: 236 }, true);
    expect(path[0]).toEqual({ x: 300, y: 229, direction: 0, scale: 236 });
    expect(path[1]).toEqual({ x: 326, y: 248, direction: 3, scale: 244 });
    expect(walkPath(on, off, 3, pad1, true)[1]!.direction).toBe(9);
    expect(path[3]).toEqual({ x: 38, y: 289, direction: 9, scale: 256 });
  });
});

describe('a walker', () => {
  it('stays where it starts until its time, then goes at 160 pixels a second at full size, in the direction of its leg', () => {
    const w = newWalker(0, false, walkPath(on, off, 0, pad0, false), 1000);
    expect(started(w, 999)).toBe(false);
    expect(stepWalker(w, 999)).toBe(false);
    expect([w.x, w.y]).toEqual([38, 289]);
    expect(started(w, 1000)).toBe(true);
    // (a frame of 50 ms: 8 pixels, along the first leg, which is nearly level)
    stepWalker(w, 1050);
    expect(w.x).toBeGreaterThan(45);
    expect(w.x).toBeLessThan(46.1);
    expect(w.anim).toBe(3);
  });

  it('takes the same time at any frame rate (a long frame counts only a tenth of a second)', () => {
    const a = newWalker(0, false, walkPath(on, off, 0, pad0, false), 0);
    const b = newWalker(0, false, walkPath(on, off, 0, pad0, false), 0);
    const slow = run(a, 16);
    const fast = run(b, 8);
    expect(Math.abs(slow - fast)).toBeLessThan(40);
    // (about 3 seconds from the door to the pad: 250 + 46 + 5 + 41 + 38 pixels at 160 a second, a little slower for the smaller size)
    expect(slow).toBeGreaterThan(2300);
    expect(slow).toBeLessThan(3200);
    const c = newWalker(0, false, walkPath(on, off, 0, pad0, false), 0);
    stepWalker(c, 5000);
    expect(c.x).toBeLessThanOrEqual(38 + (160 * MAX_STEP_MS) / 1000 + 0.01);
  });

  it('arrives on the pad at about its size, having shrunk along the legs, and the animation it ends on is the pad\'s side', () => {
    const w = newWalker(1, false, walkPath(on, off, 1, pad1, false), 0);
    const sizes: number[] = [];
    let t = 0;
    while (!stepWalker(w, (t += 16))) sizes.push(w.scale);
    expect(walkerAt(w)).toEqual([404, 231]);
    // (the last step's size is from before it: the room then sets the pad's own, as `updateWalkers` does)
    expect(w.scale).toBeLessThanOrEqual(244);
    expect(w.scale).toBeGreaterThanOrEqual(240);
    expect(Math.min(...sizes)).toBeLessThanOrEqual(244);
    expect(Math.max(...sizes)).toBe(256);
    expect(w.anim).toBe(3);
    expect(ANIM_STANDING).toBe(24);
  });

  it('walks off from the pad to the door end of the room and is done there', () => {
    const w = newWalker(0, true, walkPath(on, off, 0, pad0, true), 0);
    expect(walkerAt(w)).toEqual([250, 231]);
    expect(run(w)).toBeGreaterThan(1800);
    expect(walkerAt(w)).toEqual([38, 289]);
    expect(w.scale).toBe(256);
    expect(w.anim).toBe(9);
  });

  it('the recommended team sets off 1.33 seconds apart', () => {
    expect(WALK_DELAY_MS).toBeCloseTo(1333.3, 1);
  });
});
