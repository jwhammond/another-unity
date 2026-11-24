// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from './assets';
import { BitmapFont, IndexedScreen } from './indexed';
import type { PresentationConfig } from './package';

/**
 * Text in the game's own bitmap fonts as pictures (graphics.cpp drawString), for screens whose backgrounds are not the original's pixels: astrogation's text
 * lies over a repainted plate, so what a glyph does not draw is clear rather than the colour fonts' black ground.
 */

/** The colour fonts' background (the upper palette's black, index 128): a glyph's pixels of it are clear. */
export const FONT_CLEAR = 128;

/** astrogation.cpp's fonts (kFontMap, kFontInfo, kFontLabel): font0.fon (a one-bit font, 8 high), font2.fon (16) and font4.fon (19). */
export const ASTRO_FONT = { map: 0, info: 2, label: 4 } as const;
export type AstroFace = keyof typeof ASTRO_FONT;

export interface TextImage { width: number; height: number; data: Uint8ClampedArray }

/**
 * The string as RGBA pixels at the original's size. A one-bit font draws in `colour`, a palette index or an RGB triple; a colour font in its own colours,
 * which are indices into `palette` (256 colours, 8 bits each). With `ink` the shapes are that colour instead, each pixel as strong as it is bright.
 */
export function textImage(font: BitmapFont, text: string, palette: Uint8Array, colour: number | readonly [number, number, number] = 0xff, ink?: readonly [number, number, number]): TextImage {
  const width = Math.max(font.stringWidth(text), 1), height = font.height;
  const screen = new IndexedScreen(width, height);
  screen.pixels.fill(FONT_CLEAR);
  // (a triple is drawn as a colour of its own, in a copy of the palette: index 255 is the last, which no font glyph uses for itself)
  const own = typeof colour === 'number' ? palette : (() => { const p = palette.slice(); p.set(colour, 255 * 3); return p; })();
  screen.drawString(font, 0, 0, text, typeof colour === 'number' ? colour : 255);
  const data = new Uint8ClampedArray(width * height * 4);
  const bright = (index: number): number => 0.3 * own[index * 3]! + 0.59 * own[index * 3 + 1]! + 0.11 * own[index * 3 + 2]!;
  // (with an ink, each pixel is that colour at the strength of its own brightness against the brightest in the text: the letters' shapes in a colour that reads on the ground)
  let top = 1;
  if (ink) for (let i = 0; i < width * height; i++) if (screen.pixels[i] !== FONT_CLEAR) top = Math.max(top, bright(screen.pixels[i]!));
  for (let i = 0; i < width * height; i++) {
    const index = screen.pixels[i]!;
    if (index === FONT_CLEAR) continue;
    if (ink) data.set([ink[0], ink[1], ink[2], Math.round(255 * Math.min(1, bright(index) / top))], i * 4);
    else data.set([own[index * 3]!, own[index * 3 + 1]!, own[index * 3 + 2]!, 255], i * 4);
  }
  return { width, height, data };
}

/**
 * The info panel's wrapping (AstrogationScreen's wrapText, astrogation.cpp:1280-1318, in the info font): the lines that fit `maxWidth`, breaking at the last
 * space, and a new line in the text making a blank line.
 */
export function wrapInfo(font: BitmapFont, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  let p = 0;
  while (p < text.length && isSpace(text[p])) p++;
  if (p >= text.length) return [''];
  while (p < text.length) {
    let n = 1;
    let q = p;
    for (;;) {
      if (font.stringWidth(text.slice(p, p + n)) >= maxWidth) break;
      n++;
      q++;
      if (q >= text.length || text[q] === '\r' || text[q] === '\n') break;
    }
    let length = n - 1;
    const newLine = text[q] === '\r' || text[q] === '\n';
    if (q < text.length && !newLine) {
      // break at the last space, which goes
      let k = n - 2;
      while (k > 0 && !isSpace(text[p + k])) k--;
      length = k ? k : Math.max(n - 3, 1);
    }
    length = Math.max(length, 1);
    lines.push(text.slice(p, p + length));
    p += length;
    // (and a new line makes a blank line)
    if (newLine) lines.push('');
    while (p < text.length && isSpace(text[p])) p++;
  }
  return lines;
}

/** The fonts astrogation draws in, loaded, with the screen's palette. */
export interface AstroFonts { fonts: readonly BitmapFont[]; palette: Uint8Array }

/**
 * Loads `art.fonts` and `art.astro.palette` (`art astro publish`): null when they are not published, a file is missing from the game's assets, or the
 * fonts lack one the screen draws in. `fetchBytes` is the browser's fetch of a URL, or a test's.
 */
export async function loadAstroFonts(config: PresentationConfig, assets: AssetIndex, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<AstroFonts | null> {
  const files = config.art?.fonts?.files;
  const palette = config.art?.astro?.palette;
  if (files === undefined || palette === undefined) return null;
  const wanted = Math.max(...Object.values(ASTRO_FONT)) + 1;
  const urls = files.slice(0, wanted).map(f => assets.url(f));
  const paletteUrl = assets.url(palette);
  if (paletteUrl === undefined || urls.length < wanted || urls.some(u => u === undefined)) return null;
  const [pal, ...fonts] = await Promise.all([paletteUrl, ...(urls as string[])].map(fetchBytes));
  if (pal!.length < 256 * 3) return null;
  return { fonts: fonts.map(f => new BitmapFont(f)), palette: pal! };
}
