// SPDX-License-Identifier: GPL-3.0-or-later
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { miniCombat } from '../testing/combat';
import { AssetIndex } from '../view/assets';
import type { BattleLoaders } from '../view/combat/assets';
import { COMBAT_STILLS, SPRITE_INDEX } from '../view/combat/files';
import { textureLedger } from '../view/textureMemory';
import { BattleAssetHolder, fetchBytes } from './battleAssets';

/** Loaders whose model loads wait for `release` (a slow network), each model a mesh with a 4x4 map. */
function slowLoaders() {
  const waiting: (() => void)[] = [];
  const loaders: BattleLoaders = {
    model: () => new Promise(resolve => waiting.push(() => {
      const root = new Group();
      root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: new Texture({ width: 4, height: 4 } as unknown as HTMLImageElement) })));
      resolve(root);
    })),
    texture: async () => new Texture(),
    bytes: async () => { throw new Error('404'); },
  };
  /** Lets every model load asked for so far finish (after the loads have started: they wait for the sprites' index first). */
  const release = async () => {
    for (let i = 0; i < 10 && waiting.length === 0; i++) await new Promise(r => setTimeout(r, 0));
    for (const w of waiting.splice(0)) w();
  };
  return { loaders, release };
}

const index = () => new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));

describe('BattleAssetHolder (M8 spec §8, Plan 24 Task 6)', () => {
  it('holds one battle\'s set, says what it holds, and frees it', async () => {
    const { loaders, release } = slowLoaders();
    const warnings: string[] = [];
    const holder = new BattleAssetHolder(index, loaders, m => warnings.push(m), () => {});
    const before = textureLedger.bytes;
    const loading = holder.load(miniCombat(), 3, [2, 0]);
    expect(holder.state()).toMatchObject({ scenario: 3, state: 'loading' });
    await release();
    await loading;
    // (miniCombat's Enterprise and chodak share mini's three models and the six generic pieces; with the phaser, photon,
    // billboard and two shields, 14 models, each a 4x4 map with its mips: 85 bytes. This game has no sheets or stills)
    expect(holder.state()).toMatchObject({ scenario: 3, state: 'ready', models: 14, sprites: 0, stills: false, textures: 14, bytes: 14 * 85 });
    expect(textureLedger.bytes - before).toBe(14 * 85);
    expect(warnings).toEqual([expect.stringMatching(/^combat: battle 3 is drawn without .*__boom\.spr.*stills.*npm run unity:build/)]);
    holder.free();
    expect(holder.state()).toBeNull();
    expect(textureLedger.bytes).toBe(before);
  });

  it('warns of a backdrop plate the game has that fails to load on its own, not as a file missing from the space build (Plan 26 Task 6 review #8)', async () => {
    const { loaders, release } = slowLoaders();
    const plates = () => new AssetIndex([...Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]), ['art/space/backdrop/plate3.webp', '/a/plate3.webp']]);
    const failing: BattleLoaders = { ...loaders, texture: async url => { if (url === '/a/plate3.webp') throw new Error('decode'); return new Texture(); } };
    const warnings: string[] = [];
    const holder = new BattleAssetHolder(plates, failing, m => warnings.push(m), () => {}, () => ({ kinds: {}, backdrops: ['art/space/backdrop/plate3.webp'] }));
    const loading = holder.load(miniCombat(), 7, [2, 0]);
    await release();
    await loading;
    expect(warnings).toEqual([
      expect.stringMatching(/^combat: battle 7 is drawn without .*stills.*npm run unity:build/),
      'combat: battle 7\'s backdrop plate art/space/backdrop/plate3.webp failed to load: drawn without a backdrop',
    ]);
    expect(warnings[0]).not.toMatch(/plate/);
    holder.free();
  });

  it('frees a set that finishes loading after its battle has ended, or another has begun', async () => {
    const { loaders, release } = slowLoaders();
    const holder = new BattleAssetHolder(index, loaders, () => {}, () => {});
    const before = textureLedger.count;
    const first = holder.load(miniCombat(), 3, [2, 0]);
    holder.free();
    await release();
    const second = holder.load(miniCombat(), 8, [2]);
    await release();
    await Promise.all([first, second]);
    expect(holder.state()).toMatchObject({ scenario: 8, state: 'ready' });
    // (only the second battle's: one ship, so 13 models)
    expect(holder.state()!.models).toBe(13);
    expect(textureLedger.count - before).toBe(holder.state()!.textures);
    holder.free();
    expect(textureLedger.count).toBe(before);
  });

  /** Wraps the loaders so every model's textures are kept, with whether each was disposed. */
  function watched(loaders: BattleLoaders) {
    const made: { texture: Texture; disposed: boolean }[] = [];
    const model: BattleLoaders['model'] = async url => {
      const root = await loaders.model(url);
      root.traverse(o => {
        const map = ((o as Mesh).material as MeshStandardMaterial | undefined)?.map;
        if (!map) return;
        const entry = { texture: map, disposed: false };
        map.addEventListener('dispose', () => { entry.disposed = true; });
        made.push(entry);
      });
      return root;
    };
    return { loaders: { ...loaders, model }, made };
  }

  it('disposes a set whose load resolves after its battle has ended, and stays empty (Task 5 review: a load cannot be cancelled)', async () => {
    const slow = slowLoaders();
    const { loaders, made } = watched(slow.loaders);
    const warnings: string[] = [];
    let changes = 0;
    const holder = new BattleAssetHolder(index, loaders, m => warnings.push(m), () => { changes++; });
    const before = { count: textureLedger.count, bytes: textureLedger.bytes };
    const loading = holder.load(miniCombat(), 3, [2, 0]);
    // (the battle ends while its models are still on the wire)
    holder.free();
    expect(holder.state()).toBeNull();
    await slow.release();
    await loading;
    expect(made).toHaveLength(14);
    expect(made.every(m => m.disposed)).toBe(true);
    expect(holder.state()).toBeNull();
    expect(holder.loaded).toBeNull();
    expect({ count: textureLedger.count, bytes: textureLedger.bytes }).toEqual(before);
    // (a dropped set says nothing: no missing-files warning, no store bump)
    expect(warnings).toEqual([]);
    expect(changes).toBe(0);
  });

  it('disposes the earlier set when a second battle starts before the first one\'s load resolves', async () => {
    const slow = slowLoaders();
    const { loaders, made } = watched(slow.loaders);
    const holder = new BattleAssetHolder(index, loaders, () => {}, () => {});
    const before = textureLedger.count;
    const first = holder.load(miniCombat(), 3, [2, 0]);
    // (no free between them: the second load replaces the first while both are in flight)
    const second = holder.load(miniCombat(), 8, [2]);
    expect(holder.state()).toMatchObject({ scenario: 8, state: 'loading' });
    await slow.release();
    await Promise.all([first, second]);
    // (the first battle's 14 models and the second's 13, one texture each)
    expect(made).toHaveLength(27);
    const kept = new Set(holder.loaded!.textures);
    expect(kept.size).toBe(13);
    for (const m of made) expect(m.disposed).toBe(!kept.has(m.texture));
    expect(holder.state()).toMatchObject({ scenario: 8, state: 'ready', models: 13 });
    expect(textureLedger.count - before).toBe(13);
    holder.free();
    expect(made.every(m => m.disposed)).toBe(true);
    expect(textureLedger.count).toBe(before);
  });

  it('warns of a load that fails only while its battle is still the one held (review #3)', async () => {
    // (a model whose meshes can't be walked: loadBattleAssets itself rejects, past its per-file catch)
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const broken = new Group();
    broken.traverse = () => { throw new Error('bad model'); };
    const loaders: BattleLoaders = {
      model: async () => { await gate; return broken; },
      texture: async () => new Texture(),
      bytes: async () => { throw new Error('404'); },
    };
    const warnings: string[] = [];
    const holder = new BattleAssetHolder(index, loaders, m => warnings.push(m), () => {});
    const dropped = holder.load(miniCombat(), 3, [2, 0]);
    holder.free();
    release();
    await dropped;
    expect(warnings).toEqual([]);
    expect(holder.state()).toBeNull();
    await holder.load(miniCombat(), 3, [2, 0]);
    expect(warnings).toEqual([expect.stringMatching(/^combat: battle 3's models and sprites failed to load: bad model/)]);
    expect(holder.state()).toBeNull();
  });
});

describe('fetchBytes (review #4)', () => {
  const respond = (body: string, init: ResponseInit): typeof fetch => async () => new Response(body, init);

  it('gives an OK response\'s bytes, and throws on a 404 or an HTML page served in a file\'s place', async () => {
    expect([...await fetchBytes('/a/space/space.rgb', respond('\x01\x02', { status: 200, headers: { 'content-type': 'application/octet-stream' } }))]).toEqual([1, 2]);
    await expect(fetchBytes('/a/space/space.rgb', respond('Not found', { status: 404 }))).rejects.toThrow(/HTTP 404/);
    await expect(fetchBytes('/a/space/space.rgb', respond('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))).rejects.toThrow(/HTML page/);
  });

  it('lists a sprite index and stills the server 404s as missing, as absent ones are', async () => {
    const files = [SPRITE_INDEX, COMBAT_STILLS.console, COMBAT_STILLS.palette, COMBAT_STILLS.warp, COMBAT_STILLS.warpPalette];
    const assets = () => new AssetIndex([...Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]), ...files.map(f => [f, `/a/${f}`] as [string, string])]);
    const asked: string[] = [];
    const get: typeof fetch = async url => { asked.push(String(url)); return new Response('<!doctype html>', { status: 404, headers: { 'content-type': 'text/html' } }); };
    const loaders: BattleLoaders = { model: async () => new Group(), texture: async () => new Texture(), bytes: url => fetchBytes(url, get) };
    const warnings: string[] = [];
    const holder = new BattleAssetHolder(assets, loaders, m => warnings.push(m), () => {});
    await holder.load(miniCombat(), 3, [2, 0]);
    expect(asked).toContain(`/a/${SPRITE_INDEX}`);
    expect(asked).toContain(`/a/${COMBAT_STILLS.palette}`);
    expect(holder.state()).toMatchObject({ state: 'ready', stills: false, sprites: 0 });
    expect(holder.state()!.missing).toEqual(expect.arrayContaining([SPRITE_INDEX, 'stills']));
    holder.free();
  });
});

describe('BattleAssetHolder with the art (Plan 30 R13, R16)', () => {
  it('asks for the art\'s packs and backdrop only while the art is on, and says apart which of the art\'s it lacks', async () => {
    const { loaders, release } = slowLoaders();
    const asked: string[][] = [];
    const watching: BattleLoaders = { ...loaders, image: async () => new Texture(), bytes: async url => { asked.push([url]); throw new Error('404'); } };
    const files = () => new AssetIndex([...Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]), ['art/space/kind2.pack', '/a/kind2.pack']]);
    let space: { kinds: Record<string, string>; backdrops: string[] } | null = null;
    const warnings: string[] = [];
    const holder = new BattleAssetHolder(files, watching, m => warnings.push(m), () => {}, () => space);
    let loading = holder.load(miniCombat(), 7, [2, 0]);
    await release();
    await loading;
    expect(asked.flat()).not.toContain('/a/kind2.pack');
    expect(warnings.some(w => w.includes('art'))).toBe(false);
    space = { kinds: { 2: 'art/space/kind2.pack', 0: 'art/space/kind0.pack' }, backdrops: [] };
    warnings.length = 0;
    loading = holder.load(miniCombat(), 7, [2, 0]);
    await release();
    await loading;
    expect(asked.flat()).toContain('/a/kind2.pack');
    expect(warnings.at(-1)).toBe('combat: battle 7 is drawn in the original\'s textures where the art lacks art/space/kind0.pack, art/space/kind2.pack (npm run art:space -- publish)');
    expect(warnings[0]).not.toMatch(/kind/);
    holder.free();
  });
});
