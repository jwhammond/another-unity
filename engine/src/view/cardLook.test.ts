// SPDX-License-Identifier: GPL-3.0-or-later
import { Mesh, MeshBasicMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import type { ArtLoaders, CardArt } from './art';
import { makeDissolvable } from './beam';
import { BRIDGE_LOOK, BRIDGE_SHADOWS } from './bridgeLook';
import { applyLook, setCell, shadowMesh, type CardLook } from './cardLook';
import { loadShipPlate } from './shipPlate';

const LOOK: CardLook = { lift: [0.1, 0.1, 0.1], gain: [1, 0.9, 0.8], saturation: 0.8, feather: 3, erode: 0.4 };
const sized = (w: number, h: number): Texture => {
  const t = new Texture();
  t.image = { width: w, height: h };
  return t;
};
const loaders: ArtLoaders = { texture: async url => (url.startsWith('pad') ? sized(392 * 4, 1128) : sized(2560, 1920)), model: async () => { throw new Error('no model'); } };
const plate = { kind: 'plate' as const, plate: 'plate.webp', areas: {}, crew: [] };
const strip = { url: 'pad.strip', frames: 4, cell: [392, 1128] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100, 100, 100], loop: true };
const art: CardArt = { url: 'card.webp', frames: 1, anchor: [0.5, 1], pixelHeight: 282, anims: { 0: strip } };

/** The shader a material would compile to: its onBeforeCompile run over a stand-in of MeshBasicMaterial's. */
function compiled(material: MeshBasicMaterial) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '', fragmentShader: 'void main() {\n#include <map_fragment>\n#include <opaque_fragment>\n}' };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

describe('a card look', () => {
  it('feathers the alpha within the frame, grades the colours in linear light, and keeps its own program', () => {
    const m = new MeshBasicMaterial();
    applyLook(m, LOOK);
    const s = compiled(m);
    expect(s.fragmentShader).not.toContain('#include <map_fragment>');
    expect(s.fragmentShader).toContain('clamp( vMapUv');
    expect(s.fragmentShader).toContain('smoothstep( uErode, 1.0, edge )');
    // (the lift is given in sRGB and drawn in linear: 0.1 is about 0.01)
    expect((s.uniforms.uLift!.value as number[])[0]).toBeCloseTo(0.01, 3);
    expect(s.uniforms.uGain!.value).toEqual([1, 0.9, 0.8]);
    expect(m.customProgramCacheKey()).toBe('au-card-look');
  });

  it("follows the frame the strip shows: its cell and the strip's texel", () => {
    const u = applyLook(new MeshBasicMaterial(), LOOK);
    const t = sized(1600, 1000);
    t.repeat.set(0.25, 1);
    t.offset.set(0.5, 0);
    setCell(u, t);
    expect(u.uCell.value).toEqual([0.5, 0, 0.75, 1]);
    expect(u.uTexel.value).toEqual([1 / 1600, 1 / 1000]);
  });

  it('keeps its change when the beam makes the card dissolvable, and the two have their own program', () => {
    const mesh = new Mesh(undefined, new MeshBasicMaterial());
    applyLook(mesh.material, LOOK);
    makeDissolvable(mesh);
    const s = compiled(mesh.material);
    expect(s.fragmentShader).toContain('uErode');
    expect(s.fragmentShader).toContain('uDissolve');
    expect(mesh.material.customProgramCacheKey()).toBe('au-card-look|dissolve');
  });

  it("puts a shadow at the card's feet, moved by where the feet are in its frame, at the card's scale", () => {
    const m = shadowMesh({ width: 40, height: 8, opacity: 0.5, dx: 3, dy: -5 }, [100, 300], 0.5);
    expect([m.scale.x, m.scale.y]).toEqual([20, 4]);
    expect([m.position.x, m.position.y]).toEqual([101.5, -297.5]);
    expect(m.material.opacity).toBe(0.5);
  });
});

describe('the plate with a card set into it', () => {
  it('draws its shadow just under it, keeps the look on each frame, and takes both away with the card', async () => {
    const set = await loadShipPlate(plate, loaders);
    await set.placeCards([{ key: 'riker', art, at: [133, 354], depth: -10, anim: 0, look: LOOK, shadow: { width: 50, height: 9, opacity: 0.5, dy: -11 } }]);
    const card = set.card('riker') as Mesh<never, MeshBasicMaterial>;
    const shadow = set.node('shadow:riker') as Mesh;
    expect(shadow.renderOrder).toBe(card.renderOrder - 0.5);
    expect(shadow.position.y).toBeCloseTo(-343);
    const u = compiled(card.material).uniforms;
    expect(u.uCell!.value).toEqual([0, 0, 0.25, 1]);
    set.update(0.15);
    expect(u.uCell!.value).toEqual([0.25, 0, 0.5, 1]);
    set.removeCards(['riker']);
    expect(set.node('shadow:riker')).toBeUndefined();
  });

  it('a card with no look is drawn as published', async () => {
    const set = await loadShipPlate(plate, loaders);
    await set.placeCards([{ key: 'p', art, at: [100, 300], depth: 0, anim: 0 }]);
    expect(compiled((set.card('p') as Mesh<never, MeshBasicMaterial>).material).fragmentShader).toContain('#include <map_fragment>');
    expect(set.node('shadow:p')).toBeUndefined();
  });
});

describe("the bridge's look", () => {
  it('has a shadow for each of the five on the bridge', () => {
    expect(Object.keys(BRIDGE_SHADOWS).sort()).toEqual(['data', 'picard', 'riker', 'troi', 'worf']);
    expect(BRIDGE_LOOK.feather).toBeGreaterThan(0);
  });
});
