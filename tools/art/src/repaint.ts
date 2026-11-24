// SPDX-License-Identifier: GPL-3.0-or-later
import type { Generator } from './generator';
import { depthGraph, repaintGraph, upscaleGraph, type Models } from './graphs';
import { areaResize, decodePng, encodePng } from './image';
import type { ReferenceSpec, RepaintRecipe } from './recipe';
import { controlWindow } from './sigmas';
import { familyRepaintGraph, noiseFor, type FamilyModels } from './families';
import { dedither } from './dedither';

/** Upload names carry the run's stamp, so two runs sharing a ComfyUI input folder can't overwrite each other's files (M8). */
const names = (stamp: string): { up: string; work: string; guide: string } => ({ up: `art-in-${stamp}.png`, work: `art-work-${stamp}.png`, guide: `art-guide-${stamp}.png` });

/** A recipe reference with its crops' bytes (the run reads them from the cache, so meta.json can hash them). */
export interface ResolvedReference {
  spec: ReferenceSpec;
  images: { id: string; bytes: Uint8Array }[];
}

export interface ReferenceReport {
  model: 'style' | 'face';
  refs: string[];
  weight: number;
  weightType: string;
  start: number;
  end: number;
  startPercent: number;
  endPercent: number;
}

export interface ControlReport {
  name: 'depth' | 'lineart';
  strength: number;
  /** The recipe's window, relative to the sampled steps. */
  start: number;
  end: number;
  /** What ComfyUI was given. */
  startPercent: number;
  endPercent: number;
  /** The fraction of the sampled steps it acts on. */
  activeFraction: number;
}

/**
 * R6: upscale the original 4x (U), downsize U to the work size, img2img at the recipe's denoise with ControlNets made
 * from U, upscale 4x again and area-downsize to the plate size.
 */
export async function repaint(
  recipe: RepaintRecipe,
  original: Uint8Array,
  g: Generator,
  m: Models,
  stamp = 'run',
  refs: ResolvedReference[] = [],
  /** The denoise mask (8-bit grey PNG at the work size), for a recipe with `mask`. */
  maskPng?: Uint8Array,
  /** An experimental family's models (recipe `model` other than sdxl); `m` still gives the upscaler and depth annotator. */
  fm?: FamilyModels,
): Promise<{ plate: Uint8Array; upscaled: Uint8Array; work: Uint8Array; depth?: Uint8Array; repainted: Uint8Array; controls: ControlReport[]; references: ReferenceReport[]; dedithered?: Uint8Array; keepUpscaled?: Uint8Array }> {
  const { up: UP, work: WORK, guide: GUIDE } = names(stamp);
  const MASK = `art-mask-${stamp}.png`;
  const o = decodePng(original);
  // the de-dither pre-step: the upscale (and so the work image, the ControlNet guide and the depth map) is of the de-dithered original
  const dedithered = recipe.dedither ? encodePng(dedither(o, recipe.dedither, recipe.keep)) : undefined;
  const upscaled = (await g.run({ ...upscaleGraph(m, UP), inputs: { [UP]: dedithered ?? encodePng(o) } })).image!;
  const u = decodePng(upscaled);
  const [ww, wh] = recipe.size.work;
  const work = encodePng(areaResize(u, ww, wh));

  // the recipe's windows are relative to the sampled steps; ComfyUI wants percents over the full schedule (R3)
  const controls: ControlReport[] = [];
  const noise = noiseFor(recipe.model, recipe.shift);
  if (recipe.model !== 'sdxl' && fm?.family !== recipe.model) throw new Error(`${recipe.id} is model ${recipe.model}, but no ${recipe.model} models were given`);
  const absolute = (name: 'depth' | 'lineart'): { strength: number; start: number; end: number } | undefined => {
    const c = recipe[name];
    if (!c || (recipe.model === 'sdxl' ? !m[name] : !fm?.controlnet)) return undefined;
    const w = controlWindow(recipe.sampling.steps, recipe.denoise, recipe.sampling.scheduler, c, noise);
    controls.push({ name, strength: c.strength, start: c.start, end: c.end, startPercent: w.startPercent, endPercent: w.endPercent, activeFraction: w.activeFraction });
    return { strength: c.strength, start: w.startPercent, end: w.endPercent };
  };
  // IP-Adapter windows are relative to the sampled steps too (R3), and ComfyUI wants absolute percents
  const references: ReferenceReport[] = [];
  const refInputs: Record<string, Uint8Array> = {};
  // flux: Redux takes the references, by weight; the windows don't apply (StyleModelApply acts on every step)
  const redux = recipe.model === 'flux'
    ? refs.map((r, i) => {
        references.push({ model: r.spec.model, refs: r.images.map(x => x.id), weight: r.spec.weight, weightType: 'redux attn_bias', start: 0, end: 1, startPercent: 0, endPercent: 1 });
        const images = r.images.map((x, j) => {
          const name = `art-ref-${stamp}-${i}-${j}.png`;
          refInputs[name] = x.bytes;
          return name;
        });
        return { images, strength: r.spec.weight };
      })
    : [];
  const refParams = (recipe.model === 'sdxl' ? refs : []).map((r, i) => {
    const file = m.ipadapter?.[r.spec.model];
    if (!m.ipadapter || !file) throw new Error(`recipe ${recipe.id} has a ${r.spec.model} reference, but models.yaml's selected names no ipadapter${r.spec.model === 'style' ? 'Style' : 'Face'} (and clipVision)`);
    const w = controlWindow(recipe.sampling.steps, recipe.denoise, recipe.sampling.scheduler, r.spec, noise);
    references.push({ model: r.spec.model, refs: r.images.map(x => x.id), weight: r.spec.weight, weightType: r.spec.weightType, start: r.spec.start, end: r.spec.end, startPercent: w.startPercent, endPercent: w.endPercent });
    const images = r.images.map((x, j) => {
      const name = `art-ref-${stamp}-${i}-${j}.png`;
      refInputs[name] = x.bytes;
      return name;
    });
    return { params: { ipadapter: file, clipVision: m.ipadapter.clipVision, weight: r.spec.weight, weightType: r.spec.weightType }, images, startPercent: w.startPercent, endPercent: w.endPercent };
  });
  const common = { prompt: recipe.prompt, negative: recipe.negative, denoise: recipe.denoise, size: recipe.size.work, depth: absolute('depth'), lineart: absolute('lineart'), mask: maskPng ? MASK : undefined };
  const rp = recipe.model === 'sdxl' ? repaintGraph(m, recipe.sampling, { ...common, references: refParams }, WORK, GUIDE) : familyRepaintGraph(fm!, recipe.sampling, { ...common, guidance: recipe.guidance, shift: recipe.shift, redux }, WORK, GUIDE);
  const repainted = (await g.run({ ...rp, inputs: { [WORK]: work, [GUIDE]: upscaled, ...refInputs, ...(maskPng ? { [MASK]: maskPng } : {}) } })).image!;

  const big = (await g.run({ ...upscaleGraph(m, UP), inputs: { [UP]: repainted } })).image!;
  const plate = encodePng(areaResize(decodePng(big), recipe.size.out[0], recipe.size.out[1]));

  let depth: Uint8Array | undefined;
  const step = recipe.post.find((p): p is { depth: { resolution: number } } => 'depth' in p);
  if (step && m.depth) {
    const dj = depthGraph(m.depth.annotator, GUIDE, step.depth.resolution);
    depth = (await g.run({ ...dj, inputs: { [GUIDE]: upscaled } })).image!;
  }
  // R12: the kept interface takes the original's own upscale, so a de-dithered run upscales the original as well
  let keepUpscaled: Uint8Array | undefined;
  if (dedithered && recipe.keep.length > 0) {
    const KEEP = `art-kin-${stamp}.png`;
    keepUpscaled = (await g.run({ ...upscaleGraph(m, KEEP), inputs: { [KEEP]: encodePng(o) } })).image!;
  }
  return { plate, upscaled, work, depth, repainted, controls, references, dedithered, keepUpscaled };
}

/**
 * An upscale-only room plate (recipe `repaint: false`): the de-dithered original upscaled 4x and resized to the plate size, with no
 * diffusion pass. For an original with too little structure to measure (the alignment check is then skipped by the recipe, loudly).
 */
export async function upscaleOnly(
  recipe: RepaintRecipe,
  original: Uint8Array,
  g: Generator,
  m: Models,
  stamp = 'run',
): Promise<{ plate: Uint8Array; upscaled: Uint8Array; depth?: Uint8Array; dedithered?: Uint8Array; keepUpscaled?: Uint8Array }> {
  const { up: UP, guide: GUIDE } = names(stamp);
  const o = decodePng(original);
  const dedithered = recipe.dedither ? encodePng(dedither(o, recipe.dedither, recipe.keep)) : undefined;
  const upscaled = (await g.run({ ...upscaleGraph(m, UP), inputs: { [UP]: dedithered ?? encodePng(o) } })).image!;
  const plate = encodePng(areaResize(decodePng(upscaled), recipe.size.out[0], recipe.size.out[1]));
  let depth: Uint8Array | undefined;
  const step = recipe.post.find((p): p is { depth: { resolution: number } } => 'depth' in p);
  if (step && m.depth) depth = (await g.run({ ...depthGraph(m.depth.annotator, GUIDE, step.depth.resolution), inputs: { [GUIDE]: upscaled } })).image!;
  return { plate, upscaled, depth, dedithered };
}
