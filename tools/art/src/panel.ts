// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The away team's panel (awayteam.mrg), published as it is: each entry decoded with standard.pal, scaled up 4x nearest-neighbour (interface
 * art stays un-repainted, its flats and edges hard) and written as lossless WebP to games/unity/art/panel/<name>.webp, with
 * presentation.yaml's art.panel (the sprites by name, the scale, and the few palette colours the panel fills itself). Local and
 * git-ignored, like the rest of art/.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { COLOUR_BLANK } from './astro';
import { mrgIcon, parseMrg } from './icon';
import { nearestResize } from './pixel';
import { readWebp, toWebp } from './webp';

/** The entries the panel draws, by index (awayteam.cpp's kSprite* and kModeButtons; the selected verb is the entry after its button's). */
export const PANEL_SPRITES: Record<number, string> = {
  0: 'panel',
  1: 'admin',
  3: 'marker0',
  4: 'marker1',
  5: 'marker2',
  6: 'right',
  7: 'right_lit',
  8: 'right_off',
  9: 'left',
  10: 'left_lit',
  11: 'left_off',
  12: 'slot',
  13: 'look',
  14: 'look_on',
  15: 'walk',
  16: 'walk_on',
  17: 'talk',
  18: 'talk_on',
  19: 'use',
  20: 'use_on',
  22: 'no_phaser',
};

/** The palette indices the panel fills itself: the status line's ground and the health bar's bands (awayteam.cpp:845-846, 883). */
export const PANEL_COLOURS = { status: 0x80, separator: 0x80, empty: 0x84, healthy: 0xc4, injured: 0xa3, injuredEdge: 0xa2 } as const;

/** A standard.pal colour (index 128 and up, 6-bit) as #rrggbb. */
export function palHex(standardPal: Uint8Array, index: number): string {
  if (index < 128) throw new Error(`palette index ${index} isn't the standard half`);
  return `#${[0, 1, 2].map(k => Math.min(255, standardPal[(index - 128) * 3 + k]! << 2).toString(16).padStart(2, '0')).join('')}`;
}

/** Each named entry in colour, at `scale` times its size. */
export function panelSprites(mrg: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const entries = parseMrg(mrg);
  return Object.entries(PANEL_SPRITES).map(([i, name]) => {
    const e = entries[Number(i)];
    if (!e) throw new Error(`awayteam.mrg has no entry ${i} (${name})`);
    const img = mrgIcon(mrg, standardPal, Number(i), [0, 0, e.width, e.height], COLOUR_BLANK);
    return { name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height };
  });
}

export interface PanelDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/** Publishes the panel; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishPanel(gameDir: string, mrg: Uint8Array, standardPal: Uint8Array, deps: PanelDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites = panelSprites(mrg, standardPal, scale);
  const work = await mkdtemp(join(tmpdir(), 'panel-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'panel'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/panel/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the panel's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
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
  doc.setIn(['art', 'panel'], {
    scale,
    sprites: Object.fromEntries(staged.map(s => [s.name, s.rel])),
    colours: Object.fromEntries(Object.entries(PANEL_COLOURS).map(([k, i]) => [k, palHex(standardPal, i)])),
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
