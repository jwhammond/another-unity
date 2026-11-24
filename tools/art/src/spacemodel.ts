// SPDX-License-Identifier: GPL-3.0-or-later
import { NodeIO, type Primitive } from '@gltf-transform/core';
import { decodePng, type Rgba } from './image';

/**
 * A combat model as the art needs it (Plan 30): read from the space build's .glb (tools/space/src/gltf.ts), each textured
 * triangle with its corners' positions and texture coordinates and its material's original texture (the material extras'
 * `texture`), whether that material is keyed (alpha MASK: colour 0 clear, kMaterialKeyed, space3d.h:75), and each texture's
 * embedded picture (the original's indices in the space palette, colour 0 clear where keyed). Never a vertex moved (spec §3.1).
 */
export interface SpaceTriangle {
  /** The original texture's lower-case name, or null for a flat or Gouraud material. */
  texture: string | null;
  /** The material's index in the model's materials file (the build's primitive extras): a damage material replaces the same index (combat.cpp:1047-1050). */
  material: number;
  keyed: boolean;
  /** Three corners: x, y, z each. */
  positions: [number, number, number][];
  /** Three corners: u, v, 0 to 1 (the build's 16.16 fixed point over 65536). */
  uvs: [number, number][];
}
export interface SpaceModelArt {
  triangles: SpaceTriangle[];
  /** By lower-case texture name: the embedded picture (the first copy: every copy of a name is the same texture). */
  textures: Map<string, Rgba>;
}

const corners = (prim: Primitive, name: 'POSITION' | 'TEXCOORD_0', n: number): number[][] => {
  const a = prim.getAttribute(name);
  if (!a) return [];
  const out: number[][] = [];
  for (let i = 0; i < a.getCount(); i++) out.push(a.getElement(i, new Array<number>(n)));
  return out;
};

/** Reads a model's triangles and textures from its .glb bytes. */
export async function readSpaceModel(glb: Uint8Array): Promise<SpaceModelArt> {
  const doc = await new NodeIO().readBinary(glb);
  const triangles: SpaceTriangle[] = [];
  const textures = new Map<string, Rgba>();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      const tex = m?.getBaseColorTexture() ?? null;
      const name = tex ? ((m!.getExtras() as { texture?: string }).texture ?? tex.getName()).toLowerCase() : null;
      if (name && tex && !textures.has(name)) textures.set(name, decodePng(tex.getImage()!));
      const keyed = m?.getAlphaMode() === 'MASK';
      const material = (prim.getExtras() as { material?: number }).material ?? -1;
      const pos = corners(prim, 'POSITION', 3), uv = corners(prim, 'TEXCOORD_0', 2);
      const idx = prim.getIndices()?.getArray() ?? Uint32Array.from(pos.keys());
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const k = [idx[i]!, idx[i + 1]!, idx[i + 2]!];
        triangles.push({ texture: name, material, keyed, positions: k.map(j => pos[j] as [number, number, number]), uvs: k.map(j => (uv[j] ?? [0, 0]) as [number, number]) });
      }
    }
  }
  return { triangles, textures };
}

/** Signed twice-area of a triangle, and whether (px, py) is inside it (edges in). */
function inside(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * The texels of a `width` x `height` texture its triangles cover (Plan 30 R8): a texel is on an island when its centre is inside a
 * triangle's UV image or a corner falls in it, then the islands grown by `grow` texels (so the repaint's edge isn't the seam). 1 on, 0 off.
 */
export function uvIslandMask(width: number, height: number, uvs: readonly (readonly [number, number])[][], grow = 1): Uint8Array {
  const on = new Uint8Array(width * height);
  const clampX = (u: number) => Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const clampY = (v: number) => Math.min(height - 1, Math.max(0, Math.floor(v * height)));
  for (const t of uvs) {
    const [a, b, c] = t.map(([u, v]) => [u * width, v * height] as const);
    for (const [u, v] of t) on[clampY(v) * width + clampX(u)] = 1;
    const x0 = Math.max(0, Math.floor(Math.min(a![0], b![0], c![0]))), x1 = Math.min(width - 1, Math.ceil(Math.max(a![0], b![0], c![0])));
    const y0 = Math.max(0, Math.floor(Math.min(a![1], b![1], c![1]))), y1 = Math.min(height - 1, Math.ceil(Math.max(a![1], b![1], c![1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(a![0], a![1], b![0], b![1], c![0], c![1], x + 0.5, y + 0.5)) on[y * width + x] = 1;
  }
  let mask = on;
  for (let g = 0; g < grow; g++) {
    const next = mask.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[ny * width + nx]) { next[y * width + x] = 1; break; }
      }
    }
    mask = next;
  }
  return mask;
}

/** A picture `scale` times as big with `from`'s alpha, nearest (Plan 30 R8: a keyed texture's colour-0 mask is the original's, never repainted). */
export function withAlphaOf(picture: Rgba, from: Rgba, scale: number): Rgba {
  if (picture.width !== from.width * scale || picture.height !== from.height * scale) throw new Error(`withAlphaOf: ${picture.width}x${picture.height} is not ${scale} times ${from.width}x${from.height}`);
  const data = new Uint8Array(picture.data);
  for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) {
    data[(y * picture.width + x) * 4 + 3] = from.data[(Math.floor(y / scale) * from.width + Math.floor(x / scale)) * 4 + 3]!;
  }
  return { width: picture.width, height: picture.height, data };
}

/**
 * The work size a texture is repainted at (Plan 30 R8): its 4x upscale scaled so its area is about 1024 x 1024, each side a multiple
 * of 64 and at least 512 (SDXL's), the aspect kept within a 64 px step. Never smaller than the upscale.
 */
export function textureWorkSize(width: number, height: number): [number, number] {
  const uw = width * 4, uh = height * 4;
  const k = Math.max(1, Math.sqrt((1024 * 1024) / (uw * uh)));
  const side = (n: number) => Math.max(512, Math.round((n * k) / 64) * 64);
  return [side(uw), side(uh)];
}
