// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { artCache } from './cache';
import type { Job } from './generator';
import { decodePng, encodePng, type Rgba } from './image';
import { loadModels } from './models';
import { parseRecipe, textureRecipe } from './recipe';
import { runRecipe } from './run';
import { normalFromHeight, makeTexture, seamMask, seamRatio, seamRatioCoarse, SeamError, tile3x3 } from './texture';
import { FakeGenerator } from './testing/fakeGenerator';
import type { Models } from './graphs';

const img = (w: number, h: number, f: (x: number, y: number) => number): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([f(x, y), f(x, y), f(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};
const px = (i: Rgba, x: number, y: number): number[] => Array.from(i.data.subarray((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

describe('seamRatio', () => {
  it('is ~1 for a periodic pattern and well over 1.5 for a horizontal gradient', () => {
    const periodic = img(64, 64, (x, y) => 128 + 100 * Math.sin((x / 64) * 2 * Math.PI * 3) * Math.cos((y / 64) * 2 * Math.PI * 2));
    expect(seamRatio(periodic)).toBeGreaterThan(0.8);
    expect(seamRatio(periodic)).toBeLessThan(1.2);
    const ramp = img(64, 64, x => x * 4);
    expect(seamRatio(ramp)).toBeGreaterThan(10);
    expect(seamRatio(img(8, 8, () => 50))).toBe(1);
  });
});

describe('seamRatioCoarse', () => {
  it('catches a brightness jump at the wrap that a fine grid hides', () => {
    // a checkerboard of 2 px cells whose left half is brighter than its right: the fine ratio is ~1 inside and at the wrap
    const board = img(128, 128, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? 20 + (x < 64 ? 120 : 0) : 100 + (x < 64 ? 120 : 0));
    expect(seamRatioCoarse(board)).toBeGreaterThan(1.5);
    expect(seamRatioCoarse(img(128, 128, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? 20 : 100))).toBeLessThan(1.5);
  });
});

describe('seamMask', () => {
  it('covers the centre lines with the band, feathered, and nothing at the corners', () => {
    const m = seamMask(256, 64);
    expect(px(m, 128, 10)[0]).toBe(255);
    expect(px(m, 10, 128)[0]).toBe(255);
    expect(px(m, 128, 128)[0]).toBe(255);
    expect(px(m, 127, 200)[0]).toBe(255);
    expect(px(m, 0, 0)[0]).toBe(0);
    expect(px(m, 255, 255)[0]).toBe(0);
    expect(px(m, 128 + 31, 0)[0]).toBeGreaterThan(0);
    expect(px(m, 128 + 31, 0)[0]).toBeLessThan(255);
    expect(px(m, 128 + 40, 0)[0]).toBe(0);
    expect(px(m, 128 + 10, 0)[0]).toBe(255);
  });
});

describe('normalFromHeight', () => {
  it('of a flat image is (128,128,255) everywhere, and wraps at the edges', () => {
    const flat = normalFromHeight(img(8, 8, () => 90), 2);
    for (let i = 0; i < 64; i++) expect(Array.from(flat.data.subarray(i * 4, i * 4 + 4))).toEqual([128, 128, 255, 255]);
    // a bright column at x = 0: the pixel at x = 7 sees it on its right, so it is not (128, ...) although it is the edge
    const col = normalFromHeight(img(8, 8, x => (x === 0 ? 255 : 0)), 2);
    expect(px(col, 7, 3)[0]).toBeLessThan(128);
    expect(px(col, 1, 3)[0]).toBeGreaterThan(128);
    expect(px(col, 4, 3)[0]).toBe(128);
    // the same height in the same place tiles: rolling the input rolls the output
    expect(px(col, 3, 0)[1]).toBe(128);
  });
});

describe('tile3x3', () => {
  it('repeats the image three times each way', () => {
    const t = tile3x3(img(4, 2, (x, y) => x * 10 + y));
    expect([t.width, t.height]).toEqual([12, 6]);
    expect(px(t, 9, 4)).toEqual(px(t, 1, 0));
  });
});

const models: Models = { checkpoint: 'ck.safetensors', upscaler: 'up.pth' };
const recipe = textureRecipe.parse({
  id: 'tex.t', kind: 'texture', sampling: { seed: 1, steps: 4, cfg: 5, sampler: 'euler', scheduler: 'normal' }, prompt: 'x', size: 128, seam: { band: 16 },
});

/** txt2img gives stripes with a seam of its own at the wrap; the inpaint hands back what it was given. */
class Stripes extends FakeGenerator {
  override async run(job: Job): Promise<Record<string, Uint8Array>> {
    await super.run(job);
    const inpaint = Object.values(job.graph).some(n => n.class_type === 'SetLatentNoiseMask');
    if (inpaint) return { image: job.inputs['art-tex.png']! };
    return { image: encodePng(img(128, 128, x => (x < 64 ? 40 : 200))) };
  }
}

describe('makeTexture', () => {
  it('rolls, inpaints the seam mask, rolls back, and reports both ratios (FakeGenerator)', async () => {
    const g = new Stripes();
    let err: unknown;
    try {
      await makeTexture(recipe, g, models);
    } catch (e) {
      err = e;
    }
    // stripes 40|200 wrap with a step of 160 against 1 step of 160 in 128: the pass-through inpaint leaves the seam
    expect(err).toBeInstanceOf(SeamError);
    const r = (err as SeamError).result;
    expect(r.seamBefore).toBeGreaterThan(1.5);
    expect(r.seamAfter).toBeCloseTo(r.seamBefore, 5);
    expect(g.jobs).toHaveLength(2);
    const [t2i, inp] = g.jobs as [Job, Job];
    expect(Object.values(t2i.graph).some(n => n.class_type === 'EmptyLatentImage' && n.inputs.width === 128)).toBe(true);
    // the inpaint saw the image rolled by half: the first stripe edge moved from x=64 to x=0
    const rolled = decodePng(inp.inputs['art-tex.png']!);
    expect(px(rolled, 0, 0)[0]).toBe(200);
    expect(px(rolled, 64, 0)[0]).toBe(40);
    expect(decodePng(inp.inputs['art-tex-mask.png']!).data[(64 * 128 + 5) * 4]).toBe(255);
    const grow = Object.values(inp.graph).find(n => n.class_type === 'GrowMask');
    expect(grow?.inputs.expand).toBe(0);
    const sampler = Object.values(inp.graph).find(n => n.class_type === 'KSampler');
    expect(sampler?.inputs.denoise).toBe(0.7);
    // rolled back: the albedo is the pass-through image rolled by half again, i.e. the original stripes
    const albedo = decodePng(r.albedo);
    expect(px(albedo, 10, 0)[0]).toBe(40);
    expect(px(albedo, 100, 0)[0]).toBe(200);
    expect(decodePng(r.preview).width).toBe(384);
  });

  it('passes when the texture is seamless', async () => {
    const r = await makeTexture(recipe, new FakeGenerator([90, 90, 90, 255]), models);
    expect(r.seamAfter).toBeLessThanOrEqual(1.5);
    expect(decodePng(r.normal).data.slice(0, 4)).toEqual(new Uint8Array([128, 128, 255, 255]));
  });
});

describe('a texture recipe\'s run', () => {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  const FILES: Record<string, [string, string, string]> = {
    ck: ['checkpoint', 'checkpoints/ck.safetensors', 'CK'],
    vae: ['vae', 'vae/v.safetensors', 'VAE'],
    cn: ['controlnet', 'controlnet/cn.safetensors', 'CN'],
    dep: ['annotator', 'annotators/o/r/d.pth', 'DEP'],
    'anyline-mteed': ['annotator', 'annotators/o/r/l.pth', 'LINE'],
    up: ['upscaler', 'upscale_models/up.pth', 'UP'],
  };
  const yaml = `models:\n${Object.entries(FILES)
    .map(([k, [role, file, body]]) => `  ${k}: {role: ${role}, file: ${file}, url: "https://example.com/${k}", sha256: "${sha(body)}", licence: MIT, licenceUrl: "https://example.com/l"}`)
    .join('\n')}\nselected: {checkpoint: ck, vae: vae, depth: cn, lineart: cn, depthAnnotator: dep, lineartAnnotator: anyline-mteed, upscaler: up}\n`;
  const TEXT = `id: tex.t
kind: texture
sampling: { seed: 9, steps: 4, cfg: 5, sampler: euler, scheduler: normal }
prompt: a panel
size: 128
`;
  let tmp: string;
  let deps: Parameters<typeof runRecipe>[2];
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'art-tex-'));
    const cache = artCache({ ART_CACHE: join(tmp, 'cache') });
    for (const [, file, body] of Object.values(FILES)) {
      await mkdir(join(cache.models, file, '..'), { recursive: true });
      await writeFile(join(cache.models, file), body);
    }
    await writeFile(join(tmp, 'pins.env'), 'COMFYUI_COMMIT=abc123\n');
    deps = { generator: new FakeGenerator([90, 90, 90, 255]), models: loadModels(yaml), cache, pinsFile: join(tmp, 'pins.env'), comfyCommit: async () => 'abc123', now: () => 1_700_000_000_000 };
  });

  it('writes albedo (first), normal and a 3x3 preview, and last.json', async () => {
    const { dir, meta } = await runRecipe(parseRecipe(TEXT, '/x/tex.t.yaml'), TEXT, deps);
    expect(Object.keys(meta.outputs)).toEqual(['albedo', 'normal', 'preview']);
    expect(meta.outputs.albedo).toMatchObject({ width: 128, height: 128 });
    expect(meta.outputs.preview).toMatchObject({ width: 384, height: 384 });
    expect(decodePng(new Uint8Array(await readFile(join(dir, 'preview.png')))).width).toBe(384);
    expect((meta.checks.seam as { after: number }).after).toBeLessThanOrEqual(1.5);
    expect(JSON.parse(await readFile(join(deps.cache.work, 'tex.t', 'last.json'), 'utf8')).dir).toBe(dir);
  });

  it('refuses a texture recipe whose checkpoint has the wrong hash, and keeps a visible seam out of last.json', async () => {
    await writeFile(join(deps.cache.models, 'checkpoints/ck.safetensors'), 'TAMPERED');
    await expect(runRecipe(parseRecipe(TEXT, '/x/tex.t.yaml'), TEXT, deps)).rejects.toThrow(/sha256/);
    await writeFile(join(deps.cache.models, 'checkpoints/ck.safetensors'), 'CK');
    await expect(runRecipe(parseRecipe(TEXT, '/x/tex.t.yaml'), TEXT, { ...deps, generator: new Stripes() })).rejects.toThrow(/seam is still visible/);
    await expect(readFile(join(deps.cache.work, 'tex.t', 'last.json'))).rejects.toThrow();
  });
});

describe('textureRecipe', () => {
  it('needs a tex. id and a size that is a multiple of 64', () => {
    const base = { kind: 'texture', sampling: { seed: 1, steps: 1, cfg: 1, sampler: 'a', scheduler: 'b' }, prompt: 'x' };
    expect(() => textureRecipe.parse({ ...base, id: 'panel' })).toThrow();
    expect(() => textureRecipe.parse({ ...base, id: 'tex.a', size: 1000 })).toThrow();
    expect(textureRecipe.parse({ ...base, id: 'tex.a' })).toMatchObject({ size: 1024, seam: { band: 64, denoise: 0.7 }, post: [{ normal: { strength: 2 } }, { tilePreview: true }] });
  });
});
