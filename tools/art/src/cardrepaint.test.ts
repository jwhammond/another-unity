// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cardRecipe, recipeSchema } from './recipe';
import { groupsOf, headBoxes, layoutCanvas, repaintAnim, unionBox } from './cardrepaint';
import { decodePng, encodePng, type Rgba } from './image';
import type { Generator, GeneratorInfo, Job } from './generator';
import { FakeGenerator } from './testing/fakeGenerator';
import type { FamilyModels } from './families';
import type { Models } from './graphs';

/** A figure of `w` x `h` (head on top: a narrower block), at (x, y) in a cell, with a shadow row of alpha 100 below it. */
function figure(cell: [number, number], x: number, y: number, w = 12, h = 40, colour: [number, number, number] = [200, 40, 40], headFrac = 0.2): Rgba {
  const data = new Uint8Array(cell[0] * cell[1] * 4);
  for (let yy = 0; yy < h; yy++) {
    const headRow = yy < h * headFrac;
    for (let xx = headRow ? 3 : 0; xx < (headRow ? w - 3 : w); xx++) data.set([...colour, 255], ((y + yy) * cell[0] + x + xx) * 4);
  }
  for (let xx = 0; xx < w; xx++) data.set([0, 0, 0, 100], ((y + h) * cell[0] + x + xx) * 4);
  return { width: cell[0], height: cell[1], data };
}

const models: Models = {
  checkpoint: 'c.safetensors',
  upscaler: 'u.pth',
  depth: { controlnet: 'cn', annotator: 'da' },
  lineart: { controlnet: 'cn', annotator: 'AnyLineArtPreprocessor_aux' },
  ipadapter: { style: 'plus.safetensors', face: 'face.safetensors', clipVision: 'cv.safetensors' },
};
const recipe = (over: Record<string, unknown> = {}) =>
  cardRecipe.parse({
    id: 'card.test',
    kind: 'card',
    object: 'test',
    sprite: 'test.spr',
    sampling: { seed: 7, steps: 20, cfg: 5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    prompt: 'a person',
    denoise: 0.45,
    depth: { strength: 0.6 },
    reference: [
      { refs: ['a', 'b'], model: 'face', weight: 0.7, mask: 'head' },
      { refs: ['c'], model: 'style', weight: 0.4, mask: 'figure' },
    ],
    ...over,
  });
const cells = (n: number): Rgba[] => Array.from({ length: n }, (_, i) => figure([40, 60], 10 + i, 8, 12, 40));
const refs = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

describe('headBoxes', () => {
  it('finds the head of a synthetic figure: the top 22% of the opaque height, the width there widened 20%', () => {
    const [b] = headBoxes([figure([40, 60], 10, 8, 20, 50, [200, 40, 40], 0.25)]);
    // head rows: 22% of 50 = 11 rows from y 8; the head is 14 wide (x 13..26), widened by 10% each side (1 px)
    expect(b).toEqual([12, 8, 16, 11]);
  });
  it('gives an empty box to an empty frame', () => {
    expect(headBoxes([{ width: 4, height: 4, data: new Uint8Array(64) }])[0]).toEqual([0, 0, 0, 0]);
  });
});

describe('groupsOf', () => {
  it('splits evenly into groups of at most the size', () => {
    expect(groupsOf(6, 4)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(groupsOf(4, 4)).toEqual([[0, 1, 2, 3]]);
    expect(groupsOf(5, 1)).toHaveLength(5);
    expect(groupsOf(7, 2).map(g => g.length)).toEqual([2, 2, 2, 1]);
  });
});

describe('layoutCanvas', () => {
  it('puts the frames side by side on one square, inside it, with masks over the heads and the figures', () => {
    const f = cells(3);
    const c = layoutCanvas(f, unionBox(f));
    expect(decodePng(c.png)).toMatchObject({ width: 1024, height: 1024 });
    for (const s of c.slots) {
      expect(s.cx).toBeGreaterThanOrEqual(0);
      expect(s.cx + s.cw).toBeLessThanOrEqual(1024);
    }
    const head = decodePng(c.head);
    const fig = decodePng(c.figure);
    const s = c.slots[0]!;
    // the head mask is bright at the top of the first slot, dark at its feet; the figure mask is bright in the middle
    expect(head.data[((s.cy + 8) * 1024 + s.cx + s.cw / 2) * 4]!).toBeGreaterThan(200);
    expect(head.data[((s.cy + s.ch - 10) * 1024 + s.cx + s.cw / 2) * 4]!).toBeLessThan(20);
    expect(fig.data[((s.cy + s.ch / 2) * 1024 + s.cx + s.cw / 2) * 4]!).toBeGreaterThan(200);
  });
});

describe('repaintAnim', () => {
  it("forces each frame's alpha to the upscaled original's exactly (the generator returns a shifted, recoloured image)", async () => {
    class Shifted implements Generator {
      async run(job: Job): Promise<Record<string, Uint8Array>> {
        const data = new Uint8Array(1024 * 1024 * 4);
        for (let i = 0; i < 1024 * 1024; i++) data.set([(i % 1024) % 256, 30, 220, 255], i * 4);
        return Object.fromEntries(Object.keys(job.outputs).map(k => [k, encodePng({ width: 1024, height: 1024, data })]));
      }
      async info(): Promise<GeneratorInfo> { return { comfyui: 'x', torch: 'x', device: 'x', vramTotal: 0 }; }
      async nodeTypes(): Promise<Set<string>> { return new Set(); }
    }
    const up = cells(4);
    const out = await repaintAnim(new Shifted(), models, recipe(), up, refs);
    expect(out).toHaveLength(4);
    out.forEach((o, i) => {
      expect(o.width).toBe(up[i]!.width);
      for (let p = 3; p < o.data.length; p += 4) expect(o.data[p]).toBe(up[i]!.data[p]);
    });
    // opaque pixels took the repaint's colour (blue-ish), not the original's red
    const mid = (20 * 40 + 16) * 4;
    expect(out[0]!.data[mid + 2]).toBeGreaterThan(150);
  });

  it('hands back an animation whose frames are all clear without asking the generator', async () => {
    const g = new FakeGenerator();
    const clear = [{ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }];
    const out = await repaintAnim(g, models, recipe(), clear, refs);
    expect(g.jobs).toHaveLength(0);
    expect(out).toEqual(clear);
  });

  it('groups frames by `group` on one canvas with one seed and one reference set', async () => {
    const g = new FakeGenerator();
    await repaintAnim(g, models, recipe({ group: 2 }), cells(5), refs);
    expect(g.jobs).toHaveLength(3);
    const seeds = g.jobs.map(j => Object.values(j.graph).find(n => n.class_type === 'KSampler')!.inputs.seed);
    expect(new Set(seeds)).toEqual(new Set([7]));
    for (const j of g.jobs) {
      const apply = Object.values(j.graph).filter(n => n.class_type === 'IPAdapterAdvanced');
      expect(apply).toHaveLength(2);
      expect(apply.every(n => 'attn_mask' in n.inputs)).toBe(true);
      expect(Object.values(j.graph).filter(n => n.class_type === 'LoadImage' && String(n.inputs.image).startsWith('card-ref'))).toHaveLength(3);
      for (const bytes of refs) expect(Object.values(j.inputs).some(v => v === bytes)).toBe(true);
    }
    const one = new FakeGenerator();
    await repaintAnim(one, models, recipe({ group: 4 }), cells(4), refs);
    expect(one.jobs).toHaveLength(1);
  });

  it('refuses a wrong number of reference crops', async () => {
    await expect(repaintAnim(new FakeGenerator(), models, recipe(), cells(2), refs.slice(1))).rejects.toThrow(/3 reference crops/);
  });
});

describe('the card recipe', () => {
  const base = { id: 'card.riker', kind: 'card', object: 'riker', sprite: 'riker.spr', sampling: { seed: 1, steps: 20, cfg: 5, sampler: 'dpmpp_2m', scheduler: 'karras' }, prompt: 'p', denoise: 0.4 };
  it('parses, with the defaults', () => {
    const r = recipeSchema.parse(base);
    expect(r).toMatchObject({ kind: 'card', anims: 'used', group: 4, checks: { flickerRatio: 2.5, flickerMax: 12, deltaE: 12 } });
  });
  it('fails to parse when it names a FaceID model', () => {
    expect(() => recipeSchema.parse({ ...base, reference: [{ refs: ['x'], model: 'faceid', weight: 0.5 }] })).toThrow();
    expect(() => recipeSchema.parse({ ...base, models: { ipadapter: 'ip-adapter-faceid-plusv2_sdxl' } })).toThrow();
  });
  it('fails a ControlNet that acts on no sampled step', () => {
    expect(() => recipeSchema.parse({ ...base, depth: { strength: 1, start: 0.999, end: 1 } })).toThrow(/no sampled step|active/);
  });
});

describe('repaintAnim with an experimental family', () => {
  const FLUX: FamilyModels = { family: 'flux', unet: 'f.safetensors', textEncoders: ['clip_l.safetensors', 't5.safetensors'], vae: 'ae.safetensors', controlnet: 'u.safetensors', styleModel: 'r.safetensors', clipVision: 's.safetensors', depthAnnotator: 'da', lineartNode: 'AnyLineArtPreprocessor_aux', upscaler: 'u.pth' };
  const flux = recipe({ model: 'flux', sampling: { seed: 7, steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple' } });

  it('paints each canvas with the family graph, every reference crop through Redux at its weight, and no IP-Adapter or attention mask', async () => {
    const g = new FakeGenerator();
    const out = await repaintAnim(g, models, flux, cells(2), refs, { family: FLUX });
    expect(out).toHaveLength(2);
    const graph = Object.values(g.jobs[0]!.graph);
    expect(graph.map(n => n.class_type)).toEqual(expect.arrayContaining(['UNETLoader', 'FluxGuidance', 'ControlNetApplyAdvanced']));
    expect(graph.filter(n => n.class_type === 'StyleModelApply').map(n => n.inputs.strength)).toEqual([0.7, 0.7, 0.4]);
    expect(graph.map(n => n.class_type)).not.toContain('IPAdapterAdvanced');
    expect(Object.keys(g.jobs[0]!.inputs).filter(k => k.startsWith('card-ref-'))).toHaveLength(3);
  });

  it('refuses a family recipe without its models', async () => {
    await expect(repaintAnim(new FakeGenerator(), models, flux, cells(2), refs)).rejects.toThrow(/no flux models/);
  });
});
