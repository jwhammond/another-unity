// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FrameSampler, START_BUDGET_MS, startGaveUp, WARM_UP_MS } from './perf';

const none = { calls: 0, triangles: 0 };

/** Frames every `step` ms from `from` through `to`, each with `info`. */
function run(s: FrameSampler, from: number, to: number, step: number, info = none): number {
  let t = from;
  for (; t <= to; t += step) s.frame(t, info);
  return t - step;
}

describe('FrameSampler', () => {
  it('summarises frame times: mean, percentiles, worst and fps', () => {
    const s = new FrameSampler(60_000);
    let t = 0;
    // (the warm-up, then 100 frames at 16 ms and one at 50 ms)
    t = run(s, 0, WARM_UP_MS, 16);
    // (the first frame past it only starts the clock)
    s.frame((t += 16), none);
    for (let i = 0; i < 100; i++) s.frame((t += 16), none);
    s.frame((t += 50), none);
    s.end();
    const r = s.report();
    expect(r.frames).toBe(101);
    expect(r.p50Ms).toBe(16);
    expect(r.p95Ms).toBe(16);
    expect(r.worstMs).toBe(50);
    expect(r.meanMs).toBeCloseTo((100 * 16 + 50) / 101, 6);
    expect(r.fps).toBeCloseTo(101000 / 1650, 6);
    expect(r.seconds).toBeCloseTo(1.65, 6);
  });

  it('ignores the first second as warm-up', () => {
    const s = new FrameSampler(60_000);
    // (slow frames inside the warm-up: a 400 ms stall and busy frames)
    s.frame(0, { calls: 999, triangles: 999 });
    s.frame(400, { calls: 999, triangles: 999 });
    s.frame(800, { calls: 999, triangles: 999 });
    run(s, 1000 + 16, 1200, 16);
    s.end();
    const r = s.report();
    expect(r.worstMs).toBe(16);
    expect(r.maxCalls).toBe(0);
    expect(r.frames).toBeGreaterThan(0);
    // (nothing is kept before the second is up)
    const early = new FrameSampler(1000);
    early.frame(0, none);
    early.frame(500, none);
    expect(early.report().frames).toBe(0);
    expect(early.done).toBe(false);
  });

  it('is done once the duration has passed since the warm-up, and keeps nothing after', () => {
    const s = new FrameSampler(500);
    run(s, 0, 1400, 16);
    expect(s.done).toBe(false);
    run(s, 1416, 1600, 16);
    expect(s.done).toBe(true);
    const frames = s.report().frames;
    s.frame(5000, none);
    expect(s.report().frames).toBe(frames);
    expect(s.report().short).toBe(false);
  });

  it("keeps the busiest frame's draw calls and triangles", () => {
    const s = new FrameSampler(60_000);
    run(s, 0, 1000, 16);
    s.frame(1100, { calls: 40, triangles: 9000 });
    s.frame(1116, { calls: 95, triangles: 2000 });
    s.frame(1132, { calls: 10, triangles: 50_000 });
    s.end();
    expect(s.report()).toMatchObject({ maxCalls: 95, maxTriangles: 50_000 });
  });

  it('reports what it has, flagged short, when the battle ends before the duration', () => {
    const s = new FrameSampler(60_000);
    run(s, 0, 1500, 16);
    expect(s.done).toBe(false);
    s.end();
    expect(s.done).toBe(true);
    const r = s.report();
    expect(r.short).toBe(true);
    expect(r.frames).toBeGreaterThan(0);
    expect(new FrameSampler(1000).report()).toMatchObject({ frames: 0, fps: 0, short: false });
  });
});

describe('startGaveUp', () => {
  it('gives up when a stage outlasts its budget, or a seen battle is gone or resolved before timing', () => {
    expect(startGaveUp({ stageMs: 1000, seen: false, battle: 'gone' })).toBe(false);
    expect(startGaveUp({ stageMs: START_BUDGET_MS + 1, seen: false, battle: 'gone' })).toBe(true);
    expect(startGaveUp({ stageMs: 1000, seen: true, battle: 'live' })).toBe(false);
    expect(startGaveUp({ stageMs: 1000, seen: true, battle: 'gone' })).toBe(true);
    expect(startGaveUp({ stageMs: 1000, seen: true, battle: 'resolved' })).toBe(true);
  });

  it('leaves a zero-frame short report when the sampler is ended before timing began', () => {
    const s = new FrameSampler(60_000);
    s.end();
    expect(s.done).toBe(true);
    expect(s.report()).toMatchObject({ frames: 0, short: true });
  });
});
