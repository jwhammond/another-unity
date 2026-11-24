// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { ASTRO_MAP_SPRITES, ASTRO_SPRITES, astroSprites, ENGINE_AT, engineSprites, publishAstro, screenPalette } from './astro';
import { block, comp, sprite, u32 } from './spritefixture';
import { astroTables, dataObjectOffset } from './astrotables';
import { ASTRO_ENGINE_FRAMES, ASTRO_MAP_SPRITES as ENGINE_MAP_SPRITES, ASTRO_PANEL_SPRITES, ASTRO_SPRITES as ENGINE_SPRITES } from '../../../engine/src/ui/faces';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** An MRG of `n` entries, each 2x1: [index 13 (transparent), 128 + entry % 100]. */
function fakeMrg(n: number): Uint8Array {
  const header = 2 + n * 4;
  const bytes = new Uint8Array(header + n * 6);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, n, true);
  for (let i = 0; i < n; i++) {
    const off = header + i * 6;
    dv.setUint32(2 + i * 4, off, true);
    dv.setUint16(off, 2, true);
    dv.setUint16(off + 2, 1, true);
    bytes[off + 4] = 13;
    bytes[off + 5] = 128 + (i % 100);
  }
  return bytes;
}
const standard = new Uint8Array(128 * 3).map((_, i) => i % 64);
const screen = new Uint8Array(640 * 480 + 128 * 3);
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('screenPalette', () => {
  it('puts the screen\'s colours in the lower half and standard.pal in the upper, each shifted left by two', () => {
    const own = new Uint8Array(640 * 480 + 128 * 3);
    own.set([10, 20, 30], 3);
    const pal = screenPalette(own, standard);
    expect([...pal.subarray(3, 6)]).toEqual([40, 80, 120]);
    expect([...pal.subarray(128 * 3, 128 * 3 + 3)]).toEqual([0, 4, 8]);
    expect(() => screenPalette(new Uint8Array(10), standard)).toThrow(/palette/);
  });
});

describe('astroSprites', () => {
  it('names the course panel\'s images (the pressed one of each button too) and the info and display tabs\', scaled up nearest-neighbour', () => {
    // (and entries 1 to 25 odd: the lit view buttons, and the held arrows, pad buttons and exits, each drawn at its button's corner)
    expect(Object.keys(ASTRO_SPRITES).map(Number).sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 84, 85, 86]);
    expect([ASTRO_SPRITES[11], ASTRO_SPRITES[13], ASTRO_SPRITES[15], ASTRO_SPRITES[17], ASTRO_SPRITES[19]]).toEqual(['pad_up_down', 'pad_down_down', 'pad_right_down', 'pad_left_down', 'pad_stop_down']);
    expect(ASTRO_SPRITES[70]).toBe('engage_down');
    expect(ASTRO_SPRITES[86]).toBe('stop_down');
    const s = astroSprites(fakeMrg(93), screen, standard, 4);
    const engage = s.find(x => x.name === 'engage')!;
    expect([engage.image.width, engage.image.height, engage.width, engage.height]).toEqual([8, 4, 2, 1]);
    expect(engage.image.data[3]).toBe(0);
    // entry 84 is colour 128 + 84, the standard palette's 85th
    expect([...engage.image.data.subarray(16, 20)]).toEqual([...[84 * 3, 84 * 3 + 1, 84 * 3 + 2].map(v => (v % 64) << 2), 255]);
  });
  it('refuses an MRG without those entries', () => {
    expect(() => astroSprites(fakeMrg(79), screen, standard)).toThrow(/entry 79 \(buoy\)/);
  });
});

describe('the sprites the engine looks for', () => {
  it('are the ones this publishes, by name', () => {
    expect([...Object.values(ASTRO_MAP_SPRITES)].sort()).toEqual([...ENGINE_MAP_SPRITES].sort());
    // (the tab strips and the Display tab's swatches are astro.mrg's; the course panels are engine.spr's)
    expect([...Object.values(ASTRO_SPRITES)].sort()).toEqual([...ENGINE_SPRITES, ...ASTRO_PANEL_SPRITES.filter(n => !n.startsWith('course_'))].sort());
    const names = engineSprites(fakeEngine(), screen, standard, 1).map(x => x.name);
    expect(names.filter(n => n.startsWith('course_'))).toEqual(ASTRO_PANEL_SPRITES.filter(n => n.startsWith('course_')).sort().reverse());
  });
});

/** An engine.spr: a panel for warp (animation 0) and for impulse (2), five frames of the impulse engine (3) and six of the warp (4). */
function fakeEngine(): Uint8Array {
  const jump = block('JUMP', u32(0));
  const entries = [comp(), jump, comp(), jump, ...Array.from({ length: 5 }, () => comp()), jump, ...Array.from({ length: 6 }, () => comp()), jump];
  return sprite(entries, [0, null, 2, 4, 10]);
}

describe('engineSprites', () => {
  it('names the course panel for each drive and the frames of each engine, coloured with the screen\'s palette and 13 clear', () => {
    const pal = new Uint8Array(128 * 3).map((_, i) => i % 64);
    const all = engineSprites(fakeEngine(), screen, pal, 2);
    expect(all.map(s => s.name)).toEqual(['course_warp', 'course_impulse', ...Array.from({ length: ASTRO_ENGINE_FRAMES.warp }, (_, i) => `engine_warp${i}`), ...Array.from({ length: ASTRO_ENGINE_FRAMES.impulse }, (_, i) => `engine_impulse${i}`)]);
    const first = all[0]!;
    // (the fake's pictures are 2x1 of colours 5 and 6 of the screen's palette, scaled 2x)
    expect([first.width, first.height, first.image.width, first.image.height]).toEqual([2, 1, 4, 2]);
    expect(first.image.data[3]).toBe(255);
    expect(() => engineSprites(sprite([comp(), block('EXIT', [])], [null, null, null, null, null]), screen, pal)).toThrow(/no picture for course_warp/);
  });
  it('are published at the original\'s places: the panels at the panel\'s corner, the frames at the engine\'s', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    await publishAstro(tmp, fakeMrg(93), screen, standard, { ...copyCodec, engine: fakeEngine() });
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { astro: { sprites: Record<string, { image: string; rect: number[] }> } } };
    expect(y.art.astro.sprites.course_impulse.rect).toEqual([384, 24, 2, 1]);
    expect(y.art.astro.sprites.engine_warp5.rect).toEqual([...ENGINE_AT, 2, 1]);
    expect(existsSync(join(tmp, 'art/astro/engine_impulse4.webp'))).toBe(true);
  });
});

describe('the map\'s sprites', () => {
  it('name the stars, hazards, stations and planets by number, and the markers, without clashing with the panel\'s', () => {
    const names = Object.values(ASTRO_MAP_SPRITES);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter(n => Object.values(ASTRO_SPRITES).includes(n))).toEqual([]);
    expect(ASTRO_MAP_SPRITES[32]).toBe('star_class0');
    expect(ASTRO_MAP_SPRITES[38]).toBe('star_class6');
    expect(ASTRO_MAP_SPRITES[53]).toBe('planet0');
    expect(ASTRO_MAP_SPRITES[68]).toBe('planet15');
    expect(ASTRO_MAP_SPRITES[92]).toBe('destination_marker');
    const s = astroSprites(fakeMrg(93), screen, standard, 1);
    expect(s.find(x => x.name === 'planet15')!.width).toBe(2);
  });
});

/** A bound LE image just big enough for the tables: the data object's pages start at 0x400, strings are pooled at 0x71000 of it. */
function fakeOvl(): Uint8Array {
  const base = 0x400;
  const bytes = new Uint8Array(base + 0x72000);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  dv.setUint32(0x3c, 0x100, true);
  bytes.set([0x4c, 0x45], 0x100);
  dv.setUint32(0x100 + 0x28, 16, true);
  dv.setUint32(0x100 + 0x40, 0x40, true);
  dv.setUint32(0x100 + 0x44, 2, true);
  dv.setUint32(0x100 + 0x80, base, true);
  dv.setUint32(0x100 + 0x40 + 24 + 12, 1, true);
  let pool = 0x71000;
  const put = (text: string): number => {
    const at = pool;
    for (const c of text) bytes[base + pool++] = c.charCodeAt(0);
    bytes[base + pool++] = 0;
    return at;
  };
  const pointers = (table: number, texts: string[]) => texts.forEach((t, i) => dv.setUint32(base + table + i * 4, put(t), true));
  pointers(0x69d8c, Array.from({ length: 9 }, (_, i) => `label${i}`));
  pointers(0x69db0, Array.from({ length: 4 }, (_, i) => `message${i}`));
  pointers(0x69dc0, Array.from({ length: 5 }, (_, i) => `alignment${i}`));
  pointers(0x69e68, Array.from({ length: 16 }, (_, i) => `class${i}`));
  for (let i = 0; i < 5; i++) dv.setUint16(base + 0x69ed0 + i * 2, 0x90 + i, true);
  for (let i = 0; i < 70; i++) dv.setInt16(base + 0x70574 + i * 2, i - 20, true);
  for (let i = 0; i < 10; i++) for (const [k, c] of [...'XIV'.slice(0, 1 + (i % 3))].entries()) bytes[base + 0x704fc + i * 5 + k] = c.charCodeAt(0);
  for (let i = 0; i < 16; i++) { dv.setInt16(base + 0x69ef6 + i * 4, 10 + i, true); dv.setInt16(base + 0x69ef6 + i * 4 + 2, 20 + i, true); }
  return bytes;
}

describe('astroTables', () => {
  it('finds the data object of the bound executable', () => {
    expect(dataObjectOffset(fakeOvl())).toBe(0x400);
    expect(() => dataObjectOffset(new Uint8Array(0x200))).toThrow(/LE executable/);
  });
  it('reads the labels, messages, alignments, magnitudes, numerals, descriptions and sizes, and names the map\'s colours from the palette', () => {
    const pal = new Uint8Array(256 * 3);
    pal.set([1, 2, 3], 0x86 * 3);
    pal.set([250, 128, 0], 0x91 * 3);
    const t = astroTables(fakeOvl(), pal);
    expect(t.labels).toHaveLength(9);
    expect(t.labels[8]).toBe('label8');
    expect(t.messages).toEqual(['message0', 'message1', 'message2', 'message3']);
    expect(t.alignmentTexts[4]).toBe('alignment4');
    expect(t.planetDescriptions[15]).toBe('class15');
    expect(t.magnitudes).toHaveLength(70);
    expect(t.magnitudes[0]).toBe(-20);
    expect(t.numerals).toHaveLength(10);
    expect(t.numerals[0]).toBe('X');
    expect(t.planetSizes[3]).toEqual({ radius: 13, spacing: 23 });
    expect(t.colours.grid).toBe('#010203');
    expect(t.alignmentColours[1]).toBe('#fa8000');
  });
  it('is published with the sprites as art.astro.tables, and left out without an executable', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    await publishAstro(tmp, fakeMrg(93), screen, standard, { ...copyCodec, ovl: fakeOvl() });
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { astro: { tables?: { labels: string[] } } } };
    expect(y.art.astro.tables?.labels[0]).toBe('label0');
    await rm(tmp, { recursive: true, force: true });
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    await publishAstro(tmp, fakeMrg(93), screen, standard, copyCodec);
    const none = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { astro: { tables?: unknown } } };
    expect(none.art.astro.tables).toBeUndefined();
  });
});

describe('publishAstro', () => {
  it('writes each sprite and records art.astro: the scale, and each sprite\'s file and rectangle at the original\'s place', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    const written = await publishAstro(tmp, fakeMrg(93), screen, standard, copyCodec);
    expect(written).toHaveLength(Object.keys(ASTRO_SPRITES).length + Object.keys(ASTRO_MAP_SPRITES).length);
    expect(existsSync(join(tmp, 'art/astro/stop_down.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { astro: { scale: number; sprites: Record<string, { image: string; rect: number[] }> } } };
    expect(y.art.astro.scale).toBe(4);
    expect(y.art.astro.sprites.engage).toEqual({ image: 'art/astro/engage.webp', rect: [392, 161, 2, 1] });
    expect(y.art.astro.sprites.slower_down.rect.slice(0, 2)).toEqual([478, 121]);
  });
  it('writes the screen\'s palette and the game\'s fonts, as art.astro.palette and art.fonts, leaving other art alone', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    await writeFile(join(tmp, 'presentation.yaml'), 'art:\n  engineering:\n    pack: art/engineering/engineering.pack\n');
    const font = new Uint8Array([1, 1, 0x20, 0x20, 2, 0, 0, 0, 0, 4, 0]);
    await publishAstro(tmp, fakeMrg(93), screen, standard, { ...copyCodec, fonts: Array.from({ length: 10 }, () => font) });
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { astro: { palette: string }; fonts: { files: string[] }; engineering: { pack: string } } };
    expect(y.art.astro.palette).toBe('art/astro/palette.rgb');
    const palette = new Uint8Array(await readFile(join(tmp, y.art.astro.palette)));
    expect(palette).toHaveLength(768);
    // (the screen's own colours shifted by two, then standard.pal's from 128)
    expect(palette[128 * 3]).toBe((standard[0]! << 2) & 0xff);
    expect(y.art.fonts.files).toHaveLength(10);
    expect(existsSync(join(tmp, 'art/fonts/font4.fon'))).toBe(true);
    expect(y.art.engineering.pack).toBe('art/engineering/engineering.pack');
  });
  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'astro-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishAstro(tmp, fakeMrg(93), screen, standard, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
  });
});
