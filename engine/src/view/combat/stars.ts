// SPDX-License-Identifier: GPL-3.0-or-later
import { angleFromSinCos, apply, cosAngle, fma32, fr, fromAngles, mul, sinAngle, sqrtf, transpose, v3, type M3 } from '../../sim/combat/math';
import { nextRandom, newRandom, type RandomState } from '../../sim/combat/random';

/**
 * The stars behind a battle (TacticalScreen::start and drawStars, tactical.cpp:50-53, 293-300, 868-935; Combat::
 * updateStarDrift, combat.cpp:950-962), and the view's own random numbers (M8 spec Decision 10).
 */

/** A constant the battle's seed is XORed with for the presentation's generator (M8 spec Decision 10): 'PRES'. */
export const PRESENTATION_SEED = 0x50524553;

/** The view's generator: the M7 LCG (AstroRandom's formula, random.ts) in an instance of its own, seeded from the battle's seed. The sim's never moves for it. */
export function presentationRandom(battleSeed: number): RandomState {
  return newRandom((battleSeed ^ PRESENTATION_SEED) >>> 0);
}
/**
 * 0 to n inclusive (Common::RandomSource::getRandomNumber's range) from the generator's 15 bits: next() * (n + 1) >> 15,
 * for n below 32768. Not AstroRandom::rnd, whose 8 bits would put the stars on a 256-step grid.
 */
export function presentationInt(r: RandomState, n: number): number {
  return Math.floor((nextRandom(r) * (n + 1)) / 32768);
}

/** kNumStars, kStarRange, kStarStep (tactical.cpp:50-53): the stars move 1920 units a whole turn of the camera. */
export const STAR_COUNT = 1500;
export const STAR_RANGE = 960;
export const STAR_STEP = fr(0.1171731966);
/** The star types that twinkle: drawStars' default case (tactical.cpp:932-933), types 0 and 7-11. */
export const TWINKLES = [true, false, false, false, false, false, false, true, true, true, true, true] as const;

/** SpaceStar (tactical.h:37-40): its type (0-11) and where it is, ±kStarRange screen units about the middle. */
export interface Star { type: number; x: number; y: number }

/** TacticalScreen::start's stars (tactical.cpp:293-300), from the presentation generator: types 0-11, x and y from -960 to 943. */
export function makeStars(r: RandomState): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const type = presentationInt(r, 11);
    const x = presentationInt(r, 2 * STAR_RANGE - 17) - STAR_RANGE;
    const y = presentationInt(r, 2 * STAR_RANGE - 17) - STAR_RANGE;
    stars.push({ type, x, y });
  }
  return stars;
}

/**
 * Combat::updateStarDrift (combat.cpp:950-962): how the camera turned between two drawn frames, as the yaw, pitch
 * and roll the stars drift by. `axes` and `last` are the cameras' rows (right, down, forward). Its angles go through
 * the sim's angleFromSinCos (atan2f) and the bound trig table, as ScummVM's do.
 */
export function starDrift(axes: M3, last: M3): [number, number, number] {
  const delta = mul(axes, transpose(last));
  const z = apply(delta, v3(0, 0, 256));
  const x = apply(delta, v3(256, 0, 0));
  const yaw = angleFromSinCos(z.x, z.z);
  // (sqrtf(z.x * z.x + z.z * z.z): fma(z.x, z.x, z.z * z.z))
  const pitch = angleFromSinCos(-z.y, sqrtf(fma32(z.x, z.x, fr(z.z * z.z))));
  const xs = apply(transpose(fromAngles(yaw, pitch, 0)), x);
  return [yaw, pitch, angleFromSinCos(xs.y, xs.x)];
}

/**
 * TacticalScreen::drawStars' drift (tactical.cpp:868-900), in float32: each star moves by the yaw and pitch, wrapping
 * at ±kStarRange, and turns about the middle by the roll (sinf and cosf of the negated roll, through the bound trig table).
 */
export function driftStars(stars: Star[], drift: readonly [number, number, number]): void {
  const dx = fr(((-drift[0]) & 0x3fff) * STAR_STEP);
  const dy = fr((drift[1] & 0x3fff) * STAR_STEP);
  const roll = drift[2] !== 0;
  // ((-drift[2]) & 0x3fff) * 2.0f * (float)M_PI / 16384.0f is angleToRadians(-drift[2]))
  const s = roll ? sinAngle(-drift[2]) : 0;
  const c = roll ? cosAngle(-drift[2]) : 1;
  for (const star of stars) {
    star.x = fr(star.x + dx);
    star.y = fr(star.y + dy);
    if (star.x >= STAR_RANGE) star.x = fr(star.x - 2 * STAR_RANGE);
    else if (star.x < -STAR_RANGE) star.x = fr(star.x + 2 * STAR_RANGE);
    if (star.y >= STAR_RANGE) star.y = fr(star.y - 2 * STAR_RANGE);
    else if (star.y < -STAR_RANGE) star.y = fr(star.y + 2 * STAR_RANGE);
    if (roll) {
      // (star.x * c - star.y * s: fma(x, c, -(y * s)); star.y * c + star.x * s: fma(y, c, x * s))
      const x = fma32(star.x, c, -fr(star.y * s));
      star.y = fma32(star.y, c, fr(star.x * s));
      star.x = x;
    }
  }
}

/** Twinkles this frame: each twinkling star bright about 7 frames in 8 (getRandomNumber(0x7fff) > 0xfff, tactical.cpp:933), from the presentation generator, in the stars' order. */
export function twinkle(stars: readonly Star[], r: RandomState, out: Uint8Array): void {
  stars.forEach((star, i) => {
    out[i] = TWINKLES[star.type] ? (presentationInt(r, 0x7fff) > 0xfff ? 1 : 0) : 1;
  });
}

/** Where drawStars puts a star in a window `width` x `height`: cx + (int)x * scale, scale = width / 320 (tactical.cpp:882-883, 902). */
export function starPixel(star: Star, width: number, height: number, scale: number): { x: number; y: number } {
  return { x: Math.floor(width / 2) + Math.trunc(star.x) * scale, y: Math.floor(height / 2) + Math.trunc(star.y) * scale };
}
