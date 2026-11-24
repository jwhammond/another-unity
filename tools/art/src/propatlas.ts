// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng, type Rgba } from './image';
import type { Atlas } from './atlas';
import type { StripAtlas } from './layer';
import { NEAR_LOSSLESS, WEBP_MODES, type WebpMode } from './publish';
import { readWebp, toWebp } from './webp';

const QUALITY = 90;

/** How an atlas page is encoded in a mode: lossy (alpha kept exact), near-lossless, lossless (the same ladder a plate climbs: `WEBP_MODES`). */
export const encodePage = (mode: WebpMode) => (png: string, out: string): Promise<void> =>
  toWebp(png, out, mode === 'lossy' ? { quality: QUALITY, alpha: true } : mode === 'lossless' ? { quality: QUALITY, lossless: true } : { quality: QUALITY, nearLossless: NEAR_LOSSLESS });

export interface PageDeps {
  encode?: (png: string, out: string, mode: WebpMode) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/**
 * Encodes the atlas pages into `dir` as `<name>.<n>.webp`, trying lossy, then near-lossless, then lossless, each only when the one before fails `check` (given the
 * pages as decoded from the files, which is what a player sees). The thresholds are `check`'s and are never loosened: when lossless fails too the result is `ok: false`.
 */
export async function encodePages(
  pages: Rgba[],
  dir: string,
  name: string,
  check: (decoded: Rgba[]) => { ok: boolean; why?: string },
  deps: PageDeps = {},
): Promise<{ ok: true; files: string[]; mode: WebpMode; bytes: number } | { ok: false; why: string }> {
  let why = '';
  await mkdir(dir, { recursive: true });
  for (const mode of WEBP_MODES) {
    const files: string[] = [];
    const decoded: Rgba[] = [];
    for (const [i, page] of pages.entries()) {
      const png = join(dir, `${name}.${i}.png`);
      const out = join(dir, `${name}.${i}.webp`);
      await writeFile(png, encodePng(page));
      await (deps.encode ? deps.encode(png, out, mode) : encodePage(mode)(png, out));
      await rm(png, { force: true });
      files.push(out);
      decoded.push(await (deps.decode ?? readWebp)(out));
    }
    const r = check(decoded);
    if (r.ok) {
      let bytes = 0;
      for (const f of files) bytes += (await stat(f)).size;
      return { ok: true, files, mode, bytes };
    }
    why = r.why ?? 'the check failed';
  }
  return { ok: false, why: `${why} (even lossless)` };
}

/**
 * Publishes an animated prop's atlas under games/unity/art/cards/<object>/: the pages as `<anim>.<n>.webp` and `<anim>.json` saying which cell each frame is and where
 * the cells lie (`art masks` reads it). Replaces whatever an earlier publish of the animation left (the grid strip `<anim>.webp`, pages of another count).
 */
export async function publishPropAtlas(gameDir: string, object: string, anim: number, files: string[], atlas: Atlas, of: number[]): Promise<StripAtlas> {
  if (!/^[a-z0-9_]+$/.test(object)) throw new Error(`"${object}" isn't an object id`);
  const rel = `art/cards/${object}`;
  const dir = join(gameDir, rel);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) if (f === `${anim}.webp` || new RegExp(`^${anim}\\.[0-9]+\\.webp$`).test(f)) await rm(join(dir, f));
  const images = files.map((_, i) => `${rel}/${anim}.${i}.webp`);
  for (const [i, f] of files.entries()) await copyFile(f, join(gameDir, images[i]!));
  const published: StripAtlas = { images, pages: atlas.pages, cells: atlas.cells };
  await writeFile(join(dir, `${anim}.json`), `${JSON.stringify({ frames: of.length, of, columns: atlas.cells.length, atlas: published })}\n`);
  return published;
}
