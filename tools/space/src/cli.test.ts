// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { miniCombat } from '@another-unity/engine';
import { makeGif, makeMrg, makePic, makeSpaceMaterials, makeSpaceModel } from '@another-unity/lift/testing/space';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parsePack } from '../../../engine/src/view/indexed';
import { runSpace } from './cli';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A synthetic export (one triangle for every geometry, enterprs.mtl and its texture) and a lifted game with miniCombat's combat.yaml and a stale .glb. */
async function setup(): Promise<{ raw: string; game: string }> {
  const root = await mkdtemp(join(tmpdir(), 'space-'));
  made.push(root);
  const raw = join(root, 'raw');
  const game = join(root, 'game');
  await mkdir(join(raw, 'verbatim'), { recursive: true });
  await mkdir(join(game, 'space'), { recursive: true });
  const combat = miniCombat();
  await writeFile(join(game, 'combat.yaml'), stringify(combat));
  const triangle = makeSpaceModel({ parts: [{ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [{ material: 0, v: [0, 1, 2] }] }] });
  for (const m of Object.values(combat.models)) await writeFile(join(raw, 'verbatim', m.geometry), triangle);
  const hull = makeSpaceMaterials([{ flags: 1, texture: 'HULL.IMG' }]);
  await writeFile(join(raw, 'verbatim', 'mini.mtl'), hull);
  await writeFile(join(raw, 'verbatim', 'enterprs.mtl'), hull);
  await writeFile(join(raw, 'verbatim', 'hull.img'), makeGif(1, 1, [3], Uint8Array.from({ length: 768 }, (_, i) => i % 256)));
  // (tactical's stills: the console in its own (unused) palette, two images, and the warp's background in the palette 1, 2, 3, ...)
  await writeFile(join(raw, 'verbatim', 'spc00a.pic'), makePic(new Uint8Array(768), 9, [128, 129]));
  await writeFile(join(raw, 'verbatim', 'space.mrg'), makeMrg([{ width: 2, height: 1, pixels: [245, 255] }, { width: 1, height: 1, pixels: [13] }]));
  await writeFile(join(raw, 'verbatim', 'cheap.pic'), makePic(Uint8Array.from({ length: 768 }, (_, i) => i % 64), 200));
  await writeFile(join(game, 'space', 'stale.glb'), 'old');
  return { raw, game };
}

const STILLS = ['console.pack', 'space.rgb', 'warp.pack', 'warp.rgb'];

/** A synthetic images export: each sprite's sprite.json and its frames (w x h, frame k filled with colour k + 1), as the export writes them. */
async function images(root: string, sprites: Record<string, { frames: number; w: number; h: number }>): Promise<string> {
  const dir = join(root, 'images-export');
  for (const [file, { frames, w, h }] of Object.entries(sprites)) {
    const at = join(dir, 'images', 'sprites', file);
    await mkdir(at, { recursive: true });
    const entries: Record<string, unknown>[] = [{ type: 'position', x: 320, y: 313 }];
    for (let k = 0; k < frames; k++) {
      const png = new PNG({ width: w, height: h });
      png.data.fill(k + 1);
      const rel = `images/sprites/${file}/${String(k * 2 + 1).padStart(4, '0')}.png`;
      await writeFile(join(dir, rel), PNG.sync.write(png));
      entries.push({ type: 'sprite', width: w, height: h, png: rel }, { type: 'wait', wait: 400 });
    }
    await writeFile(join(at, 'sprite.json'), JSON.stringify({ file, palette: 'space', anims: [0], entries }));
  }
  return dir;
}

describe('runSpace: npm run space (Plan 18 Task 8)', () => {
  it('writes a .glb for every model combat.yaml names, and removes one it no longer names', async () => {
    const { raw, game } = await setup();
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game], l => log.push(l))).toBe(0);
    const want = Object.values(miniCombat().models).map(m => m.url.slice('space/'.length));
    expect((await readdir(join(game, 'space'))).sort()).toEqual([...want, ...STILLS].sort());
    expect(log).toContain('space: no images export (--images, IMAGES_DIR): the combat sprites are left out');
    expect(log.at(-1)).toBe(`space: ${want.length} models, the stills in ${join(game, 'space')}`);
  });

  it('publishes the console in the space palette and the warp\'s background in its own, as indexed packs (Plan 24 Task 3)', async () => {
    const { raw, game } = await setup();
    expect(await runSpace(['--raw', raw, '--game', game], () => {})).toBe(0);
    // (entry 0 the picture, then each of space.mrg's: MRG entry i is pack entry i + 1)
    const pack = parsePack(new Uint8Array(await readFile(join(game, 'space', 'console.pack'))));
    expect(pack.map(e => [e.width, e.height])).toEqual([[640, 480], [2, 1], [1, 1]]);
    expect([...pack[0]!.pixels.subarray(0, 3)]).toEqual([128, 129, 9]);
    expect([...pack[1]!.pixels]).toEqual([245, 255]);
    // (the space palette is hull.img's, the Enterprise's first texture's (tactical.cpp:271-278), not spc00a.pic's zeros)
    const space = new Uint8Array(await readFile(join(game, 'space', 'space.rgb')));
    expect([...space.subarray(0, 6)]).toEqual([0, 1, 2, 3, 4, 5]);
    // (cheap.pic's own, 6-bit shifted left by two)
    const warp = parsePack(new Uint8Array(await readFile(join(game, 'space', 'warp.pack'))));
    expect(warp.map(e => [e.width, e.height, e.pixels[0]])).toEqual([[640, 480, 200]]);
    expect([...new Uint8Array(await readFile(join(game, 'space', 'warp.rgb'))).subarray(0, 4)]).toEqual([0, 4, 8, 12]);
  });

  it('writes the models but fails, saying what to re-export, when the export lacks a still', async () => {
    const { raw, game } = await setup();
    await rm(join(raw, 'verbatim', 'space.mrg'));
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game], l => log.push(l))).toBe(1);
    expect(log).toContain('space: no space.mrg (re-export: sh tools/rawcheck/run-harness.sh export 300)');
    expect(await readdir(join(game, 'space'))).toContain('mini.3dv.glb');
    expect(await readdir(join(game, 'space'))).not.toContain('console.pack');
    expect(await readdir(join(game, 'space'))).toContain('warp.pack');
  });

  it('makes a sheet of every sprite combat.yaml names, its frames in rows of at most 4096 pixels, with their index', async () => {
    const { raw, game } = await setup();
    const combat = { ...miniCombat(), media: { ...miniCombat().media, sprites: ['__boom.spr', 'vwwarped.spr'] } };
    await writeFile(join(game, 'combat.yaml'), stringify(combat));
    const dir = await images(join(game, '..'), { '__boom.spr': { frames: 3, w: 4, h: 2 }, 'vwwarped.spr': { frames: 9, w: 520, h: 3 } });
    await mkdir(join(game, 'space', 'sprites'), { recursive: true });
    await writeFile(join(game, 'space', 'sprites', 'gone.png'), 'old');
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game, '--images', dir], l => log.push(l))).toBe(0);
    expect(log.at(-1)).toMatch(/ and 2 sprite sheets in /);
    expect((await readdir(join(game, 'space', 'sprites'))).sort()).toEqual(['__boom.png', 'vwwarped.png']);
    const index = JSON.parse(await readFile(join(game, 'space', 'sprites.json'), 'utf8'));
    expect(index['__boom.spr']).toMatchObject({ image: 'space/sprites/__boom.png', frames: 3, columns: 3, cell: [4, 2], palette: 'space' });
    // (520-pixel frames: 7 to a row of 4096, so 9 frames are two rows)
    expect(index['vwwarped.spr']).toMatchObject({ frames: 9, columns: 7, cell: [520, 3] });
    // (the entries as the export has them, each frame's picture as its place in the sheet)
    expect(index['__boom.spr'].entries.slice(0, 4)).toEqual([{ type: 'position', x: 320, y: 313 }, { type: 'sprite', width: 4, height: 2, frame: 0 }, { type: 'wait', wait: 400 }, { type: 'sprite', width: 4, height: 2, frame: 1 }]);
    const sheet = PNG.sync.read(await readFile(join(game, 'space', 'sprites', 'vwwarped.png')));
    expect([sheet.width, sheet.height]).toEqual([7 * 520, 2 * 3]);
    // (frame 8, the second row's second, at (520, 3), is filled with 9; the second row has no third frame)
    expect(sheet.data[(3 * sheet.width + 520) * 4]).toBe(9);
    expect(sheet.data[(3 * sheet.width + 2 * 520) * 4]).toBe(0);
  });

  it('numbers only the entries with a picture: a null png in the middle takes no frame number', async () => {
    const { raw, game } = await setup();
    const combat = { ...miniCombat(), media: { ...miniCombat().media, sprites: ['__boom.spr'] } };
    await writeFile(join(game, 'combat.yaml'), stringify(combat));
    const dir = await images(join(game, '..'), { '__boom.spr': { frames: 3, w: 2, h: 2 } });
    const at = join(dir, 'images', 'sprites', '__boom.spr', 'sprite.json');
    const json = JSON.parse(await readFile(at, 'utf8'));
    const i = json.entries.findIndex((e: { type: string }, k: number) => k > 2 && e.type === 'sprite');
    json.entries.splice(i, 0, { type: 'sprite', width: 2, height: 2, png: null });
    await writeFile(at, JSON.stringify(json));
    expect(await runSpace(['--raw', raw, '--game', game, '--images', dir], () => {})).toBe(0);
    const sheet = JSON.parse(await readFile(join(game, 'space', 'sprites.json'), 'utf8'))['__boom.spr'];
    expect(sheet.frames).toBe(3);
    const sprites = sheet.entries.filter((e: { type: string }) => e.type === 'sprite');
    expect(sprites.map((e: { frame?: number }) => e.frame)).toEqual([0, undefined, 1, 2]);
  });

  it('leaves out, and says so, a sprite the images export lacks', async () => {
    const { raw, game } = await setup();
    const combat = { ...miniCombat(), media: { ...miniCombat().media, sprites: ['__boom.spr', 'k_shield.spr'] } };
    await writeFile(join(game, 'combat.yaml'), stringify(combat));
    const dir = await images(join(game, '..'), { '__boom.spr': { frames: 1, w: 2, h: 2 } });
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game, '--images', dir], l => log.push(l))).toBe(1);
    expect(log.some(l => /^space: k_shield\.spr: not in the images export/.test(l))).toBe(true);
    expect(Object.keys(JSON.parse(await readFile(join(game, 'space', 'sprites.json'), 'utf8')))).toEqual(['__boom.spr']);
  });

  it('keeps the last good .glb of a model that fails to build, and says how many failed', async () => {
    const { raw, game } = await setup();
    const models = Object.values(miniCombat().models);
    const first = models[0];
    // (every model drawn from that geometry fails: a .3dv's .dmg model shares it)
    const failing = models.filter(m => m.geometry === first!.geometry).length;
    await writeFile(join(raw, 'verbatim', first!.geometry), 'not a model');
    await writeFile(join(game, first!.url), 'last good');
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game], l => log.push(l))).toBe(1);
    expect(await readFile(join(game, first!.url), 'utf8')).toBe('last good');
    expect(await readdir(join(game, 'space'))).not.toContain('stale.glb');
    expect(log.at(-1)).toMatch(new RegExp(`, ${failing} failed$`));
  });

  it('fails with a space: line, not a stack, without combat.yaml', async () => {
    const { raw, game } = await setup();
    await rm(join(game, 'combat.yaml'));
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game], l => log.push(l))).toBe(1);
    expect(log).toEqual([expect.stringMatching(/^space: .*combat\.yaml/)]);
  });

  it('fails, saying why, without the space palette', async () => {
    const { raw, game } = await setup();
    await rm(join(raw, 'verbatim', 'enterprs.mtl'));
    const log: string[] = [];
    expect(await runSpace(['--raw', raw, '--game', game], l => log.push(l))).toBe(1);
    expect(log.join('\n')).toMatch(/no space palette/);
  });
});
