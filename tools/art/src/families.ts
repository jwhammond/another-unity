// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The experimental model families (2026-10-18 comparison): Qwen-Image 2512 and FLUX.1 Krea [dev], against the SDXL pipeline.
 * Their files are remote-only entries of art/models.yaml (role `experimental`, one per ComfyUI folder, two text encoders for flux).
 * The graphs use ComfyUI core nodes only, plus the same two aux preprocessors the SDXL graph uses for its hints.
 */
import { basename } from 'node:path';
import type { Job } from './generator';
import { Builder, withLoras, type LoraParams, type Ref, type Sampling } from './graphs';
import type { Family, ModelsFile } from './models';
import type { NoiseSchedule } from './sigmas';

export type ExperimentalFamily = Exclude<Family, 'sdxl'>;

/** Qwen-Image under ModelSamplingAuraFlow (ComfyUI's Qwen-Image workflows use shift 3.1). */
export const QWEN_SHIFT = 3.1;
/** FLUX dev's default ModelSamplingFlux mu (no ModelSamplingFlux node in the graph). */
export const FLUX_SHIFT = 1.15;
/** FluxGuidance for Krea dev: its card recommends 4.5. */
export const FLUX_GUIDANCE = 4.5;

/** The model's noise schedule, for mapping a recipe's relative ControlNet window onto ComfyUI's percents (sigmas.ts). */
export function noiseFor(family: Family, shift?: number): NoiseSchedule {
  if (family === 'qwen-image') return { kind: 'flow', shift: shift ?? QWEN_SHIFT };
  if (family === 'flux') return { kind: 'flux', shift: FLUX_SHIFT };
  return { kind: 'sdxl' };
}

/** A family's files, as ComfyUI lists them (basenames), plus the hint annotators and upscaler the SDXL pipeline already uses. */
export interface FamilyModels {
  family: ExperimentalFamily;
  unet: string;
  /** qwen-image: one (CLIPLoader type qwen_image). flux: clip_l then t5xxl (DualCLIPLoader type flux). */
  textEncoders: string[];
  vae: string;
  controlnet?: string;
  /** flux: Redux and its SigLIP encoder. */
  styleModel?: string;
  clipVision?: string;
  /** Depth Anything's ckpt_name and the lineart aux node's class_type (the SDXL graph's). */
  depthAnnotator: string;
  lineartNode: string;
  upscaler: string;
}

/** The folders a family's experimental entries must cover, and how many files each. */
const NEED: Record<ExperimentalFamily, Record<string, number>> = {
  'qwen-image': { diffusion_models: 1, text_encoders: 1, vae: 1, controlnet: 1 },
  flux: { diffusion_models: 1, text_encoders: 2, vae: 1, controlnet: 1, style_models: 1, clip_vision: 1 },
};

/** The experimental entries of a family, keyed by their ComfyUI folder. */
export function familyEntries(file: ModelsFile, family: ExperimentalFamily | 'krea2'): Record<string, { id: string; file: string; sha256: string }[]> {
  const out: Record<string, { id: string; file: string; sha256: string }[]> = {};
  for (const [id, m] of Object.entries(file.models)) {
    if (m.role !== 'experimental' || m.family !== family) continue;
    const folder = m.file.slice(0, m.file.indexOf('/'));
    (out[folder] ??= []).push({ id, file: m.file, sha256: m.sha256 });
  }
  return out;
}

/** The family's models from art/models.yaml; `shared` brings the SDXL pipeline's annotators and upscaler. */
export function familyModels(file: ModelsFile, family: ExperimentalFamily, shared: { depthAnnotator: string; lineartNode: string; upscaler: string }): FamilyModels {
  const e = familyEntries(file, family);
  for (const [folder, n] of Object.entries(NEED[family])) {
    const have = e[folder]?.length ?? 0;
    if (have !== n) throw new Error(`art/models.yaml has ${have} experimental ${family} file(s) in ${folder}/, want ${n}`);
  }
  const one = (folder: string): string => basename(e[folder]![0]!.file);
  // flux's DualCLIPLoader: clip_l first, then t5 (the loader detects each, but keep the documented order)
  const encoders = e.text_encoders!.map(x => basename(x.file)).sort((a, b) => Number(/t5/i.test(a)) - Number(/t5/i.test(b)));
  return {
    family,
    unet: one('diffusion_models'),
    textEncoders: encoders,
    vae: one('vae'),
    controlnet: one('controlnet'),
    ...(family === 'flux' ? { styleModel: one('style_models'), clipVision: one('clip_vision') } : {}),
    ...shared,
  };
}

export interface FamilyRepaintParams {
  prompt: string;
  negative: string;
  denoise: number;
  size: [number, number];
  /** start/end are ComfyUI's ABSOLUTE percents (sigmas.ts's controlWindow with the family's noise schedule). */
  depth?: { strength: number; start?: number; end: number };
  lineart?: { strength: number; start?: number; end: number };
  /** Masked denoise: a LoadImage name whose red channel is the per-pixel denoise (differential diffusion), as in the SDXL graph. */
  mask?: string;
  /** flux: FluxGuidance (default FLUX_GUIDANCE). */
  guidance?: number;
  /** qwen-image: ModelSamplingAuraFlow's shift (default QWEN_SHIFT). */
  shift?: number;
  /** flux: Redux references (LoadImage names), each StyleModelApply'd onto the positive conditioning at `strength`. */
  redux?: { images: string[]; strength: number }[];
  /** Style LoRAs for the family's model (LoraLoader on the model and text encoders, in order). */
  loras?: LoraParams[];
}

/**
 * img2img for a flow family: the input VAE-encoded at the recipe's denoise, depth and lineart ControlNets made from the guide (each
 * net applied through ControlNetApplyAdvanced with the VAE: the Qwen Fun union and the FLUX Union Pro 2.0 both encode their hint),
 * masked denoise through SetLatentNoiseMask + DifferentialDiffusion, and the family's own loaders, sampling patch and guidance.
 */
export function familyRepaintGraph(m: FamilyModels, s: Sampling, p: FamilyRepaintParams, input: string, guide: string): Job {
  const b = new Builder();
  let model: Ref = [b.add('UNETLoader', { unet_name: m.unet, weight_dtype: 'default' }), 0];
  let clip: Ref;
  if (m.family === 'qwen-image') {
    if (m.textEncoders.length !== 1) throw new Error('qwen-image takes one text encoder');
    model = [b.add('ModelSamplingAuraFlow', { model, shift: p.shift ?? QWEN_SHIFT }), 0];
    clip = [b.add('CLIPLoader', { clip_name: m.textEncoders[0], type: 'qwen_image', device: 'default' }), 0];
  } else {
    if (m.textEncoders.length !== 2) throw new Error('flux takes two text encoders (clip_l and t5xxl)');
    clip = [b.add('DualCLIPLoader', { clip_name1: m.textEncoders[0], clip_name2: m.textEncoders[1], type: 'flux', device: 'default' }), 0];
  }
  ({ model, clip } = withLoras(b, model, clip, p.loras));
  const vae: Ref = [b.add('VAELoader', { vae_name: m.vae }), 0];
  let pos: Ref = [b.add('CLIPTextEncode', { text: p.prompt, clip }), 0];
  // flux dev is guidance-distilled and runs at cfg 1, where the negative is never evaluated: it still has to exist for the ControlNet apply
  let neg: Ref = [b.add('CLIPTextEncode', { text: p.negative, clip }), 0];
  if (m.family === 'flux') {
    if (p.redux?.length) {
      if (!m.styleModel || !m.clipVision) throw new Error('flux references need the Redux style model and its clip_vision encoder');
      const style = b.add('StyleModelLoader', { style_model_name: m.styleModel });
      const cv = b.add('CLIPVisionLoader', { clip_name: m.clipVision });
      for (const r of p.redux) {
        for (const name of r.images) {
          const img = b.add('LoadImage', { image: name });
          const enc = b.add('CLIPVisionEncode', { clip_vision: [cv, 0], image: [img, 0], crop: 'center' });
          // attn_bias scales the image tokens' attention (log bias), so a strength below 1 leaves the prompt in charge
          pos = [b.add('StyleModelApply', { conditioning: pos, style_model: [style, 0], clip_vision_output: [enc, 0], strength: r.strength, strength_type: 'attn_bias' }), 0];
        }
      }
    }
    pos = [b.add('FluxGuidance', { conditioning: pos, guidance: p.guidance ?? FLUX_GUIDANCE }), 0];
    neg = [b.add('ConditioningZeroOut', { conditioning: neg }), 0];
  } else if (p.redux?.length) {
    throw new Error('qwen-image takes no references');
  }
  const img = b.add('LoadImage', { image: input });
  const g = b.add('LoadImage', { image: guide });
  if (m.controlnet && (p.depth || p.lineart)) {
    // one union net serves both hints (neither family's union takes a type switch)
    const net: Ref = [b.add('ControlNetLoader', { control_net_name: m.controlnet }), 0];
    const control = (pre: { class_type: string; inputs: Record<string, unknown> }, k: { strength: number; start?: number; end: number }): void => {
      const hint = b.add(pre.class_type, { image: [g, 0], ...pre.inputs });
      const scaled = b.add('ImageScale', { image: [hint, 0], upscale_method: 'lanczos', width: p.size[0], height: p.size[1], crop: 'disabled' });
      const apply = b.add('ControlNetApplyAdvanced', { positive: pos, negative: neg, control_net: net, image: [scaled, 0], strength: k.strength, start_percent: k.start ?? 0, end_percent: k.end, vae });
      pos = [apply, 0];
      neg = [apply, 1];
    };
    if (p.depth) control({ class_type: 'DepthAnythingV2Preprocessor', inputs: { ckpt_name: m.depthAnnotator, resolution: 1024 } }, p.depth);
    if (p.lineart) control({ class_type: m.lineartNode, inputs: { resolution: 1024 } }, p.lineart);
  }
  let lat: Ref = [b.add('VAEEncode', { pixels: [img, 0], vae }), 0];
  if (p.mask) {
    const mk = b.add('LoadImage', { image: p.mask });
    const chan = b.add('ImageToMask', { image: [mk, 0], channel: 'red' });
    lat = [b.add('SetLatentNoiseMask', { samples: lat, mask: [chan, 0] }), 0];
    model = [b.add('DifferentialDiffusion', { model }), 0];
  }
  const k = b.add('KSampler', { model, seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, positive: pos, negative: neg, latent_image: lat, denoise: p.denoise });
  const dec = b.add('VAEDecode', { samples: [k, 0], vae });
  const out = b.add('SaveImage', { images: [dec, 0], filename_prefix: `art-${m.family}` });
  return { graph: b.graph, inputs: {}, outputs: { image: out } };
}

/** The node classes the family graphs add to graphs.ts's (all ComfyUI core). */
export const FAMILY_NODES: Record<ExperimentalFamily, string[]> = {
  'qwen-image': ['UNETLoader', 'CLIPLoader', 'LoraLoader', 'ModelSamplingAuraFlow', 'VAELoader', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'DifferentialDiffusion', 'SetLatentNoiseMask', 'KSampler'],
  flux: ['UNETLoader', 'DualCLIPLoader', 'LoraLoader', 'FluxGuidance', 'ConditioningZeroOut', 'StyleModelLoader', 'StyleModelApply', 'CLIPVisionLoader', 'CLIPVisionEncode', 'VAELoader', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'DifferentialDiffusion', 'SetLatentNoiseMask', 'KSampler'],
};

/** Which loader node and input lists a file of each ComfyUI folder. */
export const FOLDER_LOADERS: Record<string, [string, string]> = {
  diffusion_models: ['UNETLoader', 'unet_name'],
  text_encoders: ['CLIPLoader', 'clip_name'],
  vae: ['VAELoader', 'vae_name'],
  controlnet: ['ControlNetLoader', 'control_net_name'],
  style_models: ['StyleModelLoader', 'style_model_name'],
  clip_vision: ['CLIPVisionLoader', 'clip_name'],
};

/** Krea 2 Turbo's files (basenames): its diffusion model and Qwen3-VL text encoder (experimental, family krea2), and the Qwen-Image VAE it shares. */
export interface Krea2Models {
  unet: string;
  textEncoder: string;
  vae: string;
}

export function krea2Models(file: ModelsFile): Krea2Models {
  const e = familyEntries(file, 'krea2');
  for (const folder of ['diffusion_models', 'text_encoders'])
    if ((e[folder]?.length ?? 0) !== 1) throw new Error(`art/models.yaml has ${e[folder]?.length ?? 0} experimental krea2 file(s) in ${folder}/, want 1`);
  const vae = e.vae ?? familyEntries(file, 'qwen-image').vae;
  if (vae?.length !== 1) throw new Error('art/models.yaml has no single VAE for krea2 (its own, or the qwen-image one)');
  return { unet: basename(e.diffusion_models![0]!.file), textEncoder: basename(e.text_encoders![0]!.file), vae: basename(vae[0]!.file) };
}

/**
 * Krea 2 Turbo img2img (ComfyUI core nodes, as art/workflows/krea2-turbo-i2i.json without its rescale): the input VAE-encoded as it is,
 * LoRAs on the model only (LoraLoaderModelOnly), CLIPLoader type krea2. Turbo's settings are 8 steps, cfg 1, er_sde / simple.
 */
export function krea2Graph(m: Krea2Models, s: Sampling, p: { prompt: string; negative: string; denoise: number; loras?: LoraParams[] }, input: string): Job {
  const b = new Builder();
  let model: Ref = [b.add('UNETLoader', { unet_name: m.unet, weight_dtype: 'default' }), 0];
  for (const l of p.loras ?? []) model = [b.add('LoraLoaderModelOnly', { model, lora_name: l.file, strength_model: l.strength }), 0];
  const clip: Ref = [b.add('CLIPLoader', { clip_name: m.textEncoder, type: 'krea2', device: 'default' }), 0];
  const vae: Ref = [b.add('VAELoader', { vae_name: m.vae }), 0];
  const pos = b.add('CLIPTextEncode', { clip, text: p.prompt });
  const neg = b.add('CLIPTextEncode', { clip, text: p.negative });
  const img = b.add('LoadImage', { image: input });
  const lat = b.add('VAEEncode', { pixels: [img, 0], vae });
  const k = b.add('KSampler', { model, seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, positive: [pos, 0], negative: [neg, 0], latent_image: [lat, 0], denoise: p.denoise });
  const dec = b.add('VAEDecode', { samples: [k, 0], vae });
  const out = b.add('SaveImage', { images: [dec, 0], filename_prefix: 'art-krea2' });
  return { graph: b.graph, inputs: {}, outputs: { image: out } };
}
