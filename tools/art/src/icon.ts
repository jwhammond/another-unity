// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An inventory icon repainted (art icon): the game's own icon (a 52x48 sprite from icon.map, or a part of an MRG picture for one the
 * panel draws itself, such as the communicator) upscaled for its layout and colours, repainted with SDXL img2img toward a prompt that
 * names the prop (and optionally IP-Adapter on a show frame of it), then reduced to a pixel grid on k-means colours of the icon's own
 * pixels, with the sprite's alpha as the cut-out. Each variant is shown smooth and pixelated; nothing here is wired into the game.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ArtCache } from './cache';
import type { Generator } from './generator';
import { repaintGraph, upscaleGraph, type Models, type ReferenceParams } from './graphs';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { kmeansPalette, nearestResize, quantise } from './pixel';
import { bilinear, paletteTransfer } from './portrait';
import { refFile } from './refs';
import { cropOf, basePng } from './avatar';

const sampling = z.object({ seed: z.number().int().nonnegative(), steps: z.number().int().positive(), cfg: z.number().positive(), sampler: z.string(), scheduler: z.string() }).strict();
const box = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()]);

const variant = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    denoise: z.number().min(0.1).max(1),
    /** IP-Adapter `plus` (linear) on show frames of the prop: ids in art/refs/*.yaml, each cropped to [x, y, w, h]. */
    references: z.array(z.object({ ref: z.string(), crop: box.optional(), weight: z.number().min(0).max(1.5) }).strict()).default([]),
    /** 0..1: the repainted picture's Lab statistics moved this far toward the game icon's (opaque pixels). */
    palette: z.number().min(0).max(1).default(0),
  })
  .strict();
export type IconVariant = z.infer<typeof variant>;

export const iconRecipe = z
  .object({
    id: z.string().regex(/^icon\.[a-z0-9_]+$/),
    kind: z.literal('icon'),
    /** The item object's id (a kit item), or the icon's own name when it is for `objects`. */
    object: z.string().regex(/^[a-z0-9_]+$/),
    /**
     * The game's objects that show this icon too, by their ids (icon.map gives one picture to several: the zoo's sample tubes, Unity's disk
     * halves). publish-kit records the icon under each.
     */
    objects: z.array(z.string().regex(/^[a-z0-9_.]+$/)).default([]),
    /**
     * The game's icon: a sprite of the images export (`sprite`, its frame-th picture), or a part of an MRG picture decoded from the game
     * zip (`mrg`: the entry, [x, y, w, h] in its pixels, coloured with standard.pal in the palette's upper half; index 0 transparent).
     */
    source: z.union([
      z.object({ sprite: z.string().regex(/^[a-z0-9]+\.spr$/), frame: z.number().int().nonnegative().default(0) }).strict(),
      z.object({ mrg: z.string().regex(/^[a-z0-9_]+\.mrg$/), entry: z.number().int().nonnegative(), crop: box }).strict(),
    ]),
    /** The work canvas's side (the icon is centred on a square of its longer side first). */
    work: z.number().int().default(1024),
    /** The flat colour behind the icon's transparent pixels while it is repainted. */
    backdrop: z.tuple([z.number().int(), z.number().int(), z.number().int()]).default([24, 28, 36]),
    /** The pixel step: the grid (the icon's own size by default), k-means colours over the opaque cells, and the nearest-neighbour scale of the written PNG. */
    pixel: z.object({ grid: z.tuple([z.number().int().min(4), z.number().int().min(4)]).optional(), kmeans: z.number().int().min(2).max(256).default(24), scale: z.number().int().min(1).max(8).default(4) }).strict().default({}),
    variants: z.array(variant).min(1),
    /** The variant written as item.<object>.png. */
    pick: z.string().optional(),
  })
  .strict()
  .refine(r => !r.pick || r.variants.some(v => v.name === r.pick), { message: 'pick names a variant', path: ['pick'] });
export type IconRecipe = z.infer<typeof iconRecipe>;

/** An MRG file's entries (graphics.cpp loadMRG): a count, offsets, then each entry's width, height and indices. */
export function parseMrg(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint16(0, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(2 + i * 4, true);
    const width = dv.getUint16(off, true);
    const height = dv.getUint16(off + 2, true);
    out.push({ width, height, pixels: bytes.subarray(off + 4, off + 4 + width * height) });
  }
  return out;
}

/** An MRG entry's crop in colour: indices 128-255 from standard.pal (128 6-bit entries), index `clear` transparent, other low indices (the room's) black.
 * `clear` is the transparent index: 0 for the kit's icon crops (unchanged), and 13 (COLOUR_BLANK, what the original's blit skips) for sprites drawn as they are. */
export function mrgIcon(mrg: Uint8Array, standardPal: Uint8Array, entry: number, [x, y, w, h]: [number, number, number, number], clear = 0): Rgba {
  const e = parseMrg(mrg)[entry];
  if (!e) throw new Error(`no MRG entry ${entry}`);
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const sx = x + c;
      const sy = y + r;
      if (sx >= e.width || sy >= e.height) continue;
      const idx = e.pixels[sy * e.width + sx]!;
      if (idx === clear) continue;
      const rgb = idx >= 128 ? [0, 1, 2].map(k => Math.min(255, standardPal[(idx - 128) * 3 + k]! << 2)) : [0, 0, 0];
      out.data.set([...rgb, 255], (r * w + c) * 4);
    }
  return out;
}

export interface IconDeps {
  generator: Generator;
  sdxl: Models;
  cache: ArtCache;
  imagesDir: string;
  refsDir?: string;
  /** For an `mrg` source: reads a member of the game zip. */
  readGame?: (member: string) => Promise<Uint8Array>;
  log?: (line: string) => void;
}

/** The game icon (RGBA, its own size). */
export async function iconSource(recipe: IconRecipe, deps: Pick<IconDeps, 'imagesDir' | 'readGame'>): Promise<Rgba> {
  const s = recipe.source;
  if ('sprite' in s) return decodePng(new Uint8Array(readFileSync(basePng(deps.imagesDir, { sprite: s.sprite, frame: s.frame }))));
  if (!deps.readGame) throw new Error(`${recipe.id}: an mrg source needs the game zip (GAMEDATA_DIR)`);
  return mrgIcon(await deps.readGame(s.mrg), await deps.readGame('standard.pal'), s.entry, s.crop);
}

/** Where the icon sits on its square: [x, y] of its top-left corner, and the square's side (both in icon pixels). */
export function iconSquare(icon: Rgba): { side: number; x: number; y: number } {
  const side = Math.max(icon.width, icon.height);
  return { side, x: Math.floor((side - icon.width) / 2), y: Math.floor((side - icon.height) / 2) };
}

/** The icon on its backdrop, centred on a square. */
export function flatSquare(icon: Rgba, backdrop: [number, number, number]): Rgba {
  const { side, x, y } = iconSquare(icon);
  const out: Rgba = { width: side, height: side, data: new Uint8Array(side * side * 4) };
  for (let i = 0; i < side * side; i++) out.data.set([...backdrop, 255], i * 4);
  for (let r = 0; r < icon.height; r++)
    for (let c = 0; c < icon.width; c++) {
      const s = (r * icon.width + c) * 4;
      const a = icon.data[s + 3]! / 255;
      const d = ((y + r) * side + x + c) * 4;
      for (let k = 0; k < 3; k++) out.data[d + k] = Math.round(icon.data[s + k]! * a + backdrop[k]! * (1 - a));
    }
  return out;
}

/** The work-size picture cut back to the icon's own rectangle (still at work scale), with the icon's alpha scaled up bilinearly. */
export function cutOut(work: Rgba, icon: Rgba): Rgba {
  const { side, x, y } = iconSquare(icon);
  const s = work.width / side;
  const cut = cropOf(work, [Math.round(x * s), Math.round(y * s), Math.round(icon.width * s), Math.round(icon.height * s)]);
  const alpha: Rgba = { width: icon.width, height: icon.height, data: new Uint8Array(icon.data.length) };
  for (let i = 0; i < icon.width * icon.height; i++) alpha.data.set([icon.data[i * 4 + 3]!, 0, 0, 255], i * 4);
  const big = bilinear(alpha, cut.width, cut.height);
  for (let i = 0; i < cut.width * cut.height; i++) cut.data[i * 4 + 3] = big.data[i * 4]!;
  return cut;
}

/** The pixel step: the cut-out reduced to the grid, k-means colours over the opaque cells only, the icon's alpha (nearest) as the cut-out. */
export function iconPixels(cut: Rgba, icon: Rgba, o: IconRecipe['pixel']): Rgba {
  const [gw, gh] = o.grid ?? [icon.width, icon.height];
  const small = areaResize({ width: cut.width, height: cut.height, data: (() => { const d = new Uint8Array(cut.data); for (let i = 3; i < d.length; i += 4) d[i] = 255; return d; })() }, gw, gh);
  const mask = nearestResize(icon, gw, gh);
  const opaque: number[] = [];
  for (let i = 0; i < gw * gh; i++) if (mask.data[i * 4 + 3]! >= 128) opaque.push(i);
  const pts: Rgba = { width: Math.max(1, opaque.length), height: 1, data: new Uint8Array(Math.max(1, opaque.length) * 4) };
  opaque.forEach((p, j) => pts.data.set(small.data.subarray(p * 4, p * 4 + 4), j * 4));
  const q = quantise(small, kmeansPalette(pts, o.kmeans), 'none');
  for (let i = 0; i < gw * gh; i++) q.data[i * 4 + 3] = mask.data[i * 4 + 3]! >= 128 ? 255 : 0;
  return q;
}

export interface IconRun {
  variant: string;
  dir: string;
  /** The repainted icon at work scale, cut out (alpha). */
  smooth: string;
  /** The pixel icon at the grid's size, and scaled up by `pixel.scale`. */
  grid: string;
  pixel: string;
  seconds: number;
}

/** The upscaled, flattened icon square at the work size (cached by the source's hash). */
async function upscaled(recipe: IconRecipe, deps: IconDeps, icon: Rgba): Promise<Uint8Array> {
  let bytes = encodePng(flatSquare(icon, recipe.backdrop));
  for (let pass = 0; pass < 2; pass++) {
    const job = upscaleGraph(deps.sdxl, 'icon-in.png');
    job.inputs['icon-in.png'] = bytes;
    bytes = (await deps.generator.run(job)).image!;
  }
  return encodePng(bilinear(decodePng(bytes), recipe.work, recipe.work));
}

export async function runIcon(recipe: IconRecipe, deps: IconDeps, only?: string): Promise<IconRun[]> {
  const icon = await iconSource(recipe, deps);
  const root = join(deps.cache.work, 'icons', recipe.object);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'icon.png'), encodePng(icon));
  const base = await upscaled(recipe, deps, icon);
  writeFileSync(join(root, 'base.png'), base);
  const refsDir = deps.refsDir ?? join(deps.cache.root, 'refs');
  const runs: IconRun[] = [];
  for (const v of recipe.variants) {
    if (only && v.name !== only) continue;
    const t0 = Date.now();
    deps.log?.(`${recipe.id} ${v.name}: running`);
    const m = deps.sdxl;
    const inputs: Record<string, Uint8Array> = { 'icon-base.png': base };
    const references = v.references.map((r, i) => {
      if (!m.ipadapter?.style) throw new Error('models.yaml selects no ip-adapter plus model');
      let img = decodePng(new Uint8Array(readFileSync(refFile(refsDir, r.ref))));
      if (r.crop) img = cropOf(img, r.crop);
      inputs[`icon-ref-${i}.png`] = encodePng(img);
      return { params: { ipadapter: m.ipadapter.style, clipVision: m.ipadapter.clipVision, weight: r.weight, weightType: 'linear' as ReferenceParams['weightType'] }, images: [`icon-ref-${i}.png`], startPercent: 0, endPercent: 1 };
    });
    const job = repaintGraph(m, v.sampling, { prompt: v.prompt, negative: v.negative, denoise: v.denoise, size: [recipe.work, recipe.work], references }, 'icon-base.png', 'icon-base.png');
    Object.assign(job.inputs, inputs);
    let full = decodePng((await deps.generator.run(job)).image!);
    if (v.palette > 0) full = paletteTransfer(full, icon, v.palette);
    const dir = join(root, v.name, new Date(t0).toISOString().replace(/[:.]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const cut = cutOut(full, icon);
    const grid = iconPixels(cut, icon, recipe.pixel);
    writeFileSync(join(dir, 'full.png'), encodePng(full));
    writeFileSync(join(dir, 'smooth.png'), encodePng(cut));
    writeFileSync(join(dir, 'grid.png'), encodePng(grid));
    writeFileSync(join(dir, 'pixel.png'), encodePng(nearestResize(grid, grid.width * recipe.pixel.scale, grid.height * recipe.pixel.scale)));
    const seconds = (Date.now() - t0) / 1000;
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ recipe: recipe.id, variant: v.name, seconds }, null, 2)}\n`);
    runs.push({ variant: v.name, dir, smooth: join(dir, 'smooth.png'), grid: join(dir, 'grid.png'), pixel: join(dir, 'pixel.png'), seconds });
  }
  return runs;
}

/** The newest finished run of a variant, or undefined. */
export function newestIconRun(cache: ArtCache, object: string, name: string): IconRun | undefined {
  const root = join(cache.work, 'icons', object, name);
  const stamp = existsSync(root) ? readdirSync(root).sort().reverse().find(s => existsSync(join(root, s, 'pixel.png'))) : undefined;
  if (!stamp) return undefined;
  const dir = join(root, stamp);
  return { variant: name, dir, smooth: join(dir, 'smooth.png'), grid: join(dir, 'grid.png'), pixel: join(dir, 'pixel.png'), seconds: 0 };
}
