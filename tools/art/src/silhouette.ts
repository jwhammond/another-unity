// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';
import type { SpaceModelArt } from './spacemodel';

/**
 * The silhouette check (M8 spec §7; Plan 30 R10): a model drawn from six axes, orthographic, as a mask of what covers each pixel,
 * once with the original textures and once with the repaints; a keyed texel (colour 0) covers nothing, as drawTriangle skips it
 * (space3d.cpp:431-432). Sampled nearest at the texel the original's clamp gives (space3d.cpp:428-429), scaled to the texture's own
 * size, so a repaint at 4x samples the same texel of its alpha. Masks must be identical. No three, no GPU: a small software raster.
 */
export const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export type Axis = (typeof AXES)[number];

/** Looking along `axis` at the model: a corner's screen x and y (y up becomes down) before fitting. */
function project(p: readonly [number, number, number], axis: Axis): [number, number] {
  const [x, y, z] = p;
  switch (axis) {
    case '+x': return [-z, -y];
    case '-x': return [z, -y];
    case '+y': return [x, z];
    case '-y': return [x, -z];
    case '+z': return [x, -y];
    case '-z': return [-x, -y];
  }
}

/** A texel's alpha in a texture of any scale: the original's texel u, v (clamped) is texel (u, v) * scale of the repaint. */
function alphaAt(t: Rgba, scale: number, u: number, v: number, w: number, h: number): number {
  const tu = Math.min(w - 1, Math.max(0, Math.floor(u * w))), tv = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
  return t.data[((tv * scale) * t.width + tu * scale) * 4 + 3]!;
}

/**
 * The mask from one axis, `size` x `size`, the model's projected box fitted inside with a pixel's margin. `textures` by lower-case name,
 * each with its scale over the original (1 for the original, 4 for a repaint). A keyed triangle whose texture is absent from `textures` throws. 1 covered, 0 not.
 */
export function silhouette(model: SpaceModelArt, textures: ReadonlyMap<string, { picture: Rgba; scale: number }>, axis: Axis, size: number): Uint8Array {
  const pts = model.triangles.flatMap(t => t.positions.map(p => project(p, axis)));
  const mask = new Uint8Array(size * size);
  if (pts.length === 0) return mask;
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  const minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const k = (size - 2) / Math.max(maxX - minX, maxY - minY, 1e-6);
  for (const [index, t] of model.triangles.entries()) {
    if (t.keyed && !(t.texture && textures.has(t.texture))) throw new Error(`silhouette: triangle ${index} is keyed and its texture is absent`);
    const s = t.positions.map(p => { const [x, y] = project(p, axis); return [1 + (x - minX) * k, 1 + (y - minY) * k] as const; });
    const area = (s[1]![0] - s[0]![0]) * (s[2]![1] - s[0]![1]) - (s[2]![0] - s[0]![0]) * (s[1]![1] - s[0]![1]);
    if (area === 0) continue;
    const tex = t.keyed ? textures.get(t.texture!) : undefined;
    const w = tex ? tex.picture.width / tex.scale : 0, h = tex ? tex.picture.height / tex.scale : 0;
    const x0 = Math.max(0, Math.floor(Math.min(s[0]![0], s[1]![0], s[2]![0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(s[0]![0], s[1]![0], s[2]![0])));
    const y0 = Math.max(0, Math.floor(Math.min(s[0]![1], s[1]![1], s[2]![1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(s[0]![1], s[1]![1], s[2]![1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wa = ((s[1]![0] - px) * (s[2]![1] - py) - (s[2]![0] - px) * (s[1]![1] - py)) / area;
        const wb = ((s[2]![0] - px) * (s[0]![1] - py) - (s[0]![0] - px) * (s[2]![1] - py)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        if (tex) {
          const u = wa * t.uvs[0]![0] + wb * t.uvs[1]![0] + wc * t.uvs[2]![0], v = wa * t.uvs[0]![1] + wb * t.uvs[1]![1] + wc * t.uvs[2]![1];
          if (alphaAt(tex.picture, tex.scale, u, v, w, h) === 0) continue;
        }
        mask[y * size + x] = 1;
      }
    }
  }
  return mask;
}

/** Each axis's differing pixels between the model drawn with `a`'s textures and with `b`'s: all zero, or the check fails. */
export function silhouetteCheck(model: SpaceModelArt, a: ReadonlyMap<string, { picture: Rgba; scale: number }>, b: ReadonlyMap<string, { picture: Rgba; scale: number }>, size = 256): { ok: boolean; differ: Record<Axis, number> } {
  const differ = {} as Record<Axis, number>;
  for (const axis of AXES) {
    const ma = silhouette(model, a, axis, size), mb = silhouette(model, b, axis, size);
    let n = 0;
    for (let i = 0; i < ma.length; i++) if (ma[i] !== mb[i]) n++;
    differ[axis] = n;
  }
  return { ok: Object.values(differ).every(n => n === 0), differ };
}
