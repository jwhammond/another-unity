// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { withOriginalAlpha } from './hail';
import type { Rgba } from './image';

describe('withOriginalAlpha', () => {
  it('gives the repaint the original\'s transparency at the repaint\'s size, a soft edge one original pixel wide', () => {
    // a 2x1 original: blank, then opaque; the repaint is 4x
    const original: Rgba = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 0, 9, 9, 9, 255]) };
    const plate: Rgba = { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4).fill(200) };
    const out = withOriginalAlpha(plate, original);
    const alpha = [...Array(8).keys()].map(x => out.data[x * 4 + 3]!);
    expect(alpha[0]).toBe(0);
    expect(alpha[7]).toBe(255);
    expect(alpha).toEqual([...alpha].sort((a, b) => a - b));
    expect(out.data[0]).toBe(200);
  });
});
