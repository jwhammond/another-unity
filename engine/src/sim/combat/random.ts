// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AstroRandom (astrogation.h:143-156): the original's C library random numbers, which every combat roll goes through
 * in ScummVM's call order (spec §4.3). The state is a plain object so a battle's state can be cloned and compared.
 */
export interface RandomState {
  /** AstroRandom::_state, a uint32 (astrogation.h:155). */
  state: number;
  /** How many numbers have been drawn: for tests and Plan 22's trace, not in the original. */
  draws: number;
}

/** Hears each roll: where it was made, its bound and its value (Plan 22 names the sites as ScummVM's trace does). */
export type DrawHook = (site: string, n: number, value: number) => void;

/** AstroRandom() (astrogation.h:145): the state starts at 0 unless seeded. */
export function newRandom(seed = 0): RandomState {
  return { state: seed >>> 0, draws: 0 };
}

/** AstroRandom::seed (astrogation.h:146). */
export function seedRandom(r: RandomState, seed: number): void {
  r.state = seed >>> 0;
}

/** AstroRandom::next (astrogation.h:147-150): state × 0x41c64e6d + 0x3039 over uint32, then bits 16-30. */
export function nextRandom(r: RandomState): number {
  r.state = (Math.imul(r.state, 0x41c64e6d) + 0x3039) >>> 0;
  r.draws++;
  return (r.state >>> 16) & 0x7fff;
}

/** AstroRandom::rnd (astrogation.h:151-152): "from 0 to n, inclusive", as ((next() & 0xff) × (n & 0xffff) + 0x80) >> 8. */
export function rnd(r: RandomState, n: number, hook?: DrawHook, site = 'unsited'): number {
  const value = ((nextRandom(r) & 0xff) * (n & 0xffff) + 0x80) >>> 8;
  hook?.(site, n, value);
  return value;
}
