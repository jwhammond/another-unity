// SPDX-License-Identifier: GPL-3.0-or-later
import { Document, type Material, type Texture } from '@gltf-transform/core';
import { hasTexture, MATERIAL, materialType, type SpaceMaterialDef, type SpaceModelFile, type SpacePart, type SpaceTexture } from '@another-unity/lift/space';
import { PNG } from 'pngjs';

/**
 * 180 degrees about z: the original's x right, y down, z forward (space3d.h:38) becomes glTF's right at -X, up at +Y and
 * front at +Z. It is a rotation, so nothing is mirrored, and the vertices keep the file's values.
 */
export const ROOT_ROTATION: [number, number, number, number] = [0, 0, 1, 0];

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** RGB555 (SpaceTables::rgb555, space3d.h:121) as linear RGB, as glTF's colour factors are. */
function rgb555(colour: number): [number, number, number] {
  return [linear(((colour >> 10) & 31) / 31), linear(((colour >> 5) & 31) / 31), linear((colour & 31) / 31)];
}

/** A face's corners, turned if need be so glTF's front (counter-clockwise) faces the way the face's stored normal does. */
export function wound(part: SpacePart, face: number): [number, number, number] {
  const [a, b, c] = part.faces[face]!.vertices;
  const n = part.faceNormals[face];
  if (!n) return [a, b, c];
  const p = part.vertices[a]!;
  const q = part.vertices[b]!;
  const r = part.vertices[c]!;
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  return cross[0]! * n[0] + cross[1]! * n[1] + cross[2]! * n[2] < 0 ? [a, c, b] : [a, b, c];
}

/** A texture's indices in the space palette as RGBA PNG bytes; keyed, colour 0 is see-through (kMaterialKeyed, space3d.h:71). */
export function pngOf(t: SpaceTexture, palette: Uint8Array, keyed: boolean): Uint8Array {
  const png = new PNG({ width: t.width, height: t.height });
  for (let i = 0; i < t.pixels.length; i++) {
    const c = t.pixels[i]!;
    png.data[i * 4] = palette[c * 3]!;
    png.data[i * 4 + 1] = palette[c * 3 + 1]!;
    png.data[i * 4 + 2] = palette[c * 3 + 2]!;
    png.data[i * 4 + 3] = keyed && c === 0 ? 0 : 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

export interface SpaceGltfInput {
  key: string;
  model: SpaceModelFile;
  /** The materials it's drawn with, or null (generic debris takes the dying ship's). */
  materials: SpaceMaterialDef[] | null;
  materialsName: string | null;
  /** A texture by the name its material gives (any case), or null if the export lacks it. */
  texture: (name: string) => SpaceTexture | null;
  /** The space palette (spacePalette): every texture is drawn in it. */
  palette: Uint8Array;
}

/** One model and its materials as a glTF document (Plan 18 R6): every vertex, face, part and material index kept. */
export function buildSpaceGltf(input: SpaceGltfInput): { doc: Document; warnings: string[] } {
  const { key, model, materials, materialsName, texture, palette } = input;
  const warnings: string[] = [];
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(key);
  doc.getRoot().setDefaultScene(scene);
  const root = doc.createNode(`model:${key}`).setRotation(ROOT_ROTATION)
    .setExtras({ name: model.name, size: model.size, centre: model.centre, hidden: model.hidden, materials: materialsName });
  scene.addChild(root);

  const images = new Map<string, Texture | null>();
  const image = (name: string, keyed: boolean): Texture | null => {
    const id = `${name.toLowerCase()}|${keyed}`;
    if (!images.has(id)) {
      const t = texture(name);
      if (!t || t.width === 0 || t.height === 0) warnings.push(`${key}: no texture ${name}`);
      images.set(id, t && t.width > 0 && t.height > 0 ? doc.createTexture(name.toLowerCase()).setImage(pngOf(t, palette, keyed)).setMimeType('image/png') : null);
    }
    return images.get(id)!;
  };
  const made = new Map<string, Material>();
  const material = (index: number, twoSided: boolean): Material => {
    const id = `${index}:${twoSided}`;
    const found = made.get(id);
    if (found) return found;
    const m = doc.createMaterial(`m${index}${twoSided ? ':2' : ''}`).setDoubleSided(twoSided).setMetallicFactor(0).setRoughnessFactor(1);
    const def = materials?.[index];
    if (!def) {
      m.setBaseColorFactor([0.5, 0.5, 0.5, 1]).setExtras({ index, missing: true });
      if (materials) warnings.push(`${key}: no material ${index} in ${materialsName}`);
    } else {
      const type = materialType(def);
      const opacity = def.alpha > 0 ? Math.max(0, Math.min(1, 1 - def.alpha / 0x4000)) : 1;
      m.setBaseColorFactor([...rgb555(def.colour), opacity]).setExtras({ index, colour: def.colour, alpha: def.alpha, flags: def.flags, type, texture: def.texture });
      const keyed = type === MATERIAL.keyed;
      const tex = hasTexture(def) ? image(def.texture, keyed) : null;
      if (tex) m.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, opacity]);
      if (opacity < 1) m.setAlphaMode('BLEND');
      else if (keyed && tex) m.setAlphaMode('MASK').setAlphaCutoff(0.5);
    }
    made.set(id, m);
    return m;
  };

  model.parts.forEach((part, i) => {
    const node = doc.createNode(`part:${i}`).setExtras({
      part: i, billboard: part.billboard, hidden: model.hidden[i] ?? 0, faceType: part.faceType, faceNormals: part.faceNormals.flat(), faceD: part.faceD,
    });
    root.addChild(node);
    if (part.faces.length === 0) return;
    for (const f of part.faces) {
      for (const v of f.vertices) if (v >= part.vertices.length) throw new Error(`${key}: part ${i} has a face on vertex ${v}, past its ${part.vertices.length}`);
    }
    const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(part.vertices.flat())).setBuffer(buffer);
    const normal = part.vertexNormals.length === part.vertices.length
      ? doc.createAccessor().setType('VEC3').setArray(new Float32Array(part.vertexNormals.flat())).setBuffer(buffer) : null;
    // (16.16 fixed point, 0 to 1)
    const uv = part.u.length === part.vertices.length
      ? doc.createAccessor().setType('VEC2').setArray(new Float32Array(part.u.flatMap((u, j) => [u / 65536, part.v[j]! / 65536]))).setBuffer(buffer) : null;
    const groups = new Map<string, { material: number; twoSided: boolean; faces: number[] }>();
    part.faces.forEach((f, j) => {
      const g = `${f.material}:${f.twoSided}`;
      if (!groups.has(g)) groups.set(g, { material: f.material, twoSided: f.twoSided, faces: [] });
      groups.get(g)!.faces.push(j);
    });
    const mesh = doc.createMesh(`part:${i}`);
    for (const g of groups.values()) {
      const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.faces.flatMap(j => wound(part, j)))).setBuffer(buffer);
      const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices)
        .setMaterial(material(g.material, g.twoSided)).setExtras({ faces: g.faces, material: g.material, twoSided: g.twoSided });
      if (normal) prim.setAttribute('NORMAL', normal);
      if (uv) prim.setAttribute('TEXCOORD_0', uv);
      mesh.addPrimitive(prim);
    }
    node.setMesh(mesh);
  });
  return { doc, warnings };
}
