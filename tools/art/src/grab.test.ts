// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { avatarRecipe } from './avatar';
import { krea2Graph, krea2Models } from './families';
import { canvasLayout, fillBoxes, finishGrab, fitFace, grabSchema, keepJoined, onCanvas, runGrab, runMatte, softenOutside, validRect, warp, withoutRims } from './grab';
import { decodePng, encodePng, type Rgba } from './image';
import { loadModels } from './models';
import { backdropMask, gameBackdrop } from './portrait';

const solid = (w: number, h: number, rgb: [number, number, number]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};
const px = (img: Rgba, x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

/** A 48x50 "game portrait": blue backdrop, a skin-coloured figure in the middle. */
function game(): Rgba {
  const g = solid(48, 50, [20, 60, 140]);
  for (let y = 10; y < 50; y++) for (let x = 14; x < 34; x++) g.data.set([200, 150, 120, 255], (y * 48 + x) * 4);
  return g;
}

describe('grab geometry', () => {
  it('centres the game portrait on the canvas, its longer side filling it', () => {
    expect(canvasLayout(48, 50, 1000)).toEqual({ k: 20, ox: 20, oy: 0 });
    expect(onCanvas([10, 5, 30, 40], { k: 20, ox: 20, oy: 0 })).toEqual([220, 100, 620, 800]);
  });
  it('fits one face box onto another: mean scale, centres matched', () => {
    const f = fitFace([100, 100, 200, 300], [0, 0, 200, 400]);
    expect(f.s).toBe(2);
    expect([f.s * 150 + f.tx, f.s * 200 + f.ty]).toEqual([100, 200]);
  });
  it('warps by scale and move, repeating the edge past the source', () => {
    const img = solid(4, 4, [0, 0, 0]);
    img.data.set([255, 0, 0, 255], (1 * 4 + 1) * 4);
    const out = warp(img, { s: 2, tx: 0, ty: 0 }, 10);
    expect(px(out, 2, 2)[0]).toBeGreaterThan(100);
    expect(px(out, 9, 9)).toEqual([0, 0, 0]);
    // shrinking goes through an area reduction first
    expect(warp(solid(100, 100, [9, 9, 9]), { s: 0.1, tx: 0, ty: 0 }, 20).data.subarray(0, 3)).toEqual(new Uint8Array([9, 9, 9]));
    expect(validRect(4, 4, { s: 2, tx: 1, ty: -2 }, 10)).toEqual([1, 0, 8, 6]);
    expect(() => validRect(4, 4, { s: 1, tx: 20, ty: 0 }, 10)).toThrow(/misses/);
  });
});

describe('grab matte clean-up', () => {
  it('keeps only the region joined to the face, with a fringe', () => {
    const w = 20;
    const a = new Float32Array(w * w);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 10; x++) a[y * w + x] = 1;
    a[0] = 1; // a stray island in the corner
    a[5 * w + 11] = 0.05; // a soft wisp beside the kept region, under the threshold
    const k = keepJoined(a, w, w, [7, 10], 0.1, 1);
    expect(k[0]).toBe(0);
    expect(k[10 * w + 7]).toBe(1);
    expect(k[5 * w + 11]).toBeCloseTo(0.05);
    expect(() => keepJoined(a, w, w, [18, 18], 0.1, 1)).toThrow(/empty/);
  });
  it('clears and fills boxes, clipped to the picture', () => {
    const a = new Float32Array(16).fill(0.5);
    fillBoxes(a, 4, 4, [[-1, -1, 2, 2]], 0);
    fillBoxes(a, 4, 4, [[3, 3, 5, 5]], 1);
    expect([a[0], a[1], a[5], a[15]]).toEqual([0, 0.5, 0.5, 1]);
  });
  it('puts the cut-out over the game backdrop, graded toward the game figure', () => {
    const g = game();
    const S = 100;
    const fg = solid(S, S, [90, 90, 90]);
    const alpha = new Float32Array(S * S);
    for (let y = 30; y < S; y++) for (let x = 30; x < 70; x++) alpha[y * S + x] = 1;
    const o = grabSchema.parse({ ref: 'r', gameFace: [16, 12, 32, 30], matte: { feather: 0 }, remove: [[0, 45, 48, 5]] });
    const p = finishGrab(fg, alpha, g, o);
    // the backdrop is the game's blue; the person moved halfway to the figure's warm colour
    const back = px(p.portrait, 5, 5);
    expect(back[2]!).toBeGreaterThan(back[0]! + 40);
    const skin = px(p.portrait, 50, 60);
    expect(skin[0]!).toBeGreaterThan(skin[2]!);
    expect(skin[0]!).toBeGreaterThan(90);
    // the remove box (the portrait's bottom five rows) cleared the matte there
    expect(px(p.matte, 50, 96)).toEqual([0, 0, 0]);
    expect(px(p.matte, 50, 60)).toEqual([255, 255, 255]);
    // no grade: the cut-out keeps its own colour
    expect(px(finishGrab(fg, alpha, g, { ...o, grade: 0 }).cutout, 50, 60)).toEqual([90, 90, 90]);
  });
});

describe('runGrab', () => {
  it('reframes, mattes and pixelates deterministically, the model seeing only real pixels with a context margin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grab-'));
    const src = solid(60, 40, [120, 90, 70]);
    writeFileSync(join(dir, 'src.png'), encodePng(src));
    const o = grabSchema.parse({ ref: 'r', gameFace: [16, 12, 32, 30], size: 100 });
    const seen: { w: number; h: number }[] = [];
    const matte = (jobs: { in: string; alpha: string; fg: string }[]): void => {
      for (const j of jobs) {
        const img = decodePng(new Uint8Array(readFileSync(j.in)));
        seen.push({ w: img.width, h: img.height });
        writeFileSync(j.alpha, encodePng(solid(img.width, img.height, [255, 255, 255])));
        writeFileSync(j.fg, encodePng(img));
      }
    };
    const run = (sub: string) => runGrab(o, { file: join(dir, 'src.png'), face: [20, 10, 40, 30] }, game(), join(dir, sub), { out: 64, smooth: 32, pixel: { grid: [16, 16], filter: 'area', palette: { kmeans: 4 }, dither: 'none' } }, matte);
    const a = run('a');
    const b = run('b');
    expect(readFileSync(a.small)).toEqual(readFileSync(b.small));
    expect(decodePng(new Uint8Array(readFileSync(a.small))).width).toBe(64);
    expect(decodePng(new Uint8Array(readFileSync(a.png))).width).toBe(100);
    // the face (20 px) is scaled to the game face on the canvas (~33 px): the 60x40 source covers about 99x66 of the 200x200 wide canvas
    expect(seen[0]!.w).toBeGreaterThan(90);
    expect(seen[0]!.w).toBeLessThan(110);
    expect(JSON.parse(readFileSync(join(a.dir, 'meta.json'), 'utf8'))).toMatchObject({ ref: 'r', face: [20, 10, 40, 30] });
  });
  it('runs face/matte.py isolated, with only PATH, HOME and the model folder in its environment', () => {
    let call: { args: string[]; env: Record<string, string | undefined>; input: string } | undefined;
    const fake = ((_py: string, args: string[], o: { env: Record<string, string>; input: string }) => {
      call = { args, env: o.env, input: o.input };
      return { status: 0, stdout: '{"done":1}', stderr: '' };
    }) as never;
    runMatte('/py', 'birefnet-portrait', [{ in: 'i', alpha: 'a', fg: 'f' }], '/cache/models/rembg', fake);
    expect(call!.args[0]).toBe('-I');
    expect(call!.args[1]).toMatch(/face\/matte\.py$/);
    expect(Object.keys(call!.env).sort()).toEqual(['HOME', 'PATH', 'U2NET_HOME']);
    expect(JSON.parse(call!.input)).toEqual({ model: 'birefnet-portrait', images: [{ in: 'i', alpha: 'a', fg: 'f' }] });
    expect(() => runMatte('/py', 'm', [], '/x', (() => ({ status: 1, stderr: 'boom' })) as never)).toThrow(/boom/);
  });
});

describe('grab recipes', () => {
  const v = { name: 'a', sampling: { seed: 1, steps: 2, cfg: 1, sampler: 'euler', scheduler: 'normal' }, prompt: 'p', denoise: 0.9 };
  const base = { id: 'avatar.x', kind: 'avatar', object: 'x', base: { sprite: 'x.spr' }, variants: [v] };
  it('names one picture, a real variant, and may be the pick', () => {
    expect(() => grabSchema.parse({ gameFace: [0, 0, 1, 1] })).toThrow(/one of ref or from/);
    expect(() => grabSchema.parse({ ref: 'r', from: 'a', gameFace: [0, 0, 1, 1] })).toThrow(/one of ref or from/);
    expect(avatarRecipe.parse({ ...base, pick: 'grab', grab: { from: 'a', gameFace: [0, 0, 1, 1] } }).grab!.matte).toEqual({ model: 'birefnet-portrait', feather: 1, threshold: 0.1 });
    expect(() => avatarRecipe.parse({ ...base, grab: { from: 'b', gameFace: [0, 0, 1, 1] } })).toThrow(/grab.from/);
    expect(() => avatarRecipe.parse({ ...base, pick: 'grab' })).toThrow(/pick/);
    expect(() => avatarRecipe.parse({ ...base, variants: [{ ...v, name: 'grab' }] })).toThrow(/grab/);
  });
  it('a krea2 variant takes a prompt and LoRAs only', () => {
    expect(avatarRecipe.parse({ ...base, variants: [{ ...v, model: 'krea2' }] }).variants[0]!.model).toBe('krea2');
    expect(() => avatarRecipe.parse({ ...base, variants: [{ ...v, model: 'krea2', style: { weight: 0.5 } }] })).toThrow(/krea2/);
  });
});

describe('krea2Graph', () => {
  it('UNETLoader -> LoraLoaderModelOnly -> KSampler, CLIPLoader type krea2 and the Qwen-Image VAE from art/models.yaml', () => {
    const models = loadModels(readFileSync(new URL('../../../art/models.yaml', import.meta.url), 'utf8'));
    const m = krea2Models(models);
    expect(m).toEqual({ unet: 'krea2_turbo_fp8.safetensors', textEncoder: 'qwen3vl_4b_fp8_scaled.safetensors', vae: 'qwen_image_vae.safetensors' });
    const job = krea2Graph(m, { seed: 75001, steps: 8, cfg: 1, sampler: 'er_sde', scheduler: 'simple' }, { prompt: 'p', negative: '', denoise: 0.8, loras: [{ file: 'tng.safetensors', strength: 0.7 }] }, 'in.png');
    const nodes = Object.values(job.graph);
    const of = (t: string) => nodes.filter(n => n.class_type === t);
    expect(of('LoraLoaderModelOnly')[0]!.inputs).toMatchObject({ lora_name: 'tng.safetensors', strength_model: 0.7 });
    expect(of('LoraLoader')).toHaveLength(0);
    expect(of('CLIPLoader')[0]!.inputs).toMatchObject({ type: 'krea2' });
    expect(of('KSampler')[0]!.inputs).toMatchObject({ seed: 75001, steps: 8, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple', denoise: 0.8 });
    expect(of('LoadImage')[0]!.inputs).toEqual({ image: 'in.png' });
    expect(job.outputs.image).toBeDefined();
  });
});

describe('grab backdrop and edges', () => {
  it('drops the backdrop pixels next to the figure (its rim lights) before filling the backdrop', () => {
    const g = solid(10, 10, [20, 60, 140]);
    g.data.set([200, 150, 120, 255], (5 * 10 + 5) * 4);
    g.data.set([120, 180, 250, 255], (5 * 10 + 6) * 4); // a pale blue rim beside it
    const out = withoutRims(g, 1);
    expect(px(out, 6, 5)).toEqual([128, 128, 128]);
    expect(px(out, 0, 0)).toEqual([20, 60, 140]);
    expect(px(out, 5, 5)).toEqual([200, 150, 120]);
    expect(withoutRims(solid(3, 3, [200, 150, 120]), 1)).toEqual(solid(3, 3, [200, 150, 120]));
  });
  it('blurs only past the source edge', () => {
    const img = solid(10, 10, [0, 0, 0]);
    for (let x = 0; x < 10; x += 2) img.data.set([255, 255, 255, 255], x * 4); // streaks along the top row
    const a = new Float32Array(100).fill(1);
    softenOutside(img, a, [0, 1, 10, 9], 2);
    expect(px(img, 0, 0)[0]).toBeLessThan(255);
    expect(px(img, 0, 0)[0]).toBeGreaterThan(0);
    expect(px(img, 1, 5)).toEqual([0, 0, 0]);
    expect(a[0]).toBeCloseTo(1);
  });
});

describe('a dark backdrop', () => {
  /** Black all round, a skin face with black hair and a black outline pixel inside it. */
  function darkGame(): Rgba {
    const g = solid(48, 50, [0, 0, 0]);
    for (let y = 10; y < 50; y++) for (let x = 14; x < 34; x++) g.data.set([200, 150, 120, 255], (y * 48 + x) * 4);
    g.data.set([0, 0, 0, 255], (30 * 48 + 20) * 4); // an outline pixel inside the face
    return g;
  }
  it('takes the dark pixels joined to the edge as the backdrop, not the dark ones inside the figure', () => {
    const m = backdropMask(darkGame(), 'dark');
    expect(m[0]).toBe(1);
    expect(m[49 * 48 + 2]).toBe(1);
    expect(m[30 * 48 + 20]).toBe(0);
    expect(m[30 * 48 + 24]).toBe(0);
    // blue finds none in a portrait with no blue
    expect(backdropMask(darkGame(), 'blue').some(v => v === 1)).toBe(false);
    expect(() => gameBackdrop(darkGame(), 10, 1)).toThrow(/no blue backdrop/);
  });
  it('floods a dark grey backdrop from the edge, and takes hair that touches the backdrop with it', () => {
    const g = solid(20, 20, [80, 80, 80]);
    for (let y = 4; y < 20; y++) for (let x = 6; x < 14; x++) g.data.set([200, 150, 120, 255], (y * 20 + x) * 4);
    for (let x = 6; x < 14; x++) g.data.set([10, 10, 10, 255], (3 * 20 + x) * 4); // hair, shut in by the backdrop on the sides only
    const m = backdropMask(g, 'dark');
    expect(m[5 * 20 + 2]).toBe(1);
    expect(m[3 * 20 + 9]).toBe(1); // the hair touches the top edge's backdrop row above it: joined
    expect(m[10 * 20 + 9]).toBe(0);
  });
  it('sets the cut-out over a flat dark backdrop, graded to the figure not the backdrop', () => {
    const g = darkGame();
    const S = 100;
    const fg = solid(S, S, [90, 90, 90]);
    const alpha = new Float32Array(S * S);
    for (let y = 30; y < S; y++) for (let x = 30; x < 70; x++) alpha[y * S + x] = 1;
    const o = grabSchema.parse({ ref: 'r', gameFace: [16, 12, 32, 30], matte: { feather: 0 }, backdrop: 'dark' });
    expect(o.backdrop).toBe('dark');
    const p = finishGrab(fg, alpha, g, o);
    const back = px(p.portrait, 5, 5);
    expect(Math.max(...back)).toBeLessThan(20);
    const skin = px(p.portrait, 50, 60);
    expect(skin[0]!).toBeGreaterThan(skin[2]!);
    // blue stays the default
    expect(grabSchema.parse({ ref: 'r', gameFace: [0, 0, 1, 1] }).backdrop).toBe('blue');
  });
});
