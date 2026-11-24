// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pictures published the way the original draws them: one byte a pixel, a palette, no colouring in advance (engine/src/view/indexed.ts). The
 * engineering screen and the holodeck are painted from these, with the original's own palette rotations; the game's bitmap fonts ride along.
 * Everything lands in the git-ignored games/unity/art, with its key in presentation.yaml written here (the engine finds nothing without it).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { type IndexedImage, writePack } from '../../../engine/src/view/indexed';

const W = 640;
const H = 480;

/**
 * graphics.cpp setBackgroundImage: a .pic holds 256 6-bit palette entries, the other screens (.rm, .ast) the first 128, the upper half
 * being standard.pal's; then 640x480 indices. Returns them with the palette in 8 bits (each entry shifted left by two).
 */
export function backgroundIndexed(bytes: Uint8Array, standardPal: Uint8Array, name: string): { image: IndexedImage; palette: Uint8Array } {
  const colours = name.toLowerCase().endsWith('.pic') ? 256 : 128;
  const need = colours * 3 + W * H;
  if (bytes.length < need) throw new Error(`${name}: ${bytes.length} bytes, need ${need}`);
  if (colours === 128 && standardPal.length < 128 * 3) throw new Error(`standard.pal has ${standardPal.length} bytes, need ${128 * 3}`);
  const palette = new Uint8Array(256 * 3);
  palette.set(bytes.subarray(0, colours * 3));
  if (colours === 128) palette.set(standardPal.subarray(0, 128 * 3), 128 * 3);
  for (let i = 0; i < palette.length; i++) palette[i] = (palette[i]! << 2) & 0xff;
  return { image: { width: W, height: H, pixels: bytes.slice(colours * 3, need) }, palette };
}

/** Writes `art/<dir>/<name>.pack` and `art/<dir>/palette.rgb` (each through a temporary name, so a failure leaves what was there). Returns their paths relative to the game. */
export async function publishPack(gameDir: string, dir: string, name: string, images: readonly IndexedImage[], palette: Uint8Array): Promise<{ pack: string; palette: string }> {
  if (palette.length !== 256 * 3) throw new Error(`a palette is 768 bytes, not ${palette.length}`);
  await mkdir(join(gameDir, 'art', dir), { recursive: true });
  const files = { pack: `art/${dir}/${name}.pack`, palette: `art/${dir}/palette.rgb` };
  const staged: { tmp: string; dest: string }[] = [];
  try {
    for (const [rel, bytes] of [[files.pack, writePack(images)], [files.palette, palette]] as const) {
      const dest = join(gameDir, rel);
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, bytes);
      staged.push({ tmp, dest });
    }
  } catch (e) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw e;
  }
  for (const s of staged) await rename(s.tmp, s.dest);
  return files;
}

/** The game's bitmap fonts (font0.fon ...) copied as they are into `art/fonts`; returns their paths in font order. */
export async function publishFonts(gameDir: string, fonts: readonly Uint8Array[]): Promise<string[]> {
  await mkdir(join(gameDir, 'art', 'fonts'), { recursive: true });
  const rels = fonts.map((_, i) => `art/fonts/font${i}.fon`);
  await Promise.all(fonts.map((bytes, i) => writeFile(join(gameDir, rels[i]!), bytes)));
  return rels;
}

/** Sets `art.<key>` in presentation.yaml, leaving every other key as it is. */
export async function setArtKey(gameDir: string, key: string, value: unknown): Promise<void> {
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  doc.setIn(['art', key], value);
  await writeFile(path, String(doc));
}
