// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `art compare` (2026-10-18): the same room plate and crew-card frames repainted by each model family at a few settings, every
 * result checked as the real pipeline checks it (the room's 2 px alignment, the card checks), timed, and put on a review sheet.
 * Nothing is published: results go to <work>/compare/<id>/ and the numbers to art/compare/<id>.results.yaml.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { alignCheck, ALIGN_DEFAULTS, overlay } from './align';
import type { ArtCache } from './cache';
import { checkAnim, type AnimCheck } from './cardchecks';
import { repaintAnim, unionBox } from './cardrepaint';
import { cells, groupFor, loadSprite, seedFor, upscaledAnim, type CardDeps } from './cardrun';
import { familyModels, type ExperimentalFamily, type FamilyModels } from './families';
import type { Generator } from './generator';
import type { Models } from './graphs';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { denoiseMask, maskToRgba, MASK_DEFAULTS } from './maskdenoise';
import { FAMILIES, type Family, type ModelsFile } from './models';
import { originalBackground } from './originals';
import { backgroundOf, recipeSchema, type CardRecipe, type RepaintRecipe } from './recipe';
import { refFile } from './refs';
import { repaint } from './repaint';
import { loadScreenInputs } from './screen';
import { writeSheet, type Cell } from './sheet';

/** One job's changes from its recipe. `ref`: the references' weight (sdxl: IP-Adapter, flux: Redux strength), false for none. */
const jobOverride = z
  .object({
    denoise: z.number().min(0.05).max(0.7).optional(),
    depth: z.number().min(0).max(2).optional(),
    lineart: z.number().min(0).max(2).optional(),
    /** Room only: the masked denoise's protect value. */
    protect: z.number().min(0).max(1).optional(),
    steps: z.number().int().positive().optional(),
    cfg: z.number().positive().optional(),
    ref: z.union([z.number().min(0).max(1.5), z.literal(false)]).optional(),
  })
  .strict();
const variant = z.object({ name: z.string().regex(/^[a-z0-9-]+$/), room: jobOverride.default({}), card: jobOverride.default({}) }).strict();
const familyDefaults = z
  .object({
    sampling: z.object({ sampler: z.string(), scheduler: z.string(), cfg: z.number().positive().optional() }).strict().optional(),
    guidance: z.number().positive().optional(),
    shift: z.number().positive().optional(),
    room: z.object({ prompt: z.string().optional(), negative: z.string().optional() }).strict().default({}),
    card: z.object({ prompt: z.string().optional(), negative: z.string().optional() }).strict().default({}),
  })
  .strict();
export const compareSchema = z
  .object({
    id: z.string().regex(/^[0-9a-z-]+$/),
    room: z.object({ recipe: z.string(), detail: z.tuple([z.number().int(), z.number().int(), z.number().int().positive(), z.number().int().positive()]).default([330, 160, 160, 120]) }).strict(),
    card: z.object({ recipe: z.string(), anims: z.array(z.object({ anim: z.number().int().nonnegative(), frames: z.number().int().positive().optional() }).strict()).min(1) }).strict(),
    showRefs: z.array(z.string()).default([]),
    families: z.record(z.enum(FAMILIES), z.array(variant).min(1)),
    defaults: z.record(z.enum(FAMILIES), familyDefaults).default({}),
    /** Per family, the variant the sheet shows as its best (else the automatic pick, see pickBest). */
    best: z.record(z.enum(FAMILIES), z.string()).default({}),
  })
  .strict();
export type CompareFile = z.infer<typeof compareSchema>;
export type Variant = z.infer<typeof variant>;
type Defaults = z.infer<typeof familyDefaults> | undefined;

/** The references a family gets: sdxl keeps the recipe's (optionally reweighted), flux needs an explicit Redux strength, qwen-image none. */
function refsFor<R extends { reference: RepaintRecipe['reference'] }>(family: Family, base: R, ref: number | false | undefined): R['reference'] {
  if (ref === false || family === 'qwen-image') return [];
  if (family === 'flux') return ref === undefined ? [] : base.reference.map(r => ({ ...r, weight: ref }));
  return ref === undefined ? base.reference : base.reference.map(r => ({ ...r, weight: ref }));
}

/** The room recipe for a family and variant: validated by the recipe schema (the controls must be active, the family's knobs its own). */
export function variantRoom(base: RepaintRecipe, family: Family, d: Defaults, v: Variant): RepaintRecipe {
  const o = v.room;
  const flow = family !== 'sdxl';
  const r = {
    ...base,
    model: family,
    models: flow ? {} : base.models,
    sampling: { ...base.sampling, ...(d?.sampling ?? {}), ...(o.steps ? { steps: o.steps } : {}), ...(o.cfg ? { cfg: o.cfg } : {}) },
    prompt: (flow && d?.room.prompt) || base.prompt,
    negative: flow && d?.room.negative !== undefined ? d.room.negative : base.negative,
    denoise: o.denoise ?? base.denoise,
    depth: base.depth && o.depth !== undefined ? { ...base.depth, strength: o.depth } : base.depth,
    lineart: base.lineart && o.lineart !== undefined ? { ...base.lineart, strength: o.lineart } : base.lineart,
    mask: base.mask && o.protect !== undefined ? { ...base.mask, protect: o.protect } : base.mask,
    reference: refsFor(family, base, o.ref),
    ...(family === 'flux' ? { guidance: d?.guidance } : { guidance: undefined }),
    ...(family === 'qwen-image' ? { shift: d?.shift } : { shift: undefined }),
  };
  return recipeSchema.parse(r) as RepaintRecipe;
}

/** The card recipe for a family and variant (as variantRoom). */
export function variantCard(base: CardRecipe, family: Family, d: Defaults, v: Variant): CardRecipe {
  const o = v.card;
  const flow = family !== 'sdxl';
  const r = {
    ...base,
    model: family,
    models: flow ? {} : base.models,
    sampling: { ...base.sampling, ...(d?.sampling ?? {}), ...(o.steps ? { steps: o.steps } : {}), ...(o.cfg ? { cfg: o.cfg } : {}) },
    prompt: (flow && d?.card.prompt) || base.prompt,
    negative: flow && d?.card.negative !== undefined ? d.card.negative : base.negative,
    denoise: o.denoise ?? base.denoise,
    depth: base.depth && o.depth !== undefined ? { ...base.depth, strength: o.depth } : base.depth,
    lineart: base.lineart && o.lineart !== undefined ? { ...base.lineart, strength: o.lineart } : base.lineart,
    reference: refsFor(family, base, o.ref),
    ...(family === 'flux' ? { guidance: d?.guidance } : { guidance: undefined }),
    ...(family === 'qwen-image' ? { shift: d?.shift } : { shift: undefined }),
  };
  return recipeSchema.parse(r) as CardRecipe;
}

export interface RoomResult {
  ok: boolean;
  worstShift: number;
  worstPoint: string;
  /** The worst point's correlation peak (below ALIGN_DEFAULTS.minPeak the point fails: its structure is gone). */
  worstPeak: number;
  measured: number;
  total: number;
  seconds: number;
  why?: string;
}
export interface CardResult {
  anim: number;
  frames: number;
  ok: boolean;
  worstShift: number;
  /** The largest per-frame median shift. */
  medianShift: number;
  flickerMedian: number;
  flickerMax: number;
  deltaEMax: number;
  /** The forced silhouette held (the alpha is the original's in every frame). */
  silhouette: boolean;
  seconds: number;
  why?: string;
}
export interface VariantResult {
  family: Family;
  variant: string;
  /** What the run changed, in words, for the sheet. */
  settings: string;
  room?: RoomResult;
  cards: CardResult[];
  /** A run that threw (a refused graph, a timeout). */
  error?: string;
  key: string;
  /** The room's and the card's denoise (pickBest prefers more repaint). */
  denoise: [number, number];
}

export const passed = (r: VariantResult): boolean => !r.error && !!r.room?.ok && r.cards.length > 0 && r.cards.every(c => c.ok);

/**
 * The sheet's pick per family: a variant that passes every check, preferring the most repaint (the room's denoise, then the card's)
 * and then the smaller worst shift; `override` (the file's `best`) wins. Undefined when none passes.
 */
export function pickBest(results: VariantResult[], denoise: (r: VariantResult) => [number, number], override?: string): VariantResult | undefined {
  if (override) {
    const r = results.find(x => x.variant === override);
    if (r) return r;
  }
  const ok = results.filter(passed);
  ok.sort((a, b) => {
    const [ra, ca] = denoise(a);
    const [rb, cb] = denoise(b);
    return rb - ra || cb - ca || (a.room?.worstShift ?? 9) - (b.room?.worstShift ?? 9);
  });
  return ok[0];
}

export function describe(room: RepaintRecipe, card: CardRecipe): string {
  const ctl = (c?: { strength: number; start: number; end: number }) => (c ? `${c.strength}${c.start > 0 || c.end < 1 ? ` (${c.start}-${c.end})` : ''}` : 'off');
  const refs = (rs: RepaintRecipe['reference']) => (rs.length === 0 ? 'none' : rs.map(r => `${r.model} ${r.weight}`).join(' + '));
  const knob = room.model === 'flux' ? `, guidance ${room.guidance ?? 4.5}` : room.model === 'qwen-image' ? `, shift ${room.shift ?? 3.1}` : '';
  return [
    `${room.sampling.sampler}/${room.sampling.scheduler} cfg ${room.sampling.cfg}${knob}`,
    `room: d${room.denoise} protect ${room.mask?.protect ?? '-'}, ${room.sampling.steps} steps, depth ${ctl(room.depth)}, lineart ${ctl(room.lineart)}, refs ${refs(room.reference)}`,
    `card: d${card.denoise}, ${card.sampling.steps} steps, depth ${ctl(card.depth)}, lineart ${ctl(card.lineart)}, refs ${refs(card.reference)}`,
  ].join('; ');
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface CompareDeps {
  generator: Generator;
  models: ModelsFile;
  /** The SDXL models (the baseline's, and the upscaler and annotators every family shares). */
  sdxl: Models;
  cache: ArtCache;
  imagesDir: string;
  gameDir: string;
  refsDir: string;
  /** Recipe texts by path (the repo's). */
  read(path: string): string;
  /** Whether a family's files are all on the server (art doctor's family line). Families not ready are skipped and reported. */
  ready(family: Family): Promise<boolean>;
  log(line: string): void;
  /** Re-run variants that already have a result with the same settings. */
  fresh?: boolean;
  only?: { family?: Family; variant?: string };
}

const crop = (img: Rgba, b: { x: number; y: number; w: number; h: number }): Rgba => {
  const data = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) data.set(img.data.subarray(((b.y + y) * img.width + b.x) * 4, ((b.y + y) * img.width + b.x + b.w) * 4), y * b.w * 4);
  return { width: b.w, height: b.h, data };
};
/** An animation's frames side by side, each cut to the animation's opaque union, over mid grey. */
function figureRow(frames: Rgba[]): Rgba {
  const box = unionBox(frames);
  const row: Rgba = { width: box.w * frames.length, height: box.h, data: new Uint8Array(box.w * frames.length * box.h * 4) };
  frames.forEach((f, i) => {
    const c = crop(f, box);
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const s = (y * box.w + x) * 4;
        const d = (y * row.width + i * box.w + x) * 4;
        const a = c.data[s + 3]! / 255;
        for (let k = 0; k < 3; k++) row.data[d + k] = Math.round(c.data[s + k]! * a + 128 * (1 - a));
        row.data[d + 3] = 255;
      }
  });
  return row;
}

/** Runs every family's variants (skipping those whose files aren't on the server) and writes results.json; returns the results. */
export async function runCompare(file: CompareFile, deps: CompareDeps): Promise<VariantResult[]> {
  const out = join(deps.cache.work, 'compare', file.id);
  mkdirSync(out, { recursive: true });
  const roomBase = recipeSchema.parse(parseYaml(deps.read(file.room.recipe))) as RepaintRecipe;
  const cardBase = recipeSchema.parse(parseYaml(deps.read(file.card.recipe))) as CardRecipe;
  if (roomBase.kind !== 'repaint' || cardBase.kind !== 'card') throw new Error('compare needs a repaint recipe for the room and a card recipe for the crew');

  // the originals, once
  const originalPng = await originalBackground(deps.imagesDir, backgroundOf(roomBase));
  const original = decodePng(originalPng);
  const screen = await loadScreenInputs(deps.gameDir, roomBase.id, original);
  writeFileSync(join(out, 'room-original.png'), originalPng);
  const cardDeps: CardDeps = { generator: deps.generator, models: deps.models, cache: deps.cache, imagesDir: deps.imagesDir, gameDir: deps.gameDir, refsDir: deps.refsDir };
  const sprite = loadSprite(deps.imagesDir, cardBase);
  const anims: { anim: number; up: Rgba[]; orig: Rgba[] }[] = [];
  for (const a of file.card.anims) {
    const { made } = await upscaledAnim(cardDeps, cardBase, sprite, a.anim);
    const n = Math.min(made.frames, a.frames ?? made.frames);
    const up = cells(made.strip, made.frames, made.cell, made.columns).slice(0, n);
    const orig = cells(made.original, made.frames, [made.cell[0] / 4, made.cell[1] / 4], made.columns).slice(0, n);
    anims.push({ anim: a.anim, up, orig });
    writeFileSync(join(out, `card-${a.anim}-original.png`), encodePng(figureRow(up)));
  }
  const refBytes = (id: string): Uint8Array => new Uint8Array(readFileSync(refFile(deps.refsDir, id)));
  mkdirSync(join(out, 'refs'), { recursive: true });
  for (const id of file.showRefs) writeFileSync(join(out, 'refs', `${id}.png`), refBytes(id));

  const results: VariantResult[] = [];
  const prior = existsSync(join(out, 'results.json')) ? (JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as VariantResult[]) : [];
  const save = (): void => {
    const merged = [...prior.filter(p => !results.some(r => r.family === p.family && r.variant === p.variant)), ...results];
    writeFileSync(join(out, 'results.json'), `${JSON.stringify(merged, null, 2)}\n`);
  };
  for (const family of FAMILIES) {
    const variants = file.families[family];
    if (!variants) continue;
    if (deps.only?.family && deps.only.family !== family) continue;
    if (!(await deps.ready(family))) {
      deps.log(`${family}: its files are not all on the server yet; skipped (art doctor with COMFY_URL says which)`);
      continue;
    }
    const fm: FamilyModels | undefined = family === 'sdxl' ? undefined : familyModels(deps.models, family as ExperimentalFamily, { depthAnnotator: deps.sdxl.depth!.annotator, lineartNode: deps.sdxl.lineart!.annotator, upscaler: deps.sdxl.upscaler });
    for (const v of variants) {
      if (deps.only?.variant && deps.only.variant !== v.name) continue;
      const room = variantRoom(roomBase, family, file.defaults[family], v);
      const card = variantCard(cardBase, family, file.defaults[family], v);
      const key = sha(JSON.stringify({ room, card, anims: file.card.anims, fm, v: 2 }));
      const done = prior.find(p => p.family === family && p.variant === v.name && p.key === key && !p.error);
      if (done && !deps.fresh) {
        deps.log(`${family} ${v.name}: have it (${passed(done) ? 'passes' : 'fails'})`);
        results.push(done);
        continue;
      }
      const dir = join(out, family, v.name);
      mkdirSync(dir, { recursive: true });
      const res: VariantResult = { family, variant: v.name, settings: describe(room, card), cards: [], key, denoise: [room.denoise, card.denoise] };
      const stamp = `cmp-${family}-${v.name}`;
      try {
        // the room: the recipe's own mask geometry and protect value, its references, and the alignment check
        const t0 = Date.now();
        const maskPng = room.mask ? encodePng(maskToRgba(denoiseMask(original, screen.geometry, room.size.work, { ...MASK_DEFAULTS, ...room.mask, open: 1 }))) : undefined;
        const refs = room.reference.map(spec => ({ spec, images: spec.refs.map(id => ({ id, bytes: refBytes(id) })) }));
        const r = await repaint(room, originalPng, deps.generator, deps.sdxl, stamp, refs, maskPng, fm);
        const plate = decodePng(r.plate);
        const report = alignCheck(original, plate, screen.points, { ...ALIGN_DEFAULTS, maxShift: 2 });
        const seconds = (Date.now() - t0) / 1000;
        writeFileSync(join(dir, 'plate.png'), r.plate);
        writeFileSync(join(dir, 'plate-small.png'), encodePng(areaResize(plate, 1280, 960)));
        const [dx, dy, dw, dh] = file.room.detail;
        const s = plate.width / original.width;
        writeFileSync(join(dir, 'detail.png'), encodePng(crop(plate, { x: dx * s, y: dy * s, w: dw * s, h: dh * s })));
        writeFileSync(join(dir, 'align-overlay.png'), encodePng(overlay(original, plate, report)));
        writeFileSync(join(dir, 'align.json'), `${JSON.stringify(report, null, 2)}\n`);
        const w = report.worst;
        res.room = { ok: report.ok, worstShift: w ? Math.round(Math.hypot(w.dx, w.dy) * 100) / 100 : 0, worstPoint: w?.source ?? '', worstPeak: w?.peak ?? 0, measured: report.measured, total: report.total, seconds: Math.round(seconds * 10) / 10, ...(report.why ? { why: report.why } : {}) };
        deps.log(`${family} ${v.name} room: ${report.ok ? 'aligned' : 'MISALIGNED'}, worst ${res.room.worstShift} px at ${res.room.worstPoint}, ${res.room.seconds} s`);
        // the cards: one canvas per animation, the card checks
        for (const a of anims) {
          const c0 = Date.now();
          const bytes = card.reference.flatMap(x => x.refs).map(refBytes);
          // the animation's own group (groupOverrides) and seed, as art batch paints it
          const forAnim = { ...card, group: groupFor(card, a.anim), sampling: { ...card.sampling, seed: seedFor(card, a.anim) } };
          const rep = await repaintAnim(deps.generator, deps.sdxl, forAnim, a.up, bytes, { stamp: `${stamp}-${a.anim}`, family: fm });
          const check: AnimCheck = checkAnim(a.orig, a.up, rep, card.checks);
          const cs = (Date.now() - c0) / 1000;
          writeFileSync(join(dir, `card-${a.anim}.png`), encodePng(figureRow(rep)));
          writeFileSync(join(dir, `card-${a.anim}-check.json`), `${JSON.stringify(check, null, 2)}\n`);
          const silhouette = !(check.why ?? '').includes('alpha differs');
          res.cards.push({ anim: a.anim, frames: a.up.length, ok: check.ok, worstShift: Math.round(check.worstShift * 100) / 100, medianShift: Math.max(...check.alignment), flickerMedian: check.flickerMedian, flickerMax: Math.max(0, ...check.flicker), deltaEMax: Math.max(...check.deltaE), silhouette, seconds: Math.round(cs * 10) / 10, ...(check.why ? { why: check.why } : {}) });
          deps.log(`${family} ${v.name} card ${a.anim}: ${check.ok ? 'passes' : `FAILS (${check.why})`}, worst ${check.worstShift.toFixed(2)} px, dE max ${Math.max(...check.deltaE)}, ${cs.toFixed(1)} s`);
        }
      } catch (e) {
        res.error = (e instanceof Error ? e.message : String(e)).slice(0, 600);
        deps.log(`${family} ${v.name}: ERROR ${res.error}`);
      }
      results.push(res);
      save();
    }
  }
  save();
  return JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as VariantResult[];
}



const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface SheetInput {
  file: CompareFile;
  results: VariantResult[];
  /** <work>/compare/<id>: where the images are. */
  dir: string;
  /** Where the HTML goes (its images are linked relative to it). */
  html: string;
}
const denoiseOf = (r: VariantResult): [number, number] => r.denoise;

const verdict = (ok: boolean | undefined): string => (ok ? '<b class="ok">pass</b>' : '<b class="bad">FAIL</b>');

/** The review sheet: the originals and show crops, each family's best passing result with its numbers, then every variant. */
export function sheetHtml(s: SheetInput): string {
  const rel = (p: string): string => relative(join(s.html, '..'), p).split('\\').join('/');
  const img = (p: string, alt: string, cls = ''): string => (existsSync(p) ? `<img class="${cls}" src="${esc(rel(p))}" alt="${esc(alt)}" loading="lazy">` : `<div class="none">no ${esc(alt)}</div>`);
  const fam = (f: string): VariantResult[] => s.results.filter(r => r.family === f);
  const nums = (r: VariantResult): string => {
    const room = r.room
      ? `<li>room ${verdict(r.room.ok)}: alignment worst <b>${r.room.worstShift} px</b> (peak ${r.room.worstPeak}) at ${esc(r.room.worstPoint)} (${r.room.measured}/${r.room.total} points measured)${r.room.why ? `, ${esc(r.room.why)}` : ''}; <b>${r.room.seconds} s</b></li>`
      : '';
    const cards = r.cards
      .map(c => `<li>card anim ${c.anim} (${c.frames} frames) ${verdict(c.ok)}: alignment worst ${c.worstShift} px, median ${c.medianShift} px; silhouette ${c.silhouette ? 'held' : 'BROKEN'}; flicker median ${c.flickerMedian} max ${c.flickerMax}; costume dE max ${c.deltaEMax}${c.why ? `; ${esc(c.why)}` : ''}; <b>${c.seconds} s</b></li>`)
      .join('');
    return `<ul>${room}${cards}${r.error ? `<li class="bad">error: ${esc(r.error)}</li>` : ''}</ul><p class="set">${esc(r.settings)}</p>`;
  };
  const row = (r: VariantResult, title: string): string => {
    const d = join(s.dir, r.family, r.variant);
    return `<section><h3>${esc(title)}</h3><div class="imgs">${img(join(d, 'plate-small.png'), 'room plate', 'room')}${img(join(d, 'detail.png'), 'detail crop', 'detail')}${img(join(d, 'align-overlay.png'), 'alignment overlay', 'detail')}${s.file.card.anims.map(a => img(join(d, `card-${a.anim}.png`), `card ${a.anim}`, 'card')).join('')}</div>${nums(r)}</section>`;
  };
  const families = FAMILIES.filter(f => s.file.families[f]);
  const best = families.map(f => {
    const b = pickBest(fam(f), denoiseOf, s.file.best[f]);
    if (b) return row(b, `${f}: best passing (${b.variant}${s.file.best[f] === b.variant ? ', chosen by eye' : ''}${passed(b) ? '' : ', DOES NOT PASS'})`);
    const tried = fam(f);
    // nothing passes: show the first setting (the baseline) anyway, marked, so the family can still be looked at
    if (tried[0]) return row(tried[0], `${f}: no passing result; showing ${tried[0].variant}, which FAILS`);
    return `<section><h3>${esc(f)}: no passing result</h3><p>not run (files missing on the server?)</p></section>`;
  });
  const all = families.flatMap(f => fam(f).map(r => row(r, `${f} ${r.variant}: ${passed(r) ? 'passes' : 'fails'}`)));
  const original = `<section><h3>original</h3><div class="imgs">${img(join(s.dir, 'room-original.png'), 'room original', 'room')}${s.file.card.anims.map(a => img(join(s.dir, `card-${a.anim}-original.png`), `card ${a.anim} original (upscaled)`, 'card')).join('')}</div></section>`;
  const refs = `<section><h3>show reference crops</h3><div class="imgs">${s.file.showRefs.map(id => `<figure>${img(join(s.dir, 'refs', `${id}.png`), id, 'ref')}<figcaption>${esc(id)}</figcaption></figure>`).join('')}</div></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model comparison</title>
<style>:root{--bg:#fff;--fg:#111;--mut:#555;--ok:#127a2e;--bad:#b3261e;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mut:#aaa;--ok:#5bd17a;--bad:#ff8a80;--line:#333}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}h1{font-size:20px}h2{font-size:17px;margin-top:28px;border-top:1px solid var(--line);padding-top:12px}h3{font-size:15px;margin:16px 0 6px}
.imgs{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}img{max-width:100%;height:auto;background:#808080}img.room{width:640px}img.detail{width:320px}img.card{height:300px;width:auto}img.ref{height:160px;width:auto}
figure{margin:0}figcaption{font-size:12px;color:var(--mut)}ul{margin:6px 0;padding-left:18px}.set{color:var(--mut);font-size:12px;margin:4px 0}.ok{color:var(--ok)}.bad{color:var(--bad)}.none{color:var(--mut)}</style>
<h1>Model comparison ${esc(s.file.id)}</h1><p>The same room plate (with its recipe's masks and protect zones) and two crew-card canvases, per model family. Checks: the room's 2 px alignment rule; the card's alignment (median 1 px, no point past 2 px), forced silhouette, flicker and costume dE. Seconds include the two 4x upscales for the room.</p>
<h2>Originals and the show</h2>${original}${refs}<h2>Best passing result per family</h2>${best.join('')}<h2>Every variant</h2>${all.join('')}</html>`;
}

/** The PNG contact sheet: originals, show crops, then each family's best (room plate, detail crop, the two card rows). */
export async function contactSheet(s: SheetInput, out: string): Promise<void> {
  const read = (p: string): Uint8Array | undefined => (existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined);
  const cellsOf = (items: [string, string][]): Cell[] => items.flatMap(([p, caption]) => {
    const png = read(p);
    return png ? [{ png, caption }] : [];
  });
  const rows: Cell[][] = [];
  rows.push(cellsOf([[join(s.dir, 'room-original.png'), 'original room'], ...s.file.card.anims.map(a => [join(s.dir, `card-${a.anim}-original.png`), `original card ${a.anim}`] as [string, string])]));
  rows.push(cellsOf(s.file.showRefs.map(id => [join(s.dir, 'refs', `${id}.png`), id] as [string, string])));
  for (const f of FAMILIES.filter(x => s.file.families[x])) {
    const fr = s.results.filter(r => r.family === f);
    const b = pickBest(fr, denoiseOf, s.file.best[f]) ?? fr[0];
    if (!b) continue;
    const d = join(s.dir, b.family, b.variant);
    rows.push(cellsOf([[join(d, 'plate-small.png'), `${f} ${b.variant} room`], [join(d, 'detail.png'), `${f} detail`], ...s.file.card.anims.map(a => [join(d, `card-${a.anim}.png`), `${f} card ${a.anim}`] as [string, string])]));
  }
  await writeSheet(rows.filter(r => r.length > 0), out, { cell: [640, 480] });
}

/** Numbers and ids only, for art/compare/<id>.results.yaml (committed like art/bench/). */
export function resultsYaml(file: CompareFile, results: VariantResult[]): string {
  const rows = results.map(r => ({ family: r.family, variant: r.variant, passes: passed(r), settings: r.settings, ...(r.room ? { room: r.room } : {}), cards: r.cards, ...(r.error ? { error: r.error } : {}) }));
  return `# Numbers and ids only (art compare ${file.id}). Shifts in original pixels; seconds on the COMFY_URL server (RTX 4080 Super).\n${stringify({ id: file.id, results: rows })}`;
}
