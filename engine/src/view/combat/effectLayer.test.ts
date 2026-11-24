// SPDX-License-Identifier: GPL-3.0-or-later
import { AdditiveBlending, BufferAttribute, DoubleSide, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, ShaderLib, Vector3, type InstancedBufferAttribute, MeshBasicMaterial, MeshStandardMaterial, Texture, type BufferGeometry as Geometry, type Material, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { miniCombat } from '../../testing/combat';
import { fromAngles, v3, type M3 } from '../../sim/combat/math';
import type { CameraPose } from '../../sim/combat/types';
import type { BattleAssets, LoadedSprite } from './assets';
import { modelMatrix } from './axes';
import { BLOOM_LAYER } from './bloom';
import { clipTarget, EffectLayer } from './effectLayer';
import { frameUv, type EffectDraw } from './effects';

/**
 * A one-part model as GLTFLoader gives the space build's: the part's node (`billboard` and `hidden` as the file says) is
 * its mesh, of these vertices in one material, as every effect model's one part is one primitive (the loader makes a
 * one-primitive node its Mesh); `grouped`, a part of several primitives: a Group holding its meshes.
 */
function model(vertices: number[][], material: { index: number; texture?: string; map?: Texture; opacity?: number }, billboard = false, o: { grouped?: boolean; hidden?: boolean } = {}): Object3D {
  const root = new Group();
  // (the root's extras list every part's hidden flag, as the space build writes them; a part's own says whether it is)
  root.userData = { hidden: [o.hidden ? 1 : 0] };
  const extras = { part: 0, billboard, hidden: o.hidden ? 1 : 0 };
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices.flat()), 3));
  geometry.setIndex([0, 1, 2]);
  const m = new MeshStandardMaterial({ map: material.map ?? null, transparent: (material.opacity ?? 1) < 1, opacity: material.opacity ?? 1 });
  m.userData = { index: material.index, texture: material.texture ?? '' };
  const mesh = new Mesh(geometry, m);
  if (o.grouped) {
    const part = new Group();
    part.userData = extras;
    part.add(mesh);
    root.add(part);
  } else {
    mesh.userData = extras;
    root.add(mesh);
  }
  return root;
}
/** A model's first mesh, whichever way its part is nested. */
const meshOf = (o: Object3D): Mesh => {
  let found: Mesh | undefined;
  o.traverse(n => { if (!found && (n as Mesh).isMesh) found = n as Mesh; });
  return found!;
};
const sheet = (frames: number): LoadedSprite => ({ frames, columns: frames, cell: [100, 5], palette: 'space', entries: [], texture: new Texture() });

/** A set with the effects' models (as miniCombat names them: phaser, photon, bboard, the shields, generic debris) and the ship's. */
function assets(): BattleAssets {
  const models = new Map<string, Object3D>([
    ['phaser.3dv', model([[0, 0, 256], [10, 0, 0], [-10, 0, 0]], { index: 0, texture: 'PHASER1.LBM', map: new Texture() })],
    ['bboard.3dv', model([[320, -240, -1], [-320, -240, -1], [0, 240, -1]], { index: 0, texture: 'BOOM.LBM', map: new Texture() }, true)],
    ['shield_2.3dv', model([[0, 0, 0], [100, 0, 0], [0, 100, 30]], { index: 0, texture: 'SHIELD.LBM', map: new Texture(), opacity: 0.75 })],
    ['generic.pc1', model([[0, 0, 500], [10, 0, 500], [0, 10, 500]], { index: 1 })],
    ['mini.3dv', model([[0, 0, 0], [1, 0, 0], [0, 1, 0]], { index: 1, map: new Texture() })],
  ]);
  const sprites = new Map<string, LoadedSprite>([['__phaser.spr', sheet(7)], ['__boom.spr', sheet(8)], ['__shield.spr', sheet(5)]]);
  return { list: { models: [...models.keys()], sprites: [...sprites.keys()] }, models, sprites, stills: null, missing: [], textures: [], dispose: () => {} };
}
/** A camera at the origin looking along internal z (forward), unturned. */
const CAM: CameraPose = { pos: v3(), axes: fromAngles(0, 0, 0) };
const I: M3 = fromAngles(0, 0, 0);
const draw = (o: Partial<EffectDraw> & Pick<EffectDraw, 'kind' | 'model'>): EffectDraw => ({
  key: o.kind, pos: v3(0, 0, 5000), m: I, scale: 1, sprite: null, frame: 0, texture: null, tip: null, alpha: -1, ship: 1, aim: null, borrow: null, ...o,
});
const meshesOf = (layer: EffectLayer) => {
  const out: Mesh[] = [];
  layer.group.traverseVisible(o => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
};
const position = (g: Geometry) => Array.from((g.getAttribute('position') as BufferAttribute).array.slice(0, 3));

describe('EffectLayer (Combat::drawEffects and render, combat.cpp:964-1003, 1058-1077)', () => {
  it('draws a beam with its first vertex on the tip, in its geometry of its own, the sprite\'s frame in place of phaser1.lbm', () => {
    const set = assets();
    const layer = new EffectLayer(set, miniCombat());
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', sprite: '__phaser.spr', frame: 3, texture: 'phaser1.lbm', tip: v3(0, 0, 4790) })], CAM, false);
    const [mesh] = meshesOf(layer);
    const source = meshOf(set.models.get('phaser.3dv')!);
    expect(position(mesh!.geometry)).toEqual([0, 0, 4790]);
    // (the set's untouched)
    expect([mesh!.geometry !== source.geometry, position(source.geometry)]).toEqual([true, [0, 0, 256]]);
    const m = mesh!.material as MeshBasicMaterial;
    // (the modern look: unlit and additive, Decision 13; the frame a clone of the sheet's texture, at frame 3's cell)
    expect([m.blending, m.depthWrite, m.map!.source]).toEqual([AdditiveBlending, false, set.sprites.get('__phaser.spr')!.texture.source]);
    expect([m.map!.offset.toArray(), m.map!.repeat.toArray()]).toEqual(Object.values(frameUv(set.sprites.get('__phaser.spr')!, 3)));
    // (no tip yet: the model's own first vertex)
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', sprite: '__phaser.spr', texture: 'phaser1.lbm' })], CAM, false);
    expect(position(mesh!.geometry)).toEqual([0, 0, 256]);
  });

  it('turns a billboard to the camera, scaled (weapons.cpp:132-136), and draws a shield turned by its angles at its material\'s opacity', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    const cam: CameraPose = { pos: v3(100, 0, 0), axes: fromAngles(0x200, 0x100, 0) };
    const shield = fromAngles(0x2000, 0x100, 0);
    layer.update([
      draw({ kind: 'explosion', model: 'bboard.3dv', scale: 0.25, sprite: '__boom.spr', texture: 'boom.lbm' }),
      draw({ kind: 'shield', model: 'shield_2.3dv', m: shield, scale: 0.5, sprite: '__shield.spr', texture: 'shield.lbm' }),
    ], cam, false);
    const [boom, guard] = layer.group.children as Group[];
    expect(boom!.matrix.elements).toEqual(modelMatrix(v3(0, 0, 5000), cam.axes, new Matrix4(), 0.25).elements);
    expect(guard!.matrix.elements).toEqual(modelMatrix(v3(0, 0, 5000), shield, new Matrix4(), 0.5).elements);
    expect((meshesOf(layer)[1]!.material as Material).opacity).toBe(0.75);
  });

  it('draws the original\'s look in the parity mode: the set\'s material copied, keyed or translucent, lit, with the frame', () => {
    const set = assets();
    const layer = new EffectLayer(set, miniCombat());
    layer.update([draw({ kind: 'explosion', model: 'bboard.3dv', sprite: '__boom.spr', frame: 2, texture: 'boom.lbm' })], CAM, true);
    const m = meshesOf(layer)[0]!.material as MeshStandardMaterial;
    expect(m).toBeInstanceOf(MeshStandardMaterial);
    expect(m === meshOf(set.models.get('bboard.3dv')!).material).toBe(false);
    expect(m.map!.source).toBe(set.sprites.get('__boom.spr')!.texture.source);
  });

  it('fades a debris piece by its alpha in its dying ship\'s materials when it has none of its own, and draws nothing from 0x4000', () => {
    const set = assets();
    const layer = new EffectLayer(set, miniCombat());
    const piece = draw({ kind: 'debris', model: 'generic.pc1', alpha: 0x1000, borrow: 'mini.3dv' });
    layer.update([piece], CAM, false);
    const m = meshesOf(layer)[0]!.material as MeshStandardMaterial;
    // (a copy of mini.3dv's material 1, with its texture, three quarters opaque)
    expect([m.map, m.opacity, m.transparent]).toEqual([(meshOf(set.models.get('mini.3dv')!) as Mesh & { material: MeshStandardMaterial }).material.map, 0.75, true]);
    layer.update([{ ...piece, alpha: 0x4000 }], CAM, false);
    expect(meshesOf(layer)).toEqual([]);
  });

  it('bounds a piece for the depth range by its box\'s centre and half diagonal, and culls by its extent as drawModel does', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    // (miniCombat's generic.pc1: 100 x 50 x 200 about the origin; 5000 deep)
    expect(layer.update([draw({ kind: 'debris', model: 'generic.pc1', scale: 2 })], CAM, false)).toEqual([{ z: 5000, size: Math.hypot(100, 50, 200) }]);
    // (behind the camera by more than its extent, 200 x 2: culled, and no sphere)
    expect(layer.update([draw({ kind: 'debris', model: 'generic.pc1', scale: 2, pos: v3(0, 0, -400) })], CAM, false)).toEqual([]);
  });

  it('frees an effect\'s own materials, textures and geometry as it ends, never the set\'s', () => {
    const set = assets();
    const layer = new EffectLayer(set, miniCombat());
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', sprite: '__phaser.spr', texture: 'phaser1.lbm', tip: v3(0, 0, 100) })], CAM, false);
    const mesh = meshesOf(layer)[0]!;
    let freed = 0;
    for (const o of [mesh.geometry, mesh.material as Material, (mesh.material as MeshBasicMaterial).map!]) o.addEventListener('dispose', () => { freed++; });
    let setFreed = 0;
    const source = meshOf(set.models.get('phaser.3dv')!);
    for (const o of [source.geometry, source.material as Material, set.sprites.get('__phaser.spr')!.texture]) o.addEventListener('dispose', () => { setFreed++; });
    layer.update([], CAM, false);
    expect([freed, setFreed, layer.group.children.length]).toEqual([3, 0, 0]);
  });

  it('draws the torpedoes of one model and sprite as one batch: each an instance turned to the camera, in its own frame (M8 spec §8)', () => {
    const set = assets();
    const photon = model([[30, -30, -1], [-30, -30, -1], [0, 30, -1]], { index: 0, texture: 'PHOTON.LBM', map: new Texture() }, true);
    // (as the space build roots a model: a half turn about z, which modelMatrix undoes)
    photon.quaternion.set(0, 0, 1, 0);
    set.models.set('photon.3dv', photon);
    set.sprites.set('__photon.spr', sheet(4));
    const layer = new EffectLayer(set, miniCombat());
    const cam: CameraPose = { pos: v3(100, 0, 0), axes: fromAngles(0x200, 0x100, 0) };
    const torpedo = (key: string, x: number, frame: number) => draw({ kind: 'torpedo', key, model: 'photon.3dv', pos: v3(x, 0, 5000), sprite: '__photon.spr', frame, texture: 'photon.lbm', ship: -1 });
    const spheres = layer.update([torpedo('a', 0, 1), torpedo('b', 500, 3), torpedo('c', 0, 2)], cam, false);
    const batches = layer.group.children.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh);
    expect([batches.length, batches[0]!.count, spheres.length, layer.placed().map(p => p.key)]).toEqual([1, 3, 3, ['a', 'b', 'c']]);
    // (instance 1 is where a holder placed by modelMatrix with the camera's axes puts the model: its vertices in the camera's own axes)
    const holder = new Group();
    holder.matrixAutoUpdate = false;
    modelMatrix(v3(500, 0, 5000), cam.axes, holder.matrix);
    const copy = photon.clone();
    holder.add(copy);
    holder.updateMatrixWorld(true);
    const at = new Matrix4();
    batches[0]!.getMatrixAt(1, at);
    expect(at.elements.map(n => Math.round(n * 1e4))).toEqual(meshOf(copy).matrixWorld.elements.map(n => Math.round(n * 1e4)));
    const frames = batches[0]!.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute;
    const uv = frameUv(set.sprites.get('__photon.spr')!, 3);
    expect([frames.getX(1), frames.getY(1), frames.getZ(1), frames.getW(1)]).toEqual([...uv.offset, ...uv.repeat].map(Math.fround));
    expect(batches[0]!.layers.isEnabled(BLOOM_LAYER)).toBe(true);
    // (none the next frame: the batch drawn with no instances)
    layer.update([], cam, false);
    expect(batches[0]!.visible).toBe(false);
    // (the parity mode's batch does not glow)
    layer.update([torpedo('a', 0, 1)], cam, true);
    const parity = layer.group.children.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh && o.visible);
    expect(parity.map(b => [b.count, b.layers.isEnabled(BLOOM_LAYER)])).toEqual([[1, false]]);
  });

  it('skips a model the set lacks, as the original skips a missing file, and remakes an effect when the parity mode is switched', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    expect(layer.update([draw({ kind: 'beam', model: 'photon.3dv' })], CAM, false)).toEqual([]);
    expect(layer.group.children).toHaveLength(0);
    const boom = draw({ kind: 'explosion', model: 'bboard.3dv', sprite: '__boom.spr', texture: 'boom.lbm' });
    layer.update([boom], CAM, false);
    const modern = meshesOf(layer)[0]!.material;
    layer.update([boom], CAM, true);
    expect([layer.group.children.length, meshesOf(layer)[0]!.material === modern, meshesOf(layer)[0]!.material instanceof MeshStandardMaterial]).toEqual([1, false, true]);
  });

  it('moves the tip of a beam whose part is several primitives (a Group of meshes) too', () => {
    const set = assets();
    set.models.set('phaser.3dv', model([[0, 0, 256], [10, 0, 0], [-10, 0, 0]], { index: 0, texture: 'PHASER1.LBM', map: new Texture() }, false, { grouped: true }));
    const layer = new EffectLayer(set, miniCombat());
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', sprite: '__phaser.spr', texture: 'phaser1.lbm', tip: v3(0, 0, 4790) })], CAM, false);
    expect(position(meshesOf(layer)[0]!.geometry)).toEqual([0, 0, 4790]);
  });

  it('says where a beam\'s far end is drawn, from its first vertex as placed (the space build\'s root rotation undone), and what it fires at', () => {
    const set = assets();
    // (as the space build makes it: the root a half turn about z, ROOT_ROTATION, which modelMatrix undoes)
    const phaser = model([[0, 0, 256], [10, 0, 0], [-10, 0, 0]], { index: 0, texture: 'PHASER1.LBM', map: new Texture() });
    phaser.rotation.z = Math.PI;
    set.models.set('phaser.3dv', phaser);
    const layer = new EffectLayer(set, miniCombat());
    const aim = { to: 2, kind: 'hit', stale: false, lag: null, at: v3(130, 30, 9790), radius: 50 } as const;
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', pos: v3(100, 50, 5000), tip: v3(30, -20, 4790), aim })], CAM, false);
    const round = (p: { x: number; y: number; z: number } | null) => [p!.x, p!.y, p!.z].map(n => Math.round(n * 1e6) / 1e6);
    expect(layer.placed()[0]!.aim).toBe(aim);
    expect(round(layer.ends()[0]!)).toEqual([130, 30, 9790]);
    // (no tip yet: the model's own first vertex, 256 ahead of the bank)
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', pos: v3(100, 50, 5000) })], CAM, false);
    expect(round(layer.ends()[0]!)).toEqual([100, 50, 5256]);
    // (an effect that isn't a beam has no far end)
    layer.update([draw({ kind: 'explosion', model: 'bboard.3dv', sprite: '__boom.spr', texture: 'boom.lbm' })], CAM, false);
    expect(layer.ends()).toEqual([null]);
  });

  it('never draws a part the model hides, its node a mesh or a group (SpaceModel::_hidden), alone or in a torpedo batch', () => {
    for (const grouped of [false, true]) {
      const set = assets();
      set.models.set('bboard.3dv', model([[320, -240, -1], [-320, -240, -1], [0, 240, -1]], { index: 0, texture: 'BOOM.LBM', map: new Texture() }, true, { grouped, hidden: true }));
      set.models.set('photon.3dv', model([[30, -30, -1], [-30, -30, -1], [0, 30, -1]], { index: 0, texture: 'PHOTON.LBM', map: new Texture() }, true, { grouped, hidden: true }));
      const layer = new EffectLayer(set, miniCombat());
      layer.update([
        draw({ kind: 'explosion', model: 'bboard.3dv', sprite: '__boom.spr', texture: 'boom.lbm' }),
        draw({ kind: 'torpedo', key: 't', model: 'photon.3dv', ship: -1 }),
      ], CAM, false);
      expect(meshesOf(layer), `grouped: ${grouped}`).toEqual([]);
    }
  });

  it('turns a one-primitive billboard part to the camera and draws both its faces (drawObject, space3d.cpp:300, 311)', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    const cam: CameraPose = { pos: v3(100, 0, 0), axes: fromAngles(0x200, 0x100, 0) };
    layer.update([draw({ kind: 'explosion', model: 'bboard.3dv', m: fromAngles(0x2000, 0, 0), sprite: '__boom.spr', texture: 'boom.lbm' })], cam, false);
    expect((layer.group.children[0] as Group).matrix.elements).toEqual(modelMatrix(v3(0, 0, 5000), cam.axes, new Matrix4(), 1).elements);
    expect((meshesOf(layer)[0]!.material as Material).side).toBe(DoubleSide);
  });

  it('frees a torpedo batch\'s instanced mesh as it grows, as the parity mode is switched, and as the layer is disposed', () => {
    const set = assets();
    set.models.set('photon.3dv', model([[30, -30, -1], [-30, -30, -1], [0, 30, -1]], { index: 0, texture: 'PHOTON.LBM', map: new Texture() }, true));
    const layer = new EffectLayer(set, miniCombat());
    const freed = new Map<InstancedMesh, number>();
    const watch = () => {
      for (const o of layer.group.children) {
        const m = o as InstancedMesh;
        if (!m.isInstancedMesh || freed.has(m)) continue;
        freed.set(m, 0);
        m.addEventListener('dispose', () => { freed.set(m, freed.get(m)! + 1); });
        m.geometry.addEventListener('dispose', () => { freed.set(m, freed.get(m)! + 10); });
      }
    };
    const salvo = (n: number) => Array.from({ length: n }, (_, i) => draw({ kind: 'torpedo', key: `t${i}`, model: 'photon.3dv', ship: -1 }));
    layer.update(salvo(1), CAM, false);
    watch();
    // (past the first batch's 8: a batch of 16 in its place, the first freed, mesh and geometry)
    layer.update(salvo(9), CAM, false);
    watch();
    expect([...freed.values()]).toEqual([11, 0]);
    // (the parity mode's batch in place of the modern one)
    layer.update(salvo(1), CAM, true);
    watch();
    expect([...freed.values()]).toEqual([11, 11, 0]);
    layer.dispose();
    expect([[...freed.values()], layer.group.children.length]).toEqual([[11, 11, 11], 0]);
  });

  it('frees every live effect\'s own objects as the layer is disposed', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    layer.update([draw({ kind: 'explosion', model: 'bboard.3dv', sprite: '__boom.spr', texture: 'boom.lbm' })], CAM, false);
    const m = meshesOf(layer)[0]!.material as MeshBasicMaterial;
    let freed = 0;
    for (const o of [m, m.map!]) o.addEventListener('dispose', () => { freed++; });
    layer.dispose();
    expect([freed, layer.group.children.length, layer.placed()]).toEqual([2, 0, []]);
  });

  it('makes a debris piece\'s materials translucent from its first frame, so its fade shows (a program compiled opaque never fades)', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    layer.update([draw({ kind: 'debris', model: 'generic.pc1', borrow: 'mini.3dv' })], CAM, false);
    const m = meshesOf(layer)[0]!.material as Material;
    expect([m.transparent, m.opacity]).toEqual([true, 1]);
  });

  it('clips a beam at z = 1 in front of the camera in the parity mode as drawPolygon does, the texels lerped with the corners (space3d.cpp:366-387)', () => {
    const set = assets();
    // (as built: the root a half turn about z, so a vertex is an internal step from the bank; texel coordinates of its own)
    const phaser = model([[0, 0, 256], [10, 0, 0], [-10, 0, 0]], { index: 0, texture: 'PHASER1.LBM', map: new Texture() });
    phaser.rotation.z = Math.PI;
    meshOf(phaser).geometry.setAttribute('uv', new BufferAttribute(new Float32Array([1, 0.5, 0, 0, 0, 1]), 2));
    set.models.set('phaser.3dv', phaser);
    const layer = new EffectLayer(set, miniCombat());
    // (the bank a step behind the camera, at depth -1, its tip 2000 ahead: battle 69's overview, the camera on the shooter)
    const beam = draw({ kind: 'beam', model: 'phaser.3dv', pos: v3(0, 0, -1), sprite: '__phaser.spr', texture: 'phaser1.lbm', tip: v3(0, 0, 2001) });
    layer.update([beam], CAM, true);
    const mesh = meshesOf(layer)[0]!;
    layer.group.updateMatrixWorld(true);
    const g = mesh.geometry;
    const count = g.index ? g.index.count : Math.min(g.drawRange.count, g.getAttribute('position').count);
    const p = g.getAttribute('position') as BufferAttribute, uv = g.getAttribute('uv') as BufferAttribute;
    const corners = Array.from({ length: count }, (_, i) => {
      const k = g.index ? g.index.getX(i) : i;
      const w = new Vector3(p.getX(k), p.getY(k), p.getZ(k)).applyMatrix4(mesh.matrixWorld);
      // (three's z back to internal: the camera at the origin looks along internal z, so -z is the depth)
      return { depth: Math.round(-w.z * 1e4) / 1e4, uv: [uv.getX(k), uv.getY(k)].map(n => Math.round(n * 1e5) / 1e5) };
    });
    // (the tip, then where its edges to the two corners behind cross z = 1, at 1999/2001 and 2/2001 of the way)
    const lerp = (a: number[], b: number[], s: number) => a.map((n, i) => Math.round((n + (b[i]! - n) * s) * 1e5) / 1e5);
    expect(corners).toEqual([
      { depth: 2000, uv: [1, 0.5] },
      { depth: 1, uv: lerp([1, 0.5], [0, 0], 1999 / 2001) },
      { depth: 1, uv: lerp([0, 1], [1, 0.5], 2 / 2001) },
    ]);
    // (the far end is still the tip, and the modern look's beam is the model's, unclipped)
    expect(layer.ends()[0]!.z).toBeCloseTo(2000, 3);
    layer.update([beam], CAM, false);
    expect(position(meshesOf(layer)[0]!.geometry)).toEqual([0, 0, 2001]);
  });

  it('refuses a parity beam whose mesh has several material groups, which the clip would drop', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    g.addGroup(0, 3, 0);
    g.addGroup(3, 3, 1);
    // (one material: three ignores the groups, as a beam model's are; a material per group is what the clip cannot keep)
    expect(() => clipTarget(g, new MeshBasicMaterial())).not.toThrow();
    expect(() => clipTarget(g, [new MeshBasicMaterial(), new MeshBasicMaterial()])).toThrow(/2 material groups/);
  });

  it('reads a parity beam\'s texture across the screen with no perspective, as drawTriangle interpolates (space3d.cpp:404-430)', () => {
    const layer = new EffectLayer(assets(), miniCombat());
    layer.update([draw({ kind: 'beam', model: 'phaser.3dv', sprite: '__phaser.spr', texture: 'phaser1.lbm', tip: v3(0, 0, 100) })], CAM, true);
    const m = meshesOf(layer)[0]!.material as MeshStandardMaterial;
    const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} } as unknown as Parameters<Material['onBeforeCompile']>[0];
    m.onBeforeCompile(shader, undefined as never);
    // (the map's coordinates carried times w with w itself, so the GPU's perspective divide undoes the perspective)
    expect(shader.vertexShader).toMatch(/vAffineUv = vec3\( vMapUv \* gl_Position\.w, gl_Position\.w \);/);
    expect(shader.fragmentShader).toContain('texture2D( map, vAffineUv.xy / vAffineUv.z )');
    expect(shader.fragmentShader).not.toContain('texture2D( map, vMapUv )');
    expect(m.customProgramCacheKey()).toContain('affine');
  });

  it('remakes an effect whose sprite changes under the same key (an explosion restarted on another boom sheet)', () => {
    const set = assets();
    set.sprites.set('1_boom.spr', sheet(8));
    const layer = new EffectLayer(set, miniCombat());
    layer.update([draw({ kind: 'explosion', key: 'x', model: 'bboard.3dv', sprite: '__boom.spr', frame: 7, texture: 'boom.lbm' })], CAM, false);
    layer.update([draw({ kind: 'explosion', key: 'x', model: 'bboard.3dv', sprite: '1_boom.spr', frame: 0, texture: 'boom.lbm' })], CAM, false);
    const map = (meshesOf(layer)[0]!.material as MeshBasicMaterial).map!;
    expect([meshesOf(layer).length, map.source === set.sprites.get('1_boom.spr')!.texture.source, map.offset.toArray()]).toEqual([1, true, frameUv(set.sprites.get('1_boom.spr')!, 0).offset]);
  });
});
