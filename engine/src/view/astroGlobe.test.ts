// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GLOBE_COLOURS, GLOBE_RAMPS, GLOBE_SIZE, globeColours, globeTexture, renderGlobe } from './astroGlobe';

describe('the planet\'s globe', () => {
  it('has 112 colours running dark to middle to light for its class', () => {
    const c = globeColours(10);
    expect(c).toHaveLength(GLOBE_COLOURS * 3);
    expect([...c.subarray(0, 3)]).toEqual([...GLOBE_RAMPS[10]![0]!]);
    expect([...c.subarray(56 * 3, 56 * 3 + 3)]).toEqual([...GLOBE_RAMPS[10]![1]!]);
    expect(c[(GLOBE_COLOURS - 1) * 3]!).toBeGreaterThan(GLOBE_RAMPS[10]![1]![0]!);
    // (a class past the table has the last one's)
    expect([...globeColours(99)]).toEqual([...globeColours(15)]);
  });
  it('makes a surface of colour indices from the class and seed, the same every time and different for another seed', () => {
    const a = globeTexture(10, 1234), b = globeTexture(10, 1234), c = globeTexture(10, 1235);
    expect(a).toHaveLength(256 * 168);
    expect(Math.max(...a)).toBeLessThan(GLOBE_COLOURS);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // (it wraps round: the column before the first is the last, so neighbours do not jump across the seam)
    let jump = 0;
    for (let y = 0; y < 168; y++) jump += Math.abs(a[y * 256]! - a[y * 256 + 255]!);
    expect(jump / 168).toBeLessThan(GLOBE_COLOURS / 3);
  });
  it('bands the gas giants more than the rocky planets', () => {
    const rows = (t: Uint8Array) => { let sum = 0; for (let y = 1; y < 168; y++) sum += Math.abs(t[y * 256 + 100]! - t[(y - 1) * 256 + 100]!); return sum; };
    expect(rows(globeTexture(1, 77))).toBeGreaterThan(rows(globeTexture(8, 77)));
  });
  it('wraps it on a sphere with clear corners, and turns it with the clock', () => {
    const texture = globeTexture(10, 1234), colours = globeColours(10);
    const a = renderGlobe(texture, colours, 0);
    expect(a).toHaveLength(GLOBE_SIZE * GLOBE_SIZE * 4);
    expect(a[3]).toBe(0);
    const middle = (GLOBE_SIZE / 2) * GLOBE_SIZE + GLOBE_SIZE / 2;
    expect(a[middle * 4 + 3]).toBe(255);
    const opaque = a.filter((_, i) => i % 4 === 3 && a[i] === 255).length;
    // (a disc: a little under pi/4 of the square)
    expect(opaque / (GLOBE_SIZE * GLOBE_SIZE)).toBeGreaterThan(0.76);
    expect(opaque / (GLOBE_SIZE * GLOBE_SIZE)).toBeLessThan(0.8);
    expect(renderGlobe(texture, colours, 16)).not.toEqual(a);
    // (a whole turn of the texture, 256 columns of 16 ticks, is the same picture)
    expect(renderGlobe(texture, colours, 16 * 256)).toEqual(a);
  });
});
