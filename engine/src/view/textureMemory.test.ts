// SPDX-License-Identifier: GPL-3.0-or-later
import { Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { TextureLedger, textureBytes } from './textureMemory';

const texture = (w: number, h: number, mips = true) => {
  const t = new Texture({ width: w, height: h } as unknown as HTMLImageElement);
  t.generateMipmaps = mips;
  return t;
};

describe('TextureLedger', () => {
  it('counts a plate as its RGBA pixels and a third more for the mip chain', () => {
    expect(textureBytes(2560, 1920, false)).toBe(2560 * 1920 * 4);
    expect(textureBytes(2560, 1920, true)).toBe(Math.round(2560 * 1920 * 4 * 4 / 3));
    // (a half-size plate costs a quarter)
    expect(textureBytes(1280, 960, true) * 4).toBeCloseTo(textureBytes(2560, 1920, true), -1);
  });

  it('adds up what is loaded, and drops a texture when it is disposed', () => {
    const ledger = new TextureLedger();
    const a = ledger.track(texture(100, 100, false), 'art/a/plate.webp');
    ledger.track(texture(50, 50, false), 'art/b.png');
    expect(ledger.count).toBe(2);
    expect(ledger.bytes).toBe(100 * 100 * 4 + 50 * 50 * 4);
    a.dispose();
    expect(ledger.count).toBe(1);
    expect(ledger.bytes).toBe(50 * 50 * 4);
  });

  it('counts a texture once, ignores one with no image yet, and lists the biggest first', () => {
    const ledger = new TextureLedger();
    const t = texture(10, 10, false);
    ledger.track(t, 'x');
    ledger.track(t, 'x');
    ledger.track(new Texture(), 'empty');
    ledger.track(texture(20, 20, false), 'y');
    expect(ledger.count).toBe(2);
    expect(ledger.records().map(r => r.url)).toEqual(['y', 'x']);
    expect(ledger.summary()).toMatch(/^2 textures, /);
  });
});
