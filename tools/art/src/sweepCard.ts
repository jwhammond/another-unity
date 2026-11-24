// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Plan 15 Task 9's tuning sweep: one card animation repainted at several settings, each checked, timed and put on a sheet
 * (the references, the upscaled frames, then one row of repainted frames per setting). Usage:
 *   IMAGES_DIR=... CARD_SWEEP='[{"name":"d45","denoise":0.45}]' npx tsx tools/art/src/sweepCard.ts art/recipes/card.riker.yaml 6 riker-walk6
 * Variant fields: name, denoise, face, body (reference weights), group, depth, lineart (strengths), seed, prompt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artCache } from './cache';
import { checkAnim } from './cardchecks';
import { repaintAnim, unionBox } from './cardrepaint';
import { cells, loadSprite, stripOf, upscaledAnim, type CardDeps } from './cardrun';
import { withGenerator } from './comfy';
import { decodePng, encodePng, type Rgba } from './image';
import { loadModels } from './models';
import { parseRecipe, type CardRecipe } from './recipe';
import { refFile } from './refs';
import { checkPins, choiceFor } from './run';
import { modelsFor } from './select';
import { writeSheet, type Cell } from './sheet';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');

interface Variant {
  name: string;
  denoise?: number;
  face?: number;
  body?: number;
  group?: number;
  depth?: number;
  lineart?: number;
  seed?: number;
  steps?: number;
  prompt?: string;
  /** Timing probes: leave a part out. */
  noMask?: boolean;
  noRefs?: boolean;
  noDepth?: boolean;
  noLineart?: boolean;
  /** Only the first n frames (a quick look). */
  frames?: number;
}

const crop = (img: Rgba, b: { x: number; y: number; w: number; h: number }): Rgba => {
  const data = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) data.set(img.data.subarray(((b.y + y) * img.width + b.x) * 4, ((b.y + y) * img.width + b.x + b.w) * 4), y * b.w * 4);
  return { width: b.w, height: b.h, data };
};

async function main(): Promise<void> {
  const [recipePath, animArg, sheetName] = process.argv.slice(2);
  if (!recipePath || !animArg || !sheetName) throw new Error('usage: sweepCard.ts <card recipe> <anim> <sheet name>');
  const images = process.env.IMAGES_DIR;
  if (!images) throw new Error('IMAGES_DIR is not set');
  const text = readFileSync(recipePath, 'utf8');
  const base = parseRecipe(text, recipePath) as CardRecipe;
  const variants = JSON.parse(process.env.CARD_SWEEP ?? '[{"name":"base"}]') as Variant[];
  const anim = Number(animArg);
  const cache = artCache();
  const models = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
  const out = join(cache.work, 'sweep-card', sheetName);
  mkdirSync(out, { recursive: true });
  const rows: Cell[][] = [];
  const log: string[] = [];
  await withGenerator(
    cache,
    async generator => {
      const deps: CardDeps = { generator, models, cache, imagesDir: images, gameDir: join(REPO, 'games', 'unity') };
      const choice = choiceFor(base, models);
      await checkPins(choice, { generator, models, cache, external: !!process.env.COMFY_URL }, ['checkpoint', 'vae', 'lora', 'depth', 'lineart', 'depthAnnotator', 'lineartAnnotator', 'upscaler', 'ipadapterStyle', 'ipadapterFace', 'clipVision']);
      const sprite = loadSprite(images, base);
      const { made } = await upscaledAnim(deps, base, sprite, anim);
      const up = cells(made.strip, made.frames, made.cell, made.columns);
      const orig = cells(made.original, made.frames, [made.cell[0] / 4, made.cell[1] / 4], made.columns);
      writeFileSync(join(out, 'up.png'), encodePng(stripOf(up, made.cell, made.columns)));
      writeFileSync(join(out, 'cell.json'), JSON.stringify({ cell: made.cell, columns: made.columns, frames: made.frames }));
      const box = unionBox(up);
      const refs = base.reference.flatMap(r => r.refs);
      const bytes = refs.map(id => new Uint8Array(readFileSync(refFile(join(cache.root, 'refs'), id))));
      rows.push(refs.map((id, i) => ({ png: bytes[i]!, caption: id })));
      rows.push(up.map((f, i) => ({ png: encodePng(crop(f, box)), caption: `original ${i}` })));
      for (const v of variants) {
        const r: CardRecipe = {
          ...base,
          denoise: v.denoise ?? base.denoise,
          group: v.group ?? base.group,
          sampling: { ...base.sampling, seed: v.seed ?? base.sampling.seed, steps: v.steps ?? base.sampling.steps },
          prompt: v.prompt ?? base.prompt,
          depth: base.depth && v.depth !== undefined ? { ...base.depth, strength: v.depth } : base.depth,
          lineart: base.lineart && v.lineart !== undefined ? { ...base.lineart, strength: v.lineart } : base.lineart,
          reference: v.noRefs ? [] : base.reference.map(x => ({ ...x, weight: x.model === 'face' ? (v.face ?? x.weight) : (v.body ?? x.weight), ...(v.noMask ? { mask: 'none' as const } : {}) })),
        };
        if (v.noDepth) delete r.depth;
        if (v.noLineart) delete r.lineart;
        const times: number[] = [];
        const n = v.frames ?? up.length;
        const rep = await repaintAnim(generator, modelsFor(models, choice), r, up.slice(0, n), v.noRefs ? [] : bytes, { stamp: `${sheetName}-${v.name}`, onCanvas: c => times.push(c.seconds) });
        const check = checkAnim(orig.slice(0, n), up.slice(0, n), rep, r.checks);
        const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
        const line = `${v.name}: ${times.length} canvas(es) ${times.map(t => t.toFixed(0)).join('/')} s; ok=${check.ok} flicker median ${check.flickerMedian.toFixed(2)} max ${Math.max(0, ...check.flicker).toFixed(2)}; shift median ${med(check.alignment).toFixed(2)} worst ${check.worstShift.toFixed(2)}; dE max ${Math.max(...check.deltaE)}${check.why ? `; ${check.why}` : ''}`;
        console.log(line);
        log.push(line);
        writeFileSync(join(out, `${v.name}.png`), encodePng(stripOf(rep, made.cell, made.columns)));
        rows.push(rep.map((f, i) => ({ png: encodePng(crop(f, box)), caption: `${v.name} ${i}` })));
      }
    },
    { flags: models.selected?.comfyFlags },
  );
  writeFileSync(join(out, 'results.txt'), `${log.join('\n')}\n`);
  const cellW = Math.max(120, Math.floor(1800 / Math.max(...rows.map(r => r.length))));
  await writeSheet(rows, resolve(cache.work, 'sheets', `card-${sheetName}`), { cell: [cellW, Math.round(cellW * 3.2)] });
  console.log(`sheet ${join(cache.work, 'sheets', `card-${sheetName}.png`)}`);
}
void main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
void decodePng;
