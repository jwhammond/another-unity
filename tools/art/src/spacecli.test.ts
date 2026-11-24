// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMBAT_STILLS, SPRITE_INDEX } from '../../../engine/src/view/combat/files';
import { writePack } from '../../../engine/src/view/indexed';
import { artCache } from './cache';
import { decodePng } from './image';
import { runSpaceArt, SPACE_USAGE } from './spacecli';

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'art-space-')); });
afterEach(() => rm(tmp, { recursive: true, force: true }));
const deps = (env: NodeJS.ProcessEnv = {}) => ({ game: join(tmp, 'game'), cache: artCache({ ART_CACHE: join(tmp, 'cache') }), env });

describe('npm run art:space (Plan 30 R2)', () => {
  it('decodes the console in the space palette and lays out the pages\' atlas, from the game\'s space build', async () => {
    await mkdir(join(tmp, 'game', 'space'), { recursive: true });
    const images = Array.from({ length: 138 }, (_, i) => ({ width: i === 0 ? 640 : 8, height: i === 0 ? 480 : 6, pixels: new Uint8Array(i === 0 ? 640 * 480 : 48).fill(i === 0 ? 3 : 130) }));
    await writeFile(join(tmp, 'game', COMBAT_STILLS.console), writePack(images));
    await writeFile(join(tmp, 'game', COMBAT_STILLS.palette), Uint8Array.from({ length: 768 }, (_, k) => k % 256));
    const log: string[] = [];
    expect(await runSpaceArt(['originals'], l => log.push(l), deps())).toBe(0);
    const plate = decodePng(new Uint8Array(await readFile(join(tmp, 'cache', 'originals', 'space', 'console.png'))));
    expect([plate.width, plate.height, ...plate.data.subarray(0, 4)]).toEqual([640, 480, 9, 10, 11, 255]);
    const places = JSON.parse(await readFile(join(tmp, 'cache', 'originals', 'space', 'pages.json'), 'utf8')) as { image: number; width: number }[];
    expect([places.length, places[0]!.width]).toEqual([81, 8]);
    expect(log.at(-1)).toMatch(/81 pictures/);
  });

  it('says what to build without the space build, takes a LAN ComfyUI, and prints its usage', async () => {
    const log: string[] = [];
    expect(await runSpaceArt(['originals'], l => log.push(l), deps())).toBe(1);
    expect(log[0]).toMatch(/npm run unity:build/);
    // (a run may go to the LAN's ComfyUI: comfy.ts checkComfyUrl refuses any host off the local network)
    expect(await runSpaceArt(['textures'], l => log.push(l), deps({ COMFY_URL: 'http://10.0.0.2:8188' }))).not.toBe(2);
    expect(log.some(l => /COMFY_URL/.test(l))).toBe(false);
    expect(await runSpaceArt(['check'], l => log.push(l), deps({ COMFY_URL: 'http://10.0.0.2:8188' }))).toBe(1);
    expect(log.at(-1)).toMatch(/lift the game first/);
    expect(await runSpaceArt([], l => log.push(l), deps())).toBe(2);
    expect(log.at(-1)).toBe(SPACE_USAGE);
  });

  it('says to build the space first when the console pack, palette or sprite index is missing, not a raw ENOENT', async () => {
    const log: string[] = [];
    await mkdir(join(tmp, 'game'), { recursive: true });
    await writeFile(join(tmp, 'game', 'combat.yaml'), '');
    for (const cmd of ['upscales', 'publish']) expect(await runSpaceArt([cmd], l => log.push(l), deps())).toBe(1);
    expect(log.every(l => /npm run unity:build/.test(l))).toBe(true);
  });

  it('refuses to publish while a part has no run, saying what to run, with presentation.yaml untouched', async () => {
    const game = join(tmp, 'game');
    await mkdir(join(game, 'space'), { recursive: true });
    await writeFile(join(game, COMBAT_STILLS.console), writePack([{ width: 2, height: 2, pixels: new Uint8Array(4) }]));
    await writeFile(join(game, COMBAT_STILLS.palette), new Uint8Array(768));
    await writeFile(join(game, SPRITE_INDEX), '{}');
    await writeFile(join(game, 'combat.yaml'), '');
    const before = 'art:\n  rooms: {}\n';
    await writeFile(join(game, 'presentation.yaml'), before);
    const log: string[] = [];
    expect(await runSpaceArt(['publish'], l => log.push(l), deps())).toBe(1);
    expect(log.join('\n')).toMatch(/not published: no run of .*npm run art -- run art\/recipes\/plate\.tactical\.yaml/);
    expect(log.join('\n')).toMatch(/npm run art:space -- upscales/);
    expect(await readFile(join(game, 'presentation.yaml'), 'utf8')).toBe(before);
  });
});
