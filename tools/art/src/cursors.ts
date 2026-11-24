// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The away team's pointers (cursor.dat; Graphics::loadCursors and setCursor, graphics.cpp), published as they are, the way the panel's sprites are
 * (panel.ts): each picture decoded with standard.pal (index 13 clear, COLOUR_BLANK), scaled up 4x nearest-neighbour and written as lossless WebP to
 * games/unity/art/cursors/<name>.webp, with presentation.yaml's art.cursors (the pictures by name, the scale, and each verb's click point in the
 * picture's own pixels). Local and git-ignored, like the rest of art/.
 *
 * The file is a run of frames, each a u16 width, a u16 height and width x height palette indices. Frames 0 to 7 are the verbs, each as a pair: the
 * pointer, then the same lit up (updateAwayTeamCursor draws the lit one when the pointer is over something to act on, or in Walk, over floor to walk
 * on); 8 to 11 are the arrows for walking out of the screen. The click points are the table in setCursor (the exits' are the picture's middle).
 */
import { mkdir, mkdtemp, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { COLOUR_BLANK } from './astro';
import { nearestResize } from './pixel';
import { readWebp, toWebp } from './webp';

/** The frames the game draws, by index (setCursor's ids: look 0, use 2, talk 4, walk 6, each with its lit frame after it, then the exit arrows from 8). */
export const CURSOR_FRAMES: Record<number, string> = {
  0: 'look', 1: 'look_lit', 2: 'use', 3: 'use_lit', 4: 'talk', 5: 'talk_lit', 6: 'walk', 7: 'walk_lit',
  8: 'exit_down', 9: 'exit_left', 10: 'exit_right', 11: 'exit_up',
};

/** Where a click lands on each verb's pointer (setCursor's `hotspots`, the picture's own pixels; its lit frame has the same one). */
export const CURSOR_HOTSPOTS: Record<string, [number, number]> = { look: [18, 11], use: [33, 11], talk: [4, 4], walk: [33, 22] };

export interface CursorFrame { width: number; height: number; pixels: Uint8Array }

/** cursor.dat's frames in order (the file ends where its last frame does). */
export function parseCursors(dat: Uint8Array): CursorFrame[] {
  const dv = new DataView(dat.buffer, dat.byteOffset, dat.byteLength);
  const frames: CursorFrame[] = [];
  for (let p = 0; p + 4 <= dat.length;) {
    const width = dv.getUint16(p, true);
    const height = dv.getUint16(p + 2, true);
    if (p + 4 + width * height > dat.length) throw new Error(`cursor.dat frame ${frames.length} runs past the end of the file`);
    frames.push({ width, height, pixels: dat.subarray(p + 4, p + 4 + width * height) });
    p += 4 + width * height;
  }
  return frames;
}

/** Each named frame in colour (index 13 clear) at `scale` times its size. */
export function cursorSprites(dat: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const frames = parseCursors(dat);
  return Object.entries(CURSOR_FRAMES).map(([i, name]) => {
    const f = frames[Number(i)];
    if (!f) throw new Error(`cursor.dat has no frame ${i} (${name})`);
    const img: Rgba = { width: f.width, height: f.height, data: new Uint8Array(f.width * f.height * 4) };
    for (let p = 0; p < f.width * f.height; p++) {
      const idx = f.pixels[p]!;
      if (idx === COLOUR_BLANK) continue;
      // (the pointers use only the upper palette; a low index would be the room's, and is black)
      const rgb = idx >= 128 ? [0, 1, 2].map(k => Math.min(255, standardPal[(idx - 128) * 3 + k]! << 2)) : [0, 0, 0];
      img.data.set([...rgb, 255], p * 4);
    }
    return { name, image: nearestResize(img, f.width * scale, f.height * scale), width: f.width, height: f.height };
  });
}

export interface CursorDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/** Publishes the pointers; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishCursors(gameDir: string, dat: Uint8Array, standardPal: Uint8Array, deps: CursorDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites = cursorSprites(dat, standardPal, scale);
  const work = await mkdtemp(join(tmpdir(), 'cursors-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'cursors'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/cursors/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the pointer's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
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
  doc.setIn(['art', 'cursors'], {
    scale,
    sprites: Object.fromEntries(staged.map(s => [s.name, s.rel])),
    hotspots: CURSOR_HOTSPOTS,
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
