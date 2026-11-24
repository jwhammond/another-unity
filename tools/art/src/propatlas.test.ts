// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packAtlas } from './atlas';
import { decodePng, type Rgba } from './image';
import { encodePages, publishPropAtlas } from './propatlas';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'propatlas-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const page = (c: number): Rgba => {
  const p: Rgba = { width: 4, height: 4, data: new Uint8Array(64) };
  for (let i = 0; i < 16; i++) p.data.set([c, c, c, 255], i * 4);
  return p;
};

describe('encodePages', () => {
  it('stops at lossy when the pixels it publishes pass, naming the file of each page', async () => {
    const dir = await tmp();
    const modes: string[] = [];
    const r = await encodePages([page(10), page(20)], dir, '4', d => ({ ok: d.length === 2 }), {
      encode: async (png, out, mode) => { modes.push(mode); await writeFile(out, await readFile(png)); },
      decode: async f => decodePng(new Uint8Array(await readFile(f.replace('.webp', '.webp')))),
    });
    expect(r).toMatchObject({ ok: true, mode: 'lossy' });
    expect(modes).toEqual(['lossy', 'lossy']);
    if (r.ok) expect(r.files.map(f => f.slice(dir.length + 1))).toEqual(['4.0.webp', '4.1.webp']);
  });

  it('climbs lossy, near-lossless, lossless as the check fails, and never relaxes it', async () => {
    const dir = await tmp();
    const tried: string[] = [];
    let current = '';
    const r = await encodePages([page(10)], dir, '0', () => ({ ok: current === 'lossless', why: `${current} is off` }), {
      encode: async (png, out, mode) => { current = mode; tried.push(mode); await writeFile(out, await readFile(png)); },
      decode: async f => decodePng(new Uint8Array(await readFile(f))),
    });
    expect(tried).toEqual(['lossy', 'near-lossless', 'lossless']);
    expect(r).toMatchObject({ ok: true, mode: 'lossless' });
  });

  it('fails, with the last reason, when even lossless fails the check', async () => {
    const dir = await tmp();
    const r = await encodePages([page(10)], dir, '0', () => ({ ok: false, why: 'speckle' }), {
      encode: async (png, out) => { await writeFile(out, await readFile(png)); },
      decode: async f => decodePng(new Uint8Array(await readFile(f))),
    });
    expect(r).toEqual({ ok: false, why: 'speckle (even lossless)' });
  });
});

describe('publishPropAtlas', () => {
  it('copies the pages as <anim>.<n>.webp, writes the record, and clears what an earlier publish left', async () => {
    const game = await tmp();
    const cards = join(game, 'art', 'cards', 'x_y');
    await mkdir(cards, { recursive: true });
    for (const f of ['4.webp', '4.2.webp', '5.webp']) await writeFile(join(cards, f), 'old');
    const src = await tmp();
    await writeFile(join(src, 'p0'), 'page0');
    await writeFile(join(src, 'p1'), 'page1');
    const cell = (c: number): Rgba => ({ width: 4, height: 4, data: new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : c)) });
    const { atlas } = packAtlas([cell(1), cell(2)]);
    const out = await publishPropAtlas(game, 'x_y', 4, [join(src, 'p0'), join(src, 'p1')], atlas, [0, 1, 1, 0]);
    expect(out.images).toEqual(['art/cards/x_y/4.0.webp', 'art/cards/x_y/4.1.webp']);
    expect((await readdir(cards)).sort()).toEqual(['4.0.webp', '4.1.webp', '4.json', '5.webp']);
    expect(await readFile(join(cards, '4.1.webp'), 'utf8')).toBe('page1');
    expect(JSON.parse(await readFile(join(cards, '4.json'), 'utf8'))).toMatchObject({ frames: 4, of: [0, 1, 1, 0], atlas: { images: out.images, cells: atlas.cells } });
  });
});
