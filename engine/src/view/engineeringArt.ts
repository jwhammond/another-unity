// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from './assets';
import { BitmapFont, parsePack, Palette } from './indexed';
import { INFO_FONT, LABEL_FONT, PACK_ENTRIES, type EngineeringArt } from './engineeringLayout';
import type { PresentationConfig } from './package';

/** The engineering screen's published pictures, loaded: what the layout draws with, and the palette it starts from (a screen copies it, as it rotates). */
export interface LoadedEngineeringArt extends EngineeringArt { palette: Palette }

/**
 * Loads `art.engineering` (`art engineering publish`) and the fonts it is drawn in: null when it is not published, a file is missing from the
 * game's assets, or the pack lacks a picture the screen draws. `fetchBytes` is the browser's fetch of a URL, or a test's.
 */
export async function loadEngineeringArt(config: PresentationConfig, assets: AssetIndex, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<LoadedEngineeringArt | null> {
  const eng = config.art?.engineering;
  const fonts = config.art?.fonts;
  if (eng === undefined || fonts === undefined) return null;
  const packUrl = assets.url(eng.pack), paletteUrl = assets.url(eng.palette);
  const fontUrls = fonts.files.map(f => assets.url(f));
  if (packUrl === undefined || paletteUrl === undefined || fontUrls.some(u => u === undefined) || fontUrls.length <= Math.max(INFO_FONT, LABEL_FONT)) return null;
  const [pack, palette, ...fontFiles] = await Promise.all([packUrl, paletteUrl, ...(fontUrls as string[])].map(fetchBytes));
  const images = parsePack(pack!);
  if (images.length < PACK_ENTRIES || palette!.length < 256 * 3) return null;
  return { images, tables: eng.tables, fonts: fontFiles.map(f => new BitmapFont(f)), palette: new Palette(palette!) };
}
