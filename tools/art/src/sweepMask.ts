// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The masked-denoise sweep of Plan 15 Task 5: a repaint recipe with each variant's denoise, mask settings and references,
 * every plate checked by the alignment check, then a side-by-side sheet (original, earlier plates, candidates, masks).
 * Usage:
 *   IMAGES_DIR=... SWEEP_VARIANTS='[{"name":"a","denoise":0.6,"protect":0.5,"refs":["mat.lcars.1"],"weight":1,"weightType":"strong style transfer"}]' \
 *     npx tsx tools/art/src/sweepMask.ts art/recipes/lab.s01.yaml <sweep name> [--earlier <plate.png>=<caption> ...]
 * Output: <work>/sweep-mask-<name>/ (plates, overlays, masks, rows.json, sheet.png and sheet.html).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignCheck, ALIGN_DEFAULTS, overlay } from './align';
import { artCache } from './cache';
import { withGenerator } from './comfy';
import { decodePng, encodePng, meanAbsDiff } from './image';
import { denoiseMask, maskToRgba, MASK_DEFAULTS } from './maskdenoise';
import { loadModels } from './models';
import { originalBackground } from './originals';
import { backgroundOf, manifestIds, parseRecipe, type MaskSpec, type ReferenceSpec, type RepaintRecipe } from './recipe';
import { refFile } from './refs';
import { repaint } from './repaint';
import { checkPins, choiceFor } from './run';
import { loadScreenInputs } from './screen';
import { modelsFor } from './select';
import { writeSheet, type Cell } from './sheet';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Variant {
  name: string;
  refs: string[];
  weight: number;
  weightType?: ReferenceSpec['weightType'];
  denoise: number;
  protect?: number;
  seed?: number;
  mask?: Partial<MaskSpec>;
  /** Replaces the recipe's prompt. */
  prompt?: string;
  /** No mask: plain img2img at `denoise`. */
  plain?: boolean;
}

async function main(recipePath: string, name: string, earlier: [string, string][]): Promise<void> {
  const images = process.env.IMAGES_DIR;
  if (!images) throw new Error('IMAGES_DIR is not set');
  const variants = JSON.parse(process.env.SWEEP_VARIANTS ?? '[]') as Variant[];
  const base = parseRecipe(readFileSync(recipePath, 'utf8'), recipePath) as RepaintRecipe;
  const cache = artCache();
  const file = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
  const choice = choiceFor(base, file);
  const known = manifestIds();
  const out = join(cache.work, `sweep-mask-${name}`);
  mkdirSync(out, { recursive: true });
  const refsDir = join(cache.root, 'refs');
  const original = await originalBackground(images, backgroundOf(base));
  const inputs = await loadScreenInputs(join(REPO, 'games', 'unity'), base.id);
  const rows: Record<string, unknown>[] = [];
  const cells: Cell[] = [{ png: original, caption: 'original' }, ...earlier.map(([f, c]) => ({ png: new Uint8Array(readFileSync(f)), caption: c }))];
  const ref0 = earlier[0] ? decodePng(new Uint8Array(readFileSync(earlier[0][0]))) : undefined;
  const maskCells: Cell[] = [];
  const refCells = new Map<string, Cell>();
  await withGenerator(cache, async generator => {
    await checkPins(choice, { generator, models: file, cache });
    const m = modelsFor(file, choice);
    for (const v of variants) {
      for (const id of v.refs) if (!known.has(id)) throw new Error(`unknown reference ${id}`);
      const spec: ReferenceSpec = { refs: v.refs, model: 'style', weight: v.weight, weightType: v.weightType ?? 'style transfer', start: 0, end: 1, mask: 'none' };
      const maskSpec = { ...MASK_DEFAULTS, ...(v.mask ?? {}), protect: v.protect ?? 0.5, open: 1 };
      const recipe: RepaintRecipe = { ...base, denoise: v.denoise, prompt: v.prompt ?? base.prompt, sampling: { ...base.sampling, seed: v.seed ?? base.sampling.seed }, reference: [spec] };
      const refs = [{ spec, images: v.refs.map(id => ({ id, bytes: new Uint8Array(readFileSync(refFile(refsDir, id))) })) }];
      for (const r of refs[0]!.images) refCells.set(r.id, { png: r.bytes, caption: `reference ${r.id}` });
      const dm = v.plain ? undefined : encodePng(maskToRgba(denoiseMask(decodePng(original), inputs.geometry, recipe.size.work, maskSpec)));
      const t0 = Date.now();
      const r = await repaint(recipe, original, generator, m, `sweepmask-${v.name}`, refs, dm);
      const report = alignCheck(decodePng(original), decodePng(r.plate), inputs.points, { ...ALIGN_DEFAULTS, maxShift: 2 });
      const dir = join(out, v.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plate.png'), r.plate);
      if (dm) writeFileSync(join(dir, 'mask.png'), dm);
      writeFileSync(join(dir, 'align-overlay.png'), encodePng(overlay(decodePng(original), decodePng(r.plate), report)));
      const judged = report.points.filter(p => p.verdict !== 'flat');
      const bad = judged.filter(p => Math.hypot(p.dx, p.dy) > 2);
      const worst = judged.reduce<(typeof judged)[number] | undefined>((a, p) => (!a || Math.hypot(p.dx, p.dy) > Math.hypot(a.dx, a.dy) ? p : a), undefined);
      const row = {
        ...v,
        measured: report.measured,
        total: report.total,
        worstShift: worst ? Math.round(Math.hypot(worst.dx, worst.dy) * 100) / 100 : 0,
        worstPoint: worst?.source ?? '',
        failing: bad.map(p => p.source),
        changeVsFirst: ref0 ? Math.round(meanAbsDiff(ref0, decodePng(r.plate)) * 100) / 100 : null,
        ok: report.ok,
        why: report.why ?? '',
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      writeFileSync(join(out, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
      cells.push({ png: r.plate, caption: `${v.name}: d${v.denoise} protect ${v.protect ?? 0.5} ${spec.weightType} ${v.weight} align ${report.ok ? 'ok' : 'FAIL'} worst ${(row.worstShift as number).toFixed(2)}px change ${row.changeVsFirst}` });
      if (dm) maskCells.push({ png: dm, caption: `mask ${v.name}` });
    }
  });
  const all = [...cells, ...refCells.values(), ...maskCells.slice(0, 1)];
  const grid: Cell[][] = [];
  for (let i = 0; i < all.length; i += 4) grid.push(all.slice(i, i + 4));
  await writeSheet(grid, join(out, 'sheet'), { cell: [640, 480] });
  console.log(join(out, 'sheet.png'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const earlier: [string, string][] = [];
  for (let i = 2; i < args.length; i++) if (args[i] === '--earlier') earlier.push(args[++i]!.split('=', 2) as [string, string]);
  main(args[0]!, args[1]!, earlier).then(
    () => process.exit(0),
    e => {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(1);
    },
  );
}
