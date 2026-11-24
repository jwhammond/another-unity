// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './image';
import type { Models } from './graphs';
import { parseRecipe, type RepaintRecipe } from './recipe';
import { repaint } from './repaint';
import { controlWindow } from './sigmas';
import { FakeGenerator } from './testing/fakeGenerator';
import type { FamilyModels } from './families';

const M: Models = {
  checkpoint: 'ck.safetensors',
  upscaler: 'up.pth',
  depth: { controlnet: 'cnd.safetensors', annotator: 'depth.pth' },
  lineart: { controlnet: 'cnl.safetensors', annotator: 'AnyLineArtPreprocessor_aux' },
};
const YAML = `
id: t.s01
kind: repaint
source: { background: s_0001 }
sampling: { seed: 9, steps: 5, cfg: 4.5, sampler: euler, scheduler: normal }
prompt: a room
denoise: 0.3
depth: { strength: 0.7, end: 0.9 }
lineart: { strength: 0.6, start: 0.1, end: 0.8 }
post: [ { depth: { resolution: 512 } } ]
`;
const recipe = (over = ''): RepaintRecipe => parseRecipe(YAML + over, '/x/t.s01.yaml') as RepaintRecipe;
const original = (): Uint8Array => encodePng({ width: 640, height: 480, data: new Uint8Array(640 * 480 * 4).fill(90) });

describe('repaint', () => {
  it('upscales 640x480, downsizes to 1152x864, repaints with the guide, upscales and area-downsizes to 2560x1920', async () => {
    const g = new FakeGenerator();
    const r = await repaint(recipe(), original(), g, M);
    expect(decodePng(r.upscaled)).toMatchObject({ width: 2560, height: 1920 });
    expect(decodePng(r.work)).toMatchObject({ width: 1152, height: 864 });
    expect(decodePng(r.repainted)).toMatchObject({ width: 1152, height: 864 });
    expect(decodePng(r.plate)).toMatchObject({ width: 2560, height: 1920 });
    const kinds = g.jobs.map(j => Object.values(j.graph).map(n => n.class_type));
    expect(kinds[0]).toContain('ImageUpscaleWithModel');
    expect(kinds[1]).toContain('KSampler');
    expect(kinds[2]).toContain('ImageUpscaleWithModel');
    // the ControlNet guide is the 4x upscale, not the work image
    const rp = g.jobs[1]!;
    expect(decodePng(rp.inputs['art-guide-run.png']!).width).toBe(2560);
    expect(decodePng(rp.inputs['art-work-run.png']!).width).toBe(1152);
  });

  it('passes denoise, seed, and only the ControlNets the recipe names', async () => {
    const g = new FakeGenerator();
    const lineOnly = YAML.replace(/depth: \{ strength.*\n/, '').replace(/post:.*\n/, '');
    const r = parseRecipe(lineOnly, '/x/t.s01.yaml') as RepaintRecipe;
    await repaint(r, original(), g, M);
    const ks = Object.values(g.jobs[1]!.graph).find(n => n.class_type === 'KSampler')!;
    expect(ks.inputs).toMatchObject({ denoise: 0.3, seed: 9, steps: 5, cfg: 4.5 });
    const types = Object.values(g.jobs[1]!.graph).map(n => n.class_type);
    expect(types).not.toContain('DepthAnythingV2Preprocessor');
    expect(types).toContain('AnyLineArtPreprocessor_aux');
    expect(g.jobs).toHaveLength(3); // no depth post-step, no depth job
  });

  it('makes a depth map from the upscale when the recipe has a depth post-step', async () => {
    const g = new FakeGenerator();
    const r = await repaint(recipe(), original(), g, M);
    expect(r.depth).toBeDefined();
    const dj = g.jobs[3]!;
    expect(Object.values(dj.graph).find(n => n.class_type === 'DepthAnythingV2Preprocessor')!.inputs.resolution).toBe(512);
  });

  it('maps the recipe\'s relative windows onto ComfyUI\'s absolute percents over the sampled steps', async () => {
    const g = new FakeGenerator();
    const r = recipe();
    await repaint(r, original(), g, M);
    const applies = Object.values(g.jobs[1]!.graph).filter(n => n.class_type === 'ControlNetApplyAdvanced');
    const want = (rel: { start: number; end: number }) => controlWindow(5, 0.3, 'normal', rel);
    expect(applies[0]!.inputs).toMatchObject({ strength: 0.7, start_percent: want({ start: 0, end: 0.9 }).startPercent, end_percent: want({ start: 0, end: 0.9 }).endPercent });
    expect(applies[1]!.inputs).toMatchObject({ strength: 0.6, start_percent: want({ start: 0.1, end: 0.8 }).startPercent, end_percent: want({ start: 0.1, end: 0.8 }).endPercent });
    // not the raw numbers: with denoise 0.3 the sampled tail is only the end of the percent range
    expect(applies[0]!.inputs.end_percent).not.toBe(0.9);
  });

  it('reports each control\'s active fraction, and stamps the uploaded names (M8)', async () => {
    const g = new FakeGenerator();
    const r = await repaint(recipe(), original(), g, M, 'RUN1');
    expect(r.controls.map(c => c.name)).toEqual(['depth', 'lineart']);
    expect(r.controls[0]!.activeFraction).toBeGreaterThan(0.5);
    const names = g.jobs.flatMap(j => Object.keys(j.inputs));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toContain('RUN1');
    const other = new FakeGenerator();
    await repaint(recipe(), original(), other, M, 'RUN2');
    expect(new Set([...names, ...other.jobs.flatMap(j => Object.keys(j.inputs))]).size).toBe(2 * new Set(names).size);
  });
});

describe('repaint with an experimental family', () => {
  const FLUX: FamilyModels = { family: 'flux', unet: 'f.safetensors', textEncoders: ['clip_l.safetensors', 't5.safetensors'], vae: 'ae.safetensors', controlnet: 'u.safetensors', styleModel: 'r.safetensors', clipVision: 's.safetensors', depthAnnotator: 'depth.pth', lineartNode: 'AnyLineArtPreprocessor_aux', upscaler: 'up.pth' };
  const flux = (): RepaintRecipe => parseRecipe(YAML.replace('scheduler: normal', 'scheduler: simple').replace('cfg: 4.5', 'cfg: 1') + 'model: flux\nguidance: 3.5\n', '/x/t.s01.yaml') as RepaintRecipe;

  it('routes the repaint through the family graph, maps the windows on its flow schedule, and Redux takes the references', async () => {
    const g = new FakeGenerator();
    const r = flux();
    const out = await repaint({ ...r, reference: [{ refs: ['a'], model: 'style', weight: 0.4, weightType: 'linear', start: 0, end: 1, mask: 'none' }] }, original(), g, M, 'run', [{ spec: { refs: ['a'], model: 'style', weight: 0.4, weightType: 'linear', start: 0, end: 1, mask: 'none' }, images: [{ id: 'a', bytes: original() }] }], undefined, FLUX);
    const types = Object.values(g.jobs[1]!.graph).map(n => n.class_type);
    expect(types).toEqual(expect.arrayContaining(['UNETLoader', 'DualCLIPLoader', 'StyleModelApply', 'FluxGuidance']));
    expect(types).not.toContain('CheckpointLoaderSimple');
    expect(types).not.toContain('IPAdapterAdvanced');
    const lineart = out.controls.find(c => c.name === 'lineart')!;
    const want = controlWindow(5, 0.3, 'simple', { start: 0.1, end: 0.8 }, { kind: 'flux', shift: 1.15 });
    expect(lineart.endPercent).toBeCloseTo(want.endPercent, 9);
    expect(out.references[0]).toMatchObject({ weightType: 'redux attn_bias', weight: 0.4 });
    // the upscales are the shared SDXL pipeline's
    expect(Object.values(g.jobs[0]!.graph).map(n => n.class_type)).toContain('ImageUpscaleWithModel');
  });

  it('refuses a family recipe without its models', async () => {
    await expect(repaint(flux(), original(), new FakeGenerator(), M)).rejects.toThrow(/no flux models/);
  });
});

describe('repaint with dedither', () => {
  const dithered = (): Uint8Array => {
    const data = new Uint8Array(640 * 480 * 4);
    for (let i = 0; i < 640 * 480; i++) {
      const v = ((i % 640) + Math.floor(i / 640)) % 2 === 0 ? 100 : 130;
      data.set([v, v, v, 255], i * 4);
    }
    return encodePng({ width: 640, height: 480, data });
  };

  it('upscales the de-dithered original, and without keep runs no second upscale', async () => {
    const g = new FakeGenerator();
    const r = await repaint(recipe('dedither: {}\n'), dithered(), g, M);
    const sent = decodePng(g.jobs[0]!.inputs['art-in-run.png']!);
    expect(sent.data[(100 * 640 + 100) * 4]).toBe(115);
    expect(decodePng(r.dedithered!).data[(100 * 640 + 101) * 4]).toBe(115);
    expect(r.keepUpscaled).toBeUndefined();
    expect(g.jobs).toHaveLength(4);
  });

  it('sends the original as it is without dedither', async () => {
    const g = new FakeGenerator();
    const r = await repaint(recipe(), dithered(), g, M);
    expect(decodePng(g.jobs[0]!.inputs['art-in-run.png']!).data[(100 * 640 + 100) * 4]).toBe(100);
    expect(r.dedithered).toBeUndefined();
  });

  it('upscales the original as well for a recipe with keep (the kept interface takes the original\'s own upscale)', async () => {
    const g = new FakeGenerator();
    const ship = YAML.replace('id: t.s01', 'id: plate.bridge').replace('source: { background: s_0001 }', 'source: { ship: bridge }');
    const r = parseRecipe(`${ship}dedither: {}\nkeep:\n  - [0, 364, 640, 116]\n`, '/x/plate.bridge.yaml') as RepaintRecipe;
    const out = await repaint(r, dithered(), g, M, 'K1');
    expect(out.keepUpscaled).toBeDefined();
    const last = g.jobs[g.jobs.length - 1]!;
    const sent = decodePng(last.inputs['art-kin-K1.png']!);
    expect(sent.data[(100 * 640 + 100) * 4]).toBe(100);
    // the kept rows go in to the main upscale unchanged too
    expect(decodePng(g.jobs[0]!.inputs['art-in-K1.png']!).data[(400 * 640 + 100) * 4]).toBe(100);
  });
});
