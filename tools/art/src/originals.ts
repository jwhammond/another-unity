// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The original's PNG for an images-export screen id, through manifest.json. `imagesDir` is `.../runs/images/media`. */
export async function originalBackground(imagesDir: string, screen: string): Promise<Uint8Array> {
  const manifest = JSON.parse(await readFile(join(imagesDir, 'images', 'manifest.json'), 'utf8')) as { backgrounds: { screen: string; png: string }[] };
  const entry = manifest.backgrounds.find(b => b.screen === screen);
  if (!entry) throw new Error(`no background "${screen}" in ${join(imagesDir, 'images', 'manifest.json')}`);
  const path = join(imagesDir, entry.png);
  if (!path.startsWith(imagesDir)) throw new Error(`manifest path escapes the images dir: ${entry.png}`);
  return new Uint8Array(await readFile(path));
}
