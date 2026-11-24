// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FixedLoop } from './loop';

describe('FixedLoop', () => {
  it('ticks at a fixed rate whatever the frame rate, carrying part ticks over', () => {
    let ticks = 0;
    const loop = new FixedLoop(() => ticks++, () => {});
    loop.advance(1000);
    expect(ticks).toBe(0);
    loop.advance(1050);
    expect(ticks).toBe(3);
    loop.advance(1058);
    expect(ticks).toBe(3);
    loop.advance(1067);
    expect(ticks).toBe(4);
  });

  it('drops the time after a stall instead of racing to catch up', () => {
    let ticks = 0;
    const loop = new FixedLoop(() => ticks++, () => {});
    loop.advance(0);
    expect(loop.advance(10_000)).toBe(10);
    expect(loop.advance(10_010)).toBe(0);
  });

  it('runs faster at a higher speed, and passes each frame its scaled time', () => {
    let ticks = 0;
    const frames: number[] = [];
    const loop = new FixedLoop(() => ticks++, dt => frames.push(dt), { speed: 2 });
    loop.advance(0);
    loop.advance(50);
    expect(ticks).toBe(6);
    expect(frames).toEqual([0, 0.1]);
  });

  it('tells each frame how far it is into the next tick', () => {
    const alphas: number[] = [];
    const loop = new FixedLoop(() => {}, (_dt, alpha) => alphas.push(alpha));
    loop.advance(0);
    loop.advance(25);
    expect(alphas[1]).toBeCloseTo(0.5, 5);
  });

  it('runs at real time for a speed that would stop or break it', () => {
    for (const speed of [0, -2, NaN, Infinity]) {
      const loop = new FixedLoop(() => {}, () => {}, { speed });
      expect(loop.speed).toBe(1);
      loop.speed = 3;
      loop.speed = speed;
      expect(loop.speed).toBe(1);
    }
    expect(new FixedLoop(() => {}, () => {}, { speed: 0.5 }).speed).toBe(0.5);
  });
});
