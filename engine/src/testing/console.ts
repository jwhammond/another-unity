// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConsoleTextName } from '../content/types';
import { BitmapFont, type IndexedImage } from '../view/indexed';
import type { ConsoleArt } from '../view/combat/console';

/** space.mrg's entry count the console draws from (its last, 136, a scanner digit's): the fixture has as many. */
export const CONSOLE_IMAGES = 137;

/** A one-bit font whose every glyph, space to ~, is a solid 3x3 block, 4 wide: a pixel at (x, y) says a string reached it. */
export function blockFont(): BitmapFont {
  const glyphs = Array.from({ length: 0x5f }, () => [0xe0, 0xe0, 0xe0]);
  return new BitmapFont(new Uint8Array([1, 3, 0x20, 0x7e, 3, 0, 0, 0, 0, ...glyphs.flatMap(g => [4, ...g])]));
}

/** Made-up console words (combat.yaml's are kConsoleText, Plan 27 R15), one a format as `power` is. */
export const MINI_CONSOLE_TEXT: Readonly<Record<ConsoleTextName, string>> = Object.freeze({
  megawatts: 'Q', lightspeed: 'q', alien: '-Oddity-', power: '=%3.2f=', kilometres: 'J', mark: 'j', colon: '|',
});

/** The colour the fixture's space.mrg entry `i` is filled with: one of its own, none of the console's colours (0x82-0xaf) or 0, 1 and 13. */
export const imageColour = (i: number): number => (i < 112 ? 16 + i : 64 + i);

/**
 * A made-up console: the plate all colour 1; each space.mrg entry `i` a block of imageColour(i) (`sizes[i]`, else 8 x 6), so a
 * pixel says which picture was drawn there; a grey palette (entry i is (i, i, i)); block fonts as the status and maneuver fonts.
 */
export function miniConsoleArt(o: { sizes?: Record<number, [number, number]>; fonts?: boolean; text?: boolean } = {}): ConsoleArt {
  const block = (w: number, h: number, colour: number): IndexedImage => ({ width: w, height: h, pixels: new Uint8Array(w * h).fill(colour) });
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) palette.set([i, i, i], i * 3);
  return {
    plate: block(640, 480, 1),
    images: Array.from({ length: CONSOLE_IMAGES }, (_, i) => block(o.sizes?.[i]?.[0] ?? 8, o.sizes?.[i]?.[1] ?? 6, imageColour(i))),
    palette,
    fonts: o.fonts === false ? null : [blockFont(), blockFont(), blockFont()],
    text: o.text === false ? null : MINI_CONSOLE_TEXT,
  };
}
