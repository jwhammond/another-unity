// SPDX-License-Identifier: GPL-3.0-or-later
import { BUTTONS, IMAGE, PAGE_PICTURES, TAB_IMAGES } from '../../../engine/src/view/combat/console';
import { LIVE_ENTRIES } from '../../../engine/src/view/combat/spaceArt';
import { COLOUR_BLANK, type IndexedImage } from '../../../engine/src/view/indexed';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtCache } from './cache';
import type { Rgba } from './image';
import type { Rect } from './recipe';

/**
 * Tactical's console for the art (Plan 30 R3-R5): spc00a.pic and space.mrg's pictures as tactical draws them, in the space palette
 * (tactical.cpp:264-278: the published space/console.pack and space/space.rgb), the pictures the repaint takes laid out on one atlas,
 * and what comes back cut into pictures again with the original's clear pixels.
 */

/**
 * The pictures repainted with the plate's recipe at 0.45 (Plan 30 R5): the pages' own (kPagePictures, tactical.cpp:136-152), the tabs
 * (kTabImages, :62-64), every button's up and down (kButtons, :90-121) and the pictures that stand in for buttons (:122-134). The rest of
 * space.mrg (the lamps, the salvo marks, the maneuver rows, the scanner pictures, the digits) is upscaled only.
 */
export const REPAINTED: readonly number[] = [...new Set([
  ...PAGE_PICTURES.map(p => p.image),
  ...TAB_IMAGES.flat(),
  ...BUTTONS.flatMap(b => [b.up, b.down]),
  IMAGE.split, IMAGE.hailUp, IMAGE.hailDown, IMAGE.delegateOff, IMAGE.delegateOn, IMAGE.up, IMAGE.upDown, IMAGE.down, IMAGE.downDown, IMAGE.engage, IMAGE.disengage,
])].sort((a, b) => a - b);

/** A picture in the palette's colours; `clear` pixels (a blit's colour 13, Graphics::blit) have alpha 0. */
export function colourPicture(image: IndexedImage, palette: Uint8Array, clear: (index: number) => boolean = () => false): Rgba {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const c = image.pixels[i]!;
    data.set([palette[c * 3]!, palette[c * 3 + 1]!, palette[c * 3 + 2]!, clear(c) ? 0 : 255], i * 4);
  }
  return { width: image.width, height: image.height, data };
}

/** The pixels the console's art never shows (Plan 30 R6, R12): a blit's clear colour and the live palette entries, which the indices draw. */
export const notArt = (index: number): boolean => index === COLOUR_BLANK || LIVE_ENTRIES.has(index);

/** The atlas the pictures are repainted on (Plan 30 R5): 800 x 600, 4:3 as the plate, each picture `GUTTER` px from the next. */
export const ATLAS: [number, number] = [800, 600];
export const GUTTER = 4;

/**
 * Shelves: the pictures tallest first (then widest, then by number), left to right in rows, each `gutter` from its neighbours and the
 * edge. Returns each picture's top-left, by its place in `sizes`; throws if they don't fit.
 */
export function shelfPack(sizes: readonly [number, number][], width: number, height: number, gutter = GUTTER): [number, number][] {
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b]![1] - sizes[a]![1] || sizes[b]![0] - sizes[a]![0] || a - b);
  const out: [number, number][] = new Array(sizes.length);
  let x = gutter, y = gutter, row = 0;
  for (const i of order) {
    const [w, h] = sizes[i]!;
    if (x + w + gutter > width) {
      x = gutter;
      y += row + gutter;
      row = 0;
    }
    if (w + 2 * gutter > width || y + h + gutter > height) throw new Error(`the pictures don't fit a ${width} x ${height} atlas`);
    out[i] = [x, y];
    x += w + gutter;
    row = Math.max(row, h);
  }
  return out;
}

/** The atlas of the repainted pictures, on the space palette's colour 0 (black), with where each one went. */
export function pagesAtlas(images: readonly IndexedImage[], palette: Uint8Array): { atlas: Rgba; places: { image: number; x: number; y: number }[] } {
  const which = REPAINTED.filter(i => images[i]);
  const at = shelfPack(which.map(i => [images[i]!.width, images[i]!.height]), ATLAS[0], ATLAS[1]);
  const [w, h] = ATLAS;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([palette[0]!, palette[1]!, palette[2]!, 255], i * 4);
  const places = which.map((image, k) => ({ image, x: at[k]![0], y: at[k]![1] }));
  for (const p of places) {
    const pic = colourPicture(images[p.image]!, palette);
    for (let y = 0; y < pic.height; y++) data.set(pic.data.subarray(y * pic.width * 4, (y + 1) * pic.width * 4), ((p.y + y) * w + p.x) * 4);
  }
  return { atlas: { width: w, height: h, data }, places };
}

/** A picture cut from a `scale` times atlas, with the original's art alpha (notArt clear), nearest. */
export function cutPicture(atlas: Rgba, scale: number, place: { x: number; y: number }, original: IndexedImage): Rgba {
  const w = original.width * scale, h = original.height * scale;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.set(atlas.data.subarray(((place.y * scale + y) * atlas.width + place.x * scale) * 4, ((place.y * scale + y) * atlas.width + place.x * scale + w) * 4), y * w * 4);
    for (let x = 0; x < w; x++) if (notArt(original.pixels[Math.floor(y / scale) * original.width + Math.floor(x / scale)]!)) data[(y * w + x) * 4 + 3] = 0;
  }
  return { width: w, height: h, data };
}

/** Where `art:space originals` decodes the console (`console.png`) and the pages' atlas (`pages.png`, with `pages.json`, each picture's place). */
export const spaceOriginal = (cache: ArtCache, which: 'console' | 'pages'): string => join(cache.root, 'originals', 'space', `${which}.png`);

/** The pages' atlas's pictures as rectangles (original pixels), for the alignment check's points and the mask (Plan 30 R5). */
export async function pagesPictures(cache: ArtCache): Promise<{ name: string; rect: Rect }[]> {
  const places = JSON.parse(await readFile(join(cache.root, 'originals', 'space', 'pages.json'), 'utf8')) as { image: number; x: number; y: number; width: number; height: number }[];
  return places.map(p => ({ name: String(p.image), rect: [p.x, p.y, p.width, p.height] }));
}
