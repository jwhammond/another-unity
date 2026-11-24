// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng, encodePng, type Rgba } from './image';
import { findKit, publishKit } from './kitpublish';
import { cwebpArgs } from './webp';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

const px = (v: number): Rgba => ({ width: 2, height: 2, data: new Uint8Array(16).fill(v) });
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (webp: string) => decodePng(new Uint8Array(await readFile(webp))) };

async function setup() {
  tmp = await mkdtemp(join(tmpdir(), 'kit-'));
  const src = join(tmp, 'src');
  const game = join(tmp, 'game');
  await mkdir(src);
  await mkdir(game);
  for (const n of ['picard.png', 'picard.grab.png', 'picard.compare.png', 'item.phaser.png', 'item.unknown.png']) await writeFile(join(src, n), encodePng(px(9)));
  return { src, game };
}

describe('findKit', () => {
  it('takes <id>.png and item.<object>.png for the ids it is given, and not the variants and sheets', async () => {
    const { src } = await setup();
    const kit = await findKit(src, ['picard', 'riker'], ['phaser', 'tricorder']);
    expect(Object.keys(kit.portraits)).toEqual(['picard']);
    expect(Object.keys(kit.icons)).toEqual(['phaser']);
  });
});

describe('publishKit', () => {
  it('writes art/avatars and art/icons and records them in presentation.yaml, keeping what was there', async () => {
    const { src, game } = await setup();
    await writeFile(join(game, 'presentation.yaml'), '# header\nart:\n  rooms:\n    lab.s01:\n      plate: art/rooms/lab/s01/plate.webp\n');
    const kit = await findKit(src, ['picard'], ['phaser']);
    const files = await publishKit(game, kit, copyCodec);
    expect(files).toEqual(['art/avatars/picard.webp', 'art/icons/phaser.webp']);
    expect(existsSync(join(game, 'art/avatars/picard.webp'))).toBe(true);
    const text = await readFile(join(game, 'presentation.yaml'), 'utf8');
    expect(text.startsWith('# header')).toBe(true);
    const doc = parse(text);
    expect(doc.art.portraits).toEqual({ picard: 'art/avatars/picard.webp' });
    expect(doc.art.icons).toEqual({ phaser: 'art/icons/phaser.webp' });
    expect(doc.art.rooms['lab.s01'].plate).toBe('art/rooms/lab/s01/plate.webp');
  });

  it('records a portrait under each object that shows it, one file for all of them', async () => {
    const { src, game } = await setup();
    const kit = await findKit(src, ['picard', 'riker'], [], { picard: ['ship.t_bak.0401', 'ship.t_bak.0402'], riker: ['x'] });
    expect(kit.speakers).toEqual({ picard: ['ship.t_bak.0401', 'ship.t_bak.0402'] });
    const files = await publishKit(game, kit, copyCodec);
    expect(files).toEqual(['art/avatars/picard.webp']);
    const doc = parse(await readFile(join(game, 'presentation.yaml'), 'utf8'));
    expect(doc.art.portraits).toEqual({ picard: 'art/avatars/picard.webp', 'ship.t_bak.0401': 'art/avatars/picard.webp', 'ship.t_bak.0402': 'art/avatars/picard.webp' });
    await expect(publishKit(game, { portraits: kit.portraits, icons: {}, speakers: { picard: ['Bad Id'] } }, copyCodec)).rejects.toThrow(/object id/);
  });

  it('refuses a WebP that is not the PNG, and publishes nothing', async () => {
    const { src, game } = await setup();
    const kit = await findKit(src, ['picard'], []);
    const lossy = { ...copyCodec, decode: async () => px(12) };
    await expect(publishKit(game, kit, lossy)).rejects.toThrow(/differs/);
    expect(existsSync(join(game, 'art/avatars/picard.webp'))).toBe(false);
    expect(existsSync(join(game, 'art/avatars/picard.webp.tmp'))).toBe(false);
    expect(existsSync(join(game, 'presentation.yaml'))).toBe(false);
  });
});

describe('cwebpArgs lossless', () => {
  it('is lossless and exact, for hard pixel edges', () => {
    expect(cwebpArgs('a.png', 'a.webp', { quality: 100, lossless: true })).toEqual(['-lossless', '-z', '9', '-exact', '-mt', '-quiet', 'a.png', '-o', 'a.webp']);
  });
});
