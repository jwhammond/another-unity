// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lowMemoryDevice, pixelRatioFor, type DeviceInfo } from './device';

const desktop: DeviceInfo = { deviceMemory: 8, screenMin: 1080, touch: false };

describe('lowMemoryDevice', () => {
  it('is false for a big desktop and true for each reason alone', () => {
    expect(lowMemoryDevice('', desktop)).toBe(false);
    expect(lowMemoryDevice('', { ...desktop, deviceMemory: 4 })).toBe(true);
    expect(lowMemoryDevice('', { ...desktop, deviceMemory: 2 })).toBe(true);
    expect(lowMemoryDevice('', { ...desktop, screenMin: 412 })).toBe(true);
    expect(lowMemoryDevice('', { ...desktop, touch: true })).toBe(true);
  });

  it('does not take a browser that hides its memory for a poor one', () => {
    expect(lowMemoryDevice('', { screenMin: 1080, touch: false })).toBe(false);
  });

  it('is decided by ?res for a test', () => {
    expect(lowMemoryDevice('?res=half', desktop)).toBe(true);
    expect(lowMemoryDevice('?res=full', { deviceMemory: 2, screenMin: 400, touch: true })).toBe(false);
  });
});

describe('pixelRatioFor', () => {
  it('caps a low-memory device at 2 and leaves a big one alone', () => {
    expect(pixelRatioFor(3, true)).toBe(2);
    expect(pixelRatioFor(1.5, true)).toBe(1.5);
    expect(pixelRatioFor(3, false)).toBe(3);
    expect(pixelRatioFor(0, true)).toBe(1);
  });
});
