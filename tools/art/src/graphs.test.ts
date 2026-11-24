// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Graph } from './generator';
import { depthGraph, inpaintGraph, repaintGraph, txt2imgGraph, upscaleGraph, type Models, type Sampling } from './graphs';

const S: Sampling = { seed: 7, steps: 4, cfg: 2, sampler: 'euler', scheduler: 'normal' };
const M: Models = {
  checkpoint: 'ck.safetensors',
  vae: 'vae.safetensors',
  upscaler: 'up.pth',
  depth: { controlnet: 'cnd.safetensors', annotator: 'depth.pth' },
  lineart: { controlnet: 'cnl.safetensors', annotator: 'AnyLineArtPreprocessor_aux' },
};
const P = { prompt: 'a room', negative: 'blurry', denoise: 0.3, size: [1152, 864] as [number, number], depth: { strength: 0.6, end: 0.8 }, lineart: { strength: 0.5, end: 0.7 } };
const ofType = (g: Graph, t: string): [string, Graph[string]][] => Object.entries(g).filter(([, n]) => n.class_type === t);
const only = (g: Graph, t: string): [string, Graph[string]] => {
  const all = ofType(g, t);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const isRef = (v: unknown, id: string): boolean => Array.isArray(v) && v[0] === id;

describe('graphs', () => {
  it('repaintGraph wires input -> VAEEncode -> KSampler(denoise) -> VAEDecode -> SaveImage, with depth then lineart ControlNets on the guide', () => {
    const job = repaintGraph(M, S, P, 'in.png', 'guide.png');
    const g = job.graph;
    const loads = ofType(g, 'LoadImage');
    const input = loads.find(([, n]) => n.inputs.image === 'in.png')![0];
    const guide = loads.find(([, n]) => n.inputs.image === 'guide.png')![0];
    const [enc, encNode] = only(g, 'VAEEncode');
    expect(isRef(encNode.inputs.pixels, input)).toBe(true);
    const [ks, ksNode] = only(g, 'KSampler');
    expect(isRef(ksNode.inputs.latent_image, enc)).toBe(true);
    expect(ksNode.inputs).toMatchObject({ denoise: 0.3, seed: 7, steps: 4, cfg: 2, sampler_name: 'euler', scheduler: 'normal' });
    const [dec, decNode] = only(g, 'VAEDecode');
    expect(isRef(decNode.inputs.samples, ks)).toBe(true);
    const [save, saveNode] = only(g, 'SaveImage');
    expect(isRef(saveNode.inputs.images, dec)).toBe(true);
    expect(job.outputs).toEqual({ image: save });
    // both preprocessors read the guide, not the input
    const [depthId, depthNode] = only(g, 'DepthAnythingV2Preprocessor');
    const [lineId, lineNode] = only(g, 'AnyLineArtPreprocessor_aux');
    expect(isRef(depthNode.inputs.image, guide)).toBe(true);
    expect(isRef(lineNode.inputs.image, guide)).toBe(true);
    // depth is applied first, then lineart takes depth's conditioning; the sampler uses the last
    const applies = ofType(g, 'ControlNetApplyAdvanced');
    expect(applies).toHaveLength(2);
    const [a1, a1n] = applies[0]!;
    const [a2, a2n] = applies[1]!;
    const scaled1 = g[(a1n.inputs.image as string[])[0]!]!;
    expect(isRef(scaled1.inputs.image, depthId)).toBe(true);
    expect(scaled1.inputs).toMatchObject({ width: 1152, height: 864 });
    expect(isRef(g[(a2n.inputs.image as string[])[0]!]!.inputs.image, lineId)).toBe(true);
    expect(isRef(a2n.inputs.positive, a1)).toBe(true);
    expect(isRef(ksNode.inputs.positive, a2)).toBe(true);
    expect(a1n.inputs).toMatchObject({ strength: 0.6, start_percent: 0, end_percent: 0.8 });
    expect(a2n.inputs).toMatchObject({ strength: 0.5, start_percent: 0, end_percent: 0.7 });
  });

  it('repaintGraph with a mask sets it as the latent noise mask and patches the model with differential diffusion', () => {
    const g = repaintGraph(M, S, { ...P, mask: 'mask.png' }, 'in.png', 'guide.png').graph;
    const [dd] = only(g, 'DifferentialDiffusion');
    const [setMask, setNode] = only(g, 'SetLatentNoiseMask');
    expect(only(g, 'ImageToMask')[1].inputs.channel).toBe('red');
    expect(isRef(setNode.inputs.samples, only(g, 'VAEEncode')[0])).toBe(true);
    const k = only(g, 'KSampler')[1];
    expect(isRef(k.inputs.latent_image, setMask)).toBe(true);
    expect(isRef(k.inputs.model, dd)).toBe(true);
    expect(ofType(repaintGraph(M, S, P, 'in.png', 'guide.png').graph, 'DifferentialDiffusion')).toHaveLength(0);
  });
  it('repaintGraph writes a control\'s absolute start and end percents into ControlNetApplyAdvanced', () => {
    const g = repaintGraph(M, S, { ...P, depth: { strength: 0.6, start: 0.2, end: 0.97 }, lineart: undefined }, 'a', 'b').graph;
    expect(only(g, 'ControlNetApplyAdvanced')[1].inputs).toMatchObject({ start_percent: 0.2, end_percent: 0.97 });
  });

  it('withReference wires the explicit loaders, IPAdapterAdvanced and the mapped window; never IPAdapterUnifiedLoader', () => {
    const params = { ipadapter: 'ip.safetensors', clipVision: 'cv.safetensors', weight: 0.6, weightType: 'style transfer' as const };
    const refs = [{ params, images: ['r1.png', 'r2.png'], startPercent: 0.12, endPercent: 0.9 }];
    const g = repaintGraph(M, S, { ...P, references: refs }, 'a', 'b').graph;
    expect(ofType(g, 'IPAdapterUnifiedLoader')).toHaveLength(0);
    expect(only(g, 'IPAdapterModelLoader')[1].inputs).toEqual({ ipadapter_file: 'ip.safetensors' });
    expect(only(g, 'CLIPVisionLoader')[1].inputs).toEqual({ clip_name: 'cv.safetensors' });
    const [apply, an] = only(g, 'IPAdapterAdvanced');
    expect(an.inputs).toMatchObject({ weight: 0.6, weight_type: 'style transfer', start_at: 0.12, end_at: 0.9, embeds_scaling: 'V only' });
    expect(isRef(an.inputs.ipadapter, only(g, 'IPAdapterModelLoader')[0])).toBe(true);
    expect(isRef(an.inputs.clip_vision, only(g, 'CLIPVisionLoader')[0])).toBe(true);
    expect(isRef(an.inputs.model, only(g, 'CheckpointLoaderSimple')[0])).toBe(true);
    // the sampler takes the adapted model, and the two images are batched
    expect(isRef(only(g, 'KSampler')[1].inputs.model, apply)).toBe(true);
    const [batch, bn] = only(g, 'ImageBatch');
    expect(isRef(an.inputs.image, batch)).toBe(true);
    const names = [bn.inputs.image1, bn.inputs.image2].map(r => g[(r as string[])[0]!]!.inputs.image);
    expect(names).toEqual(['r1.png', 'r2.png']);
    // no references: the graph has none of these nodes
    expect(ofType(repaintGraph(M, S, P, 'a', 'b').graph, 'IPAdapterAdvanced')).toHaveLength(0);
  });

  it('withFaceId puts the LoRA on the UNet, then IPAdapterFaceID with the InsightFace loader, before the style reference', () => {
    const faceid = [
      { ipadapter: 'faceid-plusv2.bin', clipVision: 'cv.safetensors', lora: { file: 'faceid-lora.safetensors', strength: 0.6 }, weight: 0.8, weightV2: 1.5, weightType: 'linear' as const, combine: 'average' as const, provider: 'CPU' as const, images: ['f1.png', 'f2.png'], startPercent: 0.1, endPercent: 1 },
      { ipadapter: 'portrait.bin', weight: 0.5, weightV2: 1, weightType: 'linear' as const, combine: 'average' as const, provider: 'CPU' as const, images: ['f1.png'], startPercent: 0.1, endPercent: 0.8 },
    ];
    const style = [{ params: { ipadapter: 'ip.safetensors', clipVision: 'cv.safetensors', weight: 0.4, weightType: 'style transfer' as const }, images: ['s.png'], startPercent: 0.1, endPercent: 1 }];
    const g = repaintGraph(M, S, { ...P, faceid, references: style }, 'a', 'b').graph;
    const [lora, ln] = only(g, 'LoraLoaderModelOnly');
    expect(ln.inputs).toMatchObject({ lora_name: 'faceid-lora.safetensors', strength_model: 0.6 });
    expect(isRef(ln.inputs.model, only(g, 'CheckpointLoaderSimple')[0])).toBe(true);
    const applies = ofType(g, 'IPAdapterFaceID');
    expect(applies).toHaveLength(2);
    const [first, fn] = applies[0]!;
    expect(isRef(fn.inputs.model, lora)).toBe(true);
    expect(fn.inputs).toMatchObject({ weight: 0.8, weight_faceidv2: 1.5, weight_type: 'linear', combine_embeds: 'average', start_at: 0.1, end_at: 1 });
    expect(g[(fn.inputs.insightface as string[])[0]!]!).toMatchObject({ class_type: 'IPAdapterInsightFaceLoader', inputs: { provider: 'CPU', model_name: 'buffalo_l' } });
    expect(g[(fn.inputs.clip_vision as string[])[0]!]!.class_type).toBe('CLIPVisionLoader');
    // without a clipVision the input is left out; the second adapter chains on the first
    const [second, sn] = applies[1]!;
    expect(isRef(sn.inputs.model, first)).toBe(true);
    expect(sn.inputs.clip_vision).toBeUndefined();
    expect(isRef(only(g, 'IPAdapterAdvanced')[1].inputs.model, second)).toBe(true);
    expect(ofType(repaintGraph(M, S, P, 'a', 'b').graph, 'IPAdapterFaceID')).toHaveLength(0);
  });

  it('repaintGraph sets the union type only for a union controlnet, and leaves out a ControlNet the params don\'t ask for', () => {
    expect(ofType(repaintGraph(M, S, P, 'a', 'b').graph, 'SetUnionControlNetType')).toHaveLength(0);
    const union: Models = { ...M, depth: { ...M.depth!, union: true }, lineart: { ...M.lineart!, union: true } };
    const types = ofType(repaintGraph(union, S, P, 'a', 'b').graph, 'SetUnionControlNetType').map(([, n]) => n.inputs.type);
    expect(types).toEqual(['depth', 'canny/lineart/anime_lineart/mlsd']);
    const noLine = repaintGraph(M, S, { ...P, lineart: undefined }, 'a', 'b').graph;
    expect(ofType(noLine, 'AnyLineArtPreprocessor_aux')).toHaveLength(0);
    expect(ofType(noLine, 'ControlNetApplyAdvanced')).toHaveLength(1);
    const none = repaintGraph(M, S, { ...P, depth: undefined, lineart: undefined }, 'a', 'b').graph;
    expect(ofType(none, 'ControlNetLoader')).toHaveLength(0);
    expect(isRef(only(none, 'KSampler')[1].inputs.positive, '3')).toBe(true);
  });

  it('repaintGraph chains style LoRAs on the model and CLIP before the text encoders and FaceID', () => {
    const faceid = [{ ipadapter: 'portrait.bin', weight: 0.5, weightV2: 1, weightType: 'linear' as const, combine: 'average' as const, provider: 'CPU' as const, images: ['f1.png'], startPercent: 0, endPercent: 1 }];
    const g = repaintGraph(M, S, { ...P, faceid, loras: [{ file: 'a.safetensors', strength: 0.6 }, { file: 'b.safetensors', strength: 0.9 }] }, 'a', 'b').graph;
    const loras = ofType(g, 'LoraLoader');
    expect(loras.map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model, n.inputs.strength_clip])).toEqual([['a.safetensors', 0.6, 0.6], ['b.safetensors', 0.9, 0.9]]);
    expect(isRef(loras[1]![1].inputs.model, loras[0]![0])).toBe(true);
    for (const [, n] of ofType(g, 'CLIPTextEncode')) expect(isRef(n.inputs.clip, loras[1]![0])).toBe(true);
    expect(isRef(only(g, 'IPAdapterFaceID')[1].inputs.model, loras[1]![0])).toBe(true);
    expect(ofType(repaintGraph(M, S, P, 'a', 'b').graph, 'LoraLoader')).toHaveLength(0);
  });

  it('adds the LoRA between the checkpoint and the sampler, and leaves the VAE loader out when none is asked for', () => {
    const job = txt2imgGraph({ ...M, vae: undefined, lora: { file: 'l.safetensors', strength: 1 } }, S, 'p', 'n', [1024, 1024]);
    const [lora, loraNode] = only(job.graph, 'LoraLoader');
    expect(isRef(only(job.graph, 'KSampler')[1].inputs.model, lora)).toBe(true);
    expect(loraNode.inputs).toMatchObject({ lora_name: 'l.safetensors', strength_model: 1 });
    expect(ofType(job.graph, 'VAELoader')).toHaveLength(0);
    expect(only(job.graph, 'EmptyLatentImage')[1].inputs).toMatchObject({ width: 1024, height: 1024, batch_size: 1 });
  });

  it('inpaintGraph masks the latent with the grown mask, and the other graphs name their inputs', () => {
    const g = inpaintGraph(M, S, { prompt: 'p', negative: 'n', denoise: 0.7, growMask: 16 }, 'i.png', 'm.png').graph;
    expect(only(g, 'GrowMask')[1].inputs).toMatchObject({ expand: 16 });
    expect(only(g, 'KSampler')[1].inputs.denoise).toBe(0.7);
    expect(isRef(only(g, 'KSampler')[1].inputs.latent_image, only(g, 'SetLatentNoiseMask')[0])).toBe(true);
    expect(only(upscaleGraph(M, 'x.png').graph, 'UpscaleModelLoader')[1].inputs.model_name).toBe('up.pth');
    expect(only(depthGraph('depth.pth', 'x.png', 1024).graph, 'DepthAnythingV2Preprocessor')[1].inputs).toMatchObject({ ckpt_name: 'depth.pth', resolution: 1024 });
  });

  it('every graph is deterministic: the same arguments give the same JSON', () => {
    const all = (): string[] => [
      txt2imgGraph(M, S, 'p', 'n', [64, 64]),
      repaintGraph(M, S, P, 'a', 'b'),
      inpaintGraph(M, S, { prompt: 'p', negative: 'n', denoise: 0.7, growMask: 8 }, 'a', 'b'),
      upscaleGraph(M, 'a'),
      depthGraph('d', 'a', 512),
    ].map(j => JSON.stringify(j));
    expect(all()).toEqual(all());
  });
});
