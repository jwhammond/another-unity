// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Review sheets for rooms from their last good runs (Plan 15 Task 6).
 * Usage: IMAGES_DIR=... npx tsx tools/art/src/roomSheets.ts <name> <room id>...   (e.g. lab.s01 lab.s02 ...)
 * Writes <work>/sheets/<name>-contact.png (original | plate per room, in the order given, 2 rooms per row)
 * and <work>/sheets/<room>-review.png (original | plate | alignment overlay | mask) per room.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artCache } from './cache';
import { originalBackground } from './originals';
import { writeSheet, type Cell } from './sheet';

const [name, ...ids] = process.argv.slice(2);
const images = process.env.IMAGES_DIR;
if (!name || !ids.length || !images) throw new Error('usage: IMAGES_DIR=... roomSheets.ts <name> <room id>...');
const cache = artCache();
const contact: Cell[][] = [];
let row: Cell[] = [];
for (const id of ids) {
  const last = JSON.parse(readFileSync(join(cache.work, id, 'last.json'), 'utf8')) as { dir: string; meta: { recipe?: { source?: { background?: string } } } };
  const screen = `s_04${id.split('.s')[1]}`;
  const original = await originalBackground(images, screen);
  const read = (f: string): Uint8Array => new Uint8Array(readFileSync(join(last.dir, f)));
  const cells: Cell[] = [
    { png: original, caption: `${id} original` },
    { png: read('plate.png'), caption: `${id} plate` },
  ];
  await writeSheet([[...cells, { png: read('align-overlay.png'), caption: 'alignment' }, { png: read('mask.png'), caption: 'mask' }]], join(cache.work, 'sheets', `${id.replace('.', '-')}-review`), { cell: [480, 360] });
  row.push(...cells);
  if (row.length === 4) {
    contact.push(row);
    row = [];
  }
}
if (row.length) contact.push(row);
await writeSheet(contact, join(cache.work, 'sheets', `${name}-contact`), { cell: [480, 360] });
console.log(join(cache.work, 'sheets', `${name}-contact.png`));
