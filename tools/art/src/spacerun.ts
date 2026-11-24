// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WARP_SPRITES } from '../../../engine/src/view/combat/files';
import type { IndexedImage } from '../../../engine/src/view/indexed';
import type { ArtCache } from './cache';
import type { Generator } from './generator';
import { upscaleGraph, type Models } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import type { SpaceTexturesRecipe, SpaceUpscalesRecipe } from './recipe';
import { REPAINTED, colourPicture, cutPicture, notArt, spaceOriginal } from './spaceconsole';
import type { SpaceTextureInfo } from './spaceinventory';
import type { SpaceArtInputs } from './spacepublish';
import { clearView, relayoutSheet } from './spacesheet';
import { makeSpaceTexture } from './spacetex';
import { dedither, DEDITHER_DEFAULTS } from './dedither';
import { silhouetteCheck } from './silhouette';
import type { SpaceModelArt } from './spacemodel';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
/** The command that makes a recipe's run: `npm run art -- run` takes the recipe's file (tools/art/src/cli.ts), not its id. */
export const artRun = (id: string): string => `npm run art -- run art/recipes/${id}.yaml`;
/** A run's directory under the cache's work: `<work>/<id>/<stamp>/`, and `<work>/<id>/last.json` naming the last good one. */
const lastOf = async (cache: ArtCache, id: string): Promise<{ dir: string; meta: Record<string, unknown> } | null> => {
  const file = join(cache.work, id, 'last.json');
  return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as { dir: string; meta: Record<string, unknown> }) : null;
};
async function saveRun(cache: ArtCache, id: string, stamp: string, files: Record<string, Rgba>, meta: Record<string, unknown>): Promise<string> {
  const dir = join(cache.work, id, stamp);
  await mkdir(dir, { recursive: true });
  for (const [name, img] of Object.entries(files)) await writeFile(join(dir, `${name}.png`), encodePng(img));
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(join(cache.work, id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return dir;
}

/** A JSON text with every object's keys sorted, so the same values give the same text. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v);

/**
 * A texture's skip key (Plan 30 R8): the recipe as written less `seeds` and `upscaleOnly` (comments and order don't count), plus the seed
 * of its own (its `seeds` entry, else its base's for a damage texture, as textureSeed) and whether `upscaleOnly` lists it. So one
 * texture's re-roll or listing re-runs that texture alone.
 */
export function textureKey(r: SpaceTexturesRecipe, recipeText: string, t: Pick<SpaceTextureInfo, 'name' | 'base'>): string {
  const { seeds: _seeds, upscaleOnly: _listed, ...shared } = (parseYaml(recipeText) ?? {}) as Record<string, unknown>;
  const seed = r.seeds[t.name] ?? (t.base !== undefined ? r.seeds[t.base] : undefined) ?? null;
  return sha(canonical({ shared, seed, upscaleOnly: r.upscaleOnly.includes(t.name) }));
}

export interface SpaceRunDeps { cache: ArtCache; generator: Generator; models: Models; now?: () => number; log: (line: string) => void }

/**
 * Every combat texture's run (Plan 30 R8), as `tex.space.<name>` in the cache: one that already has a run from the same original and
 * recipe is skipped unless `fresh` or named in `only`; `only` runs those alone. Returns the counts.
 */
export async function makeTextures(r: SpaceTexturesRecipe, recipeText: string, textures: ReadonlyMap<string, SpaceTextureInfo>, deps: SpaceRunDeps, o: { only?: string[]; fresh?: boolean } = {}): Promise<{ repainted: number; upscaled: number; skipped: number }> {
  const counts = { repainted: 0, upscaled: 0, skipped: 0 };
  const unknown = (o.only ?? []).filter(n => !textures.has(n));
  if (unknown.length > 0) throw new Error(`--only names no texture of the space build: ${unknown.join(', ')}`);
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  for (const t of [...textures.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (o.only && !o.only.includes(t.name)) continue;
    const source = sha(encodePng(t.picture)), recipe = sha(recipeText), key = textureKey(r, recipeText, t);
    const last = await lastOf(deps.cache, `tex.space.${t.name}`);
    // (a run from before the per-texture key carries only the whole file's: it is made while the file is unchanged, and then takes the key)
    const made0 = last?.meta.source === source && (last.meta.key === key || (last.meta.key === undefined && last.meta.recipe === recipe));
    if (!o.fresh && !o.only && made0) {
      if (last.meta.key === undefined) await writeFile(join(deps.cache.work, `tex.space.${t.name}`, 'last.json'), `${JSON.stringify({ dir: last.dir, meta: { ...last.meta, key } }, null, 2)}\n`);
      counts.skipped++;
      continue;
    }
    const made = await makeSpaceTexture(r, t, deps.generator, deps.models, stamp);
    await saveRun(deps.cache, `tex.space.${t.name}`, stamp, { texture: made.picture }, { source, recipe, key, mode: made.mode, why: made.why ?? null, seed: made.seed, align: made.align ? { ok: made.align.ok, measured: made.align.measured, total: made.align.total } : null });
    counts[made.mode === 'repaint' ? 'repainted' : 'upscaled']++;
    deps.log(`art:space: tex.space.${t.name} ${made.mode}${made.why ? ` (${made.why})` : ''}`);
  }
  return counts;
}

/** A picture de-dithered (the recipe's settings) and upscaled 4x by the upscaler model, its alpha the original's, nearest. */
async function upscale(r: SpaceUpscalesRecipe, picture: Rgba, deps: SpaceRunDeps, name: string): Promise<Rgba> {
  const input = r.dedither.method === 'none' ? picture : dedither(picture, { ...DEDITHER_DEFAULTS, method: r.dedither.method, sigma: r.dedither.sigma });
  const IN = `art-space-up-${name}.png`;
  const up = decodePng((await deps.generator.run({ ...upscaleGraph({ upscaler: deps.models.upscaler }, IN), inputs: { [IN]: encodePng(input) } })).image!);
  for (let y = 0; y < up.height; y++) for (let x = 0; x < up.width; x++) up.data[(y * up.width + x) * 4 + 3] = picture.data[(Math.floor(y / 4) * picture.width + Math.floor(x / 4)) * 4 + 3]!;
  return up;
}

/**
 * The upscales (Plan 30 R5, R11, R12) in one `space.upscales` run: each effect's sheet (`sheet.<file>`, relaid in rows under 4096: its
 * meta has the columns and cell), and every space.mrg picture the console doesn't repaint (`mrg.<entry>`, its clear pixels and live
 * entries clear). The warp overlay's sheets stay the original's (R11).
 */
export async function makeUpscales(r: SpaceUpscalesRecipe, sheets: ReadonlyMap<string, { picture: Rgba; frames: number; columns: number; cell: [number, number] }>, pictures: readonly IndexedImage[], palette: Uint8Array, deps: SpaceRunDeps): Promise<string> {
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const files: Record<string, Rgba> = {};
  const layout: Record<string, { columns: number; cell: [number, number] }> = {};
  for (const [file, s] of [...sheets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (WARP_SPRITES.some(w => w.file === file)) continue;
    const re = relayoutSheet(await upscale(r, s.picture, deps, file), s, 4, s.picture);
    files[`sheet.${file}`] = re.picture;
    layout[file] = { columns: re.columns, cell: re.cell };
  }
  for (let i = 0; i < pictures.length; i++) {
    if (REPAINTED.includes(i)) continue;
    files[`mrg.${i}`] = await upscale(r, colourPicture(pictures[i]!, palette, notArt), deps, `mrg${i}`);
  }
  return saveRun(deps.cache, 'space.upscales', stamp, files, { layout, pictures: Object.keys(files).filter(f => f.startsWith('mrg.')).length, source: upscalesSource(sheets, pictures, palette) });
}

/** The sha256 of what the upscales are made from: every effect's sheet (its picture and layout), the console's pictures and the palette. */
export function upscalesSource(sheets: ReadonlyMap<string, { picture: Rgba; frames: number; columns: number; cell: [number, number] }>, pictures: readonly IndexedImage[], palette: Uint8Array): string {
  const h = createHash('sha256');
  for (const [file, s] of [...sheets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    h.update(JSON.stringify([file, s.picture.width, s.picture.height, s.frames, s.columns, s.cell]));
    h.update(s.picture.data);
  }
  for (const p of pictures) {
    h.update(JSON.stringify([p.width, p.height]));
    h.update(p.pixels);
  }
  h.update(palette);
  return h.digest('hex');
}

/**
 * What `art:space publish` publishes (Plan 30 R14), from the last runs: each texture into each kind's pack that draws it and the effects'
 * if an effect's model does; the upscaled sheets; the console's plate (its view clear) and pictures (the pages' cut from the pages' run, the
 * rest the upscales'); the nebula plates. Throws, naming it, for a texture with no run, or a console whose plate or pages have none.
 */
export async function gatherSpaceArt(cache: ArtCache, textures: ReadonlyMap<string, SpaceTextureInfo>, pictures: readonly IndexedImage[], areas: Record<string, [number, number, number, number]>): Promise<SpaceArtInputs> {
  const png = async (file: string) => decodePng(new Uint8Array(await readFile(file)));
  const inputs: SpaceArtInputs = { kinds: new Map(), effects: { textures: new Map(), sheets: new Map() }, backdrops: new Map() };
  for (const t of textures.values()) {
    const last = await lastOf(cache, `tex.space.${t.name}`);
    if (!last) throw new Error(`no run of tex.space.${t.name}: npm run art:space -- textures`);
    const picture = await png(join(last.dir, 'texture.png'));
    for (const k of t.kinds) (inputs.kinds.get(k) ?? inputs.kinds.set(k, new Map()).get(k)!).set(t.name, picture);
    if (t.effect) inputs.effects.textures.set(t.name, picture);
  }
  const ups = await lastOf(cache, 'space.upscales');
  if (ups) {
    for (const [file, l] of Object.entries((ups.meta as { layout: Record<string, { columns: number; cell: [number, number] }> }).layout)) inputs.effects.sheets.set(file, { picture: await png(join(ups.dir, `sheet.${file}.png`)), ...l });
  }
  const plate = await lastOf(cache, 'plate.tactical'), pages = await lastOf(cache, 'pages.tactical');
  if (plate || pages) {
    if (!plate || !pages || !ups) {
      const absent = [...(plate ? [] : [`plate.tactical (${artRun('plate.tactical')})`]), ...(pages ? [] : [`pages.tactical (${artRun('pages.tactical')})`]), ...(ups ? [] : ['the upscales (npm run art:space -- upscales)'])];
      throw new Error(`the console needs a run of ${absent.join(', ')}`);
    }
    const places = JSON.parse(await readFile(join(cache.root, 'originals', 'space', 'pages.json'), 'utf8')) as { image: number; x: number; y: number }[];
    const atlas = await png(join(pages.dir, 'plate.png'));
    const images = new Map<number, Rgba>();
    for (const p of places) images.set(p.image, cutPicture(atlas, 4, p, pictures[p.image]!));
    for (let i = 0; i < pictures.length; i++) if (!images.has(i) && existsSync(join(ups.dir, `mrg.${i}.png`))) images.set(i, await png(join(ups.dir, `mrg.${i}.png`)));
    inputs.console = { plate: clearView(await png(join(plate.dir, 'plate.png')), areas.view ?? [319, 23, 320, 220], 4), images, scale: 4, areas };
  }
  for (let n = 0; n < 4; n++) {
    const run = await lastOf(cache, `tex.nebula-${n}`);
    if (run) inputs.backdrops.set(n, await png(join(run.dir, 'albedo.png')));
  }
  return inputs;
}

/**
 * The silhouette check over every model (M8 spec §7; Plan 30 R10): each drawn from six axes with its original textures and with the last
 * runs' (a texture with no run counts as its original), masks compared. Returns the models that differ, with each axis's count.
 */
export async function checkSilhouettes(models: ReadonlyMap<string, SpaceModelArt>, cache: ArtCache, size = 256): Promise<{ ok: boolean; failed: { model: string; differ: Record<string, number> }[] }> {
  const failed: { model: string; differ: Record<string, number> }[] = [];
  for (const [key, model] of [...models].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const originals = new Map([...model.textures].map(([n, p]) => [n, { picture: p, scale: 1 }]));
    const repaints = new Map(originals);
    for (const name of model.textures.keys()) {
      const last = await lastOf(cache, `tex.space.${name}`);
      if (last) repaints.set(name, { picture: decodePng(new Uint8Array(await readFile(join(last.dir, 'texture.png')))), scale: 4 });
    }
    const r = silhouetteCheck(model, originals, repaints, size);
    if (!r.ok) failed.push({ model: key, differ: r.differ });
  }
  return { ok: failed.length === 0, failed };
}

/**
 * The parts `publish` needs that have no run yet, each with the command that makes it (Plan 30 R14). art.space is replaced wholesale, so
 * publishing without one would silently drop its keys.
 */
export async function missingParts(cache: ArtCache): Promise<string[]> {
  const missing: string[] = [];
  if (!(await lastOf(cache, 'space.upscales'))) missing.push('the upscales (npm run art:space -- upscales)');
  if (!(await lastOf(cache, 'plate.tactical'))) missing.push(`the console plate plate.tactical (${artRun('plate.tactical')})`);
  if (!(await lastOf(cache, 'pages.tactical'))) missing.push(`the pages' atlas pages.tactical (${artRun('pages.tactical')})`);
  for (let n = 0; n < 4; n++) if (!(await lastOf(cache, `tex.nebula-${n}`))) missing.push(`backdrop plate tex.nebula-${n} (${artRun(`tex.nebula-${n}`)})`);
  return missing;
}

/**
 * The runs publish would take that were made from an original that has since changed, and the textures with no run, each with the
 * command that makes it again (Plan 30 R14): a texture's run against its original's sha, plate.tactical's against the console's,
 * pages.tactical's against the pages' atlas and its layout (pages.json), the upscales' against `upscales` (upscalesSource of the game's
 * now). A run made before it recorded the layout or the upscales' source counts as current (it can't be judged); the textures', the
 * plate's and the pages' source have always been recorded, so a run without one is stale, as makeTextures already treats a texture's.
 */
export async function staleParts(cache: ArtCache, textures: ReadonlyMap<string, SpaceTextureInfo>, upscales: string): Promise<string[]> {
  const stale: string[] = [];
  for (const t of [...textures.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const last = await lastOf(cache, `tex.space.${t.name}`);
    if (!last) stale.push(`tex.space.${t.name} has no run (npm run art:space -- textures)`);
    else if (last.meta.source !== sha(encodePng(t.picture))) stale.push(`tex.space.${t.name} was made from an older original (npm run art:space -- textures)`);
  }
  const ups = await lastOf(cache, 'space.upscales');
  if (ups && ups.meta.source !== undefined && ups.meta.source !== upscales) stale.push('the upscales were made from older originals (npm run art:space -- upscales)');
  const file = async (path: string) => (existsSync(path) ? sha(new Uint8Array(await readFile(path))) : null);
  const plate = await lastOf(cache, 'plate.tactical');
  if (plate && plate.meta.source !== (await file(spaceOriginal(cache, 'console')))) stale.push(`plate.tactical was made from an older console (${artRun('plate.tactical')})`);
  const pages = await lastOf(cache, 'pages.tactical');
  const layout = await file(join(dirname(spaceOriginal(cache, 'pages')), 'pages.json'));
  if (pages && (pages.meta.source !== (await file(spaceOriginal(cache, 'pages'))) || (pages.meta.layout !== undefined && pages.meta.layout !== layout))) {
    stale.push(`pages.tactical was made from an older pages' atlas or layout (${artRun('pages.tactical')})`);
  }
  return stale;
}
