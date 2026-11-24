// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexedImage } from '../../../engine/src/view/indexed';
import { artCache, type ArtCache } from './cache';
import type { Models } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import { parseRecipe, type SpaceTexturesRecipe, type SpaceUpscalesRecipe } from './recipe';
import { REPAINTED } from './spaceconsole';
import type { SpaceTextureInfo } from './spaceinventory';
import { checkSilhouettes, gatherSpaceArt, makeTextures, makeUpscales, missingParts, staleParts, upscalesSource } from './spacerun';
import type { SpaceModelArt } from './spacemodel';
import { FakeGenerator } from './testing/fakeGenerator';

const M: Models = { checkpoint: 'ck.safetensors', upscaler: 'up.pth' };
const TEXTURES = `id: space.textures
kind: spacetex
sampling: { seed: 1, steps: 5, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a hull
denoise: 0.3
`;
const pic = (w: number, h: number, v = 120): Rgba => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
const info = (name: string, kinds: number[], effect = false): SpaceTextureInfo => ({ name, picture: pic(8, 8), islands: new Uint8Array(64).fill(1), kinds, effect });

let tmp: string;
let cache: ArtCache;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'art-spacerun-')); cache = artCache({ ART_CACHE: join(tmp, 'cache') }); });
afterEach(() => rm(tmp, { recursive: true, force: true }));
const deps = (g = new FakeGenerator()) => ({ cache, generator: g, models: M, now: () => 1_700_000_000_000, log: () => {} });

describe('combat\'s runs (Plan 30 R8, R11, R12, R14)', () => {
  it('runs each texture once, skips one already made from the same original and recipe, and runs it again when asked', async () => {
    const r = parseRecipe(TEXTURES, '/x/space.textures.yaml') as SpaceTexturesRecipe;
    const textures = new Map([['a.gif', info('a.gif', [2])], ['b.gif', info('b.gif', [0])]]);
    // (8 x 8 is under the smallest side: each the upscale alone, one job)
    const g = new FakeGenerator();
    expect(await makeTextures(r, TEXTURES, textures, deps(g))).toEqual({ repainted: 0, upscaled: 2, skipped: 0 });
    expect(g.jobs.length).toBe(2);
    expect(await makeTextures(r, TEXTURES, textures, deps())).toEqual({ repainted: 0, upscaled: 0, skipped: 2 });
    expect(await makeTextures(r, TEXTURES, textures, deps(), { only: ['b.gif'] })).toEqual({ repainted: 0, upscaled: 1, skipped: 0 });
    const last = JSON.parse(await readFile(join(cache.work, 'tex.space.a.gif', 'last.json'), 'utf8')) as { dir: string; meta: { mode: string; why: string } };
    expect([last.meta.mode, last.meta.why, decodePng(new Uint8Array(await readFile(join(last.dir, 'texture.png')))).width]).toEqual(['upscale', 'small', 32]);
  });

  it('keys each texture on what affects it alone: one texture\'s seed or upscaleOnly entry re-runs that texture (and a damage texture on its base)', async () => {
    const textures = new Map([['a.gif', info('a.gif', [2])], ['a.dmg.gif', { ...info('a.dmg.gif', [2]), base: 'a.gif' }], ['b.gif', info('b.gif', [0])]]);
    const make = (text: string, g = new FakeGenerator()) => makeTextures(parseRecipe(text, '/x/space.textures.yaml') as SpaceTexturesRecipe, text, textures, deps(g));
    expect(await make(TEXTURES)).toEqual({ repainted: 0, upscaled: 3, skipped: 0 });
    // (a comment or a re-ordering changes nothing)
    expect(await make(`# a note\n${TEXTURES}`)).toEqual({ repainted: 0, upscaled: 0, skipped: 3 });
    const seeded = `${TEXTURES}seeds: { a.gif: 5 }\n`;
    expect(await make(seeded)).toEqual({ repainted: 0, upscaled: 2, skipped: 1 });
    const listed = `${seeded}upscaleOnly: [b.gif]\n`;
    expect(await make(listed)).toEqual({ repainted: 0, upscaled: 1, skipped: 2 });
    expect(await make(`${seeded}seeds: { a.gif: 5, a.dmg.gif: 6 }\nupscaleOnly: [b.gif]\n`.replace('seeds: { a.gif: 5 }\n', ''))).toEqual({ repainted: 0, upscaled: 1, skipped: 2 });
    expect(await make(listed.replace('denoise: 0.3', 'denoise: 0.35'))).toEqual({ repainted: 0, upscaled: 3, skipped: 0 });
  });

  it('counts a run keyed on the whole recipe file (before the per-texture key) as made while the file is unchanged, and keeps it made after', async () => {
    const textures = new Map([['a.gif', info('a.gif', [2])], ['b.gif', info('b.gif', [0])]]);
    const make = (text: string) => makeTextures(parseRecipe(text, '/x/space.textures.yaml') as SpaceTexturesRecipe, text, textures, deps());
    for (const name of ['a.gif', 'b.gif']) {
      const dir = join(cache.work, `tex.space.${name}`, 'old');
      await mkdir(dir, { recursive: true });
      const source = createHash('sha256').update(encodePng(textures.get(name)!.picture)).digest('hex');
      await writeFile(join(cache.work, `tex.space.${name}`, 'last.json'), JSON.stringify({ dir, meta: { source, recipe: createHash('sha256').update(TEXTURES).digest('hex') } }));
    }
    expect(await make(TEXTURES)).toEqual({ repainted: 0, upscaled: 0, skipped: 2 });
    // (once counted, it carries the new key, so another texture's seed no longer re-runs it)
    expect(await make(`${TEXTURES}seeds: { a.gif: 5 }\n`)).toEqual({ repainted: 0, upscaled: 1, skipped: 1 });
  });

  it('upscales the effects\' sheets, relaid, and every console picture it doesn\'t repaint, but never the warp overlay\'s', async () => {
    const r = parseRecipe('id: space.upscales\nkind: spaceup\n', '/x/space.upscales.yaml') as SpaceUpscalesRecipe;
    const sheets = new Map([['__boom.spr', { picture: pic(16, 8), frames: 2, columns: 2, cell: [8, 8] as [number, number] }], ['vwwarped.spr', { picture: pic(8, 8), frames: 1, columns: 1, cell: [8, 8] as [number, number] }]]);
    const pictures: IndexedImage[] = Array.from({ length: 138 }, () => ({ width: 2, height: 2, pixels: new Uint8Array(4).fill(130) }));
    const dir = await makeUpscales(r, sheets, pictures, new Uint8Array(768), deps());
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as { layout: Record<string, unknown>; pictures: number };
    expect([meta.layout, meta.pictures]).toEqual([{ '__boom.spr': { columns: 2, cell: [32, 32] } }, 138 - REPAINTED.length]);
    // (what it was made from, for publish's check that it is current)
    expect((meta as { source?: string }).source).toBe(upscalesSource(sheets, pictures, new Uint8Array(768)));
    expect(upscalesSource(sheets, pictures, new Uint8Array(768).fill(1))).not.toBe(upscalesSource(sheets, pictures, new Uint8Array(768)));
  });

  it('gathers each texture into every kind\'s pack that draws it and the effects\' when an effect does, and says which has no run', async () => {
    const save = async (id: string, file: string, img: Rgba) => {
      const dir = join(cache.work, id, 'run');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, file), encodePng(img));
      await writeFile(join(cache.work, id, 'last.json'), JSON.stringify({ dir, meta: {} }));
    };
    await save('tex.space.a.gif', 'texture.png', pic(32, 32));
    await save('tex.space.g.gif', 'texture.png', pic(32, 32));
    await save('tex.nebula-2', 'albedo.png', pic(16, 16));
    const textures = new Map([['a.gif', info('a.gif', [0, 2])], ['g.gif', info('g.gif', [], true)]]);
    const got = await gatherSpaceArt(cache, textures, [], {});
    expect([[...got.kinds.keys()], [...got.kinds.get(0)!.keys()], [...got.effects.textures.keys()], [...got.backdrops.keys()], got.console]).toEqual([[0, 2], ['a.gif'], ['g.gif'], [2], undefined]);
    await expect(gatherSpaceArt(cache, new Map([['z.gif', info('z.gif', [1])]]), [], {})).rejects.toThrow('no run of tex.space.z.gif');
    await save('plate.tactical', 'plate.png', pic(8, 8));
    await expect(gatherSpaceArt(cache, textures, [], {})).rejects.toThrow(/npm run art -- run art\/recipes\/pages\.tactical\.yaml/);
  });
});

describe('the silhouette check over the runs (Plan 30 R10)', () => {
  it('passes a model whose texture\'s run keeps its alpha, and names one whose run doesn\'t', async () => {
    const keyed = pic(2, 2, 255);
    keyed.data[3] = 0;
    const model: SpaceModelArt = {
      triangles: [
        { texture: 'k.gif', material: 0, keyed: true, positions: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], uvs: [[0, 0], [1, 0], [1, 1]] },
        { texture: 'k.gif', material: 0, keyed: true, positions: [[0, 0, 0], [10, 10, 0], [0, 10, 0]], uvs: [[0, 0], [1, 1], [0, 1]] },
      ],
      textures: new Map([['k.gif', keyed]]),
    };
    const run = async (img: Rgba) => {
      const dir = join(cache.work, 'tex.space.k.gif', 'run');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'texture.png'), encodePng(img));
      await writeFile(join(cache.work, 'tex.space.k.gif', 'last.json'), JSON.stringify({ dir, meta: {} }));
    };
    const good = pic(8, 8, 255);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) good.data[(y * 8 + x) * 4 + 3] = 0;
    await run(good);
    expect(await checkSilhouettes(new Map([['m.3dv', model]]), cache, 64)).toEqual({ ok: true, failed: [] });
    await run(pic(8, 8, 255));
    const bad = await checkSilhouettes(new Map([['m.3dv', model]]), cache, 64);
    expect([bad.ok, bad.failed.map(f => f.model), bad.failed[0]!.differ['+z']! > 0]).toEqual([false, ['m.3dv'], true]);
  });
});

describe('what publish needs (Plan 30 R14)', () => {
  it('names each part with no run and the command that makes it, and nothing once all have one', async () => {
    const save = async (id: string) => {
      const dir = join(cache.work, id, 'run');
      await mkdir(dir, { recursive: true });
      await writeFile(join(cache.work, id, 'last.json'), JSON.stringify({ dir, meta: {} }));
    };
    const all = await missingParts(cache);
    expect(all.length).toBe(7);
    expect(all.join('\n')).toMatch(/upscales.*art:space -- upscales/);
    expect(all.join('\n')).toMatch(/tex\.nebula-3/);
    // (the command `npm run art -- run` takes is a recipe's file, not its id)
    for (const id of ['plate.tactical', 'pages.tactical', 'tex.nebula-3']) expect(all.join('\n')).toContain(`npm run art -- run art/recipes/${id}.yaml`);
    expect(all.join('\n')).not.toMatch(/npm run art -- run (?!art\/recipes\/)/);
    for (const id of ['space.upscales', 'plate.tactical', 'pages.tactical', 'tex.nebula-0', 'tex.nebula-1', 'tex.nebula-2']) await save(id);
    expect(await missingParts(cache)).toEqual([expect.stringContaining('tex.nebula-3')]);
    await save('tex.nebula-3');
    expect(await missingParts(cache)).toEqual([]);
  });

  it('names each part made from an original that has since changed, or a texture with no run, and the command to run again', async () => {
    const save = async (id: string, meta: object) => {
      const dir = join(cache.work, id, 'run');
      await mkdir(dir, { recursive: true });
      await writeFile(join(cache.work, id, 'last.json'), JSON.stringify({ dir, meta }));
    };
    const originals = join(cache.root, 'originals', 'space');
    await mkdir(originals, { recursive: true });
    const consolePng = encodePng(pic(4, 4, 10)), pagesPng = encodePng(pic(4, 4, 20)), layout = '[{"image":7,"x":0,"y":0}]';
    await writeFile(join(originals, 'console.png'), consolePng);
    await writeFile(join(originals, 'pages.png'), pagesPng);
    await writeFile(join(originals, 'pages.json'), layout);
    const a = info('a.gif', [2]), b = info('b.gif', [0]), c = info('c.gif', [1]);
    const shaOf = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    await save('tex.space.a.gif', { source: shaOf(encodePng(a.picture)) });
    await save('tex.space.b.gif', { source: shaOf(encodePng(pic(8, 8, 99))) });
    await save('plate.tactical', { source: shaOf(consolePng) });
    await save('pages.tactical', { source: shaOf(pagesPng), layout: shaOf(layout) });
    // (an upscales run from before it recorded its source counts as current)
    await save('space.upscales', { layout: {} });
    const textures = new Map([['a.gif', a], ['b.gif', b], ['c.gif', c]]);
    expect(await staleParts(cache, textures, 'up1')).toEqual([
      'tex.space.b.gif was made from an older original (npm run art:space -- textures)',
      'tex.space.c.gif has no run (npm run art:space -- textures)',
    ]);
    await save('tex.space.b.gif', { source: shaOf(encodePng(b.picture)) });
    await save('tex.space.c.gif', { source: shaOf(encodePng(c.picture)) });
    expect(await staleParts(cache, textures, 'up1')).toEqual([]);
    await save('space.upscales', { layout: {}, source: 'up0' });
    await writeFile(join(originals, 'console.png'), encodePng(pic(4, 4, 11)));
    await writeFile(join(originals, 'pages.json'), '[]');
    expect(await staleParts(cache, textures, 'up1')).toEqual([
      'the upscales were made from older originals (npm run art:space -- upscales)',
      'plate.tactical was made from an older console (npm run art -- run art/recipes/plate.tactical.yaml)',
      'pages.tactical was made from an older pages\' atlas or layout (npm run art -- run art/recipes/pages.tactical.yaml)',
    ]);
  });

  it('fails an --only name that matches no texture', async () => {
    const r = parseRecipe(TEXTURES, '/x/space.textures.yaml') as SpaceTexturesRecipe;
    await expect(makeTextures(r, TEXTURES, new Map([['a.gif', info('a.gif', [2])]]), deps(), { only: ['zz.gif'] })).rejects.toThrow('zz.gif');
  });
});
