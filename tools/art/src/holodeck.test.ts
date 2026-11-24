// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DIALOG_ENTRIES, holodeckPictures, publishHolodeck } from './holodeck';
import { loadHolodeckArt } from '../../../engine/src/view/holodeckArt';
import { AssetIndex } from '../../../engine/src/view/assets';
import { parsePack } from '../../../engine/src/view/indexed';
import type { PresentationConfig } from '../../../engine/src/view/package';

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
const holoRm = (): Uint8Array => { const b = new Uint8Array(128 * 3 + 640 * 480); for (let i = 0; i < 640; i++) b[128 * 3 + i] = i & 0x7f; return b; };
const standard = new Uint8Array(128 * 3).fill(7);
const font = new Uint8Array([1, 1, 0x20, 0x7e, 5, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, 1, 1, 1, 1]).flat()]);

describe('holodeckPictures', () => {
  it('are holodeck.rm (its 128 colours under standard.pal) and then dialog.mrg\'s 31 entries, so entry i is the pack\'s i + 1', () => {
    const { images, palette } = holodeckPictures(holoRm(), fakeMrg(DIALOG_ENTRIES), standard);
    expect(images).toHaveLength(1 + DIALOG_ENTRIES);
    expect([...images[0]!.pixels.subarray(0, 3)]).toEqual([0, 1, 2]);
    expect([images[1]!.width, images[1]!.height, images[1]!.pixels[0]]).toEqual([3, 2, 20]);
    expect(palette[128 * 3]).toBe(28);
  });
  it('refuses a dialog.mrg without its 31 entries', () => {
    expect(() => holodeckPictures(holoRm(), fakeMrg(30), standard)).toThrow(/30 entries, not 31/);
  });
});

describe('publishHolodeck', () => {
  it('writes the pack, palette and fonts and the two keys, leaving the other art alone, and the engine reads it back', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'holodeck-'));
    await writeFile(join(tmp, 'presentation.yaml'), 'art:\n  engineering:\n    pack: art/engineering/engineering.pack\n    palette: x\n    tables: {}\n');
    const written = await publishHolodeck(tmp, { rm: holoRm(), dialog: fakeMrg(DIALOG_ENTRIES), standardPal: standard, fonts: Array.from({ length: 10 }, () => font) });
    expect(written).toHaveLength(12);
    const doc = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: Record<string, any> };
    expect(doc.art.engineering.pack).toBe('art/engineering/engineering.pack');
    expect(doc.art.holodeck).toEqual({ pack: 'art/holodeck/holodeck.pack', palette: 'art/holodeck/palette.rgb' });
    expect(doc.art.fonts.files).toHaveLength(10);
    expect(parsePack(new Uint8Array(await readFile(join(tmp, doc.art.holodeck.pack))))).toHaveLength(1 + DIALOG_ENTRIES);
    const paths = [doc.art.holodeck.pack, doc.art.holodeck.palette, ...doc.art.fonts.files] as string[];
    const bytes = new Map<string, Uint8Array>();
    for (const p of paths) bytes.set(p, new Uint8Array(await readFile(join(tmp, p))));
    const art = await loadHolodeckArt({ art: doc.art } as unknown as PresentationConfig, new AssetIndex(paths.map(p => [p, p] as [string, string])), async url => bytes.get(url)!);
    expect(art!.frames).toHaveLength(31);
  });
});
