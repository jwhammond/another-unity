// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The IP-Adapter reference sweep of Plan 15 Task 4: a repaint recipe with its own references replaced by each variant,
 * every plate checked by the alignment check, then a side-by-side sheet (original, earlier plates, variants, references).
 * Usage:
 *   IMAGES_DIR=... SWEEP_VARIANTS='[{"name":"w0.6","refs":["set.lab.2"],"weight":0.6}]' \
 *     npx tsx tools/art/src/sweepRef.ts art/recipes/lab.s01.yaml <sweep name> [--earlier <plate.png>=<caption> ...]
 * Output: <work>/sweep-ref-<name>/ (plates, overlays, rows.json, sheet.png and sheet.html).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignCheck, ALIGN_DEFAULTS, overlay } from './align';
import { artCache } from './cache';
import { withGenerator } from './comfy';
import { decodePng, encodePng } from './image';
import { loadModels } from './models';
import { originalBackground } from './originals';
import { backgroundOf, manifestIds, parseRecipe, type ReferenceSpec, type RepaintRecipe } from './recipe';
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
  start?: number;
  end?: number;
  denoise?: number;
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
  const out = join(cache.work, `sweep-ref-${name}`);
  mkdirSync(out, { recursive: true });
  const refsDir = join(cache.root, 'refs');
  const original = await originalBackground(images, backgroundOf(base));
  const points = (await loadScreenInputs(join(REPO, 'games', 'unity'), base.id)).points;
  const rows: Record<string, unknown>[] = [];
  const cells: Cell[] = [
    { png: original, caption: 'original' },
    ...earlier.map(([f, c]) => ({ png: new Uint8Array(readFileSync(f)), caption: c })),
  ];
  const refCells = new Map<string, Cell>();
  await withGenerator(cache, async generator => {
    await checkPins(choice, { generator, models: file, cache });
    const m = modelsFor(file, choice);
    for (const v of variants) {
      for (const id of v.refs) if (!known.has(id)) throw new Error(`unknown reference ${id}`);
      const spec: ReferenceSpec = { refs: v.refs, model: 'style', weight: v.weight, weightType: v.weightType ?? 'style transfer', start: v.start ?? 0, end: v.end ?? 1, mask: 'none' };
      const recipe: RepaintRecipe = { ...base, denoise: v.denoise ?? base.denoise, reference: [spec] };
      const refs = [{ spec, images: v.refs.map(id => ({ id, bytes: new Uint8Array(readFileSync(refFile(refsDir, id))) })) }];
      for (const r of refs[0]!.images) refCells.set(r.id, { png: r.bytes, caption: `reference ${r.id}` });
      const t0 = Date.now();
      const r = await repaint(recipe, original, generator, m, `sweepref-${v.name}`, refs);
      const report = alignCheck(decodePng(original), decodePng(r.plate), points, { ...ALIGN_DEFAULTS, maxShift: 2 });
      const dir = join(out, v.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plate.png'), r.plate);
      writeFileSync(join(dir, 'align-overlay.png'), encodePng(overlay(decodePng(original), decodePng(r.plate), report)));
      const judged = report.points.filter(p => p.verdict !== 'flat');
      const worst = judged.reduce<(typeof judged)[number] | undefined>((a, p) => (!a || Math.hypot(p.dx, p.dy) > Math.hypot(a.dx, a.dy) ? p : a), undefined);
      const row = {
        ...v,
        denoise: recipe.denoise,
        measured: report.measured,
        total: report.total,
        worstShift: worst ? Math.round(Math.hypot(worst.dx, worst.dy) * 100) / 100 : 0,
        worstPoint: worst?.source ?? '',
        ok: report.ok,
        why: report.why ?? '',
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      writeFileSync(join(out, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
      cells.push({ png: r.plate, caption: `${v.name}: ${v.refs.join('+')} ${spec.weightType} ${v.weight} d${recipe.denoise} align ${report.ok ? 'ok' : 'FAIL'} worst ${(row.worstShift as number).toFixed(2)}px` });
    }
  });
  const all = [...cells, ...refCells.values()];
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
