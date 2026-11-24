// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tricorder viewer's pictures (runTricorder, tricorder.cpp), published as they are, the way the panel's sprites are (panel.ts): the frame is
 * tricord.spr's first animation (a 410 by 478 picture of the tricorder alone, drawn with its bottom centre at 320,478), the buttons are tricord.mrg's
 * entries (each with the greyed picture drawn when it can't be pressed and the lit one under the pointer). Every picture is decoded with
 * standard.pal (both files use only its upper half), index 13 clear (COLOUR_BLANK, which blit and drawMRG skip), scaled up 4x nearest-neighbour and
 * written as lossless WebP to games/unity/art/tricorder/<name>.webp, with presentation.yaml's art.tricorder (the pictures by name and the scale).
 * Where each goes and where the readout's text sits is the engine's (the constants of tricorder.cpp). Local and git-ignored, like the rest of art/.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { COLOUR_BLANK } from './astro';
import { spriteAnimation } from './enginespr';
import { mrgIcon, parseMrg } from './icon';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { nearestResize } from './pixel';
import { colourFrame } from './shipsprite';
import { readWebp, toWebp } from './webp';

/** tricord.mrg's entries the viewer draws, by name (kImage* and kTricorderButtons: each button's picture, hover and greyed twin). */
export const TRICORDER_BUTTONS: Record<number, string> = {
  0: 'mode_readings', 1: 'mode_conversations',
  2: 'page_up_off', 3: 'page_up', 4: 'page_up_hover',
  5: 'page_down_off', 6: 'page_down', 7: 'page_down_hover',
  8: 'prev_off', 9: 'prev', 10: 'prev_hover',
  11: 'next_off', 12: 'next', 13: 'next_hover',
  14: 'resume', 15: 'resume_hover',
};

export interface TricorderSprite { name: string; image: Rgba; width: number; height: number }

/** The frame, then each button, in colour (index 13 clear) at `scale` times its size. */
export function tricorderSprites(spr: Uint8Array, mrg: Uint8Array, standardPal: Uint8Array, scale = 4): TricorderSprite[] {
  // (a 256-entry palette with standard.pal, 6-bit, as the upper half)
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 128 * 3; i++) pal[128 * 3 + i] = Math.min(255, standardPal[i]! << 2);
  const [frame] = spriteAnimation(spr, 0);
  if (!frame) throw new Error('tricord.spr has no picture in its first animation');
  const out: TricorderSprite[] = [{ name: 'frame', image: nearestResize(colourFrame(frame, pal), frame.width * scale, frame.height * scale), width: frame.width, height: frame.height }];
  const entries = parseMrg(mrg);
  for (const [i, name] of Object.entries(TRICORDER_BUTTONS)) {
    const e = entries[Number(i)];
    if (!e) throw new Error(`tricord.mrg has no entry ${i} (${name})`);
    const img = mrgIcon(mrg, standardPal, Number(i), [0, 0, e.width, e.height], COLOUR_BLANK);
    out.push({ name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height });
  }
  return out;
}

export interface TricorderDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/** Publishes the viewer's pictures; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishTricorder(gameDir: string, spr: Uint8Array, mrg: Uint8Array, standardPal: Uint8Array, deps: TricorderDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites = tricorderSprites(spr, mrg, standardPal, scale);
  const work = await mkdtemp(join(tmpdir(), 'tricorder-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'tricorder'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/tricorder/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the picture's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
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
  doc.setIn(['art', 'tricorder'], { scale, sprites: Object.fromEntries(staged.map(s => [s.name, s.rel])) });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
