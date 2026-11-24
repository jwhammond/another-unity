// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from './assets';
import { loadEngineeringArt } from './engineeringArt';
import { PACK_ENTRIES } from './engineeringLayout';
import { writePack } from './indexed';
import type { PresentationConfig } from './package';

const tables = { sliders: [{ x: 1, y: 2, flags: 0x11 }], labels: [], rows: [], shieldOrder: [0, 1], paletteIndex: [1] };
const config = (over: Record<string, unknown> = {}): PresentationConfig => ({
  art: { engineering: { pack: 'art/engineering/engineering.pack', palette: 'art/engineering/palette.rgb', tables }, fonts: { files: ['art/fonts/font0.fon', 'art/fonts/font1.fon', 'art/fonts/font2.fon'] }, ...over },
}) as unknown as PresentationConfig;
const files = (): Record<string, Uint8Array> => ({
  'u/pack': writePack(Array.from({ length: PACK_ENTRIES }, () => ({ width: 1, height: 1, pixels: new Uint8Array([7]) }))),
  'u/pal': new Uint8Array(768).fill(9),
  'u/f0': new Uint8Array([1, 3, 0x20, 0x20, 3, 0, 0, 0, 0, 4, 0, 0, 0]),
});
const assets = new AssetIndex([
  ['art/engineering/engineering.pack', 'u/pack'], ['art/engineering/palette.rgb', 'u/pal'],
  ['art/fonts/font0.fon', 'u/f0'], ['art/fonts/font1.fon', 'u/f0'], ['art/fonts/font2.fon', 'u/f0'],
]);
const fetchOf = (f: Record<string, Uint8Array>) => async (url: string) => { const b = f[url]; if (!b) throw new Error(`no ${url}`); return b; };

describe('loadEngineeringArt', () => {
  it('loads the pack, the palette, the tables and the fonts', async () => {
    const art = await loadEngineeringArt(config(), assets, fetchOf(files()));
    expect(art!.images).toHaveLength(PACK_ENTRIES);
    expect(art!.palette.rgb[0]).toBe(9);
    expect(art!.tables).toEqual(tables);
    expect(art!.fonts).toHaveLength(3);
  });
  it('is null when it is not published, a file is not in the assets, or the pack lacks pictures', async () => {
    expect(await loadEngineeringArt({} as PresentationConfig, assets, fetchOf(files()))).toBeNull();
    expect(await loadEngineeringArt(config({ fonts: undefined }), assets, fetchOf(files()))).toBeNull();
    expect(await loadEngineeringArt(config(), new AssetIndex([['art/engineering/engineering.pack', 'u/pack']]), fetchOf(files()))).toBeNull();
    expect(await loadEngineeringArt(config({ fonts: { files: ['art/fonts/font0.fon'] } }), assets, fetchOf(files()))).toBeNull();
    const short = files();
    short['u/pack'] = writePack([{ width: 1, height: 1, pixels: new Uint8Array([1]) }]);
    expect(await loadEngineeringArt(config(), assets, fetchOf(short))).toBeNull();
  });
  it('lets a failed fetch reject', async () => {
    await expect(loadEngineeringArt(config(), assets, fetchOf({}))).rejects.toThrow(/no u/);
  });
});
