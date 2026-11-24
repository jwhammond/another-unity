// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { checkTactics, encodeBase64, type CombatModel, type TacticsScript } from '@another-unity/engine';
import type { Problems } from './problems';
import { decodeTexture, hasTexture, parseSpaceMaterials, parseSpaceModel } from './space';

/** A sprite's frame count as combat's animations have it (lower-case file name), or undefined for none. */
export type SpriteFrames = (file: string) => number | undefined;

/** kMaxAnimationFrames (space3d.h:182): SpaceResources::animation keeps at most this many frames. */
export const MAX_ANIMATION_FRAMES = 23;

/**
 * Each sprite's frames as SpaceResources::animation counts them (space3d.cpp:482-517): its `sprite` entries (not
 * speech sprites), at most MAX_ANIMATION_FRAMES; none for a sprite without one. From Plan 3's `export_images` output.
 */
export async function loadSpriteFrames(imagesDir: string): Promise<SpriteFrames> {
  const manifest = JSON.parse(await readFile(join(imagesDir, 'images/manifest.json'), 'utf8')) as { sprites: { file: string; json: string }[] };
  const counts = new Map<string, number>();
  for (const s of manifest.sprites) {
    const sprite = JSON.parse(await readFile(join(imagesDir, s.json), 'utf8')) as { entries: { type: string }[] };
    const n = Math.min(sprite.entries.filter(e => e.type === 'sprite').length, MAX_ANIMATION_FRAMES);
    if (n > 0) counts.set(basename(s.file).toLowerCase(), n);
  }
  return file => counts.get(file.toLowerCase());
}

/**
 * Each named `.dmg` as SpaceResources::materials reads it (space3d.cpp:537-567): one entry per material, true where
 * it loads a texture (a textured or keyed material with a name, space3d.cpp:556-561, whose file decodes,
 * space3d.cpp:570-585). A file the export lacks is a gap, and left out (createShip's null damageMaterials).
 */
export function liftDamageMaterials(files: ReadonlyMap<string, Uint8Array>, names: readonly string[], gaps: string[]): Record<string, boolean[]> {
  const out: Record<string, boolean[]> = {};
  for (const name of [...new Set(names)].sort(byText)) {
    const bytes = files.get(name);
    if (!bytes) {
      gaps.push(`combat damage materials: ${name} isn't in the export's verbatim files`);
      continue;
    }
    out[name] = parseSpaceMaterials(bytes).map(m => {
      if (!hasTexture(m)) return false;
      const texture = files.get(m.texture.toLowerCase());
      return !!texture && decodeTexture(m.texture, texture) !== null;
    });
  }
  return out;
}

/** A model combat draws: its key in combat.yaml (and its .glb's name), its geometry file, and the materials it's drawn with. */
export interface ModelWant { key: string; geometry: string; materials: string | null }

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each wanted model's record, read from its geometry's header (SpaceModel::load, space3d.cpp:117-195). */
export function liftModels(files: ReadonlyMap<string, Uint8Array>, wants: readonly ModelWant[], problems: Problems): Record<string, CombatModel> {
  const out: Record<string, CombatModel> = {};
  for (const want of [...wants].sort((a, b) => byText(a.key, b.key))) {
    if (out[want.key]) continue;
    const where = `combat models: ${want.key}`;
    const bytes = files.get(want.geometry);
    if (!bytes) {
      problems.warn(where, `${want.geometry} isn't in the export's verbatim files`);
      continue;
    }
    const model = parseSpaceModel(bytes);
    if (!model) {
      problems.warn(where, `${want.geometry} isn't a model SpaceModel::load accepts (space3d.cpp:117-195)`);
      continue;
    }
    let materials = want.materials;
    if (materials !== null && !files.has(materials)) {
      problems.warn(where, `${materials} isn't in the export's verbatim files: the model is drawn without materials`);
      materials = null;
    }
    out[want.key] = { url: `space/${want.key}.glb`, geometry: want.geometry, materials, size: model.size, centre: model.centre, parts: model.parts.length, vertices: model.parts.map(p => p.vertices.length) };
  }
  return out;
}

/** Each named tactics file, whole (Plan 18 R5), with what TacticScript::load finds in it. */
export function liftTactics(files: ReadonlyMap<string, Uint8Array>, names: readonly string[], problems: Problems): Record<string, TacticsScript> {
  const out: Record<string, TacticsScript> = {};
  for (const file of [...new Set(names)].sort(byText)) {
    const where = `combat tactics: ${file}`;
    const code = files.get(file);
    if (!code) {
      problems.warn(where, `${file} isn't in the export's verbatim files`);
      continue;
    }
    const check = checkTactics(code);
    if (!check.loads) {
      problems.warn(where, `${file} isn't a tactics file TacticScript::load accepts (tactics.cpp:135-139): no ship runs it`);
      continue;
    }
    for (const p of check.problems) problems.warn(where, `${file}: ${p}`);
    out[file] = { file, size: code.length, kernel: check.kernel, pages: check.pages, code: encodeBase64(code) };
  }
  return out;
}
