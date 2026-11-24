// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { familyModels, familyRepaintGraph, noiseFor, type FamilyModels } from './families';
import type { Graph } from './generator';
import type { Sampling } from './graphs';
import { loadModels } from './models';
import { controlWindow, flowFns } from './sigmas';

const here = dirname(fileURLToPath(import.meta.url));
/** The family nodes' inputs as ComfyUI 0.41.3 on the 4080 lists them (/object_info, file lists trimmed, uploads dropped). */
const OBJECT_INFO = JSON.parse(readFileSync(join(here, 'testdata', 'object_info-0.41.3-families.json'), 'utf8')) as Record<string, { input: { required: Record<string, unknown[]>; optional: Record<string, unknown[]> } }>;

const SHARED = { depthAnnotator: 'depth_anything_v2_vits.pth', lineartNode: 'AnyLineArtPreprocessor_aux', upscaler: 'RealESRGAN_x4plus.pth' };
const MODELS = loadModels(readFileSync(join(here, '..', '..', '..', 'art', 'models.yaml'), 'utf8'));
const QWEN = familyModels(MODELS, 'qwen-image', SHARED);
const FLUX = familyModels(MODELS, 'flux', SHARED);
const P = { prompt: 'a room', negative: 'blurry', denoise: 0.6, size: [1152, 864] as [number, number], depth: { strength: 0.8, end: 1 }, lineart: { strength: 0.7, start: 0, end: 0.8 }, mask: 'mask.png' };

const ofType = (g: Graph, t: string): [string, Graph[string]][] => Object.entries(g).filter(([, n]) => n.class_type === t);
const only = (g: Graph, t: string): [string, Graph[string]] => {
  const all = ofType(g, t);
  expect(all, t).toHaveLength(1);
  return all[0]!;
};
const refTo = (v: unknown): string => (Array.isArray(v) ? String(v[0]) : '');

/** Every node is one the server has, every required input is given, nothing it doesn't know is, and every combo value is offered. */
function checkAgainstServer(g: Graph): void {
  for (const [id, n] of Object.entries(g)) {
    const spec = OBJECT_INFO[n.class_type];
    expect(spec, `node ${id} ${n.class_type} is in the fixture`).toBeDefined();
    const known = { ...spec!.input.required, ...spec!.input.optional };
    for (const k of Object.keys(spec!.input.required)) expect(n.inputs, `${n.class_type}.${k}`).toHaveProperty(k);
    for (const [k, v] of Object.entries(n.inputs)) {
      expect(known, `${n.class_type} has an input ${k}`).toHaveProperty(k);
      const s = known[k]!;
      const options = Array.isArray(s[0]) ? (s[0] as string[]) : (s[1] as { options?: string[] } | undefined)?.options;
      if (options && options.length > 0 && !Array.isArray(v)) expect(options, `${n.class_type}.${k} offers ${String(v)}`).toContain(v);
      if (Array.isArray(v)) expect(g, `${n.class_type}.${k} links to an existing node`).toHaveProperty(String(v[0]));
    }
  }
}

describe('familyModels', () => {
  it('flux chains style LoRAs on the UNet and both text encoders before the prompt is encoded', () => {
    const S: Sampling = { seed: 1, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple' };
    const g = familyRepaintGraph(FLUX, S, { ...P, loras: [{ file: 'flux_st25style_000000800.safetensors', strength: 0.9 }] }, 'in.png', 'in.png').graph;
    const [lora, ln] = only(g, 'LoraLoader');
    expect(ln.inputs).toMatchObject({ lora_name: 'flux_st25style_000000800.safetensors', strength_model: 0.9, strength_clip: 0.9 });
    expect(g[refTo(ln.inputs.model)]!.class_type).toBe('UNETLoader');
    expect(g[refTo(ln.inputs.clip)]!.class_type).toBe('DualCLIPLoader');
    for (const [, n] of ofType(g, 'CLIPTextEncode')) expect(refTo(n.inputs.clip)).toBe(lora);
    expect(ofType(familyRepaintGraph(FLUX, S, P, 'in.png', 'in.png').graph, 'LoraLoader')).toHaveLength(0);
  });

  it('takes each family\'s remote-only files from art/models.yaml by folder (flux: clip_l before t5xxl)', () => {
    expect(QWEN).toMatchObject({ family: 'qwen-image', unet: 'qwen_image_2512_fp8_e4m3fn.safetensors', textEncoders: ['qwen_2.5_vl_7b_fp8_scaled.safetensors'], vae: 'qwen_image_vae.safetensors', controlnet: 'Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors' });
    expect(QWEN.styleModel).toBeUndefined();
    expect(FLUX).toMatchObject({ unet: 'flux1-krea-dev_fp8_scaled.safetensors', textEncoders: ['clip_l.safetensors', 't5xxl_fp8_e4m3fn.safetensors'], vae: 'ae.safetensors', controlnet: 'flux1-dev-union-pro-2.0.safetensors', styleModel: 'flux1-redux-dev.safetensors', clipVision: 'sigclip_vision_patch14_384.safetensors' });
  });

  it('refuses a family whose entries miss a folder', () => {
    const cut = { ...MODELS, models: Object.fromEntries(Object.entries(MODELS.models).filter(([id]) => id !== 'flux1-redux-dev')) };
    expect(() => familyModels(cut, 'flux', SHARED)).toThrow(/0 experimental flux file\(s\) in style_models/);
  });
});

describe('familyRepaintGraph', () => {
  const S: Sampling = { seed: 401001, steps: 30, cfg: 4, sampler: 'euler', scheduler: 'simple' };

  it('qwen-image: UNETLoader -> ModelSamplingAuraFlow -> DifferentialDiffusion -> KSampler, CLIPLoader qwen_image, the Fun union with the VAE', () => {
    const job = familyRepaintGraph(QWEN, S, P, 'in.png', 'guide.png');
    const g = job.graph;
    checkAgainstServer(g);
    const [unet] = only(g, 'UNETLoader');
    const [msa, msaNode] = only(g, 'ModelSamplingAuraFlow');
    expect(refTo(msaNode.inputs.model)).toBe(unet);
    expect(msaNode.inputs.shift).toBe(3.1);
    const [dd, ddNode] = only(g, 'DifferentialDiffusion');
    expect(refTo(ddNode.inputs.model)).toBe(msa);
    expect(only(g, 'CLIPLoader')[1].inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image' });
    const [vae] = only(g, 'VAELoader');
    // one net, two applies chained, each given the VAE (the Fun union encodes its hint)
    only(g, 'ControlNetLoader');
    const applies = ofType(g, 'ControlNetApplyAdvanced');
    expect(applies).toHaveLength(2);
    for (const [, a] of applies) expect(refTo(a.inputs.vae)).toBe(vae);
    expect(refTo(applies[1]![1].inputs.positive)).toBe(applies[0]![0]);
    expect(applies[1]![1].inputs).toMatchObject({ strength: 0.7, start_percent: 0, end_percent: 0.8 });
    expect(ofType(g, 'SetUnionControlNetType')).toHaveLength(0);
    // img2img: the input encoded, masked, sampled at the denoise with the last conditioning
    const [, mask] = only(g, 'SetLatentNoiseMask');
    expect(g[refTo(mask.inputs.samples)]!.class_type).toBe('VAEEncode');
    const [, ks] = only(g, 'KSampler');
    expect(ks.inputs).toMatchObject({ denoise: 0.6, cfg: 4, sampler_name: 'euler', scheduler: 'simple', seed: 401001 });
    expect(refTo(ks.inputs.model)).toBe(dd);
    expect(refTo(ks.inputs.positive)).toBe(applies[1]![0]);
    expect(g[refTo(ks.inputs.latent_image)]!.class_type).toBe('SetLatentNoiseMask');
    expect(ofType(g, 'FluxGuidance')).toHaveLength(0);
  });

  it('qwen-image refuses references', () => {
    expect(() => familyRepaintGraph(QWEN, S, { ...P, redux: [{ images: ['r.png'], strength: 0.5 }] }, 'in.png', 'guide.png')).toThrow(/no references/);
  });

  it('flux: DualCLIPLoader flux, Redux per image then FluxGuidance on the positive, a zeroed negative, ControlNets after', () => {
    const job = familyRepaintGraph(FLUX, { ...S, cfg: 1, steps: 28 }, { ...P, guidance: 4.5, redux: [{ images: ['a.png', 'b.png'], strength: 0.4 }] }, 'in.png', 'guide.png');
    const g = job.graph;
    checkAgainstServer(g);
    expect(only(g, 'DualCLIPLoader')[1].inputs).toMatchObject({ clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp8_e4m3fn.safetensors', type: 'flux' });
    expect(ofType(g, 'ModelSamplingAuraFlow')).toHaveLength(0);
    const styles = ofType(g, 'StyleModelApply');
    expect(styles).toHaveLength(2);
    for (const [, st] of styles) expect(st.inputs).toMatchObject({ strength: 0.4, strength_type: 'attn_bias' });
    expect(ofType(g, 'CLIPVisionEncode').map(([, n]) => n.inputs.crop)).toEqual(['center', 'center']);
    const [fg, fgNode] = only(g, 'FluxGuidance');
    expect(fgNode.inputs.guidance).toBe(4.5);
    expect(refTo(fgNode.inputs.conditioning)).toBe(styles[1]![0]);
    const [zero] = only(g, 'ConditioningZeroOut');
    const applies = ofType(g, 'ControlNetApplyAdvanced');
    expect(refTo(applies[0]![1].inputs.positive)).toBe(fg);
    expect(refTo(applies[0]![1].inputs.negative)).toBe(zero);
    const [, ks] = only(g, 'KSampler');
    expect(ks.inputs).toMatchObject({ cfg: 1, steps: 28, denoise: 0.6 });
    expect(job.outputs.image).toBe(only(g, 'SaveImage')[0]);
  });

  it('leaves out the mask, the ControlNets and Redux when not asked for', () => {
    const g = familyRepaintGraph(FLUX, S, { prompt: 'x', negative: '', denoise: 0.5, size: [1024, 1024] }, 'in.png', 'in.png').graph;
    checkAgainstServer(g);
    for (const t of ['SetLatentNoiseMask', 'DifferentialDiffusion', 'ControlNetLoader', 'StyleModelLoader']) expect(ofType(g, t), t).toHaveLength(0);
    const [, ks] = only(g, 'KSampler');
    expect(g[refTo(ks.inputs.latent_image)]!.class_type).toBe('VAEEncode');
  });

  it('refuses a family with the wrong number of text encoders', () => {
    const bad: FamilyModels = { ...FLUX, textEncoders: ['clip_l.safetensors'] };
    expect(() => familyRepaintGraph(bad, S, P, 'a', 'b')).toThrow(/two text encoders/);
  });
});

describe('flow noise schedules', () => {
  // printed by ComfyUI 0.41.3's own simple_scheduler and percent_to_sigma (comfy.model_sampling, the cache's checkout)
  const FLOW_10_06 = [0.837838, 0.799753, 0.756098, 0.707261, 0.65035, 0.58547, 0.508197, 0.417838, 0.306931, 0.172481, 0];
  const FLUX_10_06 = [0.840349, 0.802392, 0.759511, 0.710679, 0.654567, 0.589414, 0.512844, 0.421569, 0.310901, 0.173927, 0];

  it('reproduces ComfyUI\'s sampled sigmas for Qwen-Image (shift 3.1) and FLUX (mu 1.15) at 10 steps, denoise 0.6', () => {
    const flow = flowFns({ kind: 'flow', shift: 3.1 }, 'simple').sampled(10, 0.6);
    const flux = flowFns({ kind: 'flux', shift: 1.15 }, 'simple').sampled(10, 0.6);
    flow.forEach((v, i) => expect(v).toBeCloseTo(FLOW_10_06[i]!, 5));
    flux.forEach((v, i) => expect(v).toBeCloseTo(FLUX_10_06[i]!, 5));
  });

  it('percent_to_sigma and its inverse', () => {
    const f = flowFns({ kind: 'flow', shift: 3.1 }, 'simple');
    expect([0.1, 0.5, 0.9].map(p => f.percentToSigma(p))).toEqual([expect.closeTo(0.965398, 5), expect.closeTo(0.756098, 5), expect.closeTo(0.256198, 5)]);
    const x = flowFns({ kind: 'flux', shift: 1.15 }, 'simple');
    expect([0.1, 0.5, 0.9].map(p => x.percentToSigma(p))).toEqual([expect.closeTo(0.966014, 5), expect.closeTo(0.759511, 5), expect.closeTo(0.259758, 5)]);
    for (const fn of [f, x]) for (const p of [0.05, 0.3, 0.77]) expect(fn.sigmaToPercent(fn.percentToSigma(p))).toBeCloseTo(p, 9);
    expect(f.percentToSigma(0)).toBe(1);
    expect(f.percentToSigma(1)).toBe(0);
  });

  it('maps a relative window onto the sampled steps of a flow model at a partial denoise', () => {
    for (const fam of ['qwen-image', 'flux'] as const) {
      const all = controlWindow(30, 0.6, 'simple', { start: 0, end: 1 }, noiseFor(fam));
      expect(all).toEqual({ startPercent: 0, endPercent: 1, activeFraction: 1 });
      const half = controlWindow(30, 0.6, 'simple', { start: 0, end: 0.5 }, noiseFor(fam));
      expect(half.activeFraction).toBe(0.5);
      // an absolute 0.5 would cover much less than half of a 0.6 denoise's steps: the mapped end is well past it
      expect(half.endPercent).toBeGreaterThan(0.5);
      expect(controlWindow(28, 0.5, 'simple', { start: 0.25, end: 0.75 }, noiseFor(fam)).activeFraction).toBeCloseTo(0.5, 1);
    }
    expect(() => controlWindow(30, 0.6, 'karras', { start: 0, end: 1 }, noiseFor('flux'))).toThrow(/simple/);
  });
});
