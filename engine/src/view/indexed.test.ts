// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BitmapFont, COLOUR_BLANK, IndexedScreen, Palette, parsePack, writePack } from './indexed';

/** A font file: kind 1, height, first and last character, size, 0, type, pitch, then each glyph's width and bytes. */
function fontFile(opts: { height: number; start: number; glyphs: number[][]; widths: number[]; colour?: boolean; pitch?: number }): Uint8Array {
  const size = opts.glyphs[0]!.length;
  const out = [1, opts.height, opts.start, opts.start + opts.glyphs.length - 1, (opts.colour ? size + 1 : size) & 0xff, (opts.colour ? size + 1 : size) >> 8, 0, opts.colour ? 1 : 0, opts.pitch ?? 0];
  opts.glyphs.forEach((g, i) => out.push(opts.widths[i]!, ...g));
  return new Uint8Array(out);
}

describe('packs', () => {
  it('round-trip, and a file that is not one is refused', () => {
    const images = [{ width: 2, height: 2, pixels: new Uint8Array([1, 2, 3, 4]) }, { width: 3, height: 1, pixels: new Uint8Array([9, 13, 7]) }];
    const back = parsePack(writePack(images));
    expect(back.map(i => [i.width, i.height, [...i.pixels]])).toEqual([[2, 2, [1, 2, 3, 4]], [3, 1, [9, 13, 7]]]);
    expect(() => parsePack(new Uint8Array(12))).toThrow(/not an indexed pack/);
    expect(() => parsePack(writePack(images).subarray(0, 14))).toThrow(/ends inside/);
  });
});

describe('Palette', () => {
  const ramp = () => new Palette(Uint8Array.from({ length: 768 }, (_, i) => Math.floor(i / 3)));
  const at = (p: Palette, i: number) => p.rgb[i * 3];
  it('rotates from a lower index to a higher one towards the lower, the first going round to the end (rotatePalette)', () => {
    const p = ramp();
    p.rotate(4, 7);
    expect([4, 5, 6, 7, 8].map(i => at(p, i))).toEqual([5, 6, 7, 4, 8]);
  });
  it('rotates from a higher index to a lower one the other way', () => {
    const p = ramp();
    p.rotate(7, 4);
    expect([3, 4, 5, 6, 7, 8].map(i => at(p, i))).toEqual([3, 7, 4, 5, 6, 8]);
  });
  it('copies and sets single entries, and clones apart', () => {
    const p = ramp();
    const c = p.clone();
    p.copyEntry(10, 200);
    p.setEntry(11, [1, 2, 3]);
    expect([at(p, 10), [...p.rgb.subarray(33, 36)]]).toEqual([200, [1, 2, 3]]);
    expect(at(c, 10)).toBe(10);
  });
});

describe('IndexedScreen', () => {
  it('fills rectangles half open, and clipped to the screen; `fill` takes inclusive corners', () => {
    const s = new IndexedScreen(8, 4);
    s.fillRect(5, 1, 1, 3, 3);
    expect([...s.pixels].filter(v => v === 5)).toHaveLength(4);
    s.fillRect(7, -5, -5, 100, 100);
    expect(s.pixels.every(v => v === 7)).toBe(true);
    s.fill(0, 0, 1, 1, 2);
    expect([...s.pixels.subarray(0, 3)]).toEqual([2, 2, 7]);
    expect([...s.pixels.subarray(8, 11)]).toEqual([2, 2, 7]);
  });

  it('blits a picture over what is there, skipping colour 13 (not 0), and clips', () => {
    const s = new IndexedScreen(4, 3);
    s.fillRect(9, 0, 0, 4, 3);
    s.blit({ width: 3, height: 2, pixels: new Uint8Array([1, COLOUR_BLANK, 0, 2, 3, 4]) }, 2, 1);
    expect([...s.pixels]).toEqual([9, 9, 9, 9, 9, 9, 1, 9, 9, 9, 2, 3]);
    // (index 0 was drawn: black is a colour here)
    s.blit({ width: 2, height: 2, pixels: new Uint8Array([6, 6, 6, 6]) }, -1, -1);
    expect(s.pixels[0]).toBe(6);
  });

  it('draws a line as Graphics::drawLine does, Bresenham\'s from its first end, each point clipped (graphics/primitives.cpp:28-61)', () => {
    const s = new IndexedScreen(8, 4);
    s.line(0, 0, 4, 2, 9);
    const at = () => [...s.pixels].flatMap((v, i) => (v ? [`${i % 8},${Math.floor(i / 8)}`] : []));
    expect(at()).toEqual(['0,0', '1,0', '2,1', '3,1', '4,2']);
    // (from the other end the error falls the other way: the same line, two points moved)
    s.pixels.fill(0);
    s.line(4, 2, 0, 0, 9);
    expect(at()).toEqual(['0,0', '1,1', '2,1', '3,2', '4,2']);
    // (steep, and partly off the screen: only the screen's points)
    s.pixels.fill(0);
    s.line(6, -2, 7, 5, 9);
    expect(at()).toEqual(['6,0', '6,1', '7,2', '7,3']);
  });

  it('shows itself through the palette, opaque', () => {
    const s = new IndexedScreen(2, 1);
    s.pixels.set([1, 2]);
    const p = new Palette();
    p.setEntry(1, [10, 20, 30]);
    p.setEntry(2, [40, 50, 60]);
    const out = new Uint8ClampedArray(8);
    s.toRgba(p, out);
    expect([...out]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });
});

describe('BitmapFont', () => {
  it('draws a one-bit font in the colour it is given, advancing by each glyph\'s width', () => {
    // 'A' (0x41): a box with a hole; ' ' (0x20): blank. First character 0x20, so glyphs are 0x20, 0x21, ... 0x41.
    const glyphs = Array.from({ length: 0x22 }, (_, i) => (i === 0x21 ? [0xe0, 0xa0, 0xe0] : [0, 0, 0]));
    const widths = Array.from({ length: 0x22 }, (_, i) => (i === 0x21 ? 4 : 3));
    const font = new BitmapFont(fontFile({ height: 3, start: 0x20, glyphs, widths }));
    expect(font.height).toBe(3);
    expect(font.stringWidth('A A')).toBe(11);
    expect(font.charWidth(0x7f)).toBe(0);
    const s = new IndexedScreen(12, 3);
    s.drawString(font, 0, 0, 'A A', 0x55);
    const row = (y: number) => [...s.pixels.subarray(y * 12, y * 12 + 11)].map(v => (v ? 1 : 0)).join('');
    expect([row(0), row(1), row(2)]).toEqual(['11100001110', '10100001010', '11100001110']);
    // (a character the font lacks is drawn as a space and advances by nothing: charWidth is 0 outside the font)
    const t = new IndexedScreen(12, 3);
    t.drawString(font, 0, 0, 'A\x01A', 0x55);
    expect([...t.pixels.subarray(0, 11)].map(v => (v ? 1 : 0)).join('')).toBe('11101110000');
  });

  it('copies a colour font\'s glyphs as they are, backgrounds and all, clipped at the edges', () => {
    const font = new BitmapFont(fontFile({ height: 2, start: 0x20, glyphs: [[1, 2, 3, 4]], widths: [2], colour: true, pitch: 2 }));
    const s = new IndexedScreen(3, 2);
    s.drawString(font, 1, 0, '  ', 0);
    expect([...s.pixels]).toEqual([0, 1, 2, 0, 3, 4]);
    s.drawString(font, -1, 0, ' ', 0);
    expect([s.pixels[0], s.pixels[3]]).toEqual([2, 4]);
  });

  it('refuses a file that is not a font', () => {
    expect(() => new BitmapFont(new Uint8Array([2, 8, 32, 40, 9, 0, 0, 0, 0]))).toThrow(/unknown font file kind/);
    expect(() => new BitmapFont(new Uint8Array(4))).toThrow(/at least 9 bytes/);
  });
});
