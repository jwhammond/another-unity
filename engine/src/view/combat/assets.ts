// SPDX-License-Identifier: GPL-3.0-or-later
import { LinearFilter, NearestFilter, RepeatWrapping, type Material, type Mesh, type Object3D, type Texture } from 'three';
import type { CombatData } from '../../content/types';
import type { AssetIndex } from '../assets';
import { parseImagePack, type ImagePackEntry } from '../imagePack';
import { parsePack, type IndexedImage } from '../indexed';
import { textureLedger } from '../textureMemory';
import { COMBAT_STILLS, SPRITE_INDEX, WARP_SPRITES, type CombatSpriteSheet } from './files';
import { swapMaps } from './spaceArt';

/** What a battle draws (M8 spec §8): combat.yaml's model keys and sprite files, each once, sorted. */
export interface BattleAssetList {
  models: string[]; sprites: string[];
  /** The battle's backdrop plate (files.ts backdropPlate: M8 spec Decision 14), loaded if the game has it; none is not missing. */
  backdrop?: string;
  /** With the art on, the image packs of its repainted textures and upscaled sheets (spaceArt.ts spaceArtPacks: Plan 30). */
  art?: string[];
  /** The art's share of the set's bytes (default ART_BUDGET). */
  artBudget?: number;
}

/**
 * The art's share of a battle's set (M8 spec §8: the set within 160 MiB). The rest, the warp overlay's sheets and the stills, measured
 * about 24 MiB in Plan 30 Task 11's browser run; 128 leaves it room. Over it, the art's textures are decoded smaller (the user's ruling).
 */
export const ART_BUDGET = 128 * 1048576;

/**
 * The models and sprites a battle of these ships draws: what ScummVM's SpaceResources loads for it, and nothing else.
 * - Each ship's kind (`types`, CombatShip.type, the Enterprise's included): its detailed, reduced and damaged models
 *   (createShip, combat.cpp:291-300, 380-383), its debris pieces (its own or the generic ones, as the lift resolved them:
 *   destroyShip, damage.cpp:487-497), and its phaser, photon and shield sprites (setupWeapons, weapons.cpp:101-152).
 * - Every battle's: the phaser, photon and billboard models and the booms (Combat::setup, combat.cpp:183-190), the
 *   shield model of each ship's index, shield_1 to shield_N for N ships (weapons.cpp:138-144), and the warp overlay's
 *   sprites (showWarp, tactical.cpp:823-827: any battle the Enterprise can warp out of).
 * `types` has one entry a ship, in the battle's order.
 */
export function battleAssetList(combat: CombatData, types: readonly number[]): BattleAssetList {
  const models = new Set<string>();
  const sprites = new Set<string>();
  const add = <T>(set: Set<T>, v: T | null | undefined) => { if (v !== null && v !== undefined) set.add(v); };
  for (const type of new Set(types)) {
    const kind = combat.kinds[type];
    if (!kind) continue;
    add(models, kind.models.detail);
    add(models, kind.models.reduced);
    add(models, kind.models.damaged);
    for (const piece of kind.models.debris) add(models, piece);
    add(sprites, kind.effects.phaserSprite);
    add(sprites, kind.effects.photonSprite);
    add(sprites, kind.effects.shieldSprite);
  }
  const e = combat.effects;
  for (const m of [e.phaser, e.photon, e.billboard, ...e.shields.slice(0, types.length)]) add(models, m);
  for (const b of e.booms) add(sprites, b);
  for (const w of WARP_SPRITES) add(sprites, w.file);
  return { models: [...models].sort(), sprites: [...sprites].sort() };
}

/** A sprite's sheet, loaded: its texture and how its frames sit in it (CombatSpriteSheet). */
export interface LoadedSprite extends Omit<CombatSpriteSheet, 'image'> { texture: Texture }

/** Tactical's stills, loaded (COMBAT_STILLS): the console's pictures and the warp's, with their palettes. */
export interface CombatStills { console: IndexedImage[]; palette: Uint8Array; warp: IndexedImage[]; warpPalette: Uint8Array }

/** One battle's models, sprites and stills, loaded; `dispose` frees every geometry, material and texture of them. */
export interface BattleAssets {
  list: BattleAssetList;
  /** The models' scenes, by combat.yaml model key: one copy each, which the view clones (sharing geometry and materials). */
  models: Map<string, Object3D>;
  sprites: Map<string, LoadedSprite>;
  /** Null when the game's space build has no stills (an export before Plan 24). */
  stills: CombatStills | null;
  /** The backdrop plate, or none (the art has none yet: Plan 30's). */
  backdrop?: Texture | null;
  /** What was asked for and not there (a model or sheet the game lacks, a file that failed): drawn without, as the original skips a missing file. */
  missing: string[];
  /** With the art on: how many packs loaded, how many materials took a repainted texture, how many sprites an upscaled sheet (Plan 30). */
  art?: { packs: number; swapped: number; sheets: number; fit: number } | null;
  /** Every texture the set holds (the models' and the sheets'), each counted in the texture ledger until `dispose`. */
  textures: readonly Texture[];
  dispose(): void;
}

export interface BattleLoaders {
  /** A .glb's scene (ArtLoaders.model: GLTFLoader). Its textures are counted here, in the texture ledger. */
  model(url: string): Promise<Object3D>;
  /** A colour texture, counted in the texture ledger (ArtLoaders.texture). */
  texture(url: string, color: boolean): Promise<Texture>;
  /** A file's bytes (fetch). */
  bytes(url: string): Promise<Uint8Array>;
  /** A pack's picture (its encoded bytes, its media type, its size), decoded into a colour texture counted in the texture ledger (Plan 30). Without it, no art loads. */
  image?(bytes: Uint8Array, type: string, size: [number, number], o: { name: string; flipY: boolean }): Promise<Texture>;
}

/** Every texture a material holds (its maps), once. */
function materialTextures(material: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(material)) if ((value as Texture | null)?.isTexture) out.push(value as Texture);
  return out;
}

/** The meshes' geometries, materials and textures of a model, once each. */
function modelParts(root: Object3D): { geometries: Set<{ dispose(): void }>; materials: Set<Material>; textures: Set<Texture> } {
  const geometries = new Set<{ dispose(): void }>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(m);
      for (const t of materialTextures(m)) textures.add(t);
    }
  });
  return { geometries, materials, textures };
}

/**
 * Loads a battle's set: each model's .glb (AssetIndex.spaceModel), its textures counted in the texture ledger; each sprite's
 * sheet (SPRITE_INDEX); and tactical's stills. A file the game lacks, or that fails, is listed in `missing` and left out. Every
 * object it makes is kept (`owned`) and freed by `dispose`, as the views' are (engine/src/view/space.ts).
 */
export async function loadBattleAssets(combat: CombatData, list: BattleAssetList, assets: AssetIndex, loaders: BattleLoaders): Promise<BattleAssets> {
  const owned: { dispose(): void }[] = [];
  const missing: string[] = [];
  const models = new Map<string, Object3D>();
  const sprites = new Map<string, LoadedSprite>();
  const attempt = async <T>(what: string, url: string | undefined, load: (url: string) => Promise<T>): Promise<T | null> => {
    if (url === undefined) { missing.push(what); return null; }
    try { return await load(url); } catch { missing.push(what); return null; }
  };
  const index = await attempt(SPRITE_INDEX, assets.url(SPRITE_INDEX), async url => JSON.parse(new TextDecoder().decode(await loaders.bytes(url))) as Record<string, CombatSpriteSheet>);
  // (the art's packs first, so each model takes its repainted textures as it loads: Plan 30 R15. A texture a pack names twice, or
  // two packs name, is the first's; a pack that fails is listed as missing and the battle is drawn in the original's textures)
  const artTextures = new Map<string, Texture>();
  const artSheets = new Map<string, { texture: Texture; columns: number; cell: [number, number] }>();
  const image = loaders.image;
  const claimedTextures = new Set<string>(), claimedSheets = new Set<string>();
  const drawn = new Set(list.sprites.map(f => f.toLowerCase()));
  let packs = 0, swapped = 0, sheets = 0, fit = 1;
  if (list.art && image) {
    // (every pack's entries are chosen before any is decoded, so the set knows the art's bytes and can fit them to its budget)
    const take: { path: string; e: ImagePackEntry; kind: 'tex' | 'sheet'; name: string; columns: number; cell: [number, number] }[] = [];
    for (const path of list.art) {
      const entries = await attempt(path, assets.url(path), async url => parseImagePack(await loaders.bytes(url)));
      if (!entries) continue;
      packs++;
      for (const e of entries) {
        const [kind, name] = [e.name.slice(0, e.name.indexOf(':')), e.name.slice(e.name.indexOf(':') + 1)];
        if (kind !== 'tex' && kind !== 'sheet') continue;
        // (the warp overlay's sheets are always the original's, laid out by cell and blitted texel for texel: R11, whatever a pack carries)
        if (kind === 'sheet' && WARP_SPRITES.some(w => w.file === name)) continue;
        // (the effects pack holds every race's sheets: only the battle's are decoded, as its list would load the original's)
        if (kind === 'sheet' && !drawn.has(name)) continue;
        // (a texture a pack names twice, or two packs name, is the first's)
        const claims = kind === 'tex' ? claimedTextures : claimedSheets;
        if (claims.has(name)) continue;
        const meta = e.meta as { columns?: unknown; cell?: unknown } | undefined;
        const cell = meta?.cell;
        if (kind === 'sheet' && !(Number.isInteger(meta?.columns) && (meta?.columns as number) > 0 && Array.isArray(cell) && cell.length === 2 && cell.every(n => Number.isInteger(n) && n > 0))) {
          missing.push(e.name);
          continue;
        }
        claims.add(name);
        take.push({ path, e, kind, name, columns: meta?.columns as number, cell: cell as [number, number] });
      }
    }
    // (a sheet at half its 4x, its cell too; then the textures, with their mip chains, scaled to what the budget leaves: the user's
    // ruling on Plan 30 Task 11, where the busiest battles' art came to about 260 MiB)
    const half = (n: number) => Math.max(1, n >> 1);
    const sheetBytes = take.reduce((a, t) => a + (t.kind === 'sheet' ? half(t.e.width) * half(t.e.height) * 4 : 0), 0);
    const texBytes = take.reduce((a, t) => a + (t.kind === 'tex' ? t.e.width * t.e.height * 4 * 4 / 3 : 0), 0);
    if (texBytes > 0) fit = Math.min(1, Math.sqrt(Math.max(0, (list.artBudget ?? ART_BUDGET) - sheetBytes) / texBytes));
    await Promise.all(take.map(async t => {
      const size: [number, number] = t.kind === 'sheet' ? [half(t.e.width), half(t.e.height)] : [Math.max(1, Math.round(t.e.width * fit)), Math.max(1, Math.round(t.e.height * fit))];
      // (a texture as glTF's are, unflipped; a sheet as TextureLoader's, flipped: frameUv counts rows from the top)
      const texture = await attempt(t.e.name, t.path, () => image(t.e.bytes, t.e.type, size, { name: `${t.path}#${t.e.name}`, flipY: t.kind === 'sheet' }));
      if (!texture) return;
      owned.push(texture);
      if (t.kind === 'tex') artTextures.set(t.name, texture);
      else {
        texture.generateMipmaps = false;
        texture.minFilter = LinearFilter;
        artSheets.set(t.name, { texture, columns: t.columns, cell: [half(t.cell[0]), half(t.cell[1])] });
      }
    }));
  }
  const art = new Set<Texture>([...artTextures.values()]);
  await Promise.all([
    ...list.models.map(async key => {
      const path = combat.models[key]?.url;
      const scene = await attempt(key, path === undefined ? undefined : assets.spaceModel(path), u => loaders.model(u));
      if (!scene) return;
      // (the model's own copies of the textures the art repaints go at once: each .glb embeds its own, Plan 30 R15)
      const swap = swapMaps(scene, artTextures);
      swapped += swap.swapped;
      for (const t of swap.replaced) {
        t.dispose();
        (t.image as { close?: () => void } | undefined)?.close?.();
      }
      const parts = modelParts(scene);
      const own = [...parts.textures].filter(t => !art.has(t));
      for (const t of own) textureLedger.track(t, `${path}#${t.name}`);
      owned.push(...parts.geometries, ...parts.materials, ...own);
      models.set(key, scene);
    }),
    ...list.sprites.map(async file => {
      const sheet = index?.[file.toLowerCase()];
      // (an upscaled sheet, laid out in its own rows, in place of the original's: Plan 30 R11)
      const up = artSheets.get(file.toLowerCase());
      if (up && sheet) {
        const { image: _image, ...layout } = sheet;
        sprites.set(file, { ...layout, columns: up.columns, cell: up.cell, texture: up.texture });
        sheets++;
        return;
      }
      const texture = await attempt(file, sheet && assets.url(sheet.image), u => loaders.texture(u, true));
      if (!texture || !sheet) return;
      // (no mip chain: its lower levels blend neighbouring frames of the sheet, and it costs a third more memory, vwwarped's
      // 3640 x 1240 most. Linear keeps the modern view smooth; minified, a distant sprite now aliases, which the original's
      // one-texel sampling (drawTriangle, space3d.cpp:430) would too: Plan 31's screenshots check it. The warp overlay's
      // sheets are drawn texel for texel, as showWarp blits them (graphics.cpp:474-478), so Nearest: review I1.)
      texture.generateMipmaps = false;
      const warp = WARP_SPRITES.some(w => w.file === file);
      texture.minFilter = warp ? NearestFilter : LinearFilter;
      if (warp) texture.magFilter = NearestFilter;
      owned.push(texture);
      const { image: _image, ...layout } = sheet;
      sprites.set(file, { ...layout, texture });
    }),
  ]);
  // (the backdrop is the art's, Plan 30: a game without it has none, which is not a missing file)
  const backdropUrl = list.backdrop === undefined ? undefined : assets.url(list.backdrop);
  const backdrop = backdropUrl === undefined ? null : await attempt(list.backdrop!, backdropUrl, u => loaders.texture(u, true));
  if (backdrop) {
    backdrop.wrapS = backdrop.wrapT = RepeatWrapping;
    owned.push(backdrop);
  }
  const stillUrls = [COMBAT_STILLS.console, COMBAT_STILLS.palette, COMBAT_STILLS.warp, COMBAT_STILLS.warpPalette].map(p => assets.url(p));
  const stills = await attempt('stills', stillUrls.every(u => u !== undefined) ? stillUrls[0] : undefined, async () => {
    const [consolePack, palette, warpPack, warpPalette] = await Promise.all((stillUrls as string[]).map(u => loaders.bytes(u)));
    return { console: parsePack(consolePack!), palette: palette!, warp: parsePack(warpPack!), warpPalette: warpPalette! };
  });
  const textures = owned.filter((o): o is Texture => (o as Partial<Texture>).isTexture === true);
  return {
    list, models, sprites, stills, backdrop, missing: missing.sort(),
    art: list.art && image ? { packs, swapped, sheets, fit } : null,
    textures,
    dispose: () => {
      for (const o of owned) {
        o.dispose();
        // (a decoded picture's own memory goes now, not at the next collection: GLTFLoader's and TextureLoader's ImageBitmaps)
        ((o as Partial<Texture>).image as { close?: () => void } | undefined)?.close?.();
      }
      owned.length = 0;
      textures.length = 0;
      models.clear();
      sprites.clear();
    },
  };
}
