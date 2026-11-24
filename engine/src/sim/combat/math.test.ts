// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { angleFromSinCos, angleToRadians, apply, fma32, fr, fromAngles, length, mul, transpose, v3 } from './math';

describe('float32 maths (space3d.cpp:33-90)', () => {
  it('fuses a multiply-add with one rounding, as fmaf does, even where the double sum lands halfway between two floats', () => {
    // a * b is 2^-24 - 2^-70: the exact sum is just under the midpoint 1 + 3 * 2^-24, so fmaf rounds down to 1 + 2^-23
    const a = fr(1 + 2 ** -23), b = fr(2 ** -24 * (1 - 2 ** -23)), c = fr(1 + 2 ** -23);
    expect(fma32(a, b, c)).toBe(1 + 2 ** -23);
    // (rounding the double sum ties to even, upward: what an unfused port would get wrong)
    expect(fr(a * b + c)).toBe(1 + 2 ** -22);
    // 0.1f * 10 - 1 keeps the product's low bits: 2^-26 fused, 0 unfused
    expect(fma32(fr(0.1), 10, -1)).toBe(2 ** -26);
    expect(fr(fr(fr(0.1) * 10) - 1)).toBe(0);
    expect(fma32(0.75, 0.5, 0.25)).toBe(0.625);
  });

  it('turns 16384 to a turn into radians, masking the angle', () => {
    expect(angleToRadians(4096)).toBe(fr(Math.PI / 2));
    expect(angleToRadians(4096 + 16384)).toBe(angleToRadians(4096));
    expect(angleToRadians(-4096)).toBe(angleToRadians(12288));
  });

  it('turns a sine and cosine back into an angle, truncated and masked (the C reference agrees on these)', () => {
    expect(angleFromSinCos(1, 0)).toBe(4096);
    expect(angleFromSinCos(-1, 0)).toBe(12288);
    expect(angleFromSinCos(0.5, 0.5)).toBe(2048);
    expect(angleFromSinCos(-0.001, 1)).toBe(16382);
    // (Apple's atan2f(0, -1) is the float below pi, so ScummVM gets 8191 here: its trace logs it, and a parity replay takes it, libm-atan2f)
    expect(angleFromSinCos(0, -1)).toBe(8192);
  });

  it('builds the rotation as space3d does: fromAngles(100, 200, 300), bit for bit with the C reference', () => {
    expect(fromAngles(100, 200, 300)).toEqual([
      0.99299609661102295, 0.11445744335651398, -0.029297098517417908,
      -0.1117921844124794, 0.99046868085861206, 0.080462612211704254,
      0.038227405399084091, -0.076623864471912384, 0.9963269829750061,
    ]);
  });

  it('applies, transposes and multiplies matrices for row vectors, and measures lengths in float32', () => {
    const quarter = fromAngles(4096, 0, 0);
    const v = apply(quarter, v3(1, 0, 0));
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBe(-1);
    expect(mul(transpose(quarter), quarter).map(x => Math.round(x * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(length(v3(3, 4, 12))).toBe(13);
    expect(length(v3(1, 1, 1))).toBe(fr(Math.sqrt(3)));
  });
});
