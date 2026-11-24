// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The review sheet for a repainted card (R12): the show references, then per animation a row of the upscaled original's frames
 * and a row of the repainted ones (each cropped to the animation's opaque union), from the newest run in the cache.
 *   npx tsx tools/art/src/cardsheet.ts riker 6,31 riker-walk-talk [step]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { artCache } from './cache';
import { unionBox } from './cardrepaint';
import { cells } from './cardrun';
import { decodePng, encodePng, type Rgba } from './image';
import { refFile } from './refs';
import { writeSheet, type Cell } from './sheet';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [object, animArg, name, stepArg] = process.argv.slice(2);
if (!object || !animArg || !name) throw new Error('usage: cardsheet.ts <object> <anim,anim> <name> [step]');
const cache = artCache();
const step = Number(stepArg ?? 1);
const crop = (img: Rgba, b: { x: number; y: number; w: number; h: number }): Rgba => {
  const data = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) data.set(img.data.subarray(((b.y + y) * img.width + b.x) * 4, ((b.y + y) * img.width + b.x + b.w) * 4), y * b.w * 4);
  return { width: b.w, height: b.h, data };
};
const rows: Cell[][] = [];
const refsDir = join(cache.root, 'refs');
const faces = [1, 2, 3].map(i => `crew.${object}.face.${i}`).filter(id => existsSync(join(refsDir, 'crops', `${id}.png`)));
rows.push([...faces, `crew.${object}.body.1`].filter(id => existsSync(join(refsDir, 'crops', `${id}.png`))).map(id => ({ png: new Uint8Array(readFileSync(refFile(refsDir, id))), caption: `reference ${id}` })));
for (const anim of animArg.split(',')) {
  const dir = join(cache.work, 'cards', object, 'repaint', anim);
  const run = readdirSync(dir).sort().filter(d => existsSync(join(dir, d, 'check.json'))).pop()!;
  const meta = JSON.parse(readFileSync(join(dir, run, 'meta.json'), 'utf8')) as { frames: number };
  const up = decodePng(new Uint8Array(readFileSync(join(dir, run, 'upscaled.png'))));
  const rep = decodePng(new Uint8Array(readFileSync(join(dir, run, 'repainted.png'))));
  const cols = JSON.parse(readFileSync(join(dir, run, 'meta.json'), 'utf8')) as { cell?: [number, number]; columns?: number };
  // (older runs didn't record the cell: the published entry has it)
  const pub = (parse(readFileSync(join(REPO, 'games', 'unity', 'presentation.yaml'), 'utf8')) as { art: { cards: Record<string, { anims: Record<string, { cell: [number, number]; columns?: number; frames: number }> }> } }).art.cards[object]!.anims[anim]!;
  const cell = cols.cell ?? pub.cell;
  const c = cols.columns ?? pub.columns ?? pub.frames;
  const upCells = cells(up, meta.frames, cell, c);
  const repCells = cells(rep, meta.frames, cell, c);
  const box = unionBox(upCells);
  const idx = upCells.map((_, i) => i).filter(i => i % step === 0);
  rows.push(idx.map(i => ({ png: encodePng(crop(upCells[i]!, box)), caption: `anim ${anim} original ${i}` })));
  rows.push(idx.map(i => ({ png: encodePng(crop(repCells[i]!, box)), caption: `anim ${anim} repainted ${i}` })));
}
const cw = Math.max(110, Math.floor(1800 / Math.max(...rows.map(r => r.length))));
await writeSheet(rows, join(cache.work, 'sheets', name), { cell: [cw, Math.round(cw * 3.2)] });
console.log(join(cache.work, 'sheets', `${name}.png`));
