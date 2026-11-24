// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The astrogation screen's tables from the game's executable (STTNG.OVL, a DOS/4G bound LE image; data.cpp loadExecutableData and
 * findDataObjectOffset, origdata.h offsets): the labels, messages and alignment names, the planet classes' sizes and descriptions, the
 * planet numerals, the stars' magnitudes and the map's palette colours. The raw export's executable.json does not carry them. They are
 * game data and are published with the astrogation sprites (art astro publish) into the git-ignored presentation.yaml, not into the repository.
 */
const LABELS = 0x69d8c, MESSAGES = 0x69db0, ALIGNMENT_TEXTS = 0x69dc0, ALIGNMENT_COLOURS = 0x69ed0, MAGNITUDES = 0x70574;
const NUMERALS = 0x704fc, DESCRIPTIONS = 0x69e68, SIZES = 0x69ef6;
const NUM_LABELS = 9, NUM_MESSAGES = 4, NUM_ALIGNMENTS = 5, NUM_SPECTRAL = 70, NUM_NUMERALS = 10, NUM_CLASSES = 16;

/** The palette indices astrogation.cpp's colour enum names (kColour*), by the name the map uses. */
export const MAP_COLOURS: Record<string, number> = {
  black: 0x80, crossSection: 0x82, grid: 0x86, sectorBox: 0x8a, starbase: 0x8d, course: 0x90, cursorYZ: 0xa6, destination: 0xa7,
  selectionBox: 0xac, cubeBack: 0xad, cursorXY: 0xae, ticks: 0xc4, cursorXZ: 0xc6, digitZ: 0xc7, digitY: 0xcf, digitX: 0xd3,
};

export interface AstroTables {
  labels: string[];
  messages: string[];
  alignmentTexts: string[];
  alignmentColours: string[];
  magnitudes: number[];
  numerals: string[];
  planetDescriptions: string[];
  planetSizes: { radius: number; spacing: number }[];
  colours: Record<string, string>;
}

/** The file offset of the LE image's data object (findDataObjectOffset). */
export function dataObjectOffset(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let mz = 0; mz + 0x40 < b.length; mz++) {
    if (b[mz] !== 0x4d || b[mz + 1] !== 0x5a) continue;
    const le = mz + dv.getUint32(mz + 0x3c, true);
    if (le + 0x84 > b.length || b[le] !== 0x4c || b[le + 1] !== 0x45) continue;
    const pageSize = dv.getUint32(le + 0x28, true);
    const objectTable = dv.getUint32(le + 0x40, true);
    const numObjects = dv.getUint32(le + 0x44, true);
    const dataPages = dv.getUint32(le + 0x80, true);
    if (numObjects < 2) throw new Error(`unexpected LE object count ${numObjects} in the executable`);
    const pageIndex = dv.getUint32(le + objectTable + 24 + 12, true);
    return mz + dataPages + (pageIndex - 1) * pageSize;
  }
  throw new Error("couldn't find the LE executable in the overlay");
}

const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** `palette` is the 256-colour RGB the screen draws with (screenPalette: 8 bits a channel). */
export function astroTables(ovl: Uint8Array, palette: Uint8Array): AstroTables {
  const base = dataObjectOffset(ovl);
  const dv = new DataView(ovl.buffer, ovl.byteOffset, ovl.byteLength);
  const string = (at: number): string => {
    let end = base + at;
    if (end >= ovl.length) throw new Error(`string pointer ${at} is outside the overlay`);
    while (end < ovl.length && ovl[end] !== 0) end++;
    return String.fromCharCode(...ovl.subarray(base + at, end));
  };
  const pointed = (table: number, n: number): string[] => Array.from({ length: n }, (_, i) => string(dv.getUint32(base + table + i * 4, true)));
  const rgb = (index: number): string => `#${hex(palette[index * 3]!)}${hex(palette[index * 3 + 1]!)}${hex(palette[index * 3 + 2]!)}`;
  return {
    labels: pointed(LABELS, NUM_LABELS),
    messages: pointed(MESSAGES, NUM_MESSAGES),
    alignmentTexts: pointed(ALIGNMENT_TEXTS, NUM_ALIGNMENTS),
    alignmentColours: Array.from({ length: NUM_ALIGNMENTS }, (_, i) => rgb(dv.getUint16(base + ALIGNMENT_COLOURS + i * 2, true))),
    magnitudes: Array.from({ length: NUM_SPECTRAL }, (_, i) => dv.getInt16(base + MAGNITUDES + i * 2, true)),
    numerals: Array.from({ length: NUM_NUMERALS }, (_, i) => string(NUMERALS + i * 5)),
    planetDescriptions: pointed(DESCRIPTIONS, NUM_CLASSES),
    planetSizes: Array.from({ length: NUM_CLASSES }, (_, i) => ({ radius: dv.getInt16(base + SIZES + i * 4, true), spacing: dv.getInt16(base + SIZES + i * 4 + 2, true) })),
    colours: Object.fromEntries(Object.entries(MAP_COLOURS).map(([name, index]) => [name, rgb(index)])),
  };
}
