// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backdropPlate } from '../../../engine/src/view/combat/files';
import { sheetEntry, texEntry } from '../../../engine/src/view/combat/spaceArt';
import { writeImagePack, type ImagePackEntry } from '../../../engine/src/view/imagePack';
import { encodePng, type Rgba } from './image';
import { setArtKey } from './indexedart';
import { encodeChecked, halfSize, type PublishDeps } from './publish';

/** What `art:space publish` publishes (Plan 30 R14), each picture already made and checked. */
export interface SpaceArtInputs {
  /** By kind index: its textures by lower-case name, 4x, with the original's alpha. */
  kinds: Map<number, Map<string, Rgba>>;
  effects: { textures: Map<string, Rgba>; sheets: Map<string, { picture: Rgba; columns: number; cell: [number, number] }> };
  console?: { plate: Rgba; images: Map<number, Rgba>; scale: number; areas: Record<string, [number, number, number, number]> };
  /** By plate number (0-3): the nebula plates. */
  backdrops: Map<number, Rgba>;
}

/** Same alpha, texel for texel: a keyed texture's mask and a picture's clear pixels never move (Plan 30 R8, R14). */
const sameAlpha = (a: Rgba) => (b: Rgba): { ok: boolean; why?: string } => {
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) return { ok: false, why: `its alpha differs at pixel ${(i - 3) / 4}` };
  return { ok: true };
};

/**
 * The picture with black under every clear pixel (alpha untouched). Lossy and near-lossless cwebp rewrite the colour of clear pixels (no
 * `-exact`), which nobody sees but the 2/255 drift check counts; zeroed first, the WebP matches, and no colour bleeds at a keyed edge.
 */
export function clearUnderAlpha(picture: Rgba): Rgba {
  const data = new Uint8Array(picture.data);
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.fill(0, i, i + 3);
  return { width: picture.width, height: picture.height, data };
}

/**
 * Encodes a picture as WebP, lossy first, then near-lossless, then lossless (publish.ts's encodeChecked: within 2/255 of its PNG), and
 * never with its alpha changed. Throws, naming it, when even lossless fails. Returns the WebP's bytes.
 */
export async function encodeArt(label: string, picture: Rgba, tmp: string, deps: PublishDeps): Promise<Uint8Array> {
  await mkdir(tmp, { recursive: true });
  const png = join(tmp, 'in.png'), webp = join(tmp, 'out.webp');
  const cleared = clearUnderAlpha(picture);
  await writeFile(png, encodePng(cleared));
  const r = await encodeChecked(label, png, webp, cleared, deps, sameAlpha(picture));
  if (!r.ok) throw new Error(`${label}: ${r.why}`);
  return new Uint8Array(await readFile(webp));
}

/** The largest file it publishes (Plan 30 R14): the deploy's 25 MiB a file (docs/deploy.md) less its 10% warning margin, and some. */
export const MAX_FILE = 20 * 1048576;

async function writeAtomic(path: string, bytes: Uint8Array, max = MAX_FILE): Promise<void> {
  if (bytes.length > max) throw new Error(`${path} would be ${(bytes.length / 1048576).toFixed(1)} MiB, over ${(max / 1048576).toFixed(0)} MiB a file (the deploy's limit): split it`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
}

/**
 * Publishes combat's art into the game (Plan 30 R14): `art/space/kind<N>.pack` for each kind, `art/space/effects.pack`, the console's plate
 * (and its half) and `art/space/console.pack`, the backdrop plates at backdropPlate's paths, then `art.space` in presentation.yaml. Returns
 * the files written, relative to the game. A picture that can't be encoded stops it before presentation.yaml changes.
 */
export async function publishSpaceArt(gameDir: string, inputs: SpaceArtInputs, deps: PublishDeps & { maxBytes?: number } = {}): Promise<string[]> {
  const tmp = join(gameDir, 'art', 'space', '.tmp');
  const written: string[] = [];
  const entry = async (name: string, picture: Rgba, meta?: Record<string, unknown>): Promise<ImagePackEntry> =>
    ({ name, type: 'image/webp', width: picture.width, height: picture.height, ...(meta ? { meta } : {}), bytes: await encodeArt(name, picture, tmp, deps) });
  const pack = async (rel: string, entries: ImagePackEntry[]) => {
    await writeAtomic(join(gameDir, rel), writeImagePack(entries), deps.maxBytes);
    written.push(rel);
    return rel;
  };
  try {
    const kinds: Record<string, string> = {};
    for (const [kind, textures] of [...inputs.kinds].sort(([a], [b]) => a - b)) {
      const entries: ImagePackEntry[] = [];
      for (const [name, picture] of [...textures].sort(([a], [b]) => (a < b ? -1 : 1))) entries.push(await entry(texEntry(name), picture));
      kinds[String(kind)] = await pack(`art/space/kind${kind}.pack`, entries);
    }
    const effects: ImagePackEntry[] = [];
    for (const [name, picture] of [...inputs.effects.textures].sort(([a], [b]) => (a < b ? -1 : 1))) effects.push(await entry(texEntry(name), picture));
    for (const [file, s] of [...inputs.effects.sheets].sort(([a], [b]) => (a < b ? -1 : 1))) effects.push(await entry(sheetEntry(file), s.picture, { columns: s.columns, cell: s.cell }));
    const effectsPack = effects.length > 0 ? await pack('art/space/effects.pack', effects) : undefined;
    let console: Record<string, unknown> | undefined;
    if (inputs.console) {
      const c = inputs.console;
      const plate = 'art/space/console/plate.webp', half = 'art/space/console/plate.half.webp';
      await writeAtomic(join(gameDir, plate), await encodeArt('console plate', c.plate, tmp, deps));
      const [hw, hh] = halfSize(c.plate.width, c.plate.height);
      await writeAtomic(join(gameDir, half), await encodeArt('console plate (half)', halve(c.plate, hw, hh), tmp, deps));
      written.push(plate, half);
      const images: ImagePackEntry[] = [];
      for (const [i, picture] of [...c.images].sort(([a], [b]) => a - b)) images.push(await entry(String(i), picture));
      console = { plate, half, pack: await pack('art/space/console.pack', images), scale: c.scale, areas: c.areas };
    }
    const backdrops: string[] = [];
    for (const [n, picture] of [...inputs.backdrops].sort(([a], [b]) => a - b)) {
      const rel = backdropPlate(n);
      await writeAtomic(join(gameDir, rel), await encodeArt(`backdrop ${n}`, picture, tmp, deps));
      backdrops.push(rel);
      written.push(rel);
    }
    await setArtKey(gameDir, 'space', { kinds, ...(effectsPack ? { effects: effectsPack } : {}), ...(console ? { console } : {}), backdrops });
    return written;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Half size by 2 x 2 averages (the alpha too, which the plate's half may soften: only the view's rectangle is clear in it). */
function halve(img: Rgba, w: number, h: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) {
    let sum = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) sum += img.data[((2 * y + dy) * img.width + 2 * x + dx) * 4 + k]!;
    data[(y * w + x) * 4 + k] = Math.round(sum / 4);
  }
  return { width: w, height: h, data };
}
