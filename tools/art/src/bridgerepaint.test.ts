// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFixups, blendFace, cardFor, crewRepaint, faceBox, faceCard, holdStill, paintText, recipeRepaint } from './bridgerepaint';
import type { ArtCache } from './cache';
import type { Generator, Job } from './generator';
import type { Models } from './graphs';
import { encodePng } from './image';
import type { ModelsFile } from './models';
import type { CrewFrame } from './bridgeanim';
import type { Rgba } from './image';
import { rgbToLab } from './portrait';
import { recipeSchema, type BridgeCrewRecipe } from './recipe';

const solid = (w: number, h: number, rgb: [number, number, number], a = 255): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, a], i * 4);
  return { width: w, height: h, data };
};
const px = (img: Rgba, x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('holdStill', () => {
  // (two 40x8 frames at scale 4, so 10x2 original pixels at one place; the second differs from the first in its left 8 upscaled columns only)
  const up0 = solid(40, 8, [100, 100, 100]);
  const up1 = solid(40, 8, [100, 100, 100]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) up1.data.set([200, 50, 50], (y * 40 + x) * 4);
  const frames: CrewFrame[] = [{ png: up0, dx: 5, dy: 2 }, { png: up1, dx: 5, dy: 2 }];
  const rep0 = solid(40, 8, [10, 20, 30]);
  const rep1 = solid(40, 8, [90, 80, 70]);

  it('takes the first frame\'s repaint where a frame is still, feathered in from where it moved', () => {
    const [a, b] = holdStill(frames, [rep0, rep1], 4, { tolerance: 6, feather: 12 });
    expect(a).toBe(rep0);
    // (the moved part keeps its own repaint; 12 px past it, the first frame's; between, a blend)
    expect(px(b!, 3, 4)).toEqual([90, 80, 70, 255]);
    expect(px(b!, 30, 4)).toEqual([10, 20, 30, 255]);
    const mid = px(b!, 12, 4);
    expect(mid[0]).toBeLessThan(90);
    expect(mid[0]).toBeGreaterThan(10);
  });

  it('keeps each frame\'s own alpha, and holds nothing when off', () => {
    const clear = solid(40, 8, [0, 0, 0], 0);
    const [, b] = holdStill(frames, [rep0, { ...rep1, data: new Uint8Array(rep1.data) }], 4, { tolerance: 6, feather: 12 });
    for (let p = 3; p < b!.data.length; p += 4) expect(b!.data[p]).toBe(255);
    expect(holdStill(frames, [rep0, rep1], 4, { tolerance: 6, feather: 0 })[1]).toBe(rep1);
    // (a frame where the first is clear has nothing to hold)
    expect(holdStill([{ png: clear, dx: 5, dy: 2 }, frames[1]!], [clear, rep1], 4, { tolerance: 6, feather: 12 })[1]).toBe(rep1);
  });

  it('holds a frame on the earlier frame it has most in common with, as held', () => {
    // (frame 2 is frame 1 again, so it takes frame 1's held repaint where frame 1 differs from frame 0)
    const rep2 = solid(40, 8, [50, 50, 50]);
    const [, b, c] = holdStill([...frames, { png: up1, dx: 5, dy: 2 }], [rep0, rep1, rep2], 4, { tolerance: 6, feather: 12 });
    expect(px(c!, 3, 4)).toEqual(px(b!, 3, 4));
    expect(px(c!, 30, 4)).toEqual(px(b!, 30, 4));
  });

  it('matches the frames by their place from the origin, not their corners', () => {
    // (the second frame is one original pixel to the right: its column x is the first's x + 4)
    const shifted = solid(40, 8, [100, 100, 100]);
    const rep = solid(40, 8, [90, 80, 70]);
    const base = solid(40, 8, [10, 20, 30]);
    for (let y = 0; y < 8; y++) base.data.set([1, 2, 3, 255], (y * 40 + 36) * 4);
    const [, b] = holdStill([{ png: up0, dx: 5, dy: 2 }, { png: shifted, dx: 6, dy: 2 }], [base, rep], 4, { tolerance: 6, feather: 1 });
    // (its x 32 is the first frame's 36; its last 4 columns are past the first frame, so its own)
    expect(px(b!, 32, 4)).toEqual([1, 2, 3, 255]);
    expect(px(b!, 37, 4)).toEqual([90, 80, 70, 255]);
  });
});

describe('the bridge crew recipe', () => {
  const text = `id: bridgecrew.data
kind: bridgecrew
object: data
sprite: brdgdata.spr
sampling: { seed: 1, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: a man
denoise: 0.35
lineart: { strength: 0.7 }
hold: { tolerance: 6, feather: 12 }
`;
  it('parses, with a hold, and paints as a card of one frame a canvas', () => {
    const r = recipeSchema.parse(parseYaml(text)) as BridgeCrewRecipe;
    expect(r.kind).toBe('bridgecrew');
    expect(r.hold).toEqual({ tolerance: 6, feather: 12 });
    const c = cardFor(r);
    expect(c.group).toBe(1);
    expect(c.model).toBe('sdxl');
    expect(c.denoise).toBe(0.35);
  });

  it('keys a paint on what paints it: not the comments, the hold or the head pass', () => {
    const tried = text.replace('feather: 12', 'feather: 20');
    expect(paintText(`# a note\n${tried}`)).toBe(paintText(text));
    expect(paintText(`${text}face: { denoise: 0.4 }\n`)).toBe(paintText(text));
    expect(paintText(text.replace('denoise: 0.35', 'denoise: 0.4'))).not.toBe(paintText(text));
  });
});

describe('the head pass', () => {
  // (a 40x100 figure, opaque from row 10: its head box is the top 22% of that, 20 rows, as wide as the figure there, grown 10% each side)
  const figure = (): Rgba => {
    const f = solid(60, 120, [0, 0, 0], 0);
    for (let y = 10; y < 110; y++) for (let x = 10; x < 50; x++) f.data.set([100, 100, 100, 255], (y * 60 + x) * 4);
    return f;
  };

  it('crops the head box grown by its pad, square, inside the frame', () => {
    const b = faceBox(figure(), 0.25)!;
    // (the head box: x 6-54, rows 10-32: 48 wide, so a 72 px square about its centre, pushed inside the 60 px frame)
    expect(b.w).toBe(60);
    expect(b.h).toBe(72);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(faceBox(solid(10, 10, [0, 0, 0], 0), 0.3)).toBeNull();
  });

  it('blends the head back with full weight inside and none at an inner edge, keeping the alpha', () => {
    const f = figure();
    const head = solid(20, 20, [200, 0, 0]);
    const out = blendFace(f, head, { x: 20, y: 20, w: 20, h: 20 }, 0.25);
    expect(px(out, 30, 30)).toEqual([200, 0, 0, 255]);
    expect(px(out, 20, 30)[0]).toBeLessThan(110);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 0]);
    for (let p = 3; p < out.data.length; p += 4) expect(out.data[p]).toBe(f.data[p]);
  });

  it('paints the head with the face references alone, over the whole crop, at its own denoise', () => {
    const r = recipeSchema.parse(parseYaml(`id: bridgecrew.data
kind: bridgecrew
object: data
sprite: brdgdata.spr
sampling: { seed: 1, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: a man
denoise: 0.35
reference:
  - { refs: [a, b], model: face, weight: 0.9, mask: head }
  - { refs: [c], model: style, weight: 0.4, mask: figure }
face: { denoise: 0.45, weight: 1.1 }
`)) as BridgeCrewRecipe;
    const c = faceCard(r, r.face!);
    expect(c.denoise).toBe(0.45);
    expect(c.reference).toEqual([expect.objectContaining({ refs: ['a', 'b'], model: 'face', weight: 1.1, mask: 'figure' })]);
  });
});

describe('fixups', () => {
  // (animation 2 plays distinct frames 1 then 0; frame 0 of it (distinct 1) sits one original pixel (4 upscaled) right of frame 1 (distinct 0),
  // so its cell's left edge is distinct 0's: the cell's x is the target's x + 4 and the source's x)
  const source = (): Rgba => {
    const a = solid(16, 8, [10, 20, 30]);
    for (let i = 0; i < 16 * 8; i++) a.data[i * 4] = i % 16;   // the source's red is its column
    return a;
  };
  const played = [{ anim: 0, frames: [0] }, { anim: 2, frames: [1, 0] }];

  it('a fixup copies colour from the named frame, alpha unchanged, feathered at the box edge', () => {
    const a = source();
    const b = solid(16, 8, [200, 0, 0], 128);
    const frames: CrewFrame[] = [{ png: a, dx: 2, dy: 2 }, { png: b, dx: 3, dy: 2 }];
    const out = applyFixups(frames, [a, b], 4, [{ anim: 2, frame: 0, box: [4, 0, 8, 8], from: 1 }], played);
    expect(out[0]).toBe(a);
    expect(px(out[1]!, 3, 3)).toEqual([7, 20, 30, 128]);        // inside: the source's colour (cell x 7)
    expect(px(out[1]!, 0, 3)).toEqual([135, 7, 10, 128]);       // the edge: a third of the way (cell x 4)
    expect(px(out[1]!, 1, 3)).toEqual([70, 13, 20, 128]);       // two thirds (cell x 5)
    expect(px(out[1]!, 8, 3)).toEqual([200, 0, 0, 128]);        // outside the box
    expect(px(b, 3, 3)).toEqual([200, 0, 0, 128]);              // the paint itself is left as it came
  });

  it('keeps the target where the source is clear, and refuses a fixup that changes nothing or names no frame', () => {
    const a = source();
    for (let y = 0; y < 8; y++) a.data[(y * 16 + 7) * 4 + 3] = 0;   // the source's column 7 is clear
    const b = solid(16, 8, [200, 0, 0]);
    const frames: CrewFrame[] = [{ png: a, dx: 2, dy: 2 }, { png: b, dx: 3, dy: 2 }];
    const out = applyFixups(frames, [a, b], 4, [{ anim: 2, frame: 0, box: [4, 0, 8, 8], from: 1 }], played);
    expect(px(out[1]!, 3, 3)).toEqual([200, 0, 0, 255]);
    expect(px(out[1]!, 4, 3)).toEqual([8, 20, 30, 255]);
    expect(() => applyFixups(frames, [a, b], 4, [{ anim: 2, frame: 0, box: [40, 40, 4, 4], from: 1 }], played, 'bridgecrew.data')).toThrow(/bridgecrew\.data: fixup for animation 2 frame 0 changes nothing/);
    expect(() => applyFixups(frames, [a, b], 4, [{ anim: 2, frame: 5, box: [0, 0, 1, 1], from: 1 }], played)).toThrow(/2 frames/);
  });

  it('a tone fixup matches the box\'s lightness and colour to the source\'s, alpha unchanged', () => {
    // (a green-yellow face with a violet stripe against a neighbour's beige one, drawn in another pose: two columns of shadow, not one)
    const tinted = solid(16, 8, [190, 200, 120], 200);
    const near = solid(16, 8, [200, 185, 165]);
    for (let y = 0; y < 8; y++) {
      tinted.data.set([150, 130, 170], (y * 16 + 5) * 4);
      for (const x of [9, 10]) near.data.set([120, 105, 90], (y * 16 + x) * 4);
    }
    const frames: CrewFrame[] = [{ png: tinted, dx: 2, dy: 2 }, { png: near, dx: 2, dy: 2 }];
    const out = applyFixups(frames, [tinted, near], 4, [{ anim: 0, frame: 0, box: [0, 0, 16, 8], from: 1, mode: 'tone' }], [{ anim: 0, frames: [0, 1] }]);
    const mean = (img: Rgba): number[] => {
      const s = [0, 0, 0];
      for (let y = 3; y < 5; y++) for (let x = 3; x < 13; x++) { const l = rgbToLab(...(px(img, x, y).slice(0, 3) as [number, number, number])); for (let c = 0; c < 3; c++) s[c]! += l[c]! / 20; }
      return s;
    };
    const [L, a, b] = mean(out[0]!);
    const [L1, a1, b1] = mean(near);
    expect(Math.abs(a - a1)).toBeLessThan(2);
    expect(Math.abs(b - b1)).toBeLessThan(2);
    expect(Math.abs(L - L1)).toBeLessThan(10);
    expect(px(out[0]!, 6, 3)).toEqual([...px(out[0]!, 6, 3).slice(0, 3), 200]);
    const stripe = rgbToLab(...(px(out[0]!, 5, 3).slice(0, 3) as [number, number, number]));
    expect(stripe[2]).toBeGreaterThan(0);                       // the violet stripe is no longer blue
  });
});

describe('paintText with blocks', () => {
  it('drops face, hold and checks written as indented blocks, as on one line', () => {
    const one = 'id: bridgecrew.data\nprompt: a man\nhold: { tolerance: 20, feather: 12 }\nface: { denoise: 0.4 }\nchecks: { flickerMax: 12 }\ndenoise: 0.38\n';
    const block = 'id: bridgecrew.data\nprompt: a man\nhold:\n  tolerance: 20\n  feather: 12\nface:\n  denoise: 0.4\nchecks:\n  flickerMax: 12\ndenoise: 0.38\n';
    expect(paintText(block)).toBe(paintText(one));
    expect(paintText(block)).toBe('id: bridgecrew.data\nprompt: a man\ndenoise: 0.38');
    // (a folded prompt's own indented lines stay)
    expect(paintText('prompt: >-\n  a man\n  seated\nhold:\n  feather: 1\n')).toBe('prompt: >-\n  a man\n  seated');
    // (and fixups, as an indented list or one at the key's own indent)
    expect(paintText(`${one}fixups:\n  - { anim: 2, frame: 1, box: [1, 2, 3, 4], from: 0 }\n`)).toBe(paintText(one));
    expect(paintText(`${one}fixups:\n- { anim: 2, frame: 1, box: [1, 2, 3, 4], from: 0 }\nseed: 3\n`)).toBe(`${paintText(one)}\nseed: 3`);
  });
});

describe('crewRepaint and recipeRepaint', () => {
  const RECIPE = `id: bridgecrew.data
kind: bridgecrew
object: data
sprite: brdgdata.spr
sampling: { seed: 1, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: a man
denoise: 0.35
hold: { tolerance: 6, feather: 12 }
`;
  const fakeGenerator = (): Generator & { inputs: string[][] } => {
    const grey = encodePng(solid(1024, 1024, [90, 90, 90]));
    const g = {
      inputs: [] as string[][],
      run: async (job: Job) => {
        g.inputs.push(Object.keys(job.inputs));
        return { image: grey };
      },
      info: async () => ({ comfyui: 'fake', torch: 'fake', device: 'cpu', vramTotal: 0 }),
      nodeTypes: async () => new Set<string>(),
    };
    return g;
  };
  // (a 40x80 figure in a 48x96 frame, 4x)
  const figure = (): CrewFrame => {
    const f = solid(48, 96, [0, 0, 0], 0);
    for (let y = 8; y < 88; y++) for (let x = 4; x < 44; x++) f.data.set([150, 120, 100, 255], (y * 48 + x) * 4);
    return { png: f, dx: 6, dy: 24 };
  };
  const models: Models = { checkpoint: 'c.safetensors', upscaler: 'u.pth' };
  const deps = (text: string, dir: string, g: Generator) => ({ generator: g, models, recipe: recipeSchema.parse(parseYaml(text)) as BridgeCrewRecipe, refs: [], key: paintText(text), dir, scale: 4 });

  it('paints a frame once and then reuses it; the hold and the gate repaint nothing; the head pass has its own key; uploads carry the stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-repaint-'));
    try {
      const g = fakeGenerator();
      const r = crewRepaint(deps(RECIPE, dir, g));
      const [out] = await r.paint([figure()]);
      expect(g.inputs.length).toBe(1);
      expect(g.inputs[0]!.every(n => n.includes(`bridge-data-${process.pid}`))).toBe(true);
      for (let p = 3; p < out!.data.length; p += 4) expect(out!.data[p]).toBe(figure().png.data[p]);
      // (a cache hit: nothing painted)
      await r.paint([figure()]);
      expect(g.inputs.length).toBe(1);
      // (another hold and other checks: the same paints, nothing painted)
      const held = RECIPE.replace('hold: { tolerance: 6, feather: 12 }', 'hold: { tolerance: 20, feather: 4 }\nchecks: { flickerMax: 10 }');
      await crewRepaint(deps(held, dir, g)).paint([figure()]);
      expect(g.inputs.length).toBe(1);
      // (a head pass: the body from the cache, the head painted once, then cached too)
      const faced = `${RECIPE}face: { denoise: 0.4 }\n`;
      await crewRepaint(deps(faced, dir, g)).paint([figure()]);
      expect(g.inputs.length).toBe(2);
      await crewRepaint(deps(faced.replace('denoise: 0.4 }', 'denoise: 0.4, pad: 0.3 }'), dir, g)).paint([figure()]);
      expect(g.inputs.length).toBe(2);
      await crewRepaint(deps(faced.replace('denoise: 0.4 }', 'denoise: 0.45 }'), dir, g)).paint([figure()]);
      expect(g.inputs.length).toBe(3);
      // (a change to what paints the body paints it again)
      await crewRepaint(deps(RECIPE.replace('denoise: 0.35', 'denoise: 0.4'), dir, g)).paint([figure()]);
      expect(g.inputs.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixups don\'t repaint, and are applied before the hold', async () => {
    // (two frames painted 90 and 150 grey: frame 0 takes a box from frame 1, and frame 1, the same as frame 0 but for a corner, is held on it)
    const dir = mkdtempSync(join(tmpdir(), 'bridge-fixups-'));
    try {
      let n = 0;
      const g = { ...fakeGenerator(), run: async (_job: Job) => ({ image: encodePng(solid(1024, 1024, n++ ? [150, 150, 150] : [90, 90, 90])) }) };
      const f0 = figure();
      const f1 = figure();
      for (let y = 80; y < 88; y++) for (let x = 36; x < 44; x++) f1.png.data.set([20, 200, 20, 255], (y * 48 + x) * 4);
      const played = [{ anim: 0, frames: [0, 1] }];
      const [plain0, plain1] = await crewRepaint(deps(RECIPE, dir, g)).paint([f0, f1], played);
      expect(n).toBe(2);
      const fixed = `${RECIPE}fixups:\n  - { anim: 0, frame: 0, box: [8, 16, 16, 16], from: 1 }\n`;
      const [out0, out1] = await crewRepaint(deps(fixed, dir, g)).paint([f0, f1], played);
      expect(n).toBe(2);
      // (inside the box frame 0 shows frame 1's paint, 150; frame 1, held on frame 0 there, shows the fixed one: the fix-up came first)
      expect(px(plain0!, 16, 24)).toEqual([90, 90, 90, 255]);
      expect(px(plain1!, 16, 24)).toEqual([90, 90, 90, 255]);
      expect(px(out0!, 16, 24)).toEqual([150, 150, 150, 255]);
      expect(px(out1!, 16, 24)).toEqual(px(out0!, 16, 24));
      expect(px(out1!, 16, 60)).toEqual(px(plain0!, 16, 60));    // outside it, frame 1 is held on frame 0's 90
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates on the recipe\'s absolute limits, with no flicker ratio', () => {
    const r = crewRepaint(deps(`${RECIPE}checks: { flickerMax: 10, deltaE: 9 }\n`, '/nonexistent', fakeGenerator()));
    expect(r.checks).toEqual({ flickerRatio: Infinity, flickerMax: 10, deltaE: 9 });
    expect(crewRepaint(deps(RECIPE, '/nonexistent', fakeGenerator())).checks).toEqual({ flickerRatio: Infinity, flickerMax: 12, deltaE: 12 });
  });

  it('finds no repaint for an object with no recipe, and refuses a recipe for another object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-recipes-'));
    try {
      const d = { generator: fakeGenerator(), models: {} as ModelsFile, cache: {} as ArtCache, scale: 4 };
      expect(await recipeRepaint(dir, 'data', d)).toBeUndefined();
      writeFileSync(join(dir, 'bridgecrew.worf.yaml'), RECIPE.replace('id: bridgecrew.data', 'id: bridgecrew.worf'));
      await expect(recipeRepaint(dir, 'worf', d)).rejects.toThrow(/not the bridge crew recipe for worf/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
