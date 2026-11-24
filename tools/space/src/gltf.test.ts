// SPDX-License-Identifier: GPL-3.0-or-later
import { NodeIO } from '@gltf-transform/core';
import { parseSpaceMaterials, parseSpaceModel, type SpaceTexture } from '@another-unity/lift/space';
import { makeSpaceMaterials, makeSpaceModel } from '@another-unity/lift/testing/space';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { buildSpaceGltf, ROOT_ROTATION, wound } from './gltf';

const palette = Uint8Array.from({ length: 768 }, (_, i) => i % 256);
const texture: SpaceTexture = { width: 2, height: 1, pixels: Uint8Array.of(0, 5), palette: new Uint8Array(768) };
const model = parseSpaceModel(makeSpaceModel({
  name: 'ZAP.TXT', size: [10, 20, 30], hidden: [0, 1],
  parts: [
    {
      vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], uv: [[0, 0], [65536, 0], [0, 65536]],
      // (the third face's corners run against its normal)
      faces: [{ material: 0, v: [0, 1, 2] }, { material: 1, twoSided: true, v: [0, 1, 2] }, { material: 0, v: [2, 1, 0] }],
      faceNormals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
    },
    { vertices: [[0, 0, 0]], faces: [], billboard: true },
  ],
}))!;
const materials = parseSpaceMaterials(makeSpaceMaterials([{ colour: 0x7c00, flags: 1, texture: 'ZAP.IMG' }, { flags: 2, texture: 'ZAP.IMG' }]));
const build = () => buildSpaceGltf({ key: 'zap.3dv', model, materials, materialsName: 'zap.mtl', texture: n => (n.toLowerCase() === 'zap.img' ? texture : null), palette });
const root = (b: ReturnType<typeof build>) => b.doc.getRoot().listScenes()[0]!.listChildren()[0]!;

describe('buildSpaceGltf (Plan 18 R6)', () => {
  it('keeps every vertex as the file has it, under a root turned 180 degrees about z: nothing mirrored, the nose on +Z, down on -Y (Review Focus 1)', () => {
    const r = root(build());
    expect(r.getRotation()).toEqual(ROOT_ROTATION);
    const [x, y, z, w] = ROOT_ROTATION;
    const m = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
    // (x right becomes -X, glTF's right; y down becomes -Y; z forward stays +Z, glTF's front; the determinant is +1)
    expect(m).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
    const prim = r.listChildren()[0]!.getMesh()!.listPrimitives()[0]!;
    expect(Array.from(prim.getAttribute('POSITION')!.getArray()!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(prim.getAttribute('TEXCOORD_0')!.getArray()!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(r.getExtras()).toMatchObject({ name: 'ZAP.TXT', size: [10, 20, 30], hidden: [0, 1], materials: 'zap.mtl' });
  });

  it('groups faces by material and sidedness, keeps their original indices, and turns a face that disagrees with its normal', () => {
    const r = root(build());
    const part = r.listChildren()[0]!;
    const prims = part.getMesh()!.listPrimitives();
    expect(prims.map(p => p.getExtras())).toEqual([{ faces: [0, 2], material: 0, twoSided: false }, { faces: [1], material: 1, twoSided: true }]);
    expect(Array.from(prims[0]!.getIndices()!.getArray()!)).toEqual([0, 1, 2, 2, 0, 1]);
    expect(wound(model.parts[0]!, 2)).toEqual([2, 0, 1]);
    expect(prims[1]!.getMaterial()!.getDoubleSided()).toBe(true);
    expect(part.getExtras()).toMatchObject({ part: 0, billboard: false, hidden: 0, faceType: 2 });
    expect(r.listChildren()[1]!.getExtras()).toMatchObject({ part: 1, billboard: true, hidden: 1 });
    expect(r.listChildren()[1]!.getMesh()).toBeNull();
  });

  it('draws textures in the space palette, not their own; only a keyed material makes colour 0 see-through (Review Focus 2)', () => {
    const mats = build().doc.getRoot().listMaterials();
    const textured = mats.find(m => m.getName() === 'm0')!;
    const keyed = mats.find(m => m.getName() === 'm1:2')!;
    expect(textured.getAlphaMode()).toBe('OPAQUE');
    expect(keyed.getAlphaMode()).toBe('MASK');
    expect(textured.getExtras()).toMatchObject({ index: 0, colour: 0x7c00, flags: 1, type: 1, texture: 'ZAP.IMG' });
    const rgba = (m: typeof textured) => Array.from(PNG.sync.read(Buffer.from(m.getBaseColorTexture()!.getImage()!)).data);
    // (colour 5 of the space palette is 15, 16, 17; the texture's own palette is all zeros)
    expect(rgba(textured)).toEqual([0, 1, 2, 255, 15, 16, 17, 255]);
    expect(rgba(keyed)).toEqual([0, 1, 2, 0, 15, 16, 17, 255]);
  });

  it('gives a missing material a grey stand-in and says so, and refuses a face on a vertex its part lacks', () => {
    const { doc, warnings } = buildSpaceGltf({ key: 'zap.3dv', model, materials: materials.slice(0, 1), materialsName: 'zap.mtl', texture: () => texture, palette });
    expect(doc.getRoot().listMaterials().find(m => m.getName() === 'm1:2')!.getExtras()).toEqual({ index: 1, missing: true });
    expect(warnings).toEqual(['zap.3dv: no material 1 in zap.mtl']);
    const broken = { ...model, parts: [{ ...model.parts[0]!, faces: [{ material: 0, twoSided: false, vertices: [0, 1, 7] as [number, number, number] }] }] };
    expect(() => buildSpaceGltf({ key: 'bad.3dv', model: broken, materials, materialsName: 'zap.mtl', texture: () => texture, palette })).toThrow(/vertex 7/);
  });

  it('writes a .glb that reads back', async () => {
    const io = new NodeIO();
    const back = await io.readBinary(await io.writeBinary(build().doc));
    expect(back.getRoot().listNodes().map(n => n.getName())).toEqual(['model:zap.3dv', 'part:0', 'part:1']);
  });
});
