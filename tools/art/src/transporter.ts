// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The transporter room's console pictures (transp.mrg; TransporterScreen::draw, transporter.cpp:802-853), published as they are, the way
 * the course panel's are (astro.ts): each decoded in colour, scaled up 4x nearest-neighbour (interface art stays un-repainted) and written
 * as lossless WebP to games/unity/art/transporter/<name>.webp, with presentation.yaml's art.transporter (the sprites by name, the scale, and
 * the rectangle the original draws each in). Local and git-ignored, like the rest of art/.
 *
 * Colours: the room draws the MRG over transp.rm, whose own 128 colours are the palette's lower half (graphics.cpp setBackgroundImage) and
 * standard.pal's the upper half: astro.ts's screenPalette. The sliders' knob (entry 12) is not here: it is drawn as a trail the original never
 * erases, which the browser's Energize does not have.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { COLOUR_BLANK, screenPalette } from './astro';
import { spriteAnimation } from './enginespr';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { parseMrg } from './icon';
import { colourFrame, spritePalette } from './shipsprite';
import { nearestResize } from './pixel';
import { readWebp, toWebp } from './webp';

/**
 * transp.mrg's entries the room draws (transporter.cpp:63-77), by name: the arrows each with their grey (end of the list) twin, the kit's slot,
 * and the two console buttons, each as a pair (off, then lit). The pairs are 14/15 (the crew figure: Lists) and 16/17 (the planet: Map), which
 * is what the baked-in background shows (transp.rm has 14 and 16 exactly at the buttons' places) and what their sizes say (42x58 and 42x56).
 * ScummVM's kSprite* constants for them (ListsButton 14, MapButton 15, MapButtonOn 16, ListsButtonOn 17) name 15 and 17 the other way round:
 * its Lists button draws the planet lit and its Map button the crew figure lit, at the default.
 */
export const TRANSPORTER_SPRITES: Record<number, string> = {
  0: 'up',
  2: 'up_grey',
  3: 'down',
  5: 'down_grey',
  6: 'left',
  8: 'left_grey',
  9: 'right',
  11: 'right_grey',
  13: 'kit_slot',
  14: 'lists',
  15: 'lists_on',
  16: 'map',
  17: 'map_on',
};

/** Where the original draws them, in its 640x480 pixels: the sprites' own size, from this corner (the kit's slots: the first; the others at kKitSlotX). */
export const TRANSPORTER_AT: Record<string, [number, number]> = {
  up: [210, 359], up_grey: [210, 359], down: [210, 383], down_grey: [210, 383],
  left: [297, 424], left_grey: [297, 424], right: [321, 424], right_grey: [321, 424],
  kit_slot: [71, 424],
  lists: [7, 300], lists_on: [7, 300], map: [7, 359], map_on: [7, 359],
};

/** Each named entry in colour (index 13 clear: COLOUR_BLANK; index 0 is drawn, in the room palette's first colour) at `scale` times its size. */
export function transporterSprites(mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const entries = parseMrg(mrg);
  const pal = screenPalette(screen, standardPal);
  return Object.entries(TRANSPORTER_SPRITES).map(([i, name]) => {
    const e = entries[Number(i)];
    if (!e) throw new Error(`transp.mrg has no entry ${i} (${name})`);
    const img: Rgba = { width: e.width, height: e.height, data: new Uint8Array(e.width * e.height * 4) };
    for (let p = 0; p < e.width * e.height; p++) {
      const idx = e.pixels[p]!;
      if (idx === COLOUR_BLANK) continue;
      img.data.set([pal[idx * 3]!, pal[idx * 3 + 1]!, pal[idx * 3 + 2]!, 255], p * 4);
    }
    return { name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height };
  });
}

/**
 * The map's own sprites (TransporterScreen::showMap and updateLock, transporter.cpp:243-300): tmaps.spr (one 368x120 picture per world, animation n
 * is world n's, drawn with its bottom centre at (234, 414)), the scan's two lines (beamhori.spr 366x2, beamvert.spr 2x118) and the lock's blip
 * (tranblip.spr's second animation: ten 38x38 frames, a hundred milliseconds each, looping).
 */
export interface TransporterMapSources { tmaps: Uint8Array; beamhori: Uint8Array; beamvert: Uint8Array; tranblip: Uint8Array }

/** kMapX, kMapY, kMapLeft, kMapTop (transporter.cpp:56-59): the map's anchor (the bottom of its centre) and the scan's first row and column. */
export const MAP_X = 234;
export const MAP_Y = 414;
export const MAP_LEFT = 51;
export const MAP_TOP = 297;
/** The blip's animation (`startAnim(1)`). */
export const BLIP_ANIM = 1;

export interface MapSprite { name: string; image: Rgba; width: number; height: number; rect: [number, number, number, number]; delayMs?: number }

/** Where a sprite drawn with its bottom centre at (x, y) has its top left (graphics.cpp drawSprite, no scale and no adjust). */
const topLeft = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x - Math.trunc(w / 2), y - h, w, h];

/**
 * The map's pictures in colour: the sprite's own palette if it carries one, else the room's (these carry none), index 13 clear, at `scale` times their
 * size. `rect` is where the original has each at the start: the world's picture at its place, the lines as showMap adds them (across at the scan's
 * first row, down beside the first column), the blip's size alone (it is drawn where the target is).
 */
export function transporterMapSprites(src: TransporterMapSources, screen: Uint8Array, standardPal: Uint8Array, scale = 4): MapSprite[] {
  const room = screenPalette(screen, standardPal);
  const out: MapSprite[] = [];
  const add = (name: string, spr: Uint8Array, frame: { width: number; height: number; indices: Uint8Array }, rect: [number, number, number, number], delayMs?: number): void => {
    const image = nearestResize(colourFrame(frame, spritePalette(spr) ?? room), frame.width * scale, frame.height * scale);
    out.push({ name, image, width: frame.width, height: frame.height, rect, ...(delayMs !== undefined ? { delayMs } : {}) });
  };
  const view = new DataView(src.tmaps.buffer, src.tmaps.byteOffset, src.tmaps.byteLength);
  const worlds = view.getUint32(20, true);
  for (let w = 0; w < worlds; w++) {
    const [frame] = spriteAnimation(src.tmaps, w, true);
    if (!frame) throw new Error(`tmaps.spr has no picture for world ${w}`);
    add(`map_world_${w}`, src.tmaps, frame, topLeft(frame.at?.[0] ?? MAP_X, frame.at?.[1] ?? MAP_Y, frame.width, frame.height));
  }
  const [across] = spriteAnimation(src.beamhori, 0, true);
  const [down] = spriteAnimation(src.beamvert, 0, true);
  if (!across || !down) throw new Error('beamhori.spr or beamvert.spr has no picture');
  // (addSprite("beamhori.spr", kMapX, _lockY + 2) and ("beamvert.spr", _lockX + 1, kMapY))
  add('scan_across', src.beamhori, across, topLeft(MAP_X, MAP_TOP + 2, across.width, across.height));
  add('scan_down', src.beamvert, down, topLeft(MAP_LEFT + 1, MAP_Y, down.width, down.height));
  const blips = spriteAnimation(src.tranblip, BLIP_ANIM, true);
  if (blips.length === 0) throw new Error('tranblip.spr has no blip animation');
  blips.forEach((f, i) => add(`blip_${i}`, src.tranblip, f, [0, 0, f.width, f.height], f.waitMs ?? 100));
  return out;
}

export interface TransporterDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
  /** The map's sprites (tmaps.spr and the scan's): published with the console's, recorded in the same art.transporter. */
  map?: TransporterMapSources;
}

/** Publishes the sprites; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishTransporter(gameDir: string, mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, deps: TransporterDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites: { name: string; image: Rgba; width: number; height: number; rect?: [number, number, number, number]; delayMs?: number }[] = transporterSprites(mrg, screen, standardPal, scale);
  if (deps.map) sprites.push(...transporterMapSprites(deps.map, screen, standardPal, scale));
  const work = await mkdtemp(join(tmpdir(), 'transporter-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'transporter'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/transporter/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the sprite's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
    }
  } catch (e) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const s of staged) await rename(s.tmp, s.dest);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  const blipMs = sprites.find(s => s.delayMs !== undefined)?.delayMs;
  doc.setIn(['art', 'transporter'], {
    scale,
    ...(blipMs !== undefined ? { blipMs } : {}),
    sprites: Object.fromEntries(sprites.map((s, i) => [s.name, { image: staged[i]!.rel, rect: s.rect ?? [...TRANSPORTER_AT[s.name]!, s.width, s.height] }])),
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
