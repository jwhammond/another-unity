// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AstroRandom } from '../shipSystems';
import { newRandom, nextRandom, rnd, seedRandom } from './random';

describe('AstroRandom (astrogation.h:143-156)', () => {
  it('draws the C library sequence: seed 1 gives 16838, 5758, 10113, 17515, 31051', () => {
    const r = newRandom(1);
    expect([1, 2, 3, 4, 5].map(() => nextRandom(r))).toEqual([16838, 5758, 10113, 17515, 31051]);
    expect(r.draws).toBe(5);
  });

  it('wraps the state at 32 bits: seed 0x7fffffff gives 15929, 4409, 9862', () => {
    const r = newRandom(0x7fffffff);
    expect([1, 2, 3].map(() => nextRandom(r))).toEqual([15929, 4409, 9862]);
  });

  it('rolls rnd(n) as ((next() & 0xff) * (n & 0xffff) + 0x80) >> 8: seed 1234, rnd(100) six times', () => {
    const r = newRandom(1234);
    expect([1, 2, 3, 4, 5, 6].map(() => rnd(r, 100))).toEqual([90, 66, 11, 71, 9, 25]);
    expect(r.state).toBe(4265552588);
    expect(r.draws).toBe(6);
  });

  it('keeps rnd within 0 and n, n taken to 16 bits: rnd(0) is 0 and still draws, rnd(0x10000) is rnd(0)', () => {
    const r = newRandom(99);
    expect(rnd(r, 0)).toBe(0);
    expect(r.draws).toBe(1);
    expect(rnd(r, 0x10000)).toBe(0);
    for (let i = 0; i < 2000; i++) {
      const v = rnd(r, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it('tells the hook each roll, with its site', () => {
    const r = newRandom(1234);
    const heard: [string, number, number][] = [];
    rnd(r, 100, (site, n, value) => heard.push([site, n, value]), 'ai.cpp:fire');
    expect(heard).toEqual([['ai.cpp:fire', 100, 90]]);
  });

  it('reseeds, and the astrogation class draws the same numbers through it', () => {
    const r = newRandom(5);
    seedRandom(r, 1);
    expect(nextRandom(r)).toBe(16838);
    const a = new AstroRandom();
    a.seed(1234);
    expect([1, 2, 3, 4, 5, 6].map(() => a.rnd(100))).toEqual([90, 66, 11, 71, 9, 25]);
  });
});
