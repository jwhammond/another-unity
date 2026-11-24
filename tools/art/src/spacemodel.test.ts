// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { encodePng } from './image';
import { readSpaceModel, textureWorkSize, uvIslandMask, withAlphaOf } from './spacemodel';

/** A made-up model: one quad on a keyed 4 x 4 texture "Q.GIF" (its top-left texel clear), one flat triangle. */
async function glb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pixels = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(200) };
  pixels.data[3] = 0;
  const tex = doc.createTexture('q.gif').setImage(encodePng(pixels)).setMimeType('image/png');
  const keyed = doc.createMaterial('m0').setBaseColorTexture(tex).setAlphaMode('MASK').setExtras({ index: 0, texture: 'Q.GIF' });
  const flat = doc.createMaterial('m1').setExtras({ index: 1, colour: 3 });
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0])).setBuffer(buffer);
  const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])).setBuffer(buffer);
  const quad = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', uv).setMaterial(keyed).setExtras({ material: 0 })
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 0, 2, 3])).setBuffer(buffer));
  const tri = doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(flat)
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2])).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode('part:0').setMesh(doc.createMesh().addPrimitive(quad).addPrimitive(tri)));
  return new NodeIO().writeBinary(doc);
}

describe('a combat model for the art (Plan 30)', () => {
  it('reads each triangle\'s corners, texture coordinates, texture and key, and each texture once, by its lower-case name', async () => {
    const m = await readSpaceModel(await glb());
    expect(m.triangles.map(t => [t.texture, t.material, t.keyed, t.positions.length, t.uvs[1]])).toEqual([['q.gif', 0, true, 3, [1, 0]], ['q.gif', 0, true, 3, [1, 1]], [null, -1, false, 3, [0, 0]]]);
    expect([...m.textures.keys()]).toEqual(['q.gif']);
    expect([m.textures.get('q.gif')!.width, m.textures.get('q.gif')!.data[3]]).toEqual([4, 0]);
  });
});

describe('the UV islands (Plan 30 R8)', () => {
  it('marks the texels a triangle covers, and grows them by a texel', () => {
    // (the lower-left half of an 8 x 8 texture: the texels whose centre is on or below the diagonal)
    const half = uvIslandMask(8, 8, [[[0, 0], [0, 1], [1, 1]]], 0);
    expect([half[0], half[7], half[7 * 8], half[7 * 8 + 7], half[1]]).toEqual([1, 0, 1, 1, 0]);
    expect(half.reduce((n, v) => n + v, 0)).toBe(36);
    // (a sliver smaller than a texel still marks its corners' texels; grown by one, their neighbours)
    const sliver = uvIslandMask(8, 8, [[[0.51, 0.51], [0.52, 0.51], [0.51, 0.52]]], 0);
    expect(sliver.reduce((n, v) => n + v, 0)).toBe(1);
    expect(uvIslandMask(8, 8, [[[0.51, 0.51], [0.52, 0.51], [0.51, 0.52]]], 1).reduce((n, v) => n + v, 0)).toBe(5);
  });

  it('clamps coordinates outside 0 to 1 to the edge texels, as the original does (space3d.cpp:430-431)', () => {
    const m = uvIslandMask(4, 4, [[[-1, -1], [-0.5, -1], [-1, -0.5]]], 0);
    expect([m[0], m.reduce((n, v) => n + v, 0)]).toEqual([1, 1]);
  });
});

describe('the repaint\'s alpha and work size (Plan 30 R8)', () => {
  it('gives a 4x picture the original\'s alpha, nearest, and refuses another size', () => {
    const from = { width: 2, height: 1, data: Uint8Array.from([0, 0, 0, 0, 9, 9, 9, 255]) };
    const big = { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4).fill(100) };
    const a = withAlphaOf(big, from, 4);
    expect([a.data[3], a.data[(3 * 8 + 3) * 4 + 3], a.data[(3 * 8 + 4) * 4 + 3], a.data[0]]).toEqual([0, 0, 255, 100]);
    expect(() => withAlphaOf(big, from, 2)).toThrow('is not 2 times');
  });

  it('works at about a megapixel in multiples of 64, at least 512 a side, never under the upscale', () => {
    expect(textureWorkSize(128, 128)).toEqual([1024, 1024]);
    expect(textureWorkSize(25, 85)).toEqual([576, 1920]);
    expect(textureWorkSize(410, 410)).toEqual([1664, 1664]);
    expect(textureWorkSize(8, 2)).toEqual([2048, 512]);
  });
});
