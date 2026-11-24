// SPDX-License-Identifier: GPL-3.0-or-later
import type { Graph, Job } from './generator';

/** Names are as ComfyUI lists them (a file's basename in its folder), except `annotator`, see below. */
export interface Models {
  checkpoint: string;
  vae?: string;
  lora?: { file: string; strength: number };
  upscaler: string;
  /** depth.annotator: Depth Anything's ckpt_name. lineart.annotator: the aux node's class_type (e.g. AnyLineArtPreprocessor_aux). */
  depth?: { controlnet: string; annotator: string; union?: boolean };
  lineart?: { controlnet: string; annotator: string; union?: boolean };
  /** Plan 15 R4: IP-Adapter weights (file names in ComfyUI's ipadapter folder) and the CLIP vision encoder (clip_vision folder). */
  ipadapter?: { style?: string; face?: string; clipVision: string };
}
export interface Sampling {
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

export type Ref = [string, number];

/** Numbers nodes "1", "2", ... in the order they are added, so the same arguments give the same JSON. */
export class Builder {
  readonly graph: Graph = {};
  private n = 0;
  add(class_type: string, inputs: Record<string, unknown>): string {
    const id = String(++this.n);
    this.graph[id] = { class_type, inputs };
    return id;
  }
}

export interface ReferenceParams {
  /** The IP-Adapter weights file, as ComfyUI lists it. */
  ipadapter: string;
  /** The CLIP vision encoder file. */
  clipVision: string;
  weight: number;
  weightType: 'linear' | 'style transfer' | 'strong style transfer' | 'ease in-out';
}

/**
 * Chains IPAdapterModelLoader + CLIPVisionLoader + IPAdapterAdvanced onto the model; the images (LoadImage names) are
 * batched. The window is ComfyUI's ABSOLUTE percents (see sigmas.ts). Never IPAdapterUnifiedLoader, which picks files by name.
 */
export function withReference(b: Builder, model: Ref, r: ReferenceParams, images: string[], window: { startPercent: number; endPercent: number }, mask?: string): Ref {
  if (images.length === 0) throw new Error('a reference needs at least one image');
  const loaded = images.map(name => [b.add('LoadImage', { image: name }), 0] as Ref);
  let batch = loaded[0]!;
  for (const next of loaded.slice(1)) batch = [b.add('ImageBatch', { image1: batch, image2: next }), 0];
  const ip = b.add('IPAdapterModelLoader', { ipadapter_file: r.ipadapter });
  const cv = b.add('CLIPVisionLoader', { clip_name: r.clipVision });
  const apply = b.add('IPAdapterAdvanced', {
    model,
    ipadapter: [ip, 0],
    image: batch,
    weight: r.weight,
    weight_type: r.weightType,
    combine_embeds: 'concat',
    start_at: window.startPercent,
    end_at: window.endPercent,
    embeds_scaling: 'V only',
    clip_vision: [cv, 0],
    ...(mask ? { attn_mask: [mask, 0] } : {}),
  });
  return [apply, 0];
}

/**
 * Identity from InsightFace (IPAdapterFaceID): the faces in `images` (LoadImage names, batched, each one's largest face) are embedded and
 * combined (`combine`), optionally with the model's LoRA on the UNet first. IPAdapter Plus wants the CLIP vision encoder for every
 * FaceID model; `weightV2` (the structure weight) is Plus V2's only. The window is ComfyUI's absolute percents.
 */
export interface FaceIdParams {
  /** The FaceID weights file, as ComfyUI lists it. */
  ipadapter: string;
  clipVision?: string;
  lora?: { file: string; strength: number };
  weight: number;
  weightV2: number;
  weightType: ReferenceParams['weightType'];
  combine: 'concat' | 'average' | 'norm average';
  provider: 'CUDA' | 'CPU';
  images: string[];
  startPercent: number;
  endPercent: number;
}

export function withFaceId(b: Builder, model: Ref, f: FaceIdParams): Ref {
  if (f.images.length === 0) throw new Error('FaceID needs at least one face image');
  if (f.lora) model = [b.add('LoraLoaderModelOnly', { model, lora_name: f.lora.file, strength_model: f.lora.strength }), 0];
  const loaded = f.images.map(name => [b.add('LoadImage', { image: name }), 0] as Ref);
  let batch = loaded[0]!;
  for (const next of loaded.slice(1)) batch = [b.add('ImageBatch', { image1: batch, image2: next }), 0];
  const ip = b.add('IPAdapterModelLoader', { ipadapter_file: f.ipadapter });
  const face = b.add('IPAdapterInsightFaceLoader', { provider: f.provider, model_name: 'buffalo_l' });
  const apply = b.add('IPAdapterFaceID', {
    model,
    ipadapter: [ip, 0],
    image: batch,
    weight: f.weight,
    weight_faceidv2: f.weightV2,
    weight_type: f.weightType,
    combine_embeds: f.combine,
    start_at: f.startPercent,
    end_at: f.endPercent,
    embeds_scaling: 'V only',
    insightface: [face, 0],
    ...(f.clipVision ? { clip_vision: [b.add('CLIPVisionLoader', { clip_name: f.clipVision }), 0] } : {}),
  });
  return [apply, 0];
}

interface Base {
  model: Ref;
  clip: Ref;
  vae: Ref;
}

function loadBase(b: Builder, m: Pick<Models, 'checkpoint' | 'vae' | 'lora'>): Base {
  const ck = b.add('CheckpointLoaderSimple', { ckpt_name: m.checkpoint });
  let model: Ref = [ck, 0];
  let clip: Ref = [ck, 1];
  let vae: Ref = [ck, 2];
  if (m.lora) {
    const l = b.add('LoraLoader', { model, clip, lora_name: m.lora.file, strength_model: m.lora.strength, strength_clip: m.lora.strength });
    model = [l, 0];
    clip = [l, 1];
  }
  if (m.vae) vae = [b.add('VAELoader', { vae_name: m.vae }), 0];
  return { model, clip, vae };
}

function encodeText(b: Builder, clip: Ref, prompt: string, negative: string): { positive: Ref; negative: Ref } {
  return {
    positive: [b.add('CLIPTextEncode', { text: prompt, clip }), 0],
    negative: [b.add('CLIPTextEncode', { text: negative, clip }), 0],
  };
}

function sample(b: Builder, base: Base, s: Sampling, pos: Ref, neg: Ref, latent: Ref, denoise: number): Ref {
  const k = b.add('KSampler', {
    model: base.model,
    seed: s.seed,
    steps: s.steps,
    cfg: s.cfg,
    sampler_name: s.sampler,
    scheduler: s.scheduler,
    positive: pos,
    negative: neg,
    latent_image: latent,
    denoise,
  });
  return [k, 0];
}

function save(b: Builder, base: Base, samples: Ref, prefix: string): Job {
  const dec = b.add('VAEDecode', { samples, vae: base.vae });
  const out = b.add('SaveImage', { images: [dec, 0], filename_prefix: prefix });
  return { graph: b.graph, inputs: {}, outputs: { image: out } };
}

export function txt2imgGraph(m: Models, s: Sampling, prompt: string, negative: string, size: [number, number]): Job {
  const b = new Builder();
  const base = loadBase(b, m);
  const t = encodeText(b, base.clip, prompt, negative);
  const latent = b.add('EmptyLatentImage', { width: size[0], height: size[1], batch_size: 1 });
  return save(b, base, sample(b, base, s, t.positive, t.negative, [latent, 0], 1), 'art-txt2img');
}

/** The input's name is the LoadImage's `image`; the caller puts the bytes in `inputs[input]`. */
export function upscaleGraph(m: Pick<Models, 'upscaler'>, input: string): Job {
  const b = new Builder();
  const img = b.add('LoadImage', { image: input });
  const up = b.add('UpscaleModelLoader', { model_name: m.upscaler });
  const run = b.add('ImageUpscaleWithModel', { upscale_model: [up, 0], image: [img, 0] });
  const out = b.add('SaveImage', { images: [run, 0], filename_prefix: 'art-upscale' });
  return { graph: b.graph, inputs: {}, outputs: { image: out } };
}

export interface RepaintParams {
  prompt: string;
  negative: string;
  denoise: number;
  size: [number, number];
  /** start/end are ComfyUI's ABSOLUTE percents (over the full schedule); sigmas.ts's controlWindow maps a recipe's relative window onto them. */
  depth?: { strength: number; start?: number; end: number };
  lineart?: { strength: number; start?: number; end: number };
  /** IP-Adapter references, applied in order: each one's images are LoadImage names, its window ComfyUI's absolute percents. */
  references?: { params: ReferenceParams; images: string[]; startPercent: number; endPercent: number; /** Cards: a LoadImage name whose red channel is where the reference acts (IPAdapterAdvanced's attn_mask). */ mask?: string }[];
  /** Masked denoise: a LoadImage name whose red channel is the per-pixel denoise as a fraction of `denoise` (differential diffusion). */
  mask?: string;
  /** Identity (withFaceId, in order), applied before the references. */
  faceid?: FaceIdParams[];
  /** Style LoRAs (LoraLoader on the model and CLIP, in order), after the checkpoint's own `lora`. */
  loras?: LoraParams[];
}

/** A LoRA file as ComfyUI lists it (loras folder) and its strength on both the model and the text encoder. */
export interface LoraParams {
  file: string;
  strength: number;
}

/** Chains a LoraLoader per entry onto the model and its text encoder. */
export function withLoras(b: Builder, model: Ref, clip: Ref, loras: LoraParams[] = []): { model: Ref; clip: Ref } {
  for (const l of loras) {
    const n = b.add('LoraLoader', { model, clip, lora_name: l.file, strength_model: l.strength, strength_clip: l.strength });
    model = [n, 0];
    clip = [n, 1];
  }
  return { model, clip };
}

export function repaintGraph(m: Models, s: Sampling, p: RepaintParams, input: string, guide: string): Job {
  const b = new Builder();
  const base = loadBase(b, m);
  Object.assign(base, withLoras(b, base.model, base.clip, p.loras));
  const t = encodeText(b, base.clip, p.prompt, p.negative);
  const img = b.add('LoadImage', { image: input });
  const g = b.add('LoadImage', { image: guide });
  let pos = t.positive;
  let neg = t.negative;
  const control = (
    cn: NonNullable<Models['depth']>,
    pre: { class_type: string; inputs: Record<string, unknown> },
    unionType: string,
    k: { strength: number; start?: number; end: number },
  ): void => {
    const hint = b.add(pre.class_type, { image: [g, 0], ...pre.inputs });
    const scaled = b.add('ImageScale', { image: [hint, 0], upscale_method: 'lanczos', width: p.size[0], height: p.size[1], crop: 'disabled' });
    let net: Ref = [b.add('ControlNetLoader', { control_net_name: cn.controlnet }), 0];
    if (cn.union) net = [b.add('SetUnionControlNetType', { control_net: net, type: unionType }), 0];
    const apply = b.add('ControlNetApplyAdvanced', {
      positive: pos,
      negative: neg,
      control_net: net,
      image: [scaled, 0],
      strength: k.strength,
      start_percent: k.start ?? 0,
      end_percent: k.end,
      vae: base.vae,
    });
    pos = [apply, 0];
    neg = [apply, 1];
  };
  if (m.depth && p.depth) {
    control(m.depth, { class_type: 'DepthAnythingV2Preprocessor', inputs: { ckpt_name: m.depth.annotator, resolution: 1024 } }, 'depth', p.depth);
  }
  if (m.lineart && p.lineart) {
    control(m.lineart, { class_type: m.lineart.annotator, inputs: { resolution: 1024 } }, 'canny/lineart/anime_lineart/mlsd', p.lineart);
  }
  for (const f of p.faceid ?? []) base.model = withFaceId(b, base.model, f);
  for (const r of p.references ?? []) {
    let attn: string | undefined;
    if (r.mask) attn = b.add('ImageToMask', { image: [b.add('LoadImage', { image: r.mask }), 0], channel: 'red' });
    base.model = withReference(b, base.model, r.params, r.images, r, attn);
  }
  let lat: Ref = [b.add('VAEEncode', { pixels: [img, 0], vae: base.vae }), 0];
  if (p.mask) {
    // differential diffusion: each pixel is denoised over the last `mask` fraction of the sampled steps, so the mask is its own denoise
    const mk = b.add('LoadImage', { image: p.mask });
    const chan = b.add('ImageToMask', { image: [mk, 0], channel: 'red' });
    lat = [b.add('SetLatentNoiseMask', { samples: lat, mask: [chan, 0] }), 0];
    base.model = [b.add('DifferentialDiffusion', { model: base.model }), 0];
  }
  return save(b, base, sample(b, base, s, pos, neg, lat, p.denoise), 'art-repaint');
}

/** img2img inside a mask: the white part of `mask` (grown by `growMask` px) is repainted, the rest kept. */
export function inpaintGraph(
  m: Models,
  s: Sampling,
  p: { prompt: string; negative: string; denoise: number; growMask: number },
  input: string,
  mask: string,
): Job {
  const b = new Builder();
  const base = loadBase(b, m);
  const t = encodeText(b, base.clip, p.prompt, p.negative);
  const img = b.add('LoadImage', { image: input });
  const mk = b.add('LoadImage', { image: mask });
  const chan = b.add('ImageToMask', { image: [mk, 0], channel: 'red' });
  const grown = b.add('GrowMask', { mask: [chan, 0], expand: p.growMask, tapered_corners: true });
  const lat = b.add('VAEEncode', { pixels: [img, 0], vae: base.vae });
  const masked = b.add('SetLatentNoiseMask', { samples: [lat, 0], mask: [grown, 0] });
  return save(b, base, sample(b, base, s, t.positive, t.negative, [masked, 0], p.denoise), 'art-inpaint');
}

export function depthGraph(annotator: string, input: string, resolution: number): Job {
  const b = new Builder();
  const img = b.add('LoadImage', { image: input });
  const d = b.add('DepthAnythingV2Preprocessor', { image: [img, 0], ckpt_name: annotator, resolution });
  const out = b.add('SaveImage', { images: [d, 0], filename_prefix: 'art-depth' });
  return { graph: b.graph, inputs: {}, outputs: { image: out } };
}
