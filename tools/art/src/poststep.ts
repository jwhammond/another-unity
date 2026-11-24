// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { alignCheck, ALIGN_DEFAULTS, overlay, type AlignReport } from './align';
import { decodePng, encodePng, type Rgba } from './image';
import type { CheckPoint } from './points';
import type { RepaintRecipe } from './recipe';
import type { RunMeta } from './run';
import { warpPlate, type WarpReport } from './warp';

export interface PlateChecks {
  checks: Record<string, unknown>;
  alignReport?: AlignReport;
  warp?: WarpReport;
}

/**
 * The plate's post-checks for a run in `dir` (its outputs.plate is read, and rewritten when the warp changes it): the optional local
 * warp, then the alignment check as before, or, for an upscale-only plate whose recipe says `align: { skip: true, reason }`, the
 * skip, recorded with its reason and logged through `warn`. A repainted plate can't skip (the recipe schema refuses it, and this does too).
 */
export async function plateChecks(
  recipe: RepaintRecipe,
  original: Rgba,
  dir: string,
  outputs: RunMeta['outputs'],
  points: () => Promise<CheckPoint[]>,
  warn: (line: string) => void = console.warn,
): Promise<PlateChecks> {
  const checks: Record<string, unknown> = {};
  const alignStep = recipe.post.find(p => 'align' in p);
  const warpStep = recipe.post.find(p => 'warp' in p);
  const plateOut = outputs.plate!;
  if (alignStep && 'align' in alignStep && alignStep.align.skip) {
    if (recipe.repaint !== false) throw new Error(`${recipe.id}: a repainted plate can't skip the alignment check; only an upscale-only plate (repaint: false) may`);
    const reason = alignStep.align.reason ?? '(no reason given)';
    warn(`!!! ${recipe.id}: ALIGNMENT CHECK SKIPPED for this upscale-only plate: ${reason}`);
    checks.align = { ok: false, skipped: true, reason, measured: 0, total: 0 };
    return { checks };
  }
  let warp: WarpReport | undefined;
  if (warpStep && 'warp' in warpStep) {
    const pts = await points();
    const r = warpPlate(original, decodePng(new Uint8Array(await readFile(plateOut.file))), pts, warpStep.warp);
    warp = r.report;
    checks.warp = { ...r.report, points: pts.length };
    if (r.report.changed) {
      const before = join(dir, 'plate.prewarp.png');
      await copyFile(plateOut.file, before);
      const bytes = encodePng(r.plate);
      await writeFile(plateOut.file, bytes);
      outputs.plate = { ...plateOut, sha256: createHash('sha256').update(bytes).digest('hex') };
      const old = new Uint8Array(await readFile(before));
      outputs.prewarp = { file: before, sha256: createHash('sha256').update(old).digest('hex'), width: plateOut.width, height: plateOut.height };
    }
    const n = r.report.passes.reduce((s, p) => s + p.warped.length, 0);
    warn(`${recipe.id}: warp ${r.report.refused ? `REFUSED (${r.report.refused})` : `moved ${n} point${n === 1 ? '' : 's'} in ${r.report.passes.length} pass${r.report.passes.length === 1 ? '' : 'es'}`}`);
  }
  if (alignStep && 'align' in alignStep) {
    const plate = decodePng(new Uint8Array(await readFile(outputs.plate!.file)));
    const alignReport = alignCheck(original, plate, await points(), { ...ALIGN_DEFAULTS, maxShift: alignStep.align.maxShift });
    const { points: all, ...summary } = alignReport;
    await writeFile(join(dir, 'align.json'), `${JSON.stringify(alignReport, null, 2)}\n`);
    await writeFile(join(dir, 'align-overlay.png'), encodePng(overlay(original, plate, alignReport)));
    checks.align = { ...summary, points: all.length };
    return { checks, alignReport, warp };
  }
  return { checks, warp };
}

/**
 * Re-does a finished run's post stage without regenerating anything (`art post`): the run in `src` is copied to a new run directory
 * beside it, its plate is warped (the recipe's `warp` step) and checked (`align`) again, and meta.json is written for the copy.
 * An upscale-only recipe takes the run's `upscaled.png` as its plate. The source run is left as it was. Returns the new run; `ok`
 * says whether it may be published (the check passed, or was skipped by an upscale-only recipe), and only then is last.json moved.
 */
export async function rebuildRun(
  recipe: RepaintRecipe,
  recipeText: string,
  src: string,
  original: Rgba,
  points: () => Promise<CheckPoint[]>,
  warn: (line: string) => void,
  now: () => number = Date.now,
): Promise<{ dir: string; meta: RunMeta; ok: boolean; why?: string }> {
  const old = JSON.parse(await readFile(join(src, 'meta.json'), 'utf8')) as RunMeta;
  const stamp = `${basename(src)}-post-${new Date(now()).toISOString().slice(11, 19).replace(/:/g, '')}`;
  const dir = join(dirname(src), stamp);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(src)) if (f.endsWith('.png')) await copyFile(join(src, f), join(dir, f));
  const outputs: RunMeta['outputs'] = {};
  for (const [name, o] of Object.entries(old.outputs)) outputs[name] = { ...o, file: join(dir, basename(o.file)) };
  if (recipe.repaint === false) {
    // (the de-dithered upscale at the plate's size)
    const up = decodePng(new Uint8Array(await readFile(join(src, 'upscaled.png'))));
    const [w, h] = recipe.size.out;
    if (up.width !== w || up.height !== h) throw new Error(`${recipe.id}: the run's upscaled.png is ${up.width}x${up.height}, the recipe's plate ${w}x${h}`);
    const bytes = new Uint8Array(await readFile(join(src, 'upscaled.png')));
    await writeFile(join(dir, 'plate.png'), bytes);
    outputs.plate = { file: join(dir, 'plate.png'), sha256: createHash('sha256').update(bytes).digest('hex'), width: w, height: h };
    for (const k of ['work', 'repainted', 'mask']) delete outputs[k];
  }
  if (!outputs.plate) throw new Error(`${src} has no plate`);
  const { checks, alignReport } = await plateChecks(recipe, original, dir, outputs, points, warn);
  const meta: RunMeta = {
    ...old,
    recipe: recipe.id,
    recipeSha256: createHash('sha256').update(recipeText).digest('hex'),
    outputs,
    checks,
    ...(recipe.repaint === false ? { upscaleOnly: true as const } : {}),
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const skipped = (checks.align as { skipped?: boolean } | undefined)?.skipped === true;
  const ok = skipped || alignReport?.ok === true;
  return { dir, meta, ok, why: ok ? undefined : alignReport?.why ?? 'no alignment check in the recipe' };
}
