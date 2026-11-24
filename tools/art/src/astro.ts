// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The astrogation course panel's own sprites (astro.mrg, entries 70-86; AstrogationScreen::drawCoursePanel, astrogation.cpp:2770-2778), published as
 * they are the way the away team's panel is (panel.ts): each decoded in colour, scaled up 4x nearest-neighbour (interface art stays un-repainted)
 * and written as lossless WebP to games/unity/art/astro/<name>.webp, with presentation.yaml's art.astro (the sprites by name and the scale).
 * Local and git-ignored, like the rest of art/.
 *
 * Colours: the screen draws the MRG over astropnl.ast, whose own 128 colours are the palette's lower half (graphics.cpp setBackgroundImage) and
 * standard.pal's the upper half. Index 13 is clear (COLOUR_BLANK: blit skips it); the map's pictures use the lower half too, so the screen's palette matters.
 * Warp and Impulse are not here: they are not MRG images, but the engine panel's own sprites (astro's .spr animations, `engineFrame`).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { astroTables } from './astrotables';
import { publishFonts } from './indexedart';
import { spriteAnimation } from './enginespr';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { parseMrg } from './icon';
import { nearestResize } from './pixel';
import { colourFrame } from './shipsprite';
import { readWebp, toWebp } from './webp';

/** The colour of transparent pixels (COLOUR_BLANK in sprite.h): Graphics::blit and drawMRG skip it. */
export const COLOUR_BLANK = 13;

/** astro.mrg's entries the course panel draws (kImage* in astrogation.cpp:855-880), by name; each button's pressed picture is its own entry. */
export const ASTRO_SPRITES: Record<number, string> = {
  71: 'faster_warp',
  72: 'faster_warp_down',
  73: 'faster_impulse',
  74: 'faster_impulse_down',
  75: 'slower',
  76: 'slower_down',
  84: 'engage',
  70: 'engage_down',
  85: 'stop',
  86: 'stop_down',
  // (the info and display tabs' own pictures: drawInfoPanel and drawDisplayPanel)
  69: 'info_tab',
  77: 'display_tab',
  78: 'display_bottom',
  // (drawButtons, astrogation.cpp:2073-2094: the lit button of the view the map shows, and the picture of a pad button, cursor arrow or exit while it is held;
  // each is drawn at the button's own corner, and the unlit and unpressed pictures, entries 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22 and 24, are the plate's)
  1: 'view_galaxy_lit', 3: 'view_sector_lit', 5: 'view_system_lit',
  7: 'arrow_up_down', 9: 'arrow_down_down',
  11: 'pad_up_down', 13: 'pad_down_down', 15: 'pad_right_down', 17: 'pad_left_down', 19: 'pad_stop_down',
  21: 'exit_bridge_down', 23: 'exit_computer_down', 25: 'exit_engineering_down',
};

/**
 * The pictures the map draws (kImage* in astrogation.cpp:855-880; drawSector, drawSystem, drawStation, drawCourse), by name: the stars by spectral
 * class, the hazards by type from 0x40, the stations by type from 0x80, the planets by class, the belt, the moons, the selection frame and the ship
 * and destination markers. They have no place of their own (the map puts them), so each one's recorded rectangle is [0, 0, w, h].
 */
export const ASTRO_MAP_SPRITES: Record<number, string> = {
  26: 'belt', 27: 'starbase_icon', 28: 'selected', 29: 'moon', 30: 'star', 31: 'companion', 46: 'ship', 51: 'outpost_icon', 52: 'starbase_big',
  79: 'buoy', 80: 'deep_space_station', 81: 'outpost', 82: 'relay', 91: 'ship_marker', 92: 'destination_marker',
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [32 + i, `star_class${i}`])),
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [39 + i, `hazard${i}`])),
  ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [47 + i, `station${i}`])),
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [53 + i, `planet${i}`])),
};

/** Where the original draws them, in its 640x480 pixels (drawCoursePanel): the sprites' own size, from this corner. */
export const ASTRO_AT: Record<string, [number, number]> = {
  faster_warp: [478, 93], faster_warp_down: [478, 93], faster_impulse: [478, 93], faster_impulse_down: [478, 93],
  slower: [478, 121], slower_down: [478, 121],
  engage: [392, 161], engage_down: [392, 161],
  stop: [392, 189], stop_down: [392, 189],
  info_tab: [384, 24], display_tab: [389, 28], display_bottom: [389, 164],
};

/** The 256-colour palette a screen draws with: the .ast's 128 6-bit entries, then standard.pal's first 128. */
export function screenPalette(screen: Uint8Array, standardPal: Uint8Array): Uint8Array {
  if (screen.length < 128 * 3) throw new Error(`the screen has ${screen.length} bytes, need ${128 * 3} for its palette`);
  if (standardPal.length < 128 * 3) throw new Error(`standard.pal has ${standardPal.length} bytes, need ${128 * 3}`);
  const pal = new Uint8Array(256 * 3);
  pal.set(screen.subarray(0, 128 * 3));
  pal.set(standardPal.subarray(0, 128 * 3), 128 * 3);
  for (let i = 0; i < pal.length; i++) pal[i] = (pal[i]! << 2) & 0xff;
  return pal;
}

/** Each named entry in colour (index 13 clear) at `scale` times its size. */
export function astroSprites(mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const entries = parseMrg(mrg);
  const pal = screenPalette(screen, standardPal);
  return Object.entries({ ...ASTRO_SPRITES, ...ASTRO_MAP_SPRITES }).map(([i, name]) => {
    const e = entries[Number(i)];
    if (!e) throw new Error(`astro.mrg has no entry ${i} (${name})`);
    const img: Rgba = { width: e.width, height: e.height, data: new Uint8Array(e.width * e.height * 4) };
    for (let p = 0; p < e.width * e.height; p++) {
      const idx = e.pixels[p]!;
      if (idx === COLOUR_BLANK) continue;
      img.data.set([pal[idx * 3]!, pal[idx * 3 + 1]!, pal[idx * 3 + 2]!, 255], p * 4);
    }
    return { name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height };
  });
}

/** engine.spr's animations the course panel runs (astrogation.cpp kAnim*): the panel for warp and for impulse, and each engine's frames, drawn at these places. */
export const ENGINE_ANIMATIONS = { warpPanel: 0, impulsePanel: 2, impulse: 3, warp: 4 } as const;
export const COURSE_PANEL_AT: [number, number] = [384, 24];
export const ENGINE_AT: [number, number] = [393, 219];

/** The panels (`course_warp`, `course_impulse`) and each engine's frames (`engine_warp0`…, `engine_impulse0`…), coloured with the screen's palette, at `scale` times their size. */
export function engineSprites(engine: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const pal = screenPalette(screen, standardPal);
  const one = (name: string, frame: { width: number; height: number; indices: Uint8Array }) => ({
    name, image: nearestResize(colourFrame(frame, pal), frame.width * scale, frame.height * scale), width: frame.width, height: frame.height,
  });
  const panel = (name: string, anim: number) => {
    const frames = spriteAnimation(engine, anim);
    if (frames.length === 0) throw new Error(`engine.spr has no picture for ${name}`);
    return one(name, frames[0]!);
  };
  const strip = (prefix: string, anim: number) => {
    const frames = spriteAnimation(engine, anim);
    if (frames.length === 0) throw new Error(`engine.spr has no frames for ${prefix}`);
    return frames.map((f, i) => one(`${prefix}${i}`, f));
  };
  return [panel('course_warp', ENGINE_ANIMATIONS.warpPanel), panel('course_impulse', ENGINE_ANIMATIONS.impulsePanel), ...strip('engine_warp', ENGINE_ANIMATIONS.warp), ...strip('engine_impulse', ENGINE_ANIMATIONS.impulse)];
}

export interface AstroDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
  /** STTNG.OVL (STTNGINS.ZIP), for the map's tables (astrotables.ts); without it the sprites alone are published and the map uses its own tables. */
  ovl?: Uint8Array;
  /** engine.spr, for the course panel's panels and engine frames (engineSprites); without it those are not published and the panel keeps its CSS look. */
  engine?: Uint8Array;
  /** font0.fon ... font9.fon, in order: the screen's text is drawn in them (kFontMap 0, kFontInfo 2, kFontLabel 4); without them the text stays ours. */
  fonts?: Uint8Array[];
}

/** Publishes the sprites; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishAstro(gameDir: string, mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, deps: AstroDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites = [...astroSprites(mrg, screen, standardPal, scale), ...(deps.engine ? engineSprites(deps.engine, screen, standardPal, scale) : [])];
  const work = await mkdtemp(join(tmpdir(), 'astro-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'astro'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/astro/${s.name}.webp`;
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
  const tables = deps.ovl ? astroTables(deps.ovl, screenPalette(screen, standardPal)) : undefined;
  // (the screen's 256 colours, 8 bits each, which the fonts' own colours are indices into)
  const palette = 'art/astro/palette.rgb';
  await writeFile(join(gameDir, palette), screenPalette(screen, standardPal));
  if (deps.fonts) doc.setIn(['art', 'fonts'], { files: await publishFonts(gameDir, deps.fonts) });
  doc.setIn(['art', 'astro'], {
    scale,
    palette,
    ...(tables ? { tables } : {}),
    sprites: Object.fromEntries(sprites.map((s, i) => [s.name, { image: staged[i]!.rel, rect: [...(ASTRO_AT[s.name] ?? (s.name.startsWith('course_') ? COURSE_PANEL_AT : s.name.startsWith('engine_') ? ENGINE_AT : [0, 0])), s.width, s.height] }])),
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
