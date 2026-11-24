// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3 } from '@another-unity/engine';
import { ByteReader, orNull } from './reader';

export interface SpaceFace { material: number; twoSided: boolean; vertices: [number, number, number] }
export interface SpacePart {
  /** A negative vertex count: the part always faces the camera. */
  billboard: boolean;
  /** 2 is triangles; other parts are kept empty, as load keeps them. */
  faceType: number;
  vertices: Vec3[];
  /** 16.16, 0 to 1; empty without a uv table. */
  u: number[]; v: number[];
  faces: SpaceFace[];
  vertexNormals: Vec3[]; faceNormals: Vec3[]; faceD: number[];
}
export interface SpaceModelFile { name: string; size: Vec3; centre: Vec3; hidden: number[]; parts: SpacePart[] }

/** A .3dv, .3dr or .pcN as SpaceModel::load reads it (space3d.cpp:117-195), or null where load returns false. */
export function parseSpaceModel(bytes: Uint8Array): SpaceModelFile | null {
  return orNull(() => {
    const r = new ByteReader(bytes);
    r.u32();
    if (r.u16() !== 0x6e) return null;
    r.skip(4);
    const name = r.cstring(20);
    // the rest is a block of memory, with offsets from its start
    const base = 0x1e;
    r.seek(base + 4);
    const numParts = r.s32();
    if (numParts <= 0) return null;
    const partTable = r.u32();
    r.u32();
    const vec = (): Vec3 => [r.f32(), r.f32(), r.f32()];
    const size = vec();
    const centre = vec();
    const hiddenOffset = r.u32();
    r.seek(base + hiddenOffset);
    const hidden: number[] = [];
    for (let i = 0; i < numParts; i++) hidden.push(r.u8());
    const parts: SpacePart[] = [];
    for (let i = 0; i < numParts; i++) {
      r.seek(base + partTable + i * 0x2c);
      const signedVertices = r.s32();
      const numFaces = r.s32();
      const faceType = r.s32();
      const offsets: number[] = [];
      for (let j = 0; j < 8; j++) offsets.push(r.u32());
      const part: SpacePart = { billboard: signedVertices < 0, faceType, vertices: [], u: [], v: [], faces: [], vertexNormals: [], faceNormals: [], faceD: [] };
      const numVertices = Math.abs(signedVertices);
      // (only triangles are used)
      if (faceType !== 2) {
        parts.push(part);
        continue;
      }
      r.seek(base + offsets[0]!);
      for (let j = 0; j < numVertices; j++) part.vertices.push(vec());
      if (offsets[1]) {
        r.seek(base + offsets[1]);
        for (let j = 0; j < numVertices; j++) {
          part.u.push(r.s32());
          part.v.push(r.s32());
        }
      }
      r.seek(base + offsets[4]!);
      for (let j = 0; j < numFaces; j++) {
        const material = r.u16();
        part.faces.push({ material: material & 0x7fff, twoSided: (material & 0x8000) !== 0, vertices: [r.u16(), r.u16(), r.u16()] });
      }
      r.seek(base + offsets[5]!);
      for (let j = 0; j < numVertices; j++) part.vertexNormals.push(vec());
      r.seek(base + offsets[6]!);
      for (let j = 0; j < numFaces; j++) part.faceNormals.push(vec());
      r.seek(base + offsets[7]!);
      for (let j = 0; j < numFaces; j++) part.faceD.push(r.f32());
      parts.push(part);
    }
    return { name, size, centre, hidden, parts };
  });
}
