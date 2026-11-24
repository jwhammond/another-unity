// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseImagePack } from '../../../engine/src/view/imagePack';
import { parsePresentation } from '../../../engine/src/view/package';
import { decodePng, type Rgba } from './image';
import type { WebpMode } from './publish';
import { publishSpaceArt, type SpaceArtInputs } from './spacepublish';

const pic = (w: number, h: number, alpha = 255): Rgba => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(alpha) });
let game: string;
beforeEach(async () => { game = await mkdtemp(join(tmpdir(), 'spacepublish-')); });
afterEach(async () => { await rm(game, { recursive: true, force: true }); });

/** A stand-in cwebp that writes the PNG as it is, but loses one alpha value in lossy mode (as a lossy alpha would). */
const deps = (modes: WebpMode[]) => ({
  encode: async (png: string, out: string, mode: WebpMode = 'lossy') => { modes.push(mode); await copyFile(png, out); },
  decode: async (webp: string) => {
    const img = decodePng(new Uint8Array(await readFile(webp)));
    if (modes.at(-1) === 'lossy' && img.data[3] === 0) img.data[3] = 1;
    return img;
  },
});

const inputs = (): SpaceArtInputs => {
  const keyed = pic(8, 8);
  keyed.data[3] = 0;
  return {
    kinds: new Map([[2, new Map([['hull.gif', pic(8, 4)], ['keyed.gif', keyed]])], [0, new Map([['hull.gif', pic(8, 4)]])]]),
    effects: { textures: new Map([['shield.gif', pic(4, 4)]]), sheets: new Map([['__boom.spr', { picture: pic(16, 8), columns: 2, cell: [8, 8] as [number, number] }]]) },
    console: { plate: pic(16, 12), images: new Map([[7, pic(4, 4)], [115, pic(4, 8)]]), scale: 4, areas: { view: [319, 23, 320, 220], radar: [5, 21, 310, 275] } },
    backdrops: new Map([[0, pic(8, 8)], [3, pic(8, 8)]]),
  };
};

describe('publishing combat\'s art (Plan 30 R14)', () => {
  it('writes a pack per kind, the effects\' pack, the console\'s plate, half and pack, and the backdrops, and records art.space', async () => {
    const files = await publishSpaceArt(game, inputs(), deps([]));
    expect(files).toEqual([
      'art/space/kind0.pack', 'art/space/kind2.pack', 'art/space/effects.pack', 'art/space/console/plate.webp', 'art/space/console/plate.half.webp',
      'art/space/console.pack', 'art/space/backdrop/plate0.webp', 'art/space/backdrop/plate3.webp',
    ]);
    const kind2 = parseImagePack(new Uint8Array(await readFile(join(game, 'art/space/kind2.pack'))));
    expect(kind2.map(e => [e.name, e.width, e.height, e.type])).toEqual([['tex:hull.gif', 8, 4, 'image/webp'], ['tex:keyed.gif', 8, 8, 'image/webp']]);
    const effects = parseImagePack(new Uint8Array(await readFile(join(game, 'art/space/effects.pack'))));
    expect(effects.map(e => [e.name, e.meta ?? null])).toEqual([['tex:shield.gif', null], ['sheet:__boom.spr', { columns: 2, cell: [8, 8] }]]);
    const presentation = parsePresentation(await readFile(join(game, 'presentation.yaml'), 'utf8'));
    expect(presentation.art.space).toEqual({
      kinds: { 0: 'art/space/kind0.pack', 2: 'art/space/kind2.pack' }, effects: 'art/space/effects.pack',
      console: { plate: 'art/space/console/plate.webp', half: 'art/space/console/plate.half.webp', pack: 'art/space/console.pack', scale: 4, areas: { view: [319, 23, 320, 220], radar: [5, 21, 310, 275] } },
      backdrops: ['art/space/backdrop/plate0.webp', 'art/space/backdrop/plate3.webp'],
    });
    expect((parseYaml(await readFile(join(game, 'presentation.yaml'), 'utf8')) as { art: object }).art).toHaveProperty('space');
  });

  it('never publishes a changed alpha: a keyed texture whose lossy WebP moved it goes near-lossless', async () => {
    const modes: WebpMode[] = [];
    const only = inputs();
    only.kinds = new Map([[2, new Map([['keyed.gif', only.kinds.get(2)!.get('keyed.gif')!]])]]);
    only.effects = { textures: new Map(), sheets: new Map() };
    delete only.console;
    only.backdrops = new Map();
    await publishSpaceArt(game, only, deps(modes));
    expect(modes).toEqual(['lossy', 'near-lossless']);
  });

  it('zeroes the colour under clear pixels before encoding, so a lossy WebP (which rewrites it) passes its check; the alpha is kept', async () => {
    // (a coloured picture with a clear rectangle over coloured content, as clearView and cutPicture leave it)
    const plate = pic(16, 12);
    for (let i = 0; i < plate.data.length; i += 4) plate.data.set([200, 120, 40, 255], i);
    for (let y = 2; y < 8; y++) for (let x = 4; x < 12; x++) plate.data[(y * 16 + x) * 4 + 3] = 0;
    const modes: WebpMode[] = [];
    let encoded: Rgba | undefined;
    const lossyRewrites = {
      encode: async (png: string, out: string, mode: WebpMode = 'lossy') => {
        modes.push(mode);
        encoded ??= decodePng(new Uint8Array(await readFile(png)));
        await copyFile(png, out);
      },
      // (cwebp without -exact rewrites the colour of clear pixels in lossy and near-lossless modes)
      decode: async (webp: string) => {
        const img = decodePng(new Uint8Array(await readFile(webp)));
        if (modes.at(-1) !== 'lossless') for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 0) img.data.set([0, 0, 0], i);
        return img;
      },
    };
    await publishSpaceArt(game, { kinds: new Map(), effects: { textures: new Map(), sheets: new Map() }, console: { plate, images: new Map(), scale: 4, areas: {} }, backdrops: new Map() }, lossyRewrites);
    expect(modes).not.toContain('near-lossless');
    expect(modes).not.toContain('lossless');
    for (let i = 3; i < plate.data.length; i += 4) expect(encoded!.data[i]).toBe(plate.data[i]);
    const clear = (3 * 16 + 5) * 4;
    expect([...encoded!.data.subarray(clear, clear + 4)]).toEqual([0, 0, 0, 0]);
    expect([...encoded!.data.subarray(0, 4)]).toEqual([200, 120, 40, 255]);
  });

  it('refuses a pack over the deploy\'s file limit, before presentation.yaml', async () => {
    await expect(publishSpaceArt(game, inputs(), { ...deps([]), maxBytes: 64 })).rejects.toThrow(/kind0\.pack would be .* MiB, over 0 MiB a file/);
    await expect(readFile(join(game, 'presentation.yaml'), 'utf8')).rejects.toThrow();
  });

  it('stops before presentation.yaml when a picture can\'t be encoded, naming it', async () => {
    const failing = { encode: async () => { throw new Error('no cwebp'); }, decode: async () => pic(1, 1) };
    await expect(publishSpaceArt(game, inputs(), failing)).rejects.toThrow('no cwebp');
    await expect(readFile(join(game, 'presentation.yaml'), 'utf8')).rejects.toThrow();
  });
});
