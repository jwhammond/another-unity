// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { alignCheck, ALIGN_DEFAULTS } from './align';
import type { ArtCache } from './cache';
import { decodePng, encodePng, meanAbsDiff, type Rgba } from './image';
import type { CheckPoint } from './points';
import type { RunMeta } from './run';
import { readWebp, toWebp } from './webp';

/** The decoded first frame of a hail sprite (art ship originals), in its own palette, with its transparent corners. */
export const hailOriginal = (cache: ArtCache, stem: string): string => join(cache.root, 'originals', 'view', `${stem}.png`);

const QUALITY = 92;
/** A WebP must be within this mean (levels of 255) of its PNG. */
const MAX_MEAN_DIFF = 2;

/**
 * The repaint with the original's transparency: the original's alpha, bilinearly upsampled to the plate's size, so the rounded corners the sprite
 * leaves blank stay blank. The colour under a transparent pixel is kept as the repaint made it.
 */
export function withOriginalAlpha(plate: Rgba, original: Rgba): Rgba {
  const out: Rgba = { width: plate.width, height: plate.height, data: new Uint8Array(plate.data) };
  const sx = original.width / plate.width;
  const sy = original.height / plate.height;
  const a = (x: number, y: number): number => original.data[(Math.min(original.height - 1, Math.max(0, y)) * original.width + Math.min(original.width - 1, Math.max(0, x))) * 4 + 3]!;
  for (let y = 0; y < plate.height; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < plate.width; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const top = a(x0, y0) * (1 - tx) + a(x0 + 1, y0) * tx;
      const bottom = a(x0, y0 + 1) * (1 - tx) + a(x0 + 1, y0 + 1) * tx;
      out.data[(y * plate.width + x) * 4 + 3] = Math.round(top * (1 - ty) + bottom * ty);
    }
  }
  return out;
}

export interface HailDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
  /** The decoded original, for its transparency and the WebP's alignment check. */
  original: Rgba;
  /** Where the original draws the sprite: its first POSN block (bottom centre), 640x480 pixels. */
  at: [number, number];
  align?: { points: CheckPoint[]; maxShift?: number };
}

/**
 * Publishes a hail recipe's last run: art/ship/view/<stem>.still.webp (the repaint, in the original's transparency) and the entry
 * art.ship.viewscreen.hails.<stem> = { image, scale, at } in presentation.yaml. The WebP's own pixels are measured against the original again.
 */
export async function publishHail(gameDir: string, stem: string, run: { dir: string; meta: RunMeta }, deps: HailDeps): Promise<{ file: string; scale: number; drift: number }> {
  if (!/^[a-z0-9_]+$/.test(stem)) throw new Error(`"${stem}" isn't a sprite stem`);
  if ((run.meta.checks.align as { ok?: boolean } | undefined)?.ok !== true) throw new Error(`${stem}: the run in ${run.dir} has no passing alignment check; give the recipe an align post-step and art run it again`);
  const out = run.meta.outputs.plate;
  if (!out) throw new Error(`the run in ${run.dir} has no plate to publish`);
  const plate = decodePng(new Uint8Array(await readFile(out.file)));
  const scale = plate.width / deps.original.width;
  if (!Number.isInteger(scale) || plate.height !== deps.original.height * scale) throw new Error(`${stem}: the plate is ${plate.width}x${plate.height}, not a whole multiple of the original's ${deps.original.width}x${deps.original.height}`);
  const still = withOriginalAlpha(plate, deps.original);
  const png = join(run.dir, 'still.png');
  await writeFile(png, encodePng(still));
  const rel = `art/ship/view/${stem}.still.webp`;
  await mkdir(join(gameDir, 'art', 'ship', 'view'), { recursive: true });
  const dest = join(gameDir, rel);
  const tmp = `${dest}.tmp`;
  await (deps.encode ?? ((p, o) => toWebp(p, o, { quality: QUALITY, alpha: true })))(png, tmp);
  const back = await (deps.decode ?? readWebp)(tmp);
  const drift = meanAbsDiff(still, back);
  const refuse = async (why: string): Promise<never> => {
    await rm(tmp, { force: true });
    throw new Error(`${stem}: ${why}`);
  };
  if (drift > MAX_MEAN_DIFF) await refuse(`the WebP differs from the PNG by a mean of ${drift.toFixed(2)}/255 (limit ${MAX_MEAN_DIFF}); nothing was published`);
  if (deps.align) {
    const r = alignCheck(deps.original, back, deps.align.points, { ...ALIGN_DEFAULTS, maxShift: deps.align.maxShift ?? ALIGN_DEFAULTS.maxShift });
    if (!r.ok) await refuse(`the WebP no longer passes the alignment check (${r.why}); nothing was published`);
  }
  await rename(tmp, dest);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  if (!doc.getIn(['art', 'ship', 'viewscreen', 'plate'])) throw new Error(`${stem}: presentation.yaml has no published viewscreen plate (art ship publish viewscreen first)`);
  doc.setIn(['art', 'ship', 'viewscreen', 'hails', stem], { image: rel, scale, at: [...deps.at] });
  await writeFile(path, String(doc));
  return { file: rel, scale, drift };
}
