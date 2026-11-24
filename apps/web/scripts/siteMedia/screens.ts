// SPDX-License-Identifier: GPL-3.0-or-later
// The ship screens that have no single plate (engineering, the holodeck), drawn in node by the engine's own pure renderers: the original's packed
// indexed pictures and fonts on an IndexedScreen, in the original's palette. No browser. docs/site.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { shipDataSchema } from '../../../../engine/src/content/schema';
import type { ShipContent } from '../../../../engine/src/content/types';
import { newSystems } from '../../../../engine/src/sim/shipSystems';
import { AssetIndex } from '../../../../engine/src/view/assets';
import { loadEngineeringArt } from '../../../../engine/src/view/engineeringArt';
import { BACKGROUND, drawEngineering, newUi, updateColours } from '../../../../engine/src/view/engineeringLayout';
import { drawHolodeck, loadHolodeckArt } from '../../../../engine/src/view/holodeckArt';
import { IndexedScreen, SCREEN_H, SCREEN_W, type Palette } from '../../../../engine/src/view/indexed';
import type { PresentationConfig } from '../../../../engine/src/view/package';
import type { Rgba } from '../../../../tools/art/src/image';

/** A screen's indices as an opaque picture in `palette`'s colours. */
export function toPicture(screen: IndexedScreen, palette: Palette): Rgba {
  const data = new Uint8Array(screen.width * screen.height * 4);
  screen.toRgba(palette, data);
  return { width: screen.width, height: screen.height, data };
}

/** The game's files read from disk: every path the presentation names maps to its file, and a fetch is a read. */
function fromDisk(gameDir: string, config: PresentationConfig): { assets: AssetIndex; fetchBytes: (url: string) => Promise<Uint8Array> } {
  const art = (config.art ?? {}) as { engineering?: { pack: string; palette: string }; holodeck?: { pack: string; palette: string }; fonts?: { files: string[] } };
  const paths = [art.engineering?.pack, art.engineering?.palette, art.holodeck?.pack, art.holodeck?.palette, ...(art.fonts?.files ?? [])].filter((p): p is string => !!p);
  return {
    assets: new AssetIndex(paths.map(p => [p, join(gameDir, p)] as [string, string])),
    fetchBytes: async url => new Uint8Array(readFileSync(url)),
  };
}

const presentationOf = (gameDir: string): PresentationConfig => parse(readFileSync(join(gameDir, 'presentation.yaml'), 'utf8')) as PresentationConfig;

/** The engineering screen on its Power page as a new game has it (every unit as the executable sets it), palette rotation applied once. Null when the art is not published. */
export async function renderEngineering(gameDir: string): Promise<Rgba | null> {
  const config = presentationOf(gameDir);
  const { assets, fetchBytes } = fromDisk(gameDir, config);
  const art = await loadEngineeringArt(config, assets, fetchBytes);
  if (!art) return null;
  const data = shipDataSchema.parse(parse(readFileSync(join(gameDir, 'ship.yaml'), 'utf8')));
  const units = data.units;
  const ship = { units, systems: newSystems({ data: { units } } as unknown as ShipContent) };
  const ui = newUi(true);
  const screen = new IndexedScreen(SCREEN_W, SCREEN_H);
  screen.set(art.images[BACKGROUND]!);
  const palette = art.palette.clone();
  updateColours(palette, art, ui, ship, 0);
  drawEngineering(screen, art, ui, ship);
  return toPicture(screen, palette);
}

/** How many of the movie map's titles the holodeck's dialog lists in the picture: the first screenful of a player's early game. */
export const HOLODECK_TITLES = 8;

/** The holodeck: holodeck.rm with the original's choice dialog over it, listing the first movies of the movie map. Null when the art is not published. */
export async function renderHolodeck(gameDir: string): Promise<Rgba | null> {
  const config = presentationOf(gameDir);
  const { assets, fetchBytes } = fromDisk(gameDir, config);
  const art = await loadHolodeckArt(config, assets, fetchBytes);
  if (!art) return null;
  const titles = ((config as unknown as { movieMap?: { title: string }[] }).movieMap ?? []).slice(0, HOLODECK_TITLES).map(m => m.title);
  const screen = new IndexedScreen(SCREEN_W, SCREEN_H);
  drawHolodeck(screen, art, titles, 0, -1);
  return toPicture(screen, art.palette);
}
