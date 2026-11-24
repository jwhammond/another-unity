// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData } from '../../../engine/src/content/types';
import { readSpaceModel, uvIslandMask, type SpaceModelArt } from './spacemodel';
import type { Rgba } from './image';

/** A combat texture as the art finds it (Plan 30 R8, R14): its picture, its islands over every model, who draws it, and its damage base. */
export interface SpaceTextureInfo {
  name: string;
  picture: Rgba;
  islands: Uint8Array;
  /** The kinds whose models draw it (a kind's pack holds it), and whether an effect's model does (the effects' pack). */
  kinds: number[];
  effect: boolean;
  /** For a damage texture (a `.dmg` material's), the texture its material replaces on the detailed model (combat.cpp:1045-1053). */
  base?: string;
}

/**
 * Every texture combat draws, from the space build's models (`read` gives a model's .glb bytes by its url, or null when the build lacks
 * it): by lower-case name, with the union of its islands over every model, the kinds and effects that draw it, and its damage base,
 * the detailed model's texture at the same material index as a kind's damaged model's. Returns the models read too, for the
 * silhouette check, and the model keys the build lacks.
 */
export async function spaceInventory(combat: CombatData, read: (url: string) => Promise<Uint8Array | null>): Promise<{ textures: Map<string, SpaceTextureInfo>; models: Map<string, SpaceModelArt>; missing: string[] }> {
  const models = new Map<string, SpaceModelArt>();
  const missing: string[] = [];
  for (const [key, m] of Object.entries(combat.models).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = await read(m.url);
    if (bytes) models.set(key, await readSpaceModel(bytes));
    else missing.push(key);
  }
  const textures = new Map<string, SpaceTextureInfo>();
  const uvs = new Map<string, [number, number][][]>();
  for (const model of models.values()) {
    for (const [name, picture] of model.textures) if (!textures.has(name)) textures.set(name, { name, picture, islands: new Uint8Array(0), kinds: [], effect: false });
    for (const t of model.triangles) if (t.texture) (uvs.get(t.texture) ?? uvs.set(t.texture, []).get(t.texture)!).push(t.uvs);
  }
  for (const info of textures.values()) info.islands = uvIslandMask(info.picture.width, info.picture.height, uvs.get(info.name) ?? []);
  const used = (key: string | null | undefined): string[] => (key ? [...(models.get(key)?.textures.keys() ?? [])] : []);
  combat.kinds.forEach((k, type) => {
    if (!k) return;
    for (const key of [k.models.detail, k.models.reduced, k.models.damaged, ...k.models.debris]) for (const name of used(key)) {
      const info = textures.get(name)!;
      if (!info.kinds.includes(type)) info.kinds.push(type);
    }
    const detail = k.models.detail ? models.get(k.models.detail) : undefined, damaged = k.models.damaged ? models.get(k.models.damaged) : undefined;
    if (!detail || !damaged) return;
    const at = (m: SpaceModelArt) => new Map(m.triangles.filter(t => t.texture).map(t => [t.material, t.texture!]));
    const base = at(detail);
    for (const [material, name] of at(damaged)) {
      const b = base.get(material);
      if (b && b !== name) textures.get(name)!.base = b;
    }
  });
  const e = combat.effects;
  for (const key of [e.phaser, e.photon, e.billboard, ...e.shields, ...e.genericDebris]) for (const name of used(key)) textures.get(name)!.effect = true;
  return { textures, models, missing };
}
