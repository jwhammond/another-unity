// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from './assets';
import { ASTRO_FONT, FONT_CLEAR, loadAstroFonts, textImage, wrapInfo } from './bitmapText';
import { BitmapFont } from './indexed';
import type { PresentationConfig } from './package';

/** A colour font: 4-wide glyphs `height` tall, each glyph's pixels `ink` on the clear ground (128), the first column of the first row `edge`. */
function colourFont(height: number, ink: number, edge = ink): BitmapFont {
  const size = height * 4;
  const glyph = [4, ...Array.from({ length: size }, (_, i) => (i === 0 ? edge : i % 4 === 0 ? FONT_CLEAR : ink))];
  return new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (size + 1) & 0xff, (size + 1) >> 8, 0, 1, 4, ...Array.from({ length: 0x5f }, () => glyph).flat()]));
}
/** A one-bit font of 4-wide glyphs 2 high: the top row's left two columns. */
function bitFont(): BitmapFont {
  const glyph = [4, 0xc0, 0x00];
  return new BitmapFont(new Uint8Array([1, 2, 0x20, 0x7e, 2, 0, 0, 0, 0, ...Array.from({ length: 0x5f }, () => glyph).flat()]));
}
const palette = Uint8Array.from({ length: 768 }, (_, i) => (i % 3 === 0 ? Math.floor(i / 3) : 0));

describe('textImage', () => {
  it('draws a colour font in its own colours through the palette, and leaves the ground clear', () => {
    const f = colourFont(2, 200, 150);
    const t = textImage(f, 'ab', palette);
    expect([t.width, t.height]).toEqual([8, 2]);
    // (the first glyph's first pixel is its edge colour 150, the second pixel of that row is clear (the column index is 0 mod 4 only at the start), the rest ink)
    expect([...t.data.subarray(0, 4)]).toEqual([150, 0, 0, 255]);
    expect([...t.data.subarray(4, 8)]).toEqual([200, 0, 0, 255]);
    // (the clear ground is transparent)
    const clear = [...t.data].filter((_, i) => i % 4 === 3 && t.data[i] === 0).length;
    expect(clear).toBeGreaterThan(0);
  });
  it('draws the shapes in an ink, each pixel as strong as the font\'s own is bright against the brightest, for a ground the font\'s blues do not read on', () => {
    // two ink colours of the colour font: 200 (bright in this palette) and 100 (half as bright)
    const pal = Uint8Array.from({ length: 768 }, (_, i) => (Math.floor(i / 3) === 200 ? 200 : Math.floor(i / 3) === 100 ? 100 : 0));
    const glyph = [4, 200, 100, 128, 128];
    const f = new BitmapFont(new Uint8Array([1, 1, 0x20, 0x7e, 5, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => glyph).flat()]));
    const t = textImage(f, 'a', pal, 0xff, [4, 16, 30]);
    expect([...t.data.subarray(0, 4)]).toEqual([4, 16, 30, 255]);
    expect([...t.data.subarray(4, 8)]).toEqual([4, 16, 30, 128]);
    // (the clear ground stays clear)
    expect(t.data[11]).toBe(0);
    expect(t.data[15]).toBe(0);
  });
  it('draws a one-bit font in the colour it is given, a palette index or a triple, and the rest clear', () => {
    const f = bitFont();
    const byIndex = textImage(f, 'a', palette, 77);
    expect([...byIndex.data.subarray(0, 4)]).toEqual([77, 0, 0, 255]);
    expect(byIndex.data[3 * 4 + 3]).toBe(0);
    const byRgb = textImage(f, 'a', palette, [10, 20, 30]);
    expect([...byRgb.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...byRgb.data.subarray(4, 8)]).toEqual([10, 20, 30, 255]);
    expect(byRgb.data[2 * 4 + 3]).toBe(0);
    // (the palette is not changed by a triple)
    expect(palette[255 * 3]).toBe(255);
  });
  it('is one clear pixel wide for an empty string, so a canvas can have it', () => {
    expect(textImage(bitFont(), '', palette).width).toBe(1);
  });
});

describe('wrapInfo (AstrogationScreen\'s wrapText)', () => {
  const f = colourFont(2, 200); // 4 pixels a letter
  it('fits what it can in the width, breaking at the last space, which goes', () => {
    expect(wrapInfo(f, 'one two three', 29)).toEqual(['one', 'two', 'three']);
    expect(wrapInfo(f, 'one two three', 100)).toEqual(['one two three']);
    expect(wrapInfo(f, 'aa bb cc dd', 25)).toEqual(['aa bb', 'cc dd']);
    // (the original looks for the space among the characters before the one that overflowed, so a line that ends exactly on a space wraps a word early)
    expect(wrapInfo(f, 'aa bb cc dd', 24)).toEqual(['aa', 'bb', 'cc dd']);
  });
  it('makes a blank line of a new line, and nothing of leading space or an empty text', () => {
    expect(wrapInfo(f, 'ab\ncd', 100)).toEqual(['ab', '', 'cd']);
    expect(wrapInfo(f, '   ab', 100)).toEqual(['ab']);
    expect(wrapInfo(f, '', 100)).toEqual(['']);
    expect(wrapInfo(f, '  \n ', 100)).toEqual(['']);
  });
  it('breaks a word wider than the line where it must', () => {
    const lines = wrapInfo(f, 'abcdefghijkl', 20);
    expect(lines.join('')).toBe('abcdefghijkl');
    expect(lines.every(l => f.stringWidth(l) < 20 + 4)).toBe(true);
  });
});

describe('loadAstroFonts', () => {
  const config = (over: Record<string, unknown> = {}): PresentationConfig => ({ art: { fonts: { files: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'] }, astro: { scale: 4, palette: 'pal', sprites: {} }, ...over } }) as unknown as PresentationConfig;
  const font = new Uint8Array([1, 1, 0x20, 0x20, 2, 0, 0, 0, 0, 4, 0]);
  const urls = [['f0', 'u0'], ['f1', 'u1'], ['f2', 'u2'], ['f3', 'u3'], ['f4', 'u4'], ['f5', 'u5'], ['pal', 'up']] as [string, string][];
  const fetchBytes = async (url: string) => (url === 'up' ? new Uint8Array(768) : font);
  it('loads the fonts astrogation draws in, and the screen\'s palette', async () => {
    const loaded = await loadAstroFonts(config(), new AssetIndex(urls), fetchBytes);
    expect(loaded!.fonts).toHaveLength(Math.max(...Object.values(ASTRO_FONT)) + 1);
    expect(loaded!.palette).toHaveLength(768);
  });
  it('is null when not published, a file is missing from the assets, or there are fonts short', async () => {
    expect(await loadAstroFonts({} as PresentationConfig, new AssetIndex(urls), fetchBytes)).toBeNull();
    expect(await loadAstroFonts(config({ astro: { scale: 4, sprites: {} } }), new AssetIndex(urls), fetchBytes)).toBeNull();
    expect(await loadAstroFonts(config(), new AssetIndex(urls.filter(([k]) => k !== 'f4')), fetchBytes)).toBeNull();
    expect(await loadAstroFonts(config({ fonts: { files: ['f0', 'f1'] } }), new AssetIndex(urls), fetchBytes)).toBeNull();
  });
});
