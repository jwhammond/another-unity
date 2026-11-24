// SPDX-License-Identifier: GPL-3.0-or-later
import { BoxGeometry, Group, LinearFilter, Mesh, MeshStandardMaterial, NearestFilter, RepeatWrapping, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { miniCombat } from '../../testing/combat';
import { AssetIndex } from '../assets';
import { writeImagePack } from '../imagePack';
import { writePack } from '../indexed';
import { textureLedger } from '../textureMemory';
import { battleAssetList, loadBattleAssets, type BattleLoaders } from './assets';
import { backdropPlate, COMBAT_STILLS, SPRITE_INDEX, type CombatSpriteSheet } from './files';

const ENTERPRISE = 2; // (miniCombat's kinds are KINDS' order: the Enterprise is kind 2, combat.h's kCombatEnterprise)
const CHODAK = 0;

/** A texture of w x h, as a loader hands it over (its picture decoded). */
const picture = (w: number, h: number, name = '') => {
  const t = new Texture({ width: w, height: h } as unknown as HTMLImageElement);
  t.name = name;
  return t;
};

describe('battleAssetList (what SpaceResources loads for a battle: M8 spec §8)', () => {
  it('takes each kind\'s models and sprites once, every battle\'s effects, and a shield model for each ship', () => {
    // (the Enterprise, then two chodaks: kinds 2 and 0, three ships. miniCombat's kinds share the model "mini" and the
    // generic debris, and draw the race-less sprites)
    const list = battleAssetList(miniCombat(), [ENTERPRISE, CHODAK, CHODAK]);
    expect(list.models).toEqual([
      'bboard.3dv', 'generic.pc1', 'generic.pc2', 'generic.pc3', 'generic.pc4', 'generic.pc5', 'generic.pc6',
      'mini.3dr', 'mini.3dv', 'mini.dmg', 'phaser.3dv', 'photon.3dv', 'shield_1.3dv', 'shield_2.3dv', 'shield_3.3dv',
    ]);
    // (and the warp overlay's three, every battle's: showWarp, tactical.cpp:820-827)
    expect(list.sprites).toEqual(['1_boom.spr', '2_boom.spr', '3_boom.spr', '__boom.spr', '__phaser.spr', '__photon.spr', '__shield.spr', 'viewscan.spr', 'viewscr.spr', 'vwwarped.spr']);
  });

  it('takes only what a kind has: its own debris, no reduced or damaged model it lacks, no weapon sprite it lacks; and skips a kind it doesn\'t know', () => {
    const combat = miniCombat();
    const chodak = combat.kinds[CHODAK]!;
    chodak.models = { detail: 'mini.3dv', reduced: null, damaged: null, debris: ['chodak.pc1', null, null, null, null, null] };
    chodak.effects = { ...chodak.effects, phaserSprite: 'c_phaser.spr', photonSprite: null };
    const list = battleAssetList(combat, [CHODAK, 99]);
    expect(list.models).toEqual(['bboard.3dv', 'chodak.pc1', 'mini.3dv', 'phaser.3dv', 'photon.3dv', 'shield_1.3dv', 'shield_2.3dv']);
    expect(list.sprites).toEqual(['1_boom.spr', '2_boom.spr', '3_boom.spr', '__boom.spr', '__shield.spr', 'c_phaser.spr', 'viewscan.spr', 'viewscr.spr', 'vwwarped.spr']);
  });
});

/** The game's files: every model of miniCombat, the sprites' index and sheets, the stills; and loaders that count what they made. */
function game(o: { lack?: string[] } = {}) {
  const combat = miniCombat();
  const files = new Map<string, string>();
  for (const m of Object.values(combat.models)) files.set(m.url, `/a/${m.url}`);
  const sheets: Record<string, CombatSpriteSheet> = {};
  for (const s of ['__boom.spr', '1_boom.spr', '2_boom.spr', '3_boom.spr', '__phaser.spr', '__photon.spr', '__shield.spr', 'viewscan.spr', 'viewscr.spr', 'vwwarped.spr']) {
    const image = `space/sprites/${s.replace('.spr', '')}.png`;
    sheets[s] = { image, frames: 4, columns: 4, cell: [8, 8], palette: s.startsWith('v') ? 'cheap' : 'space', entries: [] };
    files.set(image, `/a/${image}`);
  }
  files.set(SPRITE_INDEX, '/a/sprites.json');
  for (const p of Object.values(COMBAT_STILLS)) files.set(p, `/a/${p}`);
  for (const p of o.lack ?? []) files.delete(p);
  const bytes: Record<string, Uint8Array> = {
    '/a/sprites.json': new TextEncoder().encode(JSON.stringify(sheets)),
    [`/a/${COMBAT_STILLS.console}`]: writePack([{ width: 2, height: 1, pixels: Uint8Array.of(1, 2) }, { width: 1, height: 1, pixels: Uint8Array.of(245) }]),
    [`/a/${COMBAT_STILLS.palette}`]: new Uint8Array(768).fill(1),
    [`/a/${COMBAT_STILLS.warp}`]: writePack([{ width: 1, height: 1, pixels: Uint8Array.of(9) }]),
    [`/a/${COMBAT_STILLS.warpPalette}`]: new Uint8Array(768).fill(2),
  };
  const made = { geometries: 0, materials: 0, textures: [] as Texture[], freed: new Set<unknown>() };
  const watch = <T extends { addEventListener(type: 'dispose', f: () => void): void }>(o: T): T => { o.addEventListener('dispose', () => made.freed.add(o)); return o; };
  const loaders: BattleLoaders = {
    // (a model as GLTFLoader gives it: a mesh with a 16x16 base colour map, as the space build embeds the textures)
    model: async url => {
      const map = watch(picture(16, 16, 'hull.img'));
      made.textures.push(map);
      made.geometries++;
      made.materials++;
      const root = new Group();
      root.add(new Mesh(watch(new BoxGeometry()), watch(new MeshStandardMaterial({ map }))));
      root.name = url;
      return root;
    },
    // (as defaultLoaders.texture: tracked in the ledger)
    texture: async url => { const t = watch(picture(32, 8)); made.textures.push(t); return textureLedger.track(t, url); },
    bytes: async url => { const b = bytes[url]; if (!b) throw new Error(`404 ${url}`); return b; },
  };
  return { combat, assets: new AssetIndex(files), loaders, made };
}

describe('loadBattleAssets (M8 spec §8, Plan 24 Task 5)', () => {
  it('loads the battle\'s models, sprites and stills, counts every texture in the ledger, and frees all of them', async () => {
    const { combat, assets, loaders, made } = game();
    const list = battleAssetList(combat, [ENTERPRISE, CHODAK]);
    const before = { count: textureLedger.count, bytes: textureLedger.bytes };
    const set = await loadBattleAssets(combat, list, assets, loaders);
    expect([...set.models.keys()].sort()).toEqual(list.models);
    expect([...set.sprites.keys()].sort()).toEqual(list.sprites);
    expect(set.missing).toEqual([]);
    expect(set.sprites.get('__boom.spr')).toMatchObject({ frames: 4, columns: 4, cell: [8, 8], palette: 'space' });
    expect(set.stills!.console.map(e => [e.width, e.height])).toEqual([[2, 1], [1, 1]]);
    expect(set.stills!.warp[0]!.pixels[0]).toBe(9);
    // (each model's 16x16 map with its mip chain, each sheet's 32x8 without: the original samples a texel)
    expect([...set.sprites.values()].every(s => !s.texture.generateMipmaps)).toBe(true);
    // (the warp overlay's sheets texel for texel, as showWarp blits them: graphics.cpp:474-478; review I1)
    const filters = (f: string) => [set.sprites.get(f)!.texture.minFilter, set.sprites.get(f)!.texture.magFilter];
    expect(['viewscan.spr', 'viewscr.spr', 'vwwarped.spr'].map(filters)).toEqual(Array(3).fill([NearestFilter, NearestFilter]));
    expect(filters('__boom.spr')[0]).toBe(LinearFilter);
    const want = list.models.length * Math.round(16 * 16 * 4 * 4 / 3) + list.sprites.length * 32 * 8 * 4;
    expect(textureLedger.count - before.count).toBe(list.models.length + list.sprites.length);
    expect(textureLedger.bytes - before.bytes).toBe(want);
    set.dispose();
    expect({ count: textureLedger.count, bytes: textureLedger.bytes }).toEqual(before);
    // (every geometry, material and texture made, freed)
    expect(made.freed.size).toBe(made.geometries + made.materials + made.textures.length);
    expect(set.models.size + set.sprites.size).toBe(0);
  });

  it('lists what the game lacks or fails to load, and loads the rest', async () => {
    const { combat, assets, loaders } = game({ lack: ['space/photon.3dv.glb', 'space/sprites/__shield.png', COMBAT_STILLS.warp] });
    const list = battleAssetList(combat, [ENTERPRISE]);
    const failing: BattleLoaders = { ...loaders, model: async url => { if (url.includes('bboard')) throw new Error('bad glb'); return loaders.model(url); } };
    const set = await loadBattleAssets(combat, list, assets, failing);
    expect(set.missing).toEqual(['__shield.spr', 'bboard.3dv', 'photon.3dv', 'stills']);
    expect(set.models.has('mini.3dv')).toBe(true);
    expect(set.stills).toBeNull();
    set.dispose();
  });

  it('loads the battle\'s backdrop plate if the game has one, repeating, freed with the set; a game without it lacks nothing (Decision 14)', async () => {
    const { combat, assets, loaders, made } = game();
    const list = { ...battleAssetList(combat, [ENTERPRISE]), backdrop: backdropPlate(7) };
    const none = await loadBattleAssets(combat, list, assets, loaders);
    expect([none.backdrop, none.missing]).toEqual([null, []]);
    none.dispose();
    const plates = new AssetIndex([...Object.values(combat.models).map(m => [m.url, `/a/${m.url}`] as [string, string]), [SPRITE_INDEX, '/a/sprites.json'], ['art/space/backdrop/plate3.webp', '/a/plate3.webp']]);
    const set = await loadBattleAssets(combat, list, plates, loaders);
    expect(set.backdrop).toBe(made.textures.at(-1));
    expect([set.backdrop!.wrapS, set.backdrop!.wrapT]).toEqual([RepeatWrapping, RepeatWrapping]);
    set.dispose();
    expect(made.freed.has(set.backdrop)).toBe(true);
  });
});

describe('loadBattleAssets: what dispose frees (Plan 24 Task 5 fix round 1)', () => {
  it('empties the set\'s texture list, and a second dispose does nothing', async () => {
    const { combat, assets, loaders, made } = game();
    const set = await loadBattleAssets(combat, battleAssetList(combat, [ENTERPRISE]), assets, loaders);
    expect(set.textures.length).toBeGreaterThan(0);
    set.dispose();
    expect(set.textures).toHaveLength(0);
    const spy = vi.spyOn(Texture.prototype, 'dispose');
    set.dispose();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(made.freed.size).toBe(made.geometries + made.materials + made.textures.length);
  });

  it('frees a texture in any material slot, not only map', async () => {
    const { combat, assets, loaders } = game();
    const emissive = picture(4, 4, 'glow.img');
    const normal = picture(4, 4, 'bump.img');
    let freed = 0;
    for (const t of [emissive, normal]) t.addEventListener('dispose', () => freed++);
    const odd: BattleLoaders = {
      ...loaders,
      model: async url => {
        const root = new Group();
        root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ emissiveMap: emissive, normalMap: normal })));
        root.name = url;
        return root;
      },
    };
    const set = await loadBattleAssets(combat, { models: ['mini.3dv'], sprites: [] }, assets, odd);
    expect(set.textures).toEqual(expect.arrayContaining([emissive, normal]));
    set.dispose();
    expect(freed).toBe(2);
  });

  it('closes each decoded picture (an ImageBitmap) when it frees its texture', async () => {
    const { combat, assets, loaders } = game();
    const close = vi.fn();
    const withClose: BattleLoaders = {
      ...loaders,
      model: async url => {
        const map = new Texture({ width: 4, height: 4, close } as unknown as HTMLImageElement);
        const root = new Group();
        root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map })));
        root.name = url;
        return root;
      },
    };
    const set = await loadBattleAssets(combat, { models: ['mini.3dv', 'mini.3dr'], sprites: [] }, assets, withClose);
    expect(close).not.toHaveBeenCalled();
    set.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('returns the ledger to its baseline after a partly failed load', async () => {
    const { combat, assets, loaders } = game({ lack: ['space/photon.3dv.glb'] });
    const before = { count: textureLedger.count, bytes: textureLedger.bytes };
    const set = await loadBattleAssets(combat, battleAssetList(combat, [ENTERPRISE]), assets, loaders);
    expect(set.missing).toContain('photon.3dv');
    expect(textureLedger.count).toBeGreaterThan(before.count);
    set.dispose();
    set.dispose();
    expect({ count: textureLedger.count, bytes: textureLedger.bytes }).toEqual(before);
  });
});

describe('loadBattleAssets with the art on (Plan 30 R11, R14, R15)', () => {
  /** miniCombat's game, its models' maps named as the space build names them, and two packs: the kinds' (hull.img) and the effects' (__boom.spr's sheet). */
  function artGame() {
    const g = game();
    const made: Texture[] = [];
    const loaders: BattleLoaders = {
      ...g.loaders,
      model: async url => {
        const root = await g.loaders.model(url);
        root.traverse(o => { const m = (o as Mesh).material as MeshStandardMaterial | undefined; if (m) m.userData = { texture: 'HULL.IMG' }; });
        return root;
      },
      image: async (_bytes, _type, [w, h], o) => { const t = picture(w, h, o.name); t.flipY = o.flipY; made.push(t); return textureLedger.track(t, o.name); },
    };
    const entry = (name: string, w: number, h: number, meta?: Record<string, unknown>) => ({ name, type: 'image/webp', width: w, height: h, ...(meta ? { meta } : {}), bytes: Uint8Array.of(1, 2, 3) });
    const files = new Map(Object.values(g.combat.models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    for (const [k, v] of [[SPRITE_INDEX, '/a/sprites.json'], ...['__boom', '1_boom', '2_boom', '3_boom', '__phaser', '__photon', '__shield', 'viewscan', 'viewscr', 'vwwarped'].map(s => [`space/sprites/${s}.png`, `/a/space/sprites/${s}.png`]), ['art/space/kind2.pack', '/a/kind2.pack'], ['art/space/effects.pack', '/a/effects.pack'], ['art/space/badmeta.pack', '/a/badmeta.pack'], ...Object.values(COMBAT_STILLS).map(p => [p, `/a/${p}`])] as [string, string][]) files.set(k, v);
    const bytes = { '/a/kind2.pack': writeImagePack([entry('tex:hull.img', 64, 64)]), '/a/effects.pack': writeImagePack([entry('sheet:__boom.spr', 64, 64, { columns: 2, cell: [32, 32] }), entry('tex:hull.img', 8, 8), entry('sheet:vwwarped.spr', 64, 64, { columns: 2, cell: [32, 32] }), entry('sheet:7_phaser.spr', 64, 64, { columns: 2, cell: [32, 32] })]),
      '/a/badmeta.pack': writeImagePack([entry('sheet:__boom.spr', 64, 64), entry('sheet:1_boom.spr', 64, 64, { columns: 'x' }), entry('tex:hull.img', 5, 5)]) };
    loaders.bytes = async url => bytes[url as keyof typeof bytes] ?? g.loaders.bytes(url);
    return { ...g, assets: new AssetIndex(files), loaders, made };
  }

  it('puts the packs\' textures on the models in place of their own, which go at once, and the upscaled sheet in place of the original\'s', async () => {
    const { combat, assets, loaders, made } = artGame();
    const before = { count: textureLedger.count, bytes: textureLedger.bytes };
    const list = { ...battleAssetList(combat, [ENTERPRISE]), art: ['art/space/kind2.pack', 'art/space/effects.pack'] };
    const set = await loadBattleAssets(combat, list, assets, loaders);
    const hull = made.find(t => t.name.endsWith('kind2.pack#tex:hull.img'))!;
    const maps = new Set<Texture>();
    for (const root of set.models.values()) root.traverse(o => { const m = (o as Mesh).material as MeshStandardMaterial | undefined; if (m?.map) maps.add(m.map); });
    // (every model's map is the kind pack's one texture; the effects pack's own hull.img came second and was never decoded)
    expect([...maps]).toEqual([hull]);
    // (a sheet the battle doesn't draw, another race's, is never decoded: the effects pack holds every race's)
    expect(made.map(t => t.name).sort()).toEqual(['art/space/effects.pack#sheet:__boom.spr', 'art/space/kind2.pack#tex:hull.img']);
    // (an upscaled sheet at half its 4x, its cell too: the user's ruling on Plan 30 Task 11's budget)
    expect(set.sprites.get('__boom.spr')).toMatchObject({ frames: 4, columns: 2, cell: [16, 16], palette: 'space' });
    expect([set.sprites.get('__boom.spr')!.texture.image.width, hull.image.width]).toEqual([32, 64]);
    // (a sheet decoded flipped, as TextureLoader's are, and drawn without a mip chain, as the original sheets)
    expect([set.sprites.get('__boom.spr')!.texture.generateMipmaps, set.sprites.get('__boom.spr')!.texture.flipY]).toEqual([false, true]);
    // (the warp overlay's sheets stay the original's, even one a pack carries, which is never decoded: R11)
    expect(set.sprites.get('vwwarped.spr')!.cell).toEqual([8, 8]);
    expect(set.sprites.get('vwwarped.spr')!.texture.name).not.toMatch(/pack#/);
    expect(set.art).toEqual({ packs: 2, swapped: list.models.length, sheets: 1, fit: 1 });
    expect(set.missing).toEqual([]);
    // (the ledger: the art's two textures and the original sheets but __boom's; none of the models' own)
    expect(textureLedger.count - before.count).toBe(2 + list.sprites.length - 1);
    expect(set.textures).toHaveLength(2 + list.sprites.length - 1);
    set.dispose();
    expect({ count: textureLedger.count, bytes: textureLedger.bytes }).toEqual(before);
  });

  it('decodes the textures smaller when the art would pass its budget, the sheets first (the user\'s ruling on Plan 30 Task 11)', async () => {
    const { combat, assets, loaders, made } = artGame();
    // (the sheet at half, 32 x 32, then a quarter of the texture's bytes with its mip chain: the texture at half a side)
    const artBudget = 32 * 32 * 4 + (64 * 64 * 4 * 4 / 3) / 4;
    const list = { ...battleAssetList(combat, [ENTERPRISE]), art: ['art/space/kind2.pack', 'art/space/effects.pack'], artBudget };
    const set = await loadBattleAssets(combat, list, assets, loaders);
    expect(made.find(t => t.name.endsWith('kind2.pack#tex:hull.img'))!.image.width).toBe(32);
    expect(set.art!.fit).toBeCloseTo(0.5);
    set.dispose();
  });

  it('draws in the original\'s textures with no pack, a pack that fails, or no picture loader; a failed pack is missing', async () => {
    const { combat, assets, loaders } = artGame();
    const list = battleAssetList(combat, [ENTERPRISE]);
    const off = await loadBattleAssets(combat, list, assets, loaders);
    expect(off.art ?? null).toBeNull();
    off.dispose();
    const lost = await loadBattleAssets(combat, { ...list, art: ['art/space/kind9.pack'] }, assets, loaders);
    expect([lost.art, lost.missing]).toEqual([{ packs: 0, swapped: 0, sheets: 0, fit: 1 }, ['art/space/kind9.pack']]);
    lost.dispose();
    const { image: _image, ...plain } = loaders;
    const none = await loadBattleAssets(combat, { ...list, art: ['art/space/kind2.pack'] }, assets, plain);
    expect([none.art ?? null, none.missing]).toEqual([null, []]);
    none.dispose();
  });

  it('keeps the original\'s sheets, one art warning and a clean ledger when a pack\'s sheet meta is bad or its picture fails to decode (Plan 30 R15)', async () => {
    const { combat, assets, loaders } = artGame();
    const before = { count: textureLedger.count, bytes: textureLedger.bytes };
    const list = { ...battleAssetList(combat, [ENTERPRISE]), art: ['art/space/badmeta.pack'] };
    const refuse: BattleLoaders = { ...loaders, image: async (b, t, s, o) => { if (o.name.endsWith('tex:hull.img')) throw new Error('decode'); return loaders.image!(b, t, s, o); } };
    const set = await loadBattleAssets(combat, list, assets, refuse);
    expect(set.sprites.get('__boom.spr')!.cell).not.toEqual([32, 32]);
    expect(set.art).toEqual({ packs: 1, swapped: 0, sheets: 0, fit: 1 });
    expect(set.missing.sort()).toEqual(['sheet:1_boom.spr', 'sheet:__boom.spr', 'tex:hull.img'].sort());
    set.dispose();
    expect({ count: textureLedger.count, bytes: textureLedger.bytes }).toEqual(before);
  });
});
