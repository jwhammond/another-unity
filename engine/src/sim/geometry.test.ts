// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { distance, samePos } from './geometry';

describe('geometry', () => {
  it('measures ground-plane distance', () => {
    expect(distance({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
  });

  it('treats positions within a micro-unit as the same', () => {
    expect(samePos({ x: 1, z: 2 }, { x: 1 + 1e-9, z: 2 })).toBe(true);
    expect(samePos({ x: 1, z: 2 }, { x: 1.01, z: 2 })).toBe(false);
  });
});
