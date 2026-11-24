// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { engineeringPictures, engineeringTables, publishEngineering } from './engineering';
import { backgroundIndexed } from './indexedart';
import { parsePack } from '../../../engine/src/view/indexed';
import { loadEngineeringArt } from '../../../engine/src/view/engineeringArt';
import { AssetIndex } from '../../../engine/src/view/assets';
import type { PresentationConfig } from '../../../engine/src/view/package';
import { PACK_ENTRIES } from '../../../engine/src/view/engineeringLayout';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** An MRG of `n` entries, each 3x2, entry i filled with index 20 + i. */
function fakeMrg(n: number): Uint8Array {
  const header = 2 + n * 4;
  const bytes = new Uint8Array(header + n * 10);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, n, true);
  for (let i = 0; i < n; i++) {
    const off = header + i * 10;
    dv.setUint32(2 + i * 4, off, true);
    dv.setUint16(off, 3, true);
    dv.setUint16(off + 2, 2, true);
    bytes.fill(20 + i, off + 4, off + 10);
  }
  return bytes;
}
/** A .pic: 256 six-bit colours, then the 640 x 480 indices, the first row being 0 1 2 ... */
function fakePic(): Uint8Array {
  const bytes = new Uint8Array(768 + 640 * 480);
  for (let i = 0; i < 768; i++) bytes[i] = i % 64;
  for (let x = 0; x < 640; x++) bytes[768 + x] = x & 0xff;
  return bytes;
}
const standard = new Uint8Array(128 * 3);

/** A bound LE image whose data object holds the engineering tables at the executable's offsets. */
function fakeOvl(): Uint8Array {
  const base = 0x400;
  const bytes = new Uint8Array(base + 0x75000);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  dv.setUint32(0x3c, 0x100, true);
  bytes.set([0x4c, 0x45], 0x100);
  dv.setUint32(0x100 + 0x28, 16, true);
  dv.setUint32(0x100 + 0x40, 0x40, true);
  dv.setUint32(0x100 + 0x44, 2, true);
  dv.setUint32(0x100 + 0x80, base, true);
  dv.setUint32(0x100 + 0x40 + 24 + 12, 1, true);
  let pool = 0x74000;
  const put = (text: string): number => { const at = pool; for (const c of text) bytes[base + pool++] = c.charCodeAt(0); bytes[base + pool++] = 0; return at; };
  for (let i = 0; i < 70; i++) {
    const at = base + 0x71364 + i * 0x30 + 0x10;
    dv.setInt32(at, 100 + i, true);
    dv.setInt32(at + 4, 20 + i, true);
    dv.setUint32(at + 8, i & 1 ? 0x21 : 0x11, true);
  }
  for (let i = 0; i < 59; i++) {
    const at = base + 0x721ac + i * 0x14;
    [10 + i, 20 + i, 50 + i, 30 + i].forEach((v, k) => dv.setInt32(at + k * 4, v, true));
    dv.setUint32(at + 16, put(`Label ${i}`), true);
  }
  for (let i = 0; i < 38; i++) [i, i + 1, i + 2, i + 3].forEach((v, k) => dv.setInt16(base + 0x728f4 + i * 8 + k * 2, v, true));
  for (let i = 0; i < 8; i++) dv.setUint32(base + 0x74bac + i * 4, 7 - i, true);
  for (let i = 0; i < 35; i++) dv.setInt32(base + 0x72a28 + i * 0x9c + 0x2c, 1 + (i % 9), true);
  return bytes;
}

describe('engineeringTables', () => {
  const t = engineeringTables(fakeOvl());
  it('reads the 70 sliders\' corners and flags, 59 labels with their words, 38 row frames, the shields\' order and the schematics\' colours', () => {
    expect(t.sliders).toHaveLength(70);
    expect(t.sliders[3]).toEqual({ x: 103, y: 23, flags: 0x21 });
    expect(t.sliders[0]).toEqual({ x: 100, y: 20, flags: 0x11 });
    expect(t.labels).toHaveLength(59);
    expect(t.labels[5]).toEqual({ rect: [15, 25, 55, 35], text: 'Label 5' });
    expect(t.rows).toHaveLength(38);
    expect(t.rows[10]).toEqual([10, 11, 12, 13]);
    expect(t.shieldOrder).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(t.paletteIndex).toHaveLength(35);
    expect(t.paletteIndex.slice(7, 11)).toEqual([8, 9, 1, 2]);
  });
});

describe('the pictures', () => {
  it('are the background (a .pic has all 256 colours of its own) and then each MRG entry, so entry i is the pack\'s i + 1', () => {
    const { images, palette } = engineeringPictures(fakePic(), fakeMrg(41), standard);
    expect(images).toHaveLength(PACK_ENTRIES);
    expect(images[0]!.width).toBe(640);
    expect([...images[0]!.pixels.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([images[1]!.width, images[1]!.height, images[1]!.pixels[0]]).toEqual([3, 2, 20]);
    expect(images[41]!.pixels[5]).toBe(60);
    // (6-bit entries shifted left by two)
    expect([...palette.subarray(0, 3)]).toEqual([0, 4, 8]);
    expect(palette).toHaveLength(768);
  });
  it('take a .rm\'s lower half of the palette from it and the upper from standard.pal', () => {
    const rm = new Uint8Array(128 * 3 + 640 * 480).fill(5);
    const pal = new Uint8Array(128 * 3).fill(9);
    const { palette, image } = backgroundIndexed(rm, pal, 'holodeck.rm');
    expect(palette[0]).toBe(20);
    expect(palette[128 * 3]).toBe(36);
    expect(image.pixels[0]).toBe(5);
    expect(() => backgroundIndexed(new Uint8Array(10), pal, 'x.rm')).toThrow(/need/);
  });
});

describe('publishEngineering', () => {
  it('writes the pack, palette and fonts under art/ and the keys in presentation.yaml, leaving its other art alone, and what it writes loads', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'engineering-'));
    await writeFile(join(tmp, 'presentation.yaml'), 'music:\n  w: old\nart:\n  astro:\n    scale: 4\n    sprites: {}\n');
    const font = new Uint8Array([1, 3, 0x20, 0x20, 3, 0, 0, 0, 0, 4, 0, 0, 0]);
    const written = await publishEngineering(tmp, { pic: fakePic(), mrg: fakeMrg(41), ovl: fakeOvl(), standardPal: standard, fonts: Array.from({ length: 10 }, () => font) });
    expect(written).toHaveLength(12);
    const doc = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { music: unknown; art: Record<string, any> };
    expect(doc.music).toEqual({ w: 'old' });
    expect(doc.art.astro).toEqual({ scale: 4, sprites: {} });
    expect(doc.art.engineering.pack).toBe('art/engineering/engineering.pack');
    expect(doc.art.engineering.tables.sliders).toHaveLength(70);
    expect(doc.art.fonts.files).toHaveLength(10);
    expect(parsePack(new Uint8Array(await readFile(join(tmp, doc.art.engineering.pack))))).toHaveLength(PACK_ENTRIES);
    // (and the engine reads it back)
    const bytes = new Map<string, Uint8Array>();
    const paths = [doc.art.engineering.pack, doc.art.engineering.palette, ...doc.art.fonts.files] as string[];
    for (const p of paths) bytes.set(p, new Uint8Array(await readFile(join(tmp, p))));
    const art = await loadEngineeringArt(doc.art ? ({ art: doc.art } as unknown as PresentationConfig) : ({} as PresentationConfig), new AssetIndex(paths.map(p => [p, p] as [string, string])), async url => bytes.get(url)!);
    expect(art!.images).toHaveLength(PACK_ENTRIES);
    expect(art!.tables.shieldOrder).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });
});
