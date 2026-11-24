// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from './assets';
import { HIGHLIGHT_FONT, NORMAL_FONT, drawChoices, layoutChoices, type DialogArt, type DialogLayout, type Rect } from './dialogLayout';
import { BitmapFont, parsePack, Palette, type IndexedImage, type IndexedScreen } from './indexed';
import type { PresentationConfig } from './package';

/** The holodeck's published pictures, loaded: the background, the dialog's frame and fonts, and the palette the screen starts from. */
export interface LoadedHolodeckArt extends DialogArt {
  background: IndexedImage;
  palette: Palette;
}

/** dialog.mrg's entries, which follow the background in the pack. */
const DIALOG_ENTRIES = 31;

/** The Bridge button painted on holodeck.rm, which `runChoice` takes as its cancel rectangle (unity.cpp:413): [x1, y1, x2, y2]. */
export const HOLODECK_CANCEL: Rect = [484, 426, 605, 468];

/**
 * Loads `art.holodeck` (`art holodeck publish`) and the fonts: null when it is not published, a file is missing from the game's assets, or the pack
 * lacks a picture. `fetchBytes` is the browser's fetch of a URL, or a test's.
 */
export async function loadHolodeckArt(config: PresentationConfig, assets: AssetIndex, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<LoadedHolodeckArt | null> {
  const holo = config.art?.holodeck;
  const fonts = config.art?.fonts;
  if (holo === undefined || fonts === undefined) return null;
  const packUrl = assets.url(holo.pack), paletteUrl = assets.url(holo.palette);
  const fontUrls = [NORMAL_FONT, HIGHLIGHT_FONT].map(i => (fonts.files[i] === undefined ? undefined : assets.url(fonts.files[i]!)));
  if (packUrl === undefined || paletteUrl === undefined || fontUrls.some(u => u === undefined)) return null;
  const [pack, palette, normal, highlight] = await Promise.all([packUrl, paletteUrl, ...(fontUrls as string[])].map(fetchBytes));
  const images = parsePack(pack!);
  if (images.length < 1 + DIALOG_ENTRIES || palette!.length < 256 * 3) return null;
  return { background: images[0]!, frames: images.slice(1, 1 + DIALOG_ENTRIES), normal: new BitmapFont(normal!), highlight: new BitmapFont(highlight!), palette: new Palette(palette!) };
}

/** What runHolodeck draws each frame: the picture, then the dialog over it with the movies as its choices. Returns the dialog's layout, for the pointer. */
export function drawHolodeck(screen: IndexedScreen, art: LoadedHolodeckArt, choices: readonly string[], startLine: number, selected: number): DialogLayout {
  screen.set(art.background);
  const layout = layoutChoices(art, choices, startLine);
  drawChoices(screen, art, layout, selected);
  return layout;
}
