// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The engineering screen's own pictures and tables (EngineeringScreen, engineering.cpp), published as the original has them: eng00a.pic (the
 * background, with its whole 256-colour palette), eng01b.mrg's entries over that palette, and from the executable (STTNG.OVL in STTNGINS.ZIP, as
 * astrotables.ts reads the astrogation screen's) the sliders' places and kinds, the labels, the rows' frames, the shields' order and the colour each
 * system has on the schematics. The game's bitmap fonts come with them (the screen's text is drawn in fonts 0 and 2).
 *
 * The screen is drawn at run time from indices (engine/src/view/engineeringLayout.ts), not from coloured pictures: the original's palette
 * rotations make the power bars shimmer and recolour the schematics as systems are damaged, and those are palette changes. Local and git-ignored,
 * like the rest of art/.
 */
import { join } from 'node:path';
import type { IndexedImage } from '../../../engine/src/view/indexed';
import { dataObjectOffset } from './astrotables';
import { backgroundIndexed, publishFonts, publishPack, setArtKey } from './indexedart';
import { parseMrg } from './icon';

// the data object's offsets (origdata.h) and sizes
const SLIDERS = 0x71364, SLIDER_SIZE = 0x30, NUM_SLIDERS = 70;
const LABELS = 0x721ac, LABEL_SIZE = 0x14, NUM_LABELS = 59;
const ROWS = 0x728f4, NUM_ROWS = 38;
const SHIELD_ORDER = 0x74bac, NUM_SHIELDS = 8;
const SHIP_UNITS = 0x72a28, SHIP_UNIT_SIZE = 0x9c, NUM_SHIP_UNITS = 35;

export interface EngineeringTables {
  /** Each slider's top left corner and its flags (0x10 repair, 0x20 power, 0x200 reactor, 0x800 read only, 0x1000 torpedoes). */
  sliders: { x: number; y: number; flags: number }[];
  /** The labels: the rectangle ([left, top, right, bottom], the original's corners, inclusive) and the words. */
  labels: { rect: [number, number, number, number]; text: string }[];
  /** The frames round the rows, inclusive corners [left, top, right, bottom]. */
  rows: [number, number, number, number][];
  /** The shields' order on the screen: the unit each of the first sliders' pairs stands for. */
  shieldOrder: number[];
  /** The palette index that shows each unit on the schematics. */
  paletteIndex: number[];
}

/** The tables from the executable. */
export function engineeringTables(ovl: Uint8Array): EngineeringTables {
  const base = dataObjectOffset(ovl);
  const dv = new DataView(ovl.buffer, ovl.byteOffset, ovl.byteLength);
  const i32 = (at: number): number => dv.getInt32(base + at, true);
  const string = (at: number): string => {
    let end = base + at;
    if (end >= ovl.length) throw new Error(`string pointer ${at} is outside the overlay`);
    while (end < ovl.length && ovl[end] !== 0) end++;
    return String.fromCharCode(...ovl.subarray(base + at, end));
  };
  return {
    sliders: Array.from({ length: NUM_SLIDERS }, (_, i) => {
      const at = SLIDERS + i * SLIDER_SIZE + 0x10;
      return { x: i32(at), y: i32(at + 4), flags: dv.getUint32(base + at + 8, true) };
    }),
    labels: Array.from({ length: NUM_LABELS }, (_, i) => {
      const at = LABELS + i * LABEL_SIZE;
      return { rect: [i32(at), i32(at + 4), i32(at + 8), i32(at + 12)] as [number, number, number, number], text: string(dv.getUint32(base + at + 16, true)) };
    }),
    rows: Array.from({ length: NUM_ROWS }, (_, i) => {
      const at = ROWS + i * 8;
      return [0, 2, 4, 6].map(o => dv.getInt16(base + at + o, true)) as [number, number, number, number];
    }),
    shieldOrder: Array.from({ length: NUM_SHIELDS }, (_, i) => dv.getUint32(base + SHIELD_ORDER + i * 4, true)),
    paletteIndex: Array.from({ length: NUM_SHIP_UNITS }, (_, i) => i32(SHIP_UNITS + i * SHIP_UNIT_SIZE + 0x2c)),
  };
}

export interface EngineeringFiles {
  /** eng00a.pic. */
  pic: Uint8Array;
  /** eng01b.mrg. */
  mrg: Uint8Array;
  /** STTNG.OVL, for the tables. */
  ovl: Uint8Array;
  standardPal: Uint8Array;
  /** font0.fon ... font9.fon, in order. */
  fonts: Uint8Array[];
}

/**
 * The pack's entries: the background, then each of eng01b.mrg's, so MRG entry `i` is pack entry `i + 1`. Returns the pictures and the palette.
 */
export function engineeringPictures(pic: Uint8Array, mrg: Uint8Array, standardPal: Uint8Array): { images: IndexedImage[]; palette: Uint8Array } {
  const { image, palette } = backgroundIndexed(pic, standardPal, 'eng00a.pic');
  return { images: [image, ...parseMrg(mrg).map(e => ({ width: e.width, height: e.height, pixels: e.pixels.slice() }))], palette };
}

/** Publishes the pack, the palette, the tables and the fonts, and records them as presentation.yaml's `art.engineering` and `art.fonts`. */
export async function publishEngineering(gameDir: string, files: EngineeringFiles): Promise<string[]> {
  const { images, palette } = engineeringPictures(files.pic, files.mrg, files.standardPal);
  const tables = engineeringTables(files.ovl);
  const published = await publishPack(gameDir, 'engineering', 'engineering', images, palette);
  const fonts = await publishFonts(gameDir, files.fonts);
  await setArtKey(gameDir, 'engineering', { ...published, tables });
  await setArtKey(gameDir, 'fonts', { files: fonts });
  return [published.pack, published.palette, ...fonts];
}

export const engineeringDir = (gameDir: string): string => join(gameDir, 'art', 'engineering');
