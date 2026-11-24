// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An away-team avatar (a head-and-shoulders portrait for the team bar). With `identity` and `layout` (the current approach), a NEW
 * picture is generated: the person's identity from InsightFace embeddings of several show frames (IP-Adapter FaceID, `faceid`), the
 * composition and colour masses from the game portrait blurred past its features (img2img at a high denoise, so no single photo and
 * not the game's face shape shows through), and the painted look from the prompt, IP-Adapter style transfer on the game portrait and a
 * palette transfer. Each variant is shown smooth and pixelated, with InsightFace likeness scores against held-out frames (face.ts).
 * A variant may add style LoRAs (`loras`) and may start `from` another variant's picture, a second img2img stage in another family (SDXL
 * FaceID for the identity, then FLUX with a painted-adventure-game LoRA for the look).
 * The earlier bases remain: with `likeness`, the base is a
 * show reference crop reframed to the game portrait's composition, set on the portrait's backdrop, relit and graded toward its palette
 * (portrait.ts), and repainted at a moderate denoise so the face keeps the person's proportions; the game portrait (`base`) then only
 * steers style (IP-Adapter style transfer or Redux) and a palette transfer after. Without it, the game's own 48x50 head (`smhd*.spr`) is
 * upscaled and repainted toward the show's crops: the palette is the game's, but its face shape survives the repaint. One recipe has
 * several variants, each a graph run of its own (and an optional second, lighter pass), and a comparison sheet puts them side by side.
 * Nothing here is wired into the game.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ArtCache } from './cache';
import { familyModels, familyRepaintGraph, type ExperimentalFamily } from './families';
import type { Generator } from './generator';
import { repaintGraph, upscaleGraph, type LoraParams, type Models, type ReferenceParams } from './graphs';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { pixelate, pixelOptions } from './pixel';
import { bilinear, blur, likenessBase, paletteTransfer } from './portrait';
import type { FaceIdParams } from './graphs';
import type { FaceScore } from './face';
import { scoreLabel } from './face';
import { basename } from 'node:path';
import type { ModelsFile } from './models';
import { refFile } from './refs';
import { controlWindow } from './sigmas';
import { noiseFor } from './families';
import { FAMILIES } from './models';
import { grabSchema, runGrab, runMatte, type GrabRun } from './grab';
import { krea2Graph, krea2Models } from './families';
import type { Box } from './portrait';

/** Names this process's uploads on the ComfyUI server: a run beside another (other agents share the server) must not overwrite their files. */
const TAG = `${process.pid}-${Date.now().toString(36)}`;

/** The grab portrait's run name (work/avatars/<object>/grab/<stamp>/). */
export const GRAB = 'grab';

const sampling = z.object({ seed: z.number().int().nonnegative(), steps: z.number().int().positive(), cfg: z.number().positive(), sampler: z.string(), scheduler: z.string() }).strict();
const control = z.object({ strength: z.number().min(0).max(2), start: z.number().min(0).max(1).default(0), end: z.number().min(0).max(1).default(1) }).strict();
/** A reference: ids in art/refs/*.yaml, each cropped to [x, y, w, h] pixels (the whole crop when omitted) before it goes to the model. */
const reference = z.object({ ref: z.string(), crop: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()]).optional(), weight: z.number().min(0).max(1.5) }).strict();

/** IP-Adapter FaceID on the recipe's `identity.refs` (each frame's largest face, embeddings combined). Ids are art/models.yaml entries (experimental, family sdxl). */
const faceid = z
  .object({
    model: z.string(),
    lora: z.object({ model: z.string(), strength: z.number().min(0).max(1.5) }).strict().optional(),
    weight: z.number().min(0).max(3),
    /** Plus V2's structure weight (weight_faceidv2); ignored by FaceID Portrait. */
    v2: z.number().min(0).max(5).default(1),
    weightType: z.enum(['linear', 'ease in-out', 'style transfer', 'strong style transfer']).default('linear'),
    combine: z.enum(['concat', 'average', 'norm average']).default('average'),
    /** Where in the sampled steps it stops (relative, as a recipe's control windows). */
    end: z.number().min(0).max(1).default(1),
  })
  .strict();

const variant = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    /** krea2: Krea 2 Turbo img2img (experimental, remote only): the prompt, model-only LoRAs, no references. */
    model: z.enum([...FAMILIES, 'krea2']).default('sdxl'),
    /** flux only. */
    guidance: z.number().positive().max(20).optional(),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    denoise: z.number().min(0.1).max(1),
    lineart: control.optional(),
    /** sdxl: IP-Adapter `plus-face` (linear); flux: Redux (attn_bias strength). */
    references: z.array(reference).default([]),
    /** sdxl only: identity adapters, applied in order before the references and style. */
    faceid: z.array(faceid).default([]),
    /** sdxl only: IP-Adapter `plus-face` on all of the recipe's identity refs at once (one adapter, the frames batched): the face's look, besides FaceID's identity. */
    plusFace: z.object({ weight: z.number().min(0).max(1.5), end: z.number().min(0).max(1).default(1) }).strict().optional(),
    /** The game portrait (upscaled) as a style reference: sdxl, IP-Adapter `plus` with the style-transfer weighting; flux, Redux at this strength. */
    style: z.object({ weight: z.number().min(0).max(1.5) }).strict().optional(),
    /** Style LoRAs (art/models.yaml ids, experimental, the variant's family), applied in order on the model and text encoder. */
    loras: z.array(z.object({ model: z.string(), strength: z.number().min(0).max(2) }).strict()).default([]),
    /**
     * A second stage: this variant's img2img base is another variant's newest finished picture (its avatar.png) instead of the recipe's
     * base, so one family's identity image can be restyled by another's (e.g. SDXL FaceID, then FLUX with a style LoRA). The two can run
     * on different servers (art avatar --variant on each).
     */
    from: z.string().regex(/^[a-z0-9-]+$/).optional(),
    /**
     * Instead of the blurred layout: one of the identity refs (never a held-out frame) as the img2img base, its centre square at the
     * work size, so the face's own geometry seeds the picture and a high denoise repaints it.
     */
    baseRef: z.string().optional(),
    /**
     * sdxl only: the pass runs on the input's face instead of the whole picture (a detailer): the largest face InsightFace finds, a
     * square `expand` times its box's longer side, scaled to the work size, repainted, scaled back and blended in through an ellipse
     * whose outer `feather` (a fraction of its radius) fades out. With `from`, identity can come last, over another stage's style.
     */
    detail: z.object({ expand: z.number().min(1).max(3).default(1.3), feather: z.number().min(0.05).max(0.9).default(0.3) }).strict().optional(),
    /** A second, lighter img2img pass over the first's output (same prompt, style and references, no lineart): brush texture. */
    refine: z.object({ denoise: z.number().min(0.05).max(0.6), seed: z.number().int().nonnegative().optional() }).strict().optional(),
    /** 0..1: the finished picture's Lab statistics moved this far toward the game portrait's. */
    palette: z.number().min(0).max(1).default(0),
    /** Overrides the recipe's `pixel` step for this variant. */
    pixel: pixelOptions.optional(),
  })
  .strict();

const rgb = z.tuple([z.number(), z.number(), z.number()]);
/** The likeness base (portrait.ts): a reference crop reframed, cut out, relit and graded toward the game portrait. */
const likeness = z
  .object({
    ref: z.string(),
    /** [x, y, w, h] in reference px (square output; may reach past the frame). */
    crop: z.tuple([z.number().int(), z.number().int(), z.number().int().positive(), z.number().int().positive()]),
    /** The subject's outline, reference px. */
    subject: z.array(z.tuple([z.number(), z.number()])).min(3),
    feather: z.number().int().nonnegative().default(10),
    grade: z.number().min(0).max(1).default(0.8),
    light: z
      .object({ strength: z.number().min(0).max(1), from: z.number().min(0).max(1), to: z.number().min(0).max(1), shadow: rgb, key: rgb })
      .strict(),
    rim: z.object({ strength: z.number().min(0).max(2), width: z.number().int().positive(), side: rgb, top: rgb }).strict(),
  })
  .strict();

export const avatarRecipe = z
  .object({
    id: z.string().regex(/^avatar\.[a-z0-9_]+$/),
    kind: z.literal('avatar'),
    /** The crew object's id. */
    object: z.string().regex(/^[a-z0-9_]+$/),
    /** Other objects (the game's object names) shown with this head when they speak: art.portraits records the picture under each. */
    speakers: z.array(z.string().regex(/^[a-z0-9_.]+$/)).default([]),
    /** The game's own head portrait (a sprite file of the images export) and which of its frames (0 = the first picture). */
    base: z.object({ sprite: z.string().regex(/^[a-z0-9]+\.spr$/), frame: z.number().int().nonnegative().default(0) }).strict(),
    /** The work canvas, and the published avatar's side. */
    size: z.object({ work: z.number().int().default(1024), out: z.number().int().default(256) }).strict().default({}),
    /** When set, the img2img base is this reference (the person's face), and `base` the style and palette source. */
    likeness: likeness.optional(),
    /** When set, the img2img base is the upscaled game portrait blurred by this radius (work px): its layout and colours, not its face. */
    layout: z.object({ blur: z.number().int().min(0).max(256) }).strict().optional(),
    /** The person: `refs` feed FaceID, `holdout` (frames never given to the model) and `others` (other people's faces) score the likeness. */
    identity: z
      .object({ refs: z.array(z.string()).min(1), holdout: z.array(z.string()).default([]), others: z.array(z.string()).default([]) })
      .strict()
      .optional(),
    variants: z.array(variant).min(1),
    /** The comparison sheet's file name (<object>.<sheet>.png) and its columns. */
    sheet: z
      .object({
        name: z.string().regex(/^[a-z0-9]+$/).default('compare'),
        columns: z.number().int().positive().default(3),
        refs: z.array(z.string()).default([]),
        /** Each variant as a pair: the smooth picture at `smooth` px and the pixelated avatar (with likeness scores when they ran). */
        pairs: z.boolean().default(false),
        smooth: z.number().int().positive().default(512),
        /** How many of the reference frames the top row shows after the game portrait (all when omitted). */
        refCount: z.number().int().nonnegative().optional(),
        /** The sheet's width limit (cells shrink to fit). */
        maxWidth: z.number().int().positive().default(1600),
        /** Earlier rounds' variants (their newest runs in the cache, no longer in the recipe) shown smooth in the top row, for comparison. */
        previous: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
        /** The variants' order: the recipe's, or by the smooth picture's likeness (best first). */
        sort: z.enum(['recipe', 'smooth']).default('recipe'),
      })
      .strict()
      .default({}),
    /** After the palette transfer, before the out size: the picture reduced to a pixel grid on a small palette and scaled back up with nearest-neighbour (pixel.ts). */
    pixel: pixelOptions.optional(),
    /** The variant published as <object>.png (the out size); `grab` names the recipe's grab portrait. */
    pick: z.string().optional(),
    /** A real picture of the person set into the game portrait (grab.ts): run as `--variant grab`, its files under grab/<stamp>/. */
    grab: grabSchema.optional(),
  })
  .strict()
  .refine(r => !(r.likeness && r.layout), { message: 'likeness and layout are two different bases: name one', path: ['layout'] })
  .refine(r => r.identity || r.variants.every(v => v.faceid.length === 0 && !v.plusFace), { message: 'a faceid variant needs the recipe\'s identity refs', path: ['identity'] })
  .refine(r => r.variants.every(v => !v.from || r.variants.some(o => o.name === v.from && o !== v)), { message: 'a variant\'s `from` names another variant of the recipe', path: ['variants'] })
  .refine(r => r.variants.every(v => stagesOf(r.variants, v) > 0), { message: 'a chain of `from` stages loops back on itself', path: ['variants'] })
  .refine(r => r.variants.every(v => !v.detail || v.model === 'sdxl'), { message: 'a detail pass is sdxl only (FaceID)', path: ['variants'] })
  .refine(r => r.variants.every(v => !v.plusFace || v.model === 'sdxl'), { message: 'plusFace is sdxl only', path: ['variants'] })
  .refine(r => r.variants.every(v => !v.baseRef || (!v.from && !!r.identity?.refs.includes(v.baseRef))), { message: 'a baseRef is one of identity.refs (not a held-out frame), on a first stage', path: ['variants'] })
  .refine(r => r.variants.every(v => v.name !== GRAB), { message: 'the variant name grab is the grab portrait\'s', path: ['variants'] })
  .refine(r => !r.grab?.from || r.variants.some(v => v.name === r.grab!.from), { message: 'grab.from names a variant of the recipe', path: ['grab'] })
  .refine(r => !r.pick || r.variants.some(v => v.name === r.pick) || (r.pick === GRAB && !!r.grab), { message: 'pick names a variant (or grab, with a grab block)', path: ['pick'] })
  .refine(r => r.variants.every(v => v.model !== 'krea2' || (v.faceid.length === 0 && !v.plusFace && !v.style && v.references.length === 0 && !v.lineart && !v.detail)), { message: 'a krea2 variant takes a prompt and LoRAs only', path: ['variants'] });
export type AvatarRecipe = z.infer<typeof avatarRecipe>;

/** How many stages a variant's `from` chain has (1: none); 0 when it loops or names no variant. */
function stagesOf(variants: { name: string; from?: string }[], v: { name: string; from?: string }): number {
  const seen = new Set<string>();
  let cur: { name: string; from?: string } | undefined = v;
  while (cur) {
    if (seen.has(cur.name)) return 0;
    seen.add(cur.name);
    if (!cur.from) return seen.size;
    const next: string = cur.from;
    cur = variants.find(o => o.name === next);
  }
  return 0;
}
export type AvatarVariant = z.infer<typeof variant>;

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface AvatarDeps {
  generator: Generator;
  models: ModelsFile;
  /** The SDXL pipeline's models (the baseline's, and the upscaler and annotators every family shares). */
  sdxl: Models;
  cache: ArtCache;
  imagesDir: string;
  refsDir?: string;
  /** Where the finished images are copied, besides the cache. */
  outDir?: string;
  /** IPAdapterInsightFaceLoader's provider: CUDA on the PC, CPU on the Mac. */
  faceProvider?: 'CUDA' | 'CPU';
  /** The largest face's box [x0, y0, x1, y1] in a picture's pixels (face.ts faceBoxes), for a `detail` pass. */
  faceBox?: (png: Uint8Array) => [number, number, number, number] | null;
  log?: (line: string) => void;
}

export function cropOf(img: Rgba, [x, y, w, h]: [number, number, number, number]): Rgba {
  const x0 = Math.min(x, img.width - 1);
  const y0 = Math.min(y, img.height - 1);
  const cw = Math.min(w, img.width - x0);
  const ch = Math.min(h, img.height - y0);
  const out: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
  for (let r = 0; r < ch; r++) out.data.set(img.data.subarray(((y0 + r) * img.width + x0) * 4, ((y0 + r) * img.width + x0 + cw) * 4), r * cw * 4);
  return out;
}

/** The base portrait's PNG path: the frame-th `sprite` entry's picture in sprite.json. */
export function basePng(imagesDir: string, base: AvatarRecipe['base']): string {
  const dir = join(imagesDir, 'images', 'sprites', base.sprite);
  const json = JSON.parse(readFileSync(join(dir, 'sprite.json'), 'utf8')) as { entries: { type: string; png?: string }[] };
  const pngs = json.entries.filter(e => e.type === 'sprite' && e.png).map(e => e.png!);
  const png = pngs[base.frame];
  if (!png) throw new Error(`${base.sprite} has no frame ${base.frame}`);
  return join(imagesDir, png);
}

/** The base portrait on a 1024 square: the original's pixels through the upscaler twice (4x, 4x), then resampled; the transparent edge is flattened to black. */
async function upscaledBase(deps: AvatarDeps, recipe: AvatarRecipe): Promise<Uint8Array> {
  const file = join(deps.cache.work, 'avatars', recipe.object, 'base.png');
  const src = new Uint8Array(readFileSync(basePng(deps.imagesDir, recipe.base)));
  const key = `${file}.${sha(src).slice(0, 12)}`;
  try {
    return new Uint8Array(readFileSync(key));
  } catch {
    // not made yet
  }
  const flat = decodePng(src);
  for (let i = 0; i < flat.width * flat.height; i++) {
    const a = flat.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) flat.data[i * 4 + c] = Math.round(flat.data[i * 4 + c]! * a);
    flat.data[i * 4 + 3] = 255;
  }
  let bytes = encodePng(flat);
  for (let pass = 0; pass < 2; pass++) {
    const job = upscaleGraph(deps.sdxl, `avatar-in-${TAG}.png`);
    job.inputs[`avatar-in-${TAG}.png`] = bytes;
    bytes = (await deps.generator.run(job)).image!;
  }
  const big = bilinear(decodePng(bytes), recipe.size.work, recipe.size.work);
  const out = encodePng(big);
  mkdirSync(join(deps.cache.work, 'avatars', recipe.object), { recursive: true });
  writeFileSync(key, out);
  return out;
}

export interface AvatarRun {
  variant: string;
  dir: string;
  /** The work-size image. */
  png: string;
  /** The avatar at the recipe's out size. */
  small: string;
  /** The picture area-averaged to the sheet's `smooth` size. */
  smooth: string;
  seconds: number;
}

/** What a variant runs from: the img2img base, the style reference (the upscaled game portrait) and the game portrait itself (palette). */
export interface AvatarBases {
  base: Uint8Array;
  style: Uint8Array;
  game: Rgba;
}

/** The avatar at the out size: the area-averaged picture, or with a `pixel` step (the variant's, else the recipe's) the pixelated one. */
export function smallOf(full: Rgba, recipe: AvatarRecipe, v: { pixel?: AvatarVariant['pixel'] }, game: Rgba): Rgba {
  const px = v.pixel ?? recipe.pixel;
  return px ? pixelate(full, game, px, [recipe.size.out, recipe.size.out]) : areaResize(full, recipe.size.out, recipe.size.out);
}

/** Writes each run's avatar.small.png again from its work-size avatar.png (after the recipe's `pixel` block changed), without generating. */
export function repixelRuns(recipe: AvatarRecipe, runs: AvatarRun[], game: Rgba): void {
  for (const r of runs) {
    const v = r.variant === GRAB ? { pixel: recipe.grab?.pixel } : recipe.variants.find(x => x.name === r.variant)!;
    const full = decodePng(new Uint8Array(readFileSync(r.png)));
    writeFileSync(r.small, encodePng(smallOf(full, recipe, v, game)));
    writeFileSync(r.smooth, encodePng(areaResize(full, recipe.sheet.smooth, recipe.sheet.smooth)));
  }
}

/** One variant of the recipe: the graph (and the refine pass's), the runs, the palette step, and the files (work/avatars/<object>/<variant>/<stamp>/). */
export async function runAvatarVariant(recipe: AvatarRecipe, v: AvatarVariant, deps: AvatarDeps, bases: AvatarBases): Promise<AvatarRun> {
  const t0 = Date.now();
  const refsDir = deps.refsDir ?? join(deps.cache.root, 'refs');
  const W = recipe.size.work;
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  const noise = noiseFor(v.model === 'krea2' ? 'sdxl' : v.model);
  const inputs: Record<string, Uint8Array> = {};
  const refNames = v.references.map((r, i) => {
    let img = decodePng(new Uint8Array(readFileSync(refFile(refsDir, r.ref))));
    if (r.crop) img = cropOf(img, r.crop);
    // a square, so each model's centre crop takes all of it
    const side = Math.min(img.width, img.height);
    img = cropOf(img, [Math.floor((img.width - side) / 2), Math.floor((img.height - side) / 2), side, side]);
    if (side > 768) img = areaResize(img, 768, 768);
    const name = `avatar-ref-${TAG}-${i}.png`;
    inputs[name] = encodePng(img);
    return name;
  });
  if (v.style) inputs[`avatar-style-${TAG}.png`] = bases.style;
  const faceNames = v.faceid.length || v.plusFace ? recipe.identity!.refs.map((id, i) => {
    const name = `avatar-face-${TAG}-${i}.png`;
    inputs[name] = encodePng(squareOf(decodePng(new Uint8Array(readFileSync(refFile(refsDir, id)))), 640));
    return name;
  }) : [];
  const pass = async (input: Uint8Array, denoise: number, seed: number, first: boolean): Promise<Uint8Array> => {
    const sampling = { ...v.sampling, seed };
    const window = (c: { start: number; end: number }): { startPercent: number; endPercent: number } => controlWindow(sampling.steps, denoise, sampling.scheduler, c, noise);
    const lineartFor = (on: boolean): { strength: number; start: number; end: number } | undefined => {
      if (!v.lineart || !first || !on) return undefined;
      const w = window(v.lineart);
      return { strength: v.lineart.strength, start: w.startPercent, end: w.endPercent };
    };
    const loras: LoraParams[] = v.loras.map(l => ({ file: loraFile(deps.models, l.model, v.model), strength: l.strength }));
    let job;
    if (v.model === 'krea2') {
      job = krea2Graph(krea2Models(deps.models), sampling, { prompt: v.prompt, negative: v.negative, denoise, loras }, `avatar-base-${TAG}.png`);
    } else if (v.model === 'sdxl') {
      const m = deps.sdxl;
      if (!m.ipadapter) throw new Error('models.yaml selects no ip-adapter');
      const w = window({ start: 0, end: 1 });
      const faceid: FaceIdParams[] = v.faceid.map(f => {
        const fw = window({ start: 0, end: f.end });
        const file = faceIdFile(deps.models, f.model);
        return {
          ipadapter: file,
          // IPAdapter Plus asks every FaceID model for the CLIP vision encoder (Portrait included), though only Plus V2 projects it
          clipVision: m.ipadapter!.clipVision,
          lora: f.lora ? { file: faceIdFile(deps.models, f.lora.model), strength: f.lora.strength } : undefined,
          weight: f.weight,
          weightV2: f.v2,
          weightType: f.weightType,
          combine: f.combine,
          provider: deps.faceProvider ?? 'CPU',
          images: faceNames,
          startPercent: fw.startPercent,
          endPercent: fw.endPercent,
        };
      });
      const references = v.references.map((r, i) => {
        if (!m.ipadapter!.face) throw new Error('models.yaml selects no ip-adapter face model');
        return { params: { ipadapter: m.ipadapter!.face, clipVision: m.ipadapter!.clipVision, weight: r.weight, weightType: 'linear' as ReferenceParams['weightType'] }, images: [refNames[i]!], startPercent: w.startPercent, endPercent: w.endPercent };
      });
      if (v.plusFace) {
        if (!m.ipadapter.face) throw new Error('models.yaml selects no ip-adapter face model');
        const pw = window({ start: 0, end: v.plusFace.end });
        references.push({ params: { ipadapter: m.ipadapter.face, clipVision: m.ipadapter.clipVision, weight: v.plusFace.weight, weightType: 'linear' as ReferenceParams['weightType'] }, images: faceNames, startPercent: pw.startPercent, endPercent: pw.endPercent });
      }
      if (v.style) {
        if (!m.ipadapter.style) throw new Error('models.yaml selects no ip-adapter style model');
        references.push({ params: { ipadapter: m.ipadapter.style, clipVision: m.ipadapter.clipVision, weight: v.style.weight, weightType: 'style transfer' as ReferenceParams['weightType'] }, images: [`avatar-style-${TAG}.png`], startPercent: w.startPercent, endPercent: w.endPercent });
      }
      job = repaintGraph(m, sampling, { prompt: v.prompt, negative: v.negative, denoise, size: [W, W], lineart: m.lineart ? lineartFor(true) : undefined, references, faceid, loras }, `avatar-base-${TAG}.png`, `avatar-base-${TAG}.png`);
    } else {
      if (v.faceid.length) throw new Error(`${v.name}: faceid is sdxl only`);
      const fm = familyModels(deps.models, v.model as ExperimentalFamily, { depthAnnotator: deps.sdxl.depth!.annotator, lineartNode: deps.sdxl.lineart!.annotator, upscaler: deps.sdxl.upscaler });
      const redux = v.references.map((r, i) => ({ strength: r.weight, images: [refNames[i]!] }));
      if (v.style) redux.push({ strength: v.style.weight, images: [`avatar-style-${TAG}.png`] });
      job = familyRepaintGraph(fm, sampling, { prompt: v.prompt, negative: v.negative, denoise, size: [W, W], lineart: lineartFor(true), guidance: v.guidance, redux, loras }, `avatar-base-${TAG}.png`, `avatar-base-${TAG}.png`);
    }
    for (const [name, bytes] of Object.entries(inputs)) job.inputs[name] = bytes;
    job.inputs[`avatar-base-${TAG}.png`] = input;
    return (await deps.generator.run(job)).image!;
  };
  deps.log?.(`${recipe.id} ${v.name}: running`);
  const dir = join(deps.cache.work, 'avatars', recipe.object, v.name, stamp);
  mkdirSync(dir, { recursive: true });
  const input = v.from
    ? new Uint8Array(readFileSync(latestRun(recipe, deps.cache, v.from).png))
    : v.baseRef
      ? encodePng(squareOf(decodePng(new Uint8Array(readFileSync(refFile(refsDir, v.baseRef)))), W))
      : bases.base;
  if (v.baseRef) writeFileSync(join(dir, 'base.png'), input);
  if (v.from) writeFileSync(join(dir, 'from.png'), input);
  let out: Uint8Array;
  if (v.detail) {
    if (!deps.faceBox) throw new Error(`${v.name}: a detail pass needs face boxes (the face venv)`);
    const box = deps.faceBox(input);
    if (!box) throw new Error(`${v.name}: no face in the input`);
    const src = decodePng(input);
    const sq = detailSquare(box, src.width, src.height, v.detail.expand);
    writeFileSync(join(dir, 'detail.json'), `${JSON.stringify({ box, square: sq })}\n`);
    const crop = bilinear(cropOf(src, sq), W, W);
    writeFileSync(join(dir, 'detail.in.png'), encodePng(crop));
    const painted = await pass(encodePng(crop), v.denoise, v.sampling.seed, true);
    writeFileSync(join(dir, 'detail.out.png'), painted);
    out = encodePng(blendDetail(src, areaResize(decodePng(painted), sq[2], sq[3]), sq, v.detail.feather));
  } else out = await pass(input, v.denoise, v.sampling.seed, true);
  if (v.refine) {
    writeFileSync(join(dir, 'pass1.png'), out);
    deps.log?.(`${recipe.id} ${v.name}: refine at ${v.refine.denoise}`);
    out = await pass(out, v.refine.denoise, v.refine.seed ?? v.sampling.seed + 1, false);
  }
  let full = decodePng(out);
  if (v.palette > 0) {
    writeFileSync(join(dir, 'raw.png'), out);
    full = paletteTransfer(full, bases.game, v.palette);
    out = encodePng(full);
  }
  const small = encodePng(smallOf(full, recipe, v, bases.game));
  writeFileSync(join(dir, 'avatar.png'), out);
  writeFileSync(join(dir, 'avatar.small.png'), small);
  writeFileSync(join(dir, 'avatar.smooth.png'), encodePng(areaResize(full, recipe.sheet.smooth, recipe.sheet.smooth)));
  const seconds = (Date.now() - t0) / 1000;
  const refs = [...v.references.map(r => r.ref), ...(recipe.likeness ? [recipe.likeness.ref] : []), ...(v.faceid.length || v.plusFace ? recipe.identity!.refs : [])];
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ recipe: recipe.id, variant: v.name, seconds, baseSha256: sha(input), ...(v.from ? { from: v.from } : {}), loras: v.loras, references: Object.fromEntries(refs.map(r => [r, sha(readFileSync(refFile(refsDir, r)))])) }, null, 2)}\n`);
  if (deps.outDir) {
    mkdirSync(deps.outDir, { recursive: true });
    writeFileSync(join(deps.outDir, `${recipe.object}.${v.name}.png`), small);
  }
  return { variant: v.name, dir, png: join(dir, 'avatar.png'), small: join(dir, 'avatar.small.png'), smooth: join(dir, 'avatar.smooth.png'), seconds };
}

/** The detail pass's square [x, y, side, side]: `expand` times the face box's longer side about its centre, kept inside the picture. */
export function detailSquare(box: [number, number, number, number], width: number, height: number, expand: number): [number, number, number, number] {
  const side = Math.min(width, height, Math.round(Math.max(box[2] - box[0], box[3] - box[1]) * expand));
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const x = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)));
  return [x, y, side, side];
}

/** `patch` (the square's size) laid over `img` at the square through an ellipse: opaque inside, fading over its outer `feather` (smoothstep). */
export function blendDetail(img: Rgba, patch: Rgba, [x0, y0, w, h]: [number, number, number, number], feather: number): Rgba {
  const out: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot((x + 0.5 - w / 2) / (w / 2), (y + 0.5 - h / 2) / (h / 2));
      const t = Math.max(0, Math.min(1, (1 - r) / feather));
      const a = t * t * (3 - 2 * t);
      if (a <= 0) continue;
      const d = ((y0 + y) * img.width + x0 + x) * 4;
      const s = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) out.data[d + k] = Math.round(patch.data[s + k]! * a + img.data[d + k]! * (1 - a));
    }
  return out;
}

/** The centre square of an image at `side` px. */
export function squareOf(img: Rgba, side: number): Rgba {
  const s = Math.min(img.width, img.height);
  return areaResize(cropOf(img, [Math.floor((img.width - s) / 2), Math.floor((img.height - s) / 2), s, s]), side, side);
}

/** A FaceID model's file name as ComfyUI lists it: an experimental sdxl entry of art/models.yaml. */
export function faceIdFile(models: ModelsFile, id: string): string {
  const m = models.models[id];
  if (!m) throw new Error(`no model "${id}" in art/models.yaml`);
  if (m.role !== 'experimental' || m.family !== 'sdxl') throw new Error(`model "${id}" is not an experimental sdxl entry (the FaceID family is experimental only)`);
  return basename(m.file);
}

/** A style LoRA's file name as ComfyUI lists it: an experimental art/models.yaml entry in loras/ of the variant's family. */
export function loraFile(models: ModelsFile, id: string, family: string): string {
  const m = models.models[id];
  if (!m) throw new Error(`no model "${id}" in art/models.yaml`);
  if (m.role !== 'experimental' || !m.file.startsWith('loras/') || m.family !== family) throw new Error(`model "${id}" is not an experimental ${family} LoRA`);
  return basename(m.file);
}

/** The game portrait's layout: each channel box-blurred (three passes, near Gaussian) by `radius` px. */
export function blurred(img: Rgba, radius: number): Rgba {
  if (radius <= 0) return img;
  const n = img.width * img.height;
  const out: Rgba = { width: img.width, height: img.height, data: new Uint8Array(n * 4) };
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = img.data[i * 4 + c]!;
    const b = blur(ch, img.width, img.height, radius);
    for (let i = 0; i < n; i++) out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(b[i]!)));
  }
  for (let i = 0; i < n; i++) out.data[i * 4 + 3] = 255;
  return out;
}

/** The game portrait's first-frame pixels, with the transparent edge flattened to black. */
export function gamePortrait(imagesDir: string, base: AvatarRecipe['base']): Rgba {
  const img = decodePng(new Uint8Array(readFileSync(basePng(imagesDir, base))));
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round(img.data[i * 4 + c]! * a);
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

/** The variants' bases: with `likeness`, the reference made over toward the game portrait (and written to the cache, base.likeness.png); else the upscaled portrait. */
export async function avatarBases(recipe: AvatarRecipe, deps: AvatarDeps): Promise<AvatarBases> {
  const style = await upscaledBase(deps, recipe);
  const game = gamePortrait(deps.imagesDir, recipe.base);
  if (recipe.layout) {
    const base = encodePng(blurred(decodePng(style), recipe.layout.blur));
    mkdirSync(join(deps.cache.work, 'avatars', recipe.object), { recursive: true });
    writeFileSync(join(deps.cache.work, 'avatars', recipe.object, 'base.layout.png'), base);
    return { base, style, game };
  }
  if (!recipe.likeness) return { base: style, style, game };
  const l = recipe.likeness;
  const refsDir = deps.refsDir ?? join(deps.cache.root, 'refs');
  const ref = decodePng(new Uint8Array(readFileSync(refFile(refsDir, l.ref))));
  const base = encodePng(likenessBase(ref, game, { crop: l.crop, subject: l.subject, size: recipe.size.work, feather: l.feather, grade: l.grade, light: l.light, rim: l.rim }));
  const dir = join(deps.cache.work, 'avatars', recipe.object);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'base.likeness.png'), base);
  return { base, style, game };
}

/** Every variant (or one), in the recipe's order. */
export async function runAvatar(recipe: AvatarRecipe, deps: AvatarDeps, only?: string): Promise<AvatarRun[]> {
  const bases = await avatarBases(recipe, deps);
  const runs: AvatarRun[] = [];
  for (const v of recipe.variants) {
    if (only && v.name !== only) continue;
    runs.push(await runAvatarVariant(recipe, v, deps, bases));
  }
  return runs;
}

/**
 * The comparison image's rows: the game's own portrait and the show's reference crops, then the variants, `sheet.columns` to a row
 * (with `pairs`, each variant is two cells: smooth, then pixelated, each captioned with its likeness score when `scores` has one).
 */
export function sheetRows(recipe: AvatarRecipe, deps: Pick<AvatarDeps, 'imagesDir' | 'refsDir' | 'cache'>, runs: AvatarRun[], scores: Record<string, FaceScore | null> = {}, previous: AvatarRun[] = []): { png: Uint8Array; caption: string; title?: string }[][] {
  const refsDir = deps.refsDir ?? join(deps.cache.root, 'refs');
  const refs = [...new Set([...(recipe.likeness ? [recipe.likeness.ref] : []), ...(recipe.identity?.refs ?? []), ...recipe.sheet.refs, ...recipe.variants.flatMap(v => v.references.map(r => r.ref))])].slice(0, recipe.sheet.refCount);
  const game = gamePortrait(deps.imagesDir, recipe.base);
  const top = [
    { png: encodePng(areaResize(game, game.width * 8, game.height * 8)), caption: 'game portrait' },
    ...refs.map(r => ({ png: new Uint8Array(readFileSync(refFile(refsDir, r))), caption: r.replace(/^crew\.[a-z_]+\./, 'ref ') })),
  ];
  const label = (base: string, file: string): string => [base, scoreLabel(scores[file])].filter(Boolean).join(' ');
  top.push(...previous.map(r => ({ png: new Uint8Array(readFileSync(r.smooth)), title: `was ${r.variant}`, caption: label('', r.smooth) || 'smooth' })));
  if (recipe.sheet.sort === 'smooth') runs = [...runs].sort((a, b) => (scores[b.smooth]?.sim ?? -1) - (scores[a.smooth]?.sim ?? -1));
  const cells = recipe.sheet.pairs
    ? runs.flatMap(r => [
        { png: new Uint8Array(readFileSync(r.smooth)), title: r.variant, caption: label('', r.smooth) || 'smooth' },
        { png: new Uint8Array(readFileSync(r.small)), title: 'pixel', caption: label('', r.small) || 'pixel' },
      ])
    : runs.map(r => ({ png: new Uint8Array(readFileSync(r.small)), caption: label(r.variant, r.small) }));
  const per = recipe.sheet.columns * (recipe.sheet.pairs ? 2 : 1);
  const rows = [top];
  for (let i = 0; i < cells.length; i += per) rows.push(cells.slice(i, i + per));
  return rows;
}

/** The newest finished run of one variant (by name: a variant since dropped from the recipe too), or undefined. */
export function newestRun(recipe: AvatarRecipe, cache: ArtCache, name: string): AvatarRun | undefined {
  const root = join(cache.work, 'avatars', recipe.object, name);
  const stamp = existsSync(root) ? readdirSync(root).sort().reverse().find(s => existsSync(join(root, s, 'avatar.small.png'))) : undefined;
  if (!stamp) return undefined;
  return { variant: name, dir: join(root, stamp), png: join(root, stamp, 'avatar.png'), small: join(root, stamp, 'avatar.small.png'), smooth: join(root, stamp, 'avatar.smooth.png'), seconds: 0 };
}

/** The newest finished run of a variant; throws when it never ran. */
export function latestRun(recipe: AvatarRecipe, cache: ArtCache, name: string): AvatarRun {
  const r = newestRun(recipe, cache, name);
  if (!r) throw new Error(`${recipe.id}: no run of ${name} in ${join(cache.work, 'avatars', recipe.object, name)}`);
  return r;
}

/** The newest finished run of each variant, for a sheet without generating again (`partial`: variants never run are left out). */
export function latestRuns(recipe: AvatarRecipe, cache: ArtCache, partial = false): AvatarRun[] {
  const runs: AvatarRun[] = [];
  for (const v of recipe.variants) {
    const r = partial ? newestRun(recipe, cache, v.name) : latestRun(recipe, cache, v.name);
    if (r) runs.push(r);
  }
  if (recipe.grab) {
    const r = partial ? newestRun(recipe, cache, GRAB) : latestRun(recipe, cache, GRAB);
    if (r) runs.push(r);
  }
  return runs;
}

export interface GrabDeps {
  cache: ArtCache;
  imagesDir: string;
  /** A show ref's full frame and its crop's [x, y, w, h] in it (art/refs manifests; the frame cached by art refs grab). */
  frame: (ref: string) => { file: string; crop: [number, number, number, number] };
  /** The largest face's box [x0, y0, x1, y1] in a picture file's pixels (face.ts faceBoxes). */
  faceBox: (file: string) => Box | null;
  /** The face venv's python (face/matte.py). */
  python: string;
  outDir?: string;
  log?: (line: string) => void;
}

/** The recipe's grab portrait (grab.ts), into work/avatars/<object>/grab/<stamp>/. */
export function runGrabAvatar(recipe: AvatarRecipe, deps: GrabDeps): AvatarRun {
  const g = recipe.grab;
  if (!g) throw new Error(`${recipe.id} has no grab block`);
  const t0 = Date.now();
  let file: string;
  let face: Box | null;
  if (g.ref) {
    const f = deps.frame(g.ref);
    file = f.file;
    // InsightFace on the ref's crop (the person the ref was cut for, not another face in the frame), moved into the frame
    const inCrop = g.face ? null : deps.faceBox(refFile(join(deps.cache.root, 'refs'), g.ref));
    face = g.face ? (g.face as Box) : inCrop && [inCrop[0] + f.crop[0], inCrop[1] + f.crop[1], inCrop[2] + f.crop[0], inCrop[3] + f.crop[1]];
  } else {
    file = latestRun(recipe, deps.cache, g.from!).png;
    face = g.face ? (g.face as Box) : deps.faceBox(file);
  }
  if (!face) throw new Error(`${recipe.id}: no face found in ${file}`);
  const game = gamePortrait(deps.imagesDir, recipe.base);
  const dir = join(deps.cache.work, 'avatars', recipe.object, GRAB, new Date(t0).toISOString().replace(/[:.]/g, '-'));
  deps.log?.(`${recipe.id} grab: ${g.ref ?? g.from} (${g.matte.model})`);
  const r: GrabRun = runGrab(g, { file, face }, game, dir, { out: recipe.size.out, smooth: recipe.sheet.smooth, pixel: recipe.pixel }, jobs =>
    runMatte(deps.python, g.matte.model, jobs, join(deps.cache.root, 'models', 'rembg')),
  );
  if (deps.outDir) {
    mkdirSync(deps.outDir, { recursive: true });
    writeFileSync(join(deps.outDir, `${recipe.object}.${GRAB}.png`), readFileSync(r.small));
  }
  return { variant: GRAB, dir: r.dir, png: r.png, small: r.small, smooth: r.smooth, seconds: (Date.now() - t0) / 1000 };
}
