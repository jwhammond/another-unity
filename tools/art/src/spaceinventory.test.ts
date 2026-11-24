// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { miniCombat } from '../../../engine/src/testing/combat';
import { encodePng } from './image';
import { spaceInventory } from './spaceinventory';

/** A made-up .glb: one triangle per [material index, texture name], each texture 4 x 4, the triangle on its left half. */
async function glb(materials: [number, string][]): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh();
  for (const [index, name] of materials) {
    const tex = doc.createTexture(name).setImage(encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(200) })).setMimeType('image/png');
    const m = doc.createMaterial().setBaseColorTexture(tex).setExtras({ index, texture: name.toUpperCase() });
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 0.5, 0, 0, 1])).setBuffer(buffer);
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', uv).setMaterial(m).setExtras({ material: index }));
  }
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

describe('the combat textures the art finds (Plan 30 R8, R14)', () => {
  it('names each texture once, with its islands, the kinds and effects that draw it, and a damage texture\'s base', async () => {
    // (miniCombat: kinds 0-2 draw mini.3dv, .3dr and .dmg; the effects their own models. The detailed model's material 1 is hull,
    // which the damaged model's material 1 replaces with scorch; the shields draw glow)
    const combat = miniCombat();
    const files: Record<string, [number, string][]> = { 'space/mini.3dv.glb': [[0, 'trim.gif'], [1, 'hull.gif']], 'space/mini.3dr.glb': [[0, 'trim.gif']], 'space/mini.dmg.glb': [[0, 'trim.gif'], [1, 'scorch.gif']], 'space/shield_1.3dv.glb': [[0, 'glow.gif']] };
    const inv = await spaceInventory(combat, async url => (files[url] ? glb(files[url]!) : null));
    expect([...inv.textures.keys()].sort()).toEqual(['glow.gif', 'hull.gif', 'scorch.gif', 'trim.gif']);
    const kinds = combat.kinds.flatMap((k, t) => (k?.models.detail ? [t] : []));
    expect(inv.textures.get('hull.gif')).toMatchObject({ kinds, effect: false });
    expect(inv.textures.get('scorch.gif')).toMatchObject({ base: 'hull.gif' });
    expect(inv.textures.get('trim.gif')!.base).toBeUndefined();
    expect(inv.textures.get('glow.gif')).toMatchObject({ kinds: [], effect: true });
    // (the triangle's texels: its corners' columns 0-1, the rows its left half covers)
    expect([...inv.textures.get('hull.gif')!.islands].reduce((n, v) => n + v, 0)).toBeGreaterThan(0);
    expect(inv.missing).toContain('phaser.3dv');
    expect(inv.models.size).toBe(4);
  });
});
