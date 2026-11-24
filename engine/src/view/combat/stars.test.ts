// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fromAngles, MATH_LIBM, bindLibm } from '../../sim/combat/math';
import { newRandom } from '../../sim/combat/random';
import { driftStars, makeStars, presentationInt, presentationRandom, PRESENTATION_SEED, STAR_COUNT, STAR_STEP, starDrift, twinkle, TWINKLES } from './stars';

describe('the presentation generator (M8 spec Decision 10)', () => {
  it('is the M7 LCG in its own instance, seeded with the battle\'s seed XOR a constant, and gives 0 to n', () => {
    const r = presentationRandom(1234);
    expect(r).toEqual(newRandom((1234 ^ PRESENTATION_SEED) >>> 0));
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(presentationInt(r, 3));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('the stars (tactical.cpp:50-53, 293-300, 868-935; combat.cpp:950-962)', () => {
  it('makes 1500, the same for a seed, of types 0-11, from -960 to 943 each way', () => {
    const a = makeStars(presentationRandom(7)), b = makeStars(presentationRandom(7)), c = makeStars(presentationRandom(8));
    expect(a).toHaveLength(STAR_COUNT);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    expect(Math.min(...a.map(s => Math.min(s.x, s.y)))).toBe(-960);
    expect(Math.max(...a.map(s => Math.max(s.x, s.y)))).toBe(943);
    const types = new Set(a.map(s => s.type));
    expect([...types].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('drifts by how the camera turned since the last frame: none for no turn, the yaw for a turn about the camera\'s down', () => {
    bindLibm(MATH_LIBM);
    expect(starDrift(fromAngles(0x100, 0, 0), fromAngles(0x100, 0, 0))).toEqual([0, 0, 0]);
    // (a 0x100 yaw: forward (256 sin, 0, 256 cos) of 5.625 degrees, whose angle atan2f gives back as 0x100)
    expect(starDrift(fromAngles(0x100, 0, 0), fromAngles(0, 0, 0))).toEqual([0x100, 0, 0]);
    expect(starDrift(fromAngles(0, 0x80, 0), fromAngles(0, 0, 0))).toEqual([0, 0x80, 0]);
  });

  it('moves each star by 0.11717 a unit of yaw and pitch, wraps at ±960, and turns them about the middle by the roll', () => {
    bindLibm(MATH_LIBM);
    const stars = [{ type: 0, x: 950, y: 0 }, { type: 0, x: -959.9, y: 959 }];
    // (yaw -1: ((-0x3fff) & 0x3fff) = 1 unit right; pitch 0x10: 16 units down)
    driftStars(stars, [0x3fff, 0x10, 0]);
    expect(stars[0]!.x).toBeCloseTo(950 + STAR_STEP, 4);
    expect(stars[1]!.y).toBeCloseTo(959 + 16 * STAR_STEP - 1920, 3);
    // (a quarter-turn roll: (10, 0) to (0, -10))
    const rolled = [{ type: 0, x: 10, y: 0 }];
    driftStars(rolled, [0, 0, 0x1000]);
    expect(rolled[0]!.x).toBeCloseTo(0, 4);
    expect(rolled[0]!.y).toBeCloseTo(-10, 4);
  });

  it('twinkles the twinkling types, bright about 7 frames in 8, and keeps the rest bright', () => {
    const r = presentationRandom(3);
    const stars = Array.from({ length: 12 }, (_, type) => ({ type, x: 0, y: 0 }));
    const out = new Uint8Array(12);
    let bright = 0, twinkling = 0;
    for (let frame = 0; frame < 2000; frame++) {
      twinkle(stars, r, out);
      stars.forEach((s, i) => {
        if (!TWINKLES[s.type]) expect(out[i]).toBe(1);
        else { twinkling++; bright += out[i]!; }
      });
    }
    expect(bright / twinkling).toBeGreaterThan(0.85);
    expect(bright / twinkling).toBeLessThan(0.90);
  });
});
