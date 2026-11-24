// SPDX-License-Identifier: GPL-3.0-or-later
export function normalizeSeed(seed: number): number {
  const s = seed >>> 0;
  return s === 0 ? 1 : s;
}

/** Hears each draw: where it was made, its bound and its value. */
export type DrawListener = (site: string, max: number, value: number) => void;

/**
 * ScummVM's Common::RandomSource (xorshift 13/21/11), bit-exact, so a
 * shared seed gives the same skill checks as the reference engine. The
 * seed lives in the store (the world state), so saves resume the sequence.
 */
export class Rng {
  constructor(
    private readonly store: { rngSeed: number },
    private readonly onDraw?: DrawListener,
  ) {}

  /** `site` names the draw as ScummVM's trace does, so the two engines' draws can be compared. */
  next(max: number, site = 'unsited'): number {
    let s = this.store.rngSeed >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
    s = (s ^ (s << 21)) >>> 0;
    s = (s ^ (s >>> 11)) >>> 0;
    this.store.rngSeed = s;
    const product = Math.imul(s, 0xdeadbf03) >>> 0;
    const value = max === 0xffffffff ? product : product % (max + 1);
    this.onDraw?.(site, max, value);
    return value;
  }
}
