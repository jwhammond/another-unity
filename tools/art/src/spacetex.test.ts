// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Generator, Job } from './generator';
import type { Models } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import { nearestResize } from './pixel';
import { parseRecipe, type SpaceTexturesRecipe } from './recipe';
import { islandMask, makeSpaceTexture, textureRepaintRecipe, textureSeed } from './spacetex';
import { FakeGenerator } from './testing/fakeGenerator';

const M: Models = { checkpoint: 'ck.safetensors', upscaler: 'up.pth' };
const recipe = (extra = ''): SpaceTexturesRecipe => parseRecipe(`id: space.textures
kind: spacetex
sampling: { seed: 300001, steps: 5, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a hull
denoise: 0.3
${extra}`, '/x/space.textures.yaml') as SpaceTexturesRecipe;

/** A made-up w x h texture: a light square on dark, keyed (its top-left texel clear), every texel on an island. */
function texture(w: number, h: number, name = 'hull.gif', base?: string) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const lit = x > w / 4 && x < (3 * w) / 4 && y > h / 4 && y < (3 * h) / 4;
    data.set(lit ? [220, 200, 180, 255] : [30, 40, 50, 255], (y * w + x) * 4);
  }
  data[3] = 0;
  return { name, picture: { width: w, height: h, data } as Rgba, islands: new Uint8Array(w * h).fill(1), ...(base ? { base } : {}) };
}

/** A generator that gives its picture back: the upscaler 4x nearest, the sampler its work image unchanged (a perfect repaint, for the check). */
class Mirror implements Generator {
  readonly jobs: Job[] = [];
  async run(job: Job): Promise<Record<string, Uint8Array>> {
    this.jobs.push(job);
    const kinds = Object.values(job.graph).map(n => n.class_type);
    const input = (prefix: string) => decodePng(Object.entries(job.inputs).find(([k]) => k.startsWith(prefix))![1]);
    const out = kinds.includes('KSampler') ? input('art-work') : (() => { const i = Object.values(job.inputs).map(decodePng)[0]!; return nearestResize(i, i.width * 4, i.height * 4); })();
    return Object.fromEntries(Object.keys(job.outputs).map(k => [k, encodePng(out)]));
  }
  async info() { return { comfyui: 'mirror', torch: '-', device: '-', vramTotal: 0 }; }
  async nodeTypes() { return new Set<string>(); }
}

describe('a combat texture\'s repaint (Plan 30 R8)', () => {
  it('runs as tex.space.<name> at its own work size, 4x out, de-dithered, at its seed: its own, its base\'s, or the recipe\'s', () => {
    const r = recipe('seeds: { hull.gif: 7 }');
    const one = textureRepaintRecipe(r, texture(64, 48));
    expect([one.id, one.size, one.sampling.seed, one.denoise, one.dedither?.method]).toEqual(['tex.space.hull.gif', { work: [1152, 896], out: [256, 192] }, 7, 0.3, 'bilateral']);
    expect([textureSeed(r, { name: 'hull.dmg.gif', base: 'hull.gif' }), textureSeed(r, { name: 'other.gif' })]).toEqual([7, 300001]);
    // (a damage texture's own entry beats its base's)
    expect(textureSeed(recipe('seeds: { hull.gif: 7, hull.dmg.gif: 9 }'), { name: 'hull.dmg.gif', base: 'hull.gif' })).toBe(9);
  });

  it('masks the denoise to the islands at the work size, feathered at their edge', () => {
    const islands = Uint8Array.from([1, 0, 0, 0]);
    const m = islandMask(islands, 2, 2, [8, 8], 1);
    const at = (x: number, y: number) => m.data[(y * 8 + x) * 4]!;
    expect([at(0, 0), at(7, 7), at(3, 1) > 0 && at(3, 1) < 255, at(4, 4), at(5, 5)]).toEqual([255, 0, true, 28, 0]);
  });

  it('keeps a repaint that lines up, with the original\'s alpha at 4x', async () => {
    const r = await makeSpaceTexture(recipe(), texture(64, 48), new Mirror(), M);
    expect([r.mode, r.picture.width, r.picture.height, r.align?.ok, r.seed]).toEqual(['repaint', 256, 192, true, 300001]);
    expect([r.picture.data[3], r.picture.data[4 * 4 + 3]]).toEqual([0, 255]);
  });

  it('publishes the upscale for a texture that doesn\'t line up, one under the smallest side, and one the recipe lists', async () => {
    // (the fake's flat grey has no edge where the original has them: the check fails)
    const flat = await makeSpaceTexture(recipe(), texture(64, 48), new FakeGenerator(), M);
    expect([flat.mode, flat.align?.ok, flat.picture.width]).toEqual(['upscale', false, 256]);
    const g = new FakeGenerator();
    const small = await makeSpaceTexture(recipe(), texture(16, 40), g, M);
    expect([small.mode, small.why, small.picture.width, small.picture.height, g.jobs.length]).toEqual(['upscale', 'small', 64, 160, 1]);
    expect((await makeSpaceTexture(recipe('upscaleOnly: [hull.gif]'), texture(64, 48), new FakeGenerator(), M)).why).toBe('listed');
    // (a flat original has no edge to measure: even a perfect repaint can't be shown to line up, so it is the upscale: R8)
    const plain = texture(64, 48);
    for (let i = 0; i < plain.picture.data.length; i += 4) plain.picture.data.set([90, 90, 90], i);
    const unmeasured = await makeSpaceTexture(recipe(), plain, new Mirror(), M);
    expect([unmeasured.mode, unmeasured.align?.ok, unmeasured.picture.width]).toEqual(['upscale', false, 256]);
  });
});
