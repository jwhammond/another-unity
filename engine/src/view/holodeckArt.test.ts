// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from './assets';
import { drawHolodeck, HOLODECK_CANCEL, loadHolodeckArt } from './holodeckArt';
import { IndexedScreen, writePack } from './indexed';
import type { PresentationConfig } from './package';

const config = (over: Record<string, unknown> = {}): PresentationConfig => ({
  art: { holodeck: { pack: 'art/holodeck/holodeck.pack', palette: 'art/holodeck/palette.rgb' }, fonts: { files: ['f0', 'f1', 'f2', 'f3'] }, ...over },
}) as unknown as PresentationConfig;
/** A 1x1 colour font, one glyph for a space. */
const font = (colour: number) => new Uint8Array([1, 1, 0x20, 0x7e, 5, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, colour, colour, colour, colour]).flat()]);
function files(frames = 31): Record<string, Uint8Array> {
  const bg = { width: 640, height: 480, pixels: new Uint8Array(640 * 480).fill(9) };
  return {
    pack: writePack([bg, ...Array.from({ length: frames }, () => ({ width: 2, height: 2, pixels: new Uint8Array(4).fill(1) }))]),
    pal: new Uint8Array(768).fill(3), f2: font(55), f3: font(66), f: font(1),
  };
}
const assets = new AssetIndex([['art/holodeck/holodeck.pack', 'pack'], ['art/holodeck/palette.rgb', 'pal'], ['f0', 'f'], ['f1', 'f'], ['f2', 'f2'], ['f3', 'f3']]);
const fetchOf = (f: Record<string, Uint8Array>) => async (url: string) => { const b = f[url]; if (!b) throw new Error(`no ${url}`); return b; };

describe('loadHolodeckArt', () => {
  it('loads the background, the dialog\'s 31 frames, fonts 2 and 3 and the palette', async () => {
    const art = await loadHolodeckArt(config(), assets, fetchOf(files()));
    expect(art!.background.width).toBe(640);
    expect(art!.frames).toHaveLength(31);
    expect(art!.palette.rgb[0]).toBe(3);
    expect(art!.normal.charWidth(0x41)).toBe(4);
  });
  it('is null when not published, a file is not in the assets, or the pack lacks frames', async () => {
    expect(await loadHolodeckArt({} as PresentationConfig, assets, fetchOf(files()))).toBeNull();
    expect(await loadHolodeckArt(config({ fonts: undefined }), assets, fetchOf(files()))).toBeNull();
    expect(await loadHolodeckArt(config({ fonts: { files: ['f0', 'f1'] } }), assets, fetchOf(files()))).toBeNull();
    expect(await loadHolodeckArt(config(), new AssetIndex([['art/holodeck/holodeck.pack', 'pack']]), fetchOf(files()))).toBeNull();
    expect(await loadHolodeckArt(config(), assets, fetchOf(files(5)))).toBeNull();
  });
});

describe('drawHolodeck', () => {
  it('draws the picture and the dialog over it with the movies as choices, and gives the dialog\'s layout back', async () => {
    const art = (await loadHolodeckArt(config(), assets, fetchOf(files())))!;
    const s = new IndexedScreen();
    s.pixels.fill(77);
    const layout = drawHolodeck(s, art, ['Tour', 'Warp'], 0, 1);
    // (the picture first: far from the dialog it is the background; the dialog's first line is in font 2, the selected second choice in font 3)
    expect(s.pixels[5 * 640 + 5]).toBe(9);
    expect(s.pixels[layout.rects[0]![1] * 640 + layout.rects[0]![0]]).toBe(55);
    expect(s.pixels[layout.rects[1]![1] * 640 + layout.rects[1]![0]]).toBe(66);
    // (and again afresh: the screen is not left with the last frame's highlight)
    drawHolodeck(s, art, ['Tour', 'Warp'], 0, -1);
    expect(s.pixels[layout.rects[1]![1] * 640 + layout.rects[1]![0]]).toBe(55);
  });
  it('has the Bridge button painted on the picture as its cancel rectangle (unity.cpp:413)', () => {
    expect(HOLODECK_CANCEL).toEqual([484, 426, 605, 468]);
  });
});
