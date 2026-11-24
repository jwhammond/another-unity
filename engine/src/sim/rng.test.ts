// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { normalizeSeed, Rng } from './rng';

describe('Rng', () => {
  it('matches ScummVM RandomSource for seed 12345', () => {
    // (these values come from a C copy of common/random.cpp)
    const rng = new Rng({ rngSeed: 12345 });
    expect([rng.next(255), rng.next(255), rng.next(255), rng.next(99), rng.next(0xfffffffe)])
      .toEqual([186, 111, 189, 56, 3486722707]);
  });

  it('keeps its seed in the store, so a copy of the store resumes the sequence', () => {
    const store = { rngSeed: 7 };
    const a = new Rng(store);
    a.next(10);
    const b = new Rng({ ...store });
    expect(b.next(1000)).toBe(a.next(1000));
  });

  it('treats seed 0 as 1, like ScummVM', () => {
    expect(normalizeSeed(0)).toBe(1);
    expect(normalizeSeed(5)).toBe(5);
  });
});
