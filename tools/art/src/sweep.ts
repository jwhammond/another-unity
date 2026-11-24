// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The ControlNet-window sweep of Plan 15 Task 3: a repaint recipe at several denoises, without ControlNets and with
 * depth+lineart at several strengths, each checked by the alignment check. Writes plates, overlays and a result table
 * under <work>/sweep-<id>/ and the numbers to a YAML file. Usage:
 *   IMAGES_DIR=... npx tsx tools/art/src/sweep.ts art/recipes/lab.s01.yaml art/bench/<date>-cn-window.yaml
 *   npx tsx tools/art/src/sweep.ts --sheet <recipe> <sweep dir>    (contact sheets from a finished sweep)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { alignCheck, ALIGN_DEFAULTS, overlay, type AlignReport } from './align';
import { artCache } from './cache';
import { withGenerator } from './comfy';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { loadModels } from './models';
import { originalBackground } from './originals';
import { backgroundOf, parseRecipe, type RepaintRecipe } from './recipe';
import { repaint } from './repaint';
import { checkPins, choiceFor } from './run';
import { loadScreenInputs } from './screen';
import { modelsFor } from './select';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');

/** SWEEP_DENOISES='[0.3]' and SWEEP_STRENGTHS='[[1,0.9]]' (JSON) narrow or move the grid; SWEEP_NOCN=0 leaves out the no-ControlNet column. */
export const DENOISES: number[] = process.env.SWEEP_DENOISES ? JSON.parse(process.env.SWEEP_DENOISES) : [0.25, 0.35, 0.45, 0.55];
export const STRENGTHS: [number, number][] = process.env.SWEEP_STRENGTHS ? JSON.parse(process.env.SWEEP_STRENGTHS) : [[0.5, 0.4], [0.7, 0.6], [0.9, 0.8]];
const NOCN = process.env.SWEEP_NOCN !== '0';
export const label = (d: number, s?: [number, number]): string => `d${d.toFixed(2)}-${s ? `cn${s[0]}-${s[1]}` : 'nocn'}`;

interface Row {
  denoise: number;
  controls: string;
  measured: number;
  total: number;
  worstShift: number;
  worstPoint: string;
  drift: number;
  ok: boolean;
  why: string;
  activeFraction: string;
  seconds: number;
}

async function sweep(recipePath: string, benchOut: string): Promise<void> {
  const images = process.env.IMAGES_DIR;
  if (!images) throw new Error('IMAGES_DIR is not set');
  const text = readFileSync(recipePath, 'utf8');
  const base = parseRecipe(text, recipePath) as RepaintRecipe;
  const cache = artCache();
  const file = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
  const choice = choiceFor(base, file);
  const out = join(cache.work, `sweep-${base.id}${process.env.SWEEP_SUFFIX ?? ''}`);
  mkdirSync(out, { recursive: true });
  const rows: Row[] = [];
  await withGenerator(cache, async generator => {
    await checkPins(choice, { generator, models: file, cache });
    const original = await originalBackground(images, backgroundOf(base));
    const points = (await loadScreenInputs(join(REPO, 'games', 'unity'), base.id)).points;
    const m = modelsFor(file, choice);
    for (const denoise of DENOISES) {
      for (const s of [...(NOCN ? [undefined] : []), ...STRENGTHS]) {
        const name = label(denoise, s);
        const recipe: RepaintRecipe = {
          ...base,
          denoise,
          depth: s ? { strength: s[0], start: 0, end: 1 } : undefined,
          lineart: s ? { strength: s[1], start: 0, end: 1 } : undefined,
        };
        const t0 = Date.now();
        const r = await repaint(recipe, original, generator, m, `sweep-${name}`);
        const report: AlignReport = alignCheck(decodePng(original), decodePng(r.plate), points, { ...ALIGN_DEFAULTS, maxShift: 2 });
        const dir = join(out, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'plate.png'), r.plate);
        writeFileSync(join(dir, 'repainted.png'), r.repainted);
        writeFileSync(join(dir, 'align-overlay.png'), encodePng(overlay(decodePng(original), decodePng(r.plate), report)));
        const judged = report.points.filter(p => p.verdict !== 'flat');
        const worst = judged.reduce<(typeof judged)[number] | undefined>((a, p) => (!a || Math.hypot(p.dx, p.dy) > Math.hypot(a.dx, a.dy) ? p : a), undefined);
        const row: Row = {
          denoise,
          controls: s ? `depth ${s[0]} + lineart ${s[1]}` : 'none',
          measured: report.measured,
          total: report.total,
          worstShift: worst ? Math.round(Math.hypot(worst.dx, worst.dy) * 100) / 100 : 0,
          worstPoint: worst?.source ?? '',
          drift: Math.max(report.axes?.x.median ?? 0, report.axes?.y.median ?? 0),
          ok: report.ok,
          why: report.why ?? '',
          activeFraction: r.controls.map(c => `${c.name} ${c.activeFraction.toFixed(2)}`).join(', '),
          seconds: Math.round((Date.now() - t0) / 100) / 10,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        writeFileSync(join(out, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
      }
    }
  });
  const header = `# Plan 15 Task 3: ${base.id} at seed ${base.sampling.seed}, ${base.sampling.steps} steps ${base.sampling.sampler}/${base.sampling.scheduler}, ControlNet windows {0, 1} relative to the sampled steps.\n# Numbers only. worstShift is the largest |shift| (px, original scale) of any measured point; drift the larger axis median.\n`;
  mkdirSync(dirname(resolve(benchOut)), { recursive: true });
  writeFileSync(benchOut, header + stringify({ recipe: base.id, rows }));
}

/** Contact sheets: one row per denoise; columns original, no CN, then each strength. A second sheet of the alignment overlays. */
async function sheets(recipePath: string, dir: string, images: string): Promise<void> {
  const base = parseRecipe(readFileSync(recipePath, 'utf8'), recipePath) as RepaintRecipe;
  const original = decodePng(await originalBackground(images, backgroundOf(base)));
  const W = 640;
  const H = 480;
  const cols = 2 + STRENGTHS.length;
  const make = (pick: (name: string) => Rgba, firstCol: Rgba, file: string): void => {
    const sheet: Rgba = { width: W * cols, height: H * DENOISES.length, data: new Uint8Array(W * cols * H * DENOISES.length * 4).fill(0) };
    const put = (img: Rgba, cx: number, cy: number): void => {
      const s = areaResize(img, W, H);
      for (let y = 0; y < H; y++) sheet.data.set(s.data.subarray(y * W * 4, (y + 1) * W * 4), ((cy * H + y) * sheet.width + cx * W) * 4);
    };
    DENOISES.forEach((d, row) => {
      put(firstCol, 0, row);
      [undefined, ...STRENGTHS].forEach((s, i) => put(pick(label(d, s)), i + 1, row));
    });
    writeFileSync(file, encodePng(sheet));
    console.log(file);
  };
  const read = (name: string, f: string): Rgba => decodePng(new Uint8Array(readFileSync(join(dir, name, f))));
  make(n => read(n, 'plate.png'), original, join(dir, 'sheet-plates.png'));
  make(n => read(n, 'align-overlay.png'), original, join(dir, 'sheet-overlays.png'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const run = args[0] === '--sheet' ? sheets(args[1]!, args[2]!, process.env.IMAGES_DIR!) : sweep(args[0]!, args[1]!);
  run.then(
    () => process.exit(0),
    e => {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(1);
    },
  );
}
