// SPDX-License-Identifier: GPL-3.0-or-later
import { ByteReader, orNull } from './reader';

/** One material (SpaceMaterial, space3d.h): RGB555 colour, alpha (0 opaque to 0x4000 invisible), flags (type in the low 5 bits, then render flags) and the texture's name as the file has it. */
export interface SpaceMaterialDef { colour: number; alpha: number; flags: number; texture: string }

/** Material types (space3d.h:68-73). */
export const MATERIAL = { flat: 0, textured: 1, keyed: 2, gouraud: 3 } as const;

export const materialType = (m: SpaceMaterialDef): number => m.flags & 0x1f;
/** Only textured and keyed materials with a name load a texture (space3d.cpp:561-563). */
export const hasTexture = (m: SpaceMaterialDef): boolean =>
  (materialType(m) === MATERIAL.textured || materialType(m) === MATERIAL.keyed) && m.texture !== '';

/** A .mtl, .mtr or .dmg as SpaceResources::materials reads it (space3d.cpp:537-567); [] for a file cut short. */
export function parseSpaceMaterials(bytes: Uint8Array): SpaceMaterialDef[] {
  return orNull(() => {
    const r = new ByteReader(bytes);
    r.u32();
    const count = r.u32();
    const out: SpaceMaterialDef[] = [];
    for (let i = 0; i < count; i++) {
      r.seek(0x1e + i * 0x24);
      const colour = r.u32() & 0x7fff;
      const alpha = r.u32();
      const flags = r.u32();
      r.u32();
      out.push({ colour, alpha, flags, texture: r.cstring(20) });
    }
    return out;
  }) ?? [];
}
