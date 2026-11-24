// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bridgePalette, colourFrame, COLOUR_BLANK, firstSpriteFrame, firstSpritePosition, shipGameZip, spritePalette, viewFrame } from './shipsprite';

const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const block = (type: string, body: number[]): number[] => [...[...type].map(c => c.charCodeAt(0)), ...u32(body.length + 8), ...body];

/** The COMP block of a 4x1 type-2 image: a single pixel 5, a single pixel 130, a blank run of 2. */
function comp(): number[] {
  // (2-bit type then 8 bits: 01 00000101 | 01 10000010 | 00 00000001 -> 10 bits, 10 bits, 10 bits = 30 bits)
  const bits = '01' + '00000101' + '01' + '10000010' + '00' + '00000001';
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
  return block('PMOC', [...u32(4), ...u32(1), 0x0d, 0, 2, 0, ...bytes]);
}
/** A sprite of that image alone. */
function sprite(): Uint8Array {
  return new Uint8Array(block('TRPS', [...u32(0x1000), ...block('TSIL', [...u32(1), ...u32(12), ...comp()])]));
}

describe('bridge sprites', () => {
  it('decodes the first frame of a sprite to palette indices, blank where the original draws nothing', () => {
    const f = firstSpriteFrame(sprite());
    expect([f.width, f.height]).toEqual([4, 1]);
    expect([...f.indices]).toEqual([5, 130, COLOUR_BLANK, COLOUR_BLANK]);
  });

  it('colours index 5 from the bridge\'s own entries and index 130 from the standard ones (the export had index 5 black)', () => {
    const bridge = new Uint8Array(128 * 3);
    bridge.set([10, 20, 30], 5 * 3);
    const standard = new Uint8Array(128 * 3);
    standard.set([1, 2, 3], 2 * 3);
    const img = colourFrame(firstSpriteFrame(sprite()), bridgePalette(bridge, standard));
    expect([...img.data.slice(0, 4)]).toEqual([40, 80, 120, 255]);
    expect([...img.data.slice(4, 8)]).toEqual([4, 8, 12, 255]);
    expect(img.data[11]).toBe(0);
  });
});

describe('hail sprites', () => {
  it('are coloured with viewscr.rm\'s own entries, not the bridge\'s and not the standard half alone (the export had index 5 black)', () => {
    const viewscr = new Uint8Array(128 * 3);
    viewscr.set([10, 20, 30], 5 * 3);
    const bridge = new Uint8Array(128 * 3);
    bridge.set([1, 1, 1], 5 * 3);
    const standard = new Uint8Array(128 * 3);
    standard.set([7, 7, 7], 2 * 3);
    const img = viewFrame(sprite(), viewscr, standard);
    expect([...img.data.slice(0, 4)]).toEqual([40, 80, 120, 255]);
    expect([...img.data.slice(4, 8)]).toEqual([28, 28, 28, 255]);
    // the bridge's palette would colour the same pixel differently
    expect([...colourFrame(firstSpriteFrame(sprite()), bridgePalette(bridge, standard)).data.slice(0, 3)]).toEqual([4, 4, 4]);
    // and the export's palette (the standard half only, the rest black) gives black
    expect([...colourFrame(firstSpriteFrame(sprite()), bridgePalette(new Uint8Array(128 * 3), standard)).data.slice(0, 3)]).toEqual([0, 0, 0]);
  });
});

describe('a hail sprite with its own palette and position', () => {
  /** sprite() with an RGBP block (256 entries, 6-bit: index 5 is 1,2,3 and index 130 is 9,8,7) and a POSN block before the image. */
  function withPalette(): Uint8Array {
    const pal = new Array<number>(256 * 3).fill(0);
    pal.splice(5 * 3, 3, 1, 2, 3);
    pal.splice(130 * 3, 3, 9, 8, 7);
    const rgbp = block('PBGR', pal);
    const posn = block('NSOP', [...u32(319), ...u32(311)]);
    const list = block('TSIL', [...u32(1), ...u32(12), ...rgbp, ...posn, ...comp()]);
    return new Uint8Array(block('TRPS', [...u32(0x1000), ...list]));
  }

  it('reads the palette, shifted left by 2, and the first position', () => {
    const spr = withPalette();
    const pal = spritePalette(spr)!;
    expect([...pal.slice(5 * 3, 5 * 3 + 3)]).toEqual([4, 8, 12]);
    expect([...pal.slice(130 * 3, 130 * 3 + 3)]).toEqual([36, 32, 28]);
    expect(firstSpritePosition(spr)).toEqual([319, 311]);
    expect(spritePalette(sprite())).toBeUndefined();
    expect(firstSpritePosition(sprite())).toBeUndefined();
  });

  it('colours a hail frame with the sprite\'s own palette, not viewscr.rm\'s', () => {
    const viewscr = new Uint8Array(128 * 3);
    viewscr.set([10, 20, 30], 5 * 3);
    const img = viewFrame(withPalette(), viewscr, new Uint8Array(128 * 3));
    expect([...img.data.slice(0, 4)]).toEqual([4, 8, 12, 255]);
    expect([...img.data.slice(4, 8)]).toEqual([36, 32, 28, 255]);
  });
});

describe('shipGameZip', () => {
  it('is an error, not a warning, without GAMEDATA_DIR', () => {
    expect(() => shipGameZip(undefined)).toThrow(/needs GAMEDATA_DIR/);
    expect(() => shipGameZip('')).toThrow(/needs GAMEDATA_DIR/);
    expect(shipGameZip('/g')).toBe('/g/STTNG.ZIP');
  });
});
