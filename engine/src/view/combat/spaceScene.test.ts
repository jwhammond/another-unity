// SPDX-License-Identifier: GPL-3.0-or-later
import { AdditiveBlending, BoxGeometry, Color, DirectionalLight, DoubleSide, AmbientLight, FrontSide, Group, Layers, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Points, SRGBColorSpace, Texture, type Material, type Object3D, type ShaderMaterial, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { CAMERA_SEAMS } from '../../sim/combat/camera';
import { add, apply, bindLibm, fromAngles, MATH_LIBM, sub } from '../../sim/combat/math';
import { fromInternal, orientation, toInternal } from '../../sim/combat/aim';
import { WEAPON_SEAMS } from '../../sim/combat/weapons';
import { STEP_TIME } from '../../sim/combat/time';
import type { BattleAssets } from './assets';
import { modelMatrix } from './axes';
import { effectScale, modelRadius } from './effects';
import { BLOOM_LAYER, HIDES_LAYER, SelectiveBloom } from './bloom';
import { AMBIENT_LIGHT, hidingDepth, KEY_LIGHT, SpaceScene } from './spaceScene';
import { MARK_EDGE } from './targetMarks';

/**
 * A model as GLTFLoader gives the space build's: a root with a part node holding a mesh, its material's extras in userData;
 * `single`, a part of one primitive, whose node the loader makes the mesh itself (the root's extras list the parts' hidden flags).
 */
function model(name: string, o: { hidden?: boolean; single?: boolean } = {}): Object3D {
  const root = new Group();
  root.name = name;
  root.userData = { hidden: [o.hidden ? 1 : 0] };
  const extras = { part: 0, billboard: false, hidden: o.hidden ? 1 : 0 };
  // (rgb555 0x7c00: red)
  const mesh = new Mesh(new BoxGeometry(100, 50, 200), new MeshStandardMaterial({ userData: { colour: 0x7c00, type: 1 } }));
  if (o.single) {
    mesh.userData = extras;
    root.add(mesh);
  } else {
    const part = new Group();
    part.userData = extras;
    part.add(mesh);
    root.add(part);
  }
  return root;
}
/** A set holding miniCombat's ship models (every kind's "mini") and nothing else. */
function assets(): BattleAssets {
  const models = new Map<string, Object3D>([['mini.3dv', model('mini.3dv')], ['mini.3dr', model('mini.3dr')]]);
  return { list: { models: [...models.keys()], sprites: [] }, models, sprites: new Map(), stills: null, missing: [], textures: [], dispose: () => {} };
}
/** miniCombat's battle 3 with the camera placed (the chase view behind the Enterprise), and a scene of it. */
function scene(parity = false) {
  const { b } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
  const set = assets();
  return { b, set, s: new SpaceScene(set, miniCombat(), b.view.seed, { width: 320, height: 220, parity }) };
}
const shown = (s: SpaceScene, ship: number) => s.drawn().find(d => d.index === ship);

describe('SpaceScene (M8 spec §3)', () => {
  it('lights as the original: an ambient and a key light from above and behind (combat.cpp:76)', () => {
    const { s } = scene();
    const ambient = s.scene.children.find((o): o is AmbientLight => o instanceof AmbientLight)!;
    const key = s.scene.children.find((o): o is DirectionalLight => o instanceof DirectionalLight)!;
    expect([ambient.intensity, key.intensity]).toEqual([AMBIENT_LIGHT, KEY_LIGHT]);
    // (internal (0, -0.7071, -0.7071), up and behind, is three's (0, 0.7071, 0.7071))
    expect(key.position.toArray()).toEqual([0, 0.7071, 0.7071]);
  });

  it('draws each ship as a clone of its set\'s model, its geometry and material shared, placed by modelMatrix', () => {
    const { b, set, s } = scene(true);
    s.update(b);
    expect(s.drawn().map(d => [d.index, d.model, d.flat])).toEqual([[0, 'mini.3dv', false], [1, 'mini.3dv', false]]);
    // (the Enterprise in the middle of the window, as the chase view frames it: half a pixel right and down, project's rounding)
    expect([shown(s, 0)!.x, shown(s, 0)!.y].map(n => Math.round(n * 10) / 10)).toEqual([160.5, 110.5]);
    const meshes: Mesh[] = [];
    // (what the frame draws: not the ships' depth for the bloom's pre-pass, on HIDES_LAYER alone)
    s.scene.traverse(o => { if ((o as Mesh).isMesh && o.visible && o.parent?.visible && !o.userData.hides) meshes.push(o as Mesh); });
    const source = (set.models.get('mini.3dv')!.children[0]!.children[0] as Mesh);
    expect(meshes.every(m => m.geometry === source.geometry && m.material === source.material)).toBe(true);
    const e = b.ships[0]!;
    const holder = meshes[0]!.parent!.parent!.parent!;
    expect(holder.matrix.elements).toEqual(modelMatrix({ x: e.pos.x, y: -e.pos.z, z: e.pos.y }, fromAngles(e.angles[0], e.angles[1], e.angles[2]), new Matrix4()).elements);
  });

  it('draws a far ship flat, in its material\'s raw colour, unlit (kFlatFlags, combat.cpp:55), with materials of its own that dispose frees', () => {
    const { b, set, s } = scene(true);
    // (miniCombat's chodak has a reduced model, flat from 60000 away)
    b.ships[1]!.pos = { x: 0, y: 70000, z: 0 };
    s.update(b);
    expect(shown(s, 1)).toMatchObject({ model: 'mini.3dr', flat: true });
    const flat: MeshBasicMaterial[] = [];
    s.scene.traverse(o => { const m = (o as Mesh).material; if (m instanceof MeshBasicMaterial && o.parent?.parent?.visible && !o.userData.hides) flat.push(m); });
    expect(flat).toHaveLength(1);
    expect(flat[0]!.color.getHexString()).toBe('ff0000');
    let freed = 0;
    flat[0]!.addEventListener('dispose', () => { freed++; });
    let setFreed = 0;
    (set.models.get('mini.3dv')!.children[0]!.children[0] as Mesh).geometry.addEventListener('dispose', () => { setFreed++; });
    s.dispose();
    expect([freed, setFreed]).toEqual([1, 0]);
  });

  it('hides a cloaked ship until its decloak time and shows it from then, as the sim does, under a shimmer on the bloom layer for 400 ms (Decision 8)', () => {
    const modern = scene();
    const chodak = modern.b.ships[1]!;
    chodak.decloakTime = modern.b.now + 1000;
    modern.s.update(modern.b);
    expect([shown(modern.s, 1), modern.s.blooms()]).toEqual([undefined, false]);
    // (the sim clears decloakTime at the step it passes: the scene remembers it)
    modern.b.now += 1000;
    chodak.decloakTime = 0;
    const glows: number[] = [];
    for (let i = 0; i < 40; i++) {
      modern.s.update(modern.b);
      expect(shown(modern.s, 1), `frame ${i}`).toBeDefined();
      holderOf(modern.s, 1)!.traverseVisible(o => {
        const m = (o as Mesh).material as MeshBasicMaterial | undefined;
        // (the glow is the bloom's alone: not on layer 0, which the view draws)
        if ((o as Mesh).isMesh && o.layers.isEnabled(BLOOM_LAYER)) glows.push(o.layers.isEnabled(0) ? -1 : m!.opacity);
      });
    }
    // (one glow a frame, at the start between half and full strength, by the view's generator)
    expect(glows).toHaveLength(40);
    expect(Math.min(...glows)).toBeGreaterThanOrEqual(0.5);
    expect(new Set(glows).size).toBeGreaterThan(1);
    expect(modern.s.blooms()).toBe(true);
    // (400 ms on: no glow)
    modern.b.now += 400;
    modern.s.update(modern.b);
    expect(modern.s.blooms()).toBe(false);
    // (steady under prefers-reduced-motion)
    const calm = scene();
    calm.s.setOptions({ width: 320, height: 220, parity: false, reducedMotion: true });
    calm.b.ships[1]!.decloakTime = calm.b.now - 100;
    calm.s.update(calm.b);
    const steady: number[] = [];
    holderOf(calm.s, 1)!.traverseVisible(o => { if (o.layers.isEnabled(BLOOM_LAYER) && (o as Mesh).isMesh) steady.push(((o as Mesh).material as MeshBasicMaterial).opacity); });
    expect(steady).toEqual([0.75]);
    // (the parity mode: shown, no shimmer)
    const parity = scene(true);
    parity.b.ships[1]!.decloakTime = parity.b.now;
    parity.s.update(parity.b);
    expect([shown(parity.s, 1) !== undefined, parity.s.blooms()]).toEqual([true, false]);
  });

  it('never draws a part the model hides (SpaceModel::_hidden)', () => {
    const { b, set, s } = scene();
    set.models.set('mini.3dv', model('mini.3dv', { hidden: true }));
    set.models.set('mini.3dr', model('mini.3dr', { hidden: true }));
    s.update(b);
    let visible = 0;
    s.scene.traverseVisible(o => { if ((o as Mesh).isMesh && o.name !== 'targetMarks') visible++; });
    expect(visible).toBe(0);
  });

  it('never draws a hidden part of one primitive either (the loader\'s part node is its mesh)', () => {
    const { b, set, s } = scene();
    set.models.set('mini.3dv', model('mini.3dv', { hidden: true, single: true }));
    set.models.set('mini.3dr', model('mini.3dr', { hidden: true, single: true }));
    s.update(b);
    let visible = 0;
    s.scene.traverseVisible(o => { if ((o as Mesh).isMesh && o.name !== 'targetMarks') visible++; });
    expect(visible).toBe(0);
  });

  it('fits the depth range to what it draws', () => {
    const { b, s } = scene(true);
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    s.update(b);
    // (the chase camera 600 behind the Enterprise along the camera's forward: 400 to its front, its size being 200; the chodak
    // 5000 ahead of it, 600 + 5000 cos 8.09 degrees deep, and 200 to its back)
    expect(s.camera.near).toBeCloseTo(400, 2);
    expect(s.camera.far).toBeCloseTo(600 + 5000 * 0.990058 + 200, 1);
  });

  it('draws a ship\'s damaged materials with its damage model\'s, where that has a texture, on the detailed model only (combat.cpp:1045-1053)', () => {
    const { b, set, s } = scene(true);
    // (materials 0 and 1, and the damage model's: 1 textured, 0 not)
    const textured = (index: number, map: boolean) => new MeshStandardMaterial({ userData: { index, type: map ? 1 : 3 }, ...(map ? { map: new Texture() } : {}) });
    const parts = (a: MeshStandardMaterial, c: MeshStandardMaterial) => {
      const root = new Group();
      root.add(new Mesh(new BoxGeometry(100, 50, 200), a), new Mesh(new BoxGeometry(10, 10, 10), c));
      return root;
    };
    const own = [textured(0, true), textured(1, true)];
    const marked = [textured(0, false), textured(1, true)];
    set.models.set('mini.3dv', parts(own[0]!, own[1]!));
    set.models.set('mini.dmg', parts(marked[0]!, marked[1]!));
    const far = [textured(0, true), textured(1, true)];
    set.models.set('mini.3dr', parts(far[0]!, far[1]!));
    const chodak = b.ships[1]!;
    const drawnMaterials = () => {
      const out: unknown[] = [];
      holderOf(s, 1)!.traverseVisible(o => { if ((o as Mesh).isMesh && !o.userData.hides) out.push((o as Mesh).material); });
      return out;
    };
    chodak.damagedMaterials = [0, 1];
    s.update(b);
    // (material 1 swapped; material 0's damage has no texture, so it keeps its own)
    expect(drawnMaterials()).toEqual([own[0], marked[1]]);
    chodak.damagedMaterials = [];
    s.update(b);
    expect(drawnMaterials()).toEqual([own[0], own[1]]);
    // (the reduced model, 20000 off, is never marked)
    chodak.damagedMaterials = [1];
    chodak.pos = { x: 0, y: 30000, z: 0 };
    s.update(b);
    expect(shown(s, 1)).toMatchObject({ model: 'mini.3dr', flat: false });
    expect(drawnMaterials()).toEqual([far[0], far[1]]);
  });

  it('draws the battle\'s effects with its ships and lists them', () => {
    const { b, set, s } = scene(true);
    set.models.set('bboard.3dv', model('bboard.3dv'));
    // (the chodak, 5000 ahead, explodes; its boom is miniCombat's bboard scaled to it)
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    b.ships[1]!.explosion = { frames: '__boom.spr', frame: 0, frameTime: 0, lastFrame: 0 };
    s.update(b);
    expect(s.effectsDrawn().map(e => [e.kind, e.model])).toEqual([['explosion', 'bboard.3dv']]);
    expect(s.effectsDrawn()[0]!.x).toBeCloseTo(shown(s, 1)!.x, 6);
    b.ships[1]!.explosion.frames = null;
    s.update(b);
    expect(s.effectsDrawn()).toEqual([]);
  });

  for (const parity of [true, false]) {
    it(`draws a beam to what it fires at: its far end on the window where its target is drawn, as the sim's tip says (weapons.cpp:378-380), ${parity ? 'in the parity mode' : 'between steps in the modern view'}`, () => {
      // (the weapons set up too: each ship's banks)
      const { b } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS, ...WEAPON_SEAMS }) });
      const set = assets();
      const s = new SpaceScene(set, miniCombat(), b.view.seed, { width: 320, height: 220, parity });
      // (the phaser as the space build makes it: its root a half turn about z, ROOT_ROTATION)
      const phaser = model('phaser.3dv');
      phaser.rotation.z = Math.PI;
      set.models.set('phaser.3dv', phaser);
      const [e, chodak] = [b.ships[0]!, b.ships[1]!];
      chodak.pos = { x: 300, y: 5000, z: -200 };
      // (both moving, half a step on: each drawn halfway from where its trail says it was)
      e.trail = [{ pos: { x: 0, y: e.pos.y - 20, z: 0 }, angles: e.angles }, { pos: { x: 0, y: e.pos.y - 20, z: 0 }, angles: e.angles }];
      chodak.trail = [{ pos: { x: 285, y: 5000, z: -200 }, angles: chodak.angles }, { pos: { x: 285, y: 5000, z: -200 }, angles: chodak.angles }];
      b.now = b.lastStep + STEP_TIME / 2;
      e.target = 1;
      const bank = e.banks[0]!;
      bank.active = true;
      bank.beam = { frames: '__phaser.spr', frame: 3, frameTime: 0, lastFrame: 0 };
      // (updateBeams' tip: the target less the bank's place on the ship, in internal coordinates)
      bank.tip = toInternal(sub(chodak.pos, add(e.pos, fromInternal(apply(orientation(e), bank.offset)))));
      s.update(b);
      const beam = s.effectsDrawn().find(d => d.kind === 'beam')!;
      expect(beam.aim).toMatchObject({ to: 1, kind: 'hit', stale: false });
      // (the end on the chodak's centre as drawn; its travel this step, 15, the lag a ship later in the list is allowed)
      expect(beam.aim!.off).toBeCloseTo(0, 3);
      expect([beam.aim!.lag, beam.aim!.radius]).toEqual([15, chodak.radius]);
      expect(beam.end!.x).toBeCloseTo(shown(s, 1)!.x, 3);
      expect(beam.end!.y).toBeCloseTo(shown(s, 1)!.y, 3);
      // (and away from where the beam leaves the Enterprise)
      expect(Math.hypot(beam.end!.x - beam.x, beam.end!.y - beam.y)).toBeGreaterThan(5);
    });
  }

  it('fits the depth range to the effects too: an explosion drawn alone sets it', () => {
    const { b, set, s } = scene(true);
    set.models.set('bboard.3dv', model('bboard.3dv'));
    // (no ship model in the set, so no ship's sphere: only the chodak's explosion, 5000 ahead, sets near and far)
    set.models.delete('mini.3dv');
    set.models.delete('mini.3dr');
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    b.ships[1]!.explosion = { frames: '__boom.spr', frame: 0, frameTime: 0, lastFrame: 0 };
    s.update(b);
    const combat = miniCombat();
    const r = modelRadius(combat.models['bboard.3dv']!, effectScale(combat, b.ships[1]!));
    expect([s.drawn(), s.effectsDrawn().length]).toEqual([[], 1]);
    // (the sphere's front and back, about the explosion's depth)
    expect((s.camera.far - s.camera.near) / 2).toBeCloseTo(r, 6);
    expect(s.camera.near).toBeGreaterThan(4000);
  });

  it('frees the effects\' own objects for another battle, and as it is disposed', () => {
    const { b, set, s } = scene(true);
    set.models.set('bboard.3dv', model('bboard.3dv'));
    const boom = () => ({ frames: '__boom.spr', frame: 0, frameTime: 0, lastFrame: 0 });
    b.ships[1]!.explosion = boom();
    s.update(b);
    const material = () => {
      let m: Material | undefined;
      s.scene.getObjectByName('effects')!.traverse(o => { if (!m && (o as Mesh).isMesh) m = (o as Mesh).material as Material; });
      return m!;
    };
    let freed = 0;
    const first = material();
    first.addEventListener('dispose', () => { freed++; });
    // (battle 2, its chodak exploding too: the same key, but a new effect, the first's freed)
    const { b: two } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
    two.ships[1]!.explosion = boom();
    s.update(two);
    const second = material();
    expect([freed, second === first]).toEqual([1, false]);
    second.addEventListener('dispose', () => { freed++; });
    s.dispose();
    expect(freed).toBe(2);
  });

  it('warms before its first frame: compiles what its frames draw with, builds its bloom and uploads the set\'s textures (Plan 34 Task 8)', async () => {
    const { b } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
    const texture = new Texture();
    const set = { ...assets(), textures: [texture] };
    const s = new SpaceScene(set, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    let target: unknown = null;
    const compiled: { first: Object3D; materials: Material[]; target: unknown }[] = [];
    const uploaded: unknown[] = [];
    const targets: unknown[] = [];
    const renderer = {
      getPixelRatio: () => 2,
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => { target = t; },
      initRenderTarget: (t: unknown) => { targets.push(t); },
      initTexture: (t: unknown) => { uploaded.push(t); },
      properties: { get: () => ({}) },
      compile: (o: Object3D) => {
        const materials: Material[] = [];
        o.traverse(x => { const m = (x as Mesh).material as Material | Material[] | undefined; if (m) materials.push(...[m].flat()); });
        compiled.push({ first: o, materials, target });
        return new Set(materials);
      },
    } as unknown as WebGLRenderer;
    const bloomOf = () => (s as unknown as { bloom: SelectiveBloom | null }).bloom;
    expect(bloomOf()).toBeNull();
    await s.warm(renderer, { width: 640, height: 440 });
    const bloom = bloomOf();
    expect(bloom).toBeInstanceOf(SelectiveBloom);
    const onCanvas = compiled.filter(c => c.target === null).flatMap(c => c.materials);
    const intoBloom = compiled.filter(c => c.target !== null).flatMap(c => c.materials);
    // (the scene's own: the stars and the backdrop)
    expect(compiled.some(c => c.first === s.scene && c.target === null)).toBe(true);
    // (the set's model as it is lit, and its flat tier)
    const own = (set.models.get('mini.3dv')!.getObjectByProperty('isMesh', true) as Mesh).material as Material;
    expect(onCanvas).toContain(own);
    expect(onCanvas.some(m => m instanceof MeshBasicMaterial && !m.transparent && m.color.getHex() === 0xff0000)).toBe(true);
    // (the effects' additive look on the canvas, and into the bloom's target with the bloom's own passes)
    expect(onCanvas.some(m => m.blending === AdditiveBlending)).toBe(true);
    expect(intoBloom.some(m => m.blending === AdditiveBlending)).toBe(true);
    expect(intoBloom.some(m => (m as ShaderMaterial).uniforms?.luminosityThreshold !== undefined)).toBe(true);
    expect(intoBloom.filter(m => m instanceof MeshBasicMaterial && !m.colorWrite).map(m => m.side).sort()).toEqual([0, 1, 2]);
    // (its targets made at the view's CSS pixels, the set's textures uploaded, and the renderer's target as it was)
    expect(targets.length).toBeGreaterThan(1);
    expect((targets[0] as { width: number; height: number })).toMatchObject({ width: 320, height: 220 });
    expect([uploaded, target]).toEqual([[texture], null]);
    // (the first glow draws with the bloom built here)
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    b.ships[1]!.explosion = { frames: '__boom.spr', frame: 0, frameTime: 0, lastFrame: 0 };
    set.models.set('bboard.3dv', model('bboard.3dv'));
    s.update(b);
    s.postRender(new Proxy({}, { get: () => () => {} }) as unknown as WebGLRenderer);
    expect(bloomOf()).toBe(bloom);
    s.dispose();
  });

  it('builds no bloom in the parity mode, which never blooms', async () => {
    const { s } = scene(true);
    const renderer = {
      getPixelRatio: () => 1, getRenderTarget: () => null, setRenderTarget: () => {}, initTexture: () => {},
      properties: { get: () => ({}) }, compile: () => new Set(),
    } as unknown as WebGLRenderer;
    await s.warm(renderer, { width: 320, height: 220 });
    expect((s as unknown as { bloom: SelectiveBloom | null }).bloom).toBeNull();
    s.dispose();
  });

  it('a battle left mid-warm-up: the materials freed while their programs link drop out of the wait, with no throw and no upload after (Plan 34 Task 8 fix I2)', async () => {
    const { b } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
    const set = { ...assets(), textures: [new Texture()] };
    const s = new SpaceScene(set, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    // (three's properties as a material's dispose leaves them: forgotten, its programs with it; the programs still linking)
    const props = new Map<Material, { programs: Map<string, { isReady(): boolean }> }>();
    const linking = { isReady: () => false };
    const uploaded: unknown[] = [];
    const renderer = {
      getPixelRatio: () => 1, getRenderTarget: () => null, setRenderTarget: () => {}, initRenderTarget: () => {},
      initTexture: (t: unknown) => { uploaded.push(t); },
      properties: { get: (m: Material) => props.get(m) ?? {} },
      compile: (o: Object3D) => {
        const materials = new Set<Material>();
        o.traverse(x => { const m = (x as Mesh).material as Material | Material[] | undefined; if (m) for (const one of [m].flat()) materials.add(one); });
        for (const m of materials) {
          props.set(m, { programs: new Map([['p', linking]]) });
          m.addEventListener('dispose', () => props.delete(m));
        }
        return materials;
      },
    } as unknown as WebGLRenderer;
    vi.useFakeTimers();
    try {
      let settled = false;
      const warm = s.warm(renderer, { width: 320, height: 220 }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      // (the battle ends: the scene freed, and the set's own materials with it)
      s.dispose();
      set.models.forEach(m => m.traverse(o => { if ((o as Mesh).isMesh) ((o as Mesh).material as Material).dispose(); }));
      await vi.advanceTimersByTimeAsync(50);
      await warm;
      expect([settled, uploaded]).toEqual([true, []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts an explosion on the bloom layer, the ships not, and blooms only then, never in the parity mode', () => {
    for (const parity of [false, true]) {
      const { b, set, s } = scene(parity);
      set.models.set('bboard.3dv', model('bboard.3dv'));
      s.update(b);
      let asked = 0;
      const renderer = new Proxy({}, { get: () => () => { asked++; } }) as unknown as WebGLRenderer;
      // (nothing glows: no bloom drawn)
      s.postRender(renderer);
      expect([s.blooms(), asked]).toEqual([false, 0]);
      // (the ship doesn't glow, and hides the halo of what glows behind it: by its depth, a mesh on HIDES_LAYER alone)
      const ship: boolean[][] = [];
      holderOf(s, 0)!.traverse(o => { if ((o as Mesh).isMesh) ship.push([o.layers.isEnabled(0), o.layers.isEnabled(BLOOM_LAYER), o.layers.isEnabled(HIDES_LAYER)]); });
      expect(ship).toEqual([[true, false, false], [false, false, true]]);
      // (the chodak 5000 ahead explodes)
      b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
      b.ships[1]!.explosion = { frames: '__boom.spr', frame: 0, frameTime: 0, lastFrame: 0 };
      s.update(b);
      expect(s.blooms(), `parity ${parity}`).toBe(!parity);
      const glow: boolean[] = [];
      // (tested against the depth of what hides it)
      s.scene.getObjectByName('effects')!.traverse(o => { if ((o as Mesh).isMesh) glow.push(o.layers.isEnabled(BLOOM_LAYER) && !o.layers.isEnabled(HIDES_LAYER) && ((o as Mesh).material as Material).depthTest); });
      expect(glow).toEqual([!parity]);
    }
  });

  it('a keyed or translucent ship part doesn\'t hide glows: the halo behind it shows through its holes (bloom.ts)', () => {
    const { b, set, s } = scene();
    const part = (name: string, m: MeshStandardMaterial) => Object.assign(new Mesh(new BoxGeometry(100, 50, 200), m), { name });
    const root = new Group();
    root.add(
      part('solid', new MeshStandardMaterial()),
      part('keyed', new MeshStandardMaterial({ alphaTest: 0.5, side: DoubleSide })),
      part('translucent', new MeshStandardMaterial({ transparent: true, opacity: 0.5 })),
    );
    set.models.set('mini.3dv', root);
    s.update(b);
    const hides: [string, boolean][] = [];
    holderOf(s, 1)!.traverse(o => { if ((o as Mesh).isMesh && !o.userData.hides) hides.push([o.name, o.layers.isEnabled(HIDES_LAYER)]); });
    expect(hides).toEqual([['solid', false], ['keyed', false], ['translucent', false]]);
    // (the depth the bloom's pre-pass draws: the solid part's box alone, its 12 triangles)
    expect(depthOf(holderOf(s, 1)!).map(m => [m.geometry.index!.count / 3, (m.material as Material).side])).toEqual([[12, FrontSide]]);
  });

  it('draws the ships\' depth for the bloom\'s pre-pass in a draw a ship, not one a mesh: three ships of thirty parts each (battle 82\'s shape, Plan 34 fix)', () => {
    const { b, set, s } = scene();
    // (thirty solid parts, as a ship model is: battle 82's three drew 210 calls a glowing frame when the pre-pass drew each)
    const many = () => {
      const root = new Group();
      for (let p = 0; p < 30; p++) {
        const part = new Group();
        part.userData = { part: p, billboard: false, hidden: 0 };
        const mesh = new Mesh(new BoxGeometry(10, 10, 10), new MeshStandardMaterial());
        mesh.position.set(p * 10, 0, 0);
        part.add(mesh);
        root.add(part);
      }
      return root;
    };
    set.models.set('mini.3dv', many());
    set.models.set('mini.3dr', many());
    b.ships[2] = structuredClone(b.ships[1]!);
    b.ships[2].pos = { ...b.ships[2].pos, x: b.ships[2].pos.x + 200 };
    s.update(b);
    expect(s.drawn()).toHaveLength(3);
    // (what the pre-pass draws: the visible meshes on HIDES_LAYER, as the bloom's camera sees them)
    const hides = new Layers();
    hides.set(HIDES_LAYER);
    const frame = new Layers();
    let prepass = 0, drawn = 0, triangles = 0;
    s.scene.traverseVisible(o => {
      if (!(o as Mesh).isMesh) return;
      if (o.layers.test(hides)) {
        prepass++;
        triangles += (o as Mesh).geometry.index!.count / 3;
      }
      if (o.layers.test(frame) && !o.userData.hides && o.name !== 'targetMarks') drawn++;
    });
    // (a draw a ship, every solid part's triangles in it; the frame still draws each part)
    expect([prepass, triangles]).toEqual([3, 3 * 30 * 12]);
    expect(drawn).toBe(3 * 30);
  });

  it('merges a ship\'s depth in its own space: a part\'s place kept, a hidden part left out, a mirrored part\'s faces turned about', () => {
    const root = new Group();
    const shownPart = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial());
    shownPart.position.set(5, 0, 0);
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    const mirrored = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ side: DoubleSide }));
    mirrored.scale.set(-1, 1, 1);
    root.add(shownPart, hidden, mirrored);
    root.position.set(100, 0, 0);
    const depth = hidingDepth(root);
    expect([...depth.keys()]).toEqual([FrontSide, DoubleSide]);
    const front = depth.get(FrontSide)!;
    // (the plane's 4 corners, 5 along x, in the root's own space: its own place not added)
    const xs = Array.from({ length: 4 }, (_, i) => front.getAttribute('position').getX(i));
    expect(xs.sort((a, b) => a - b)).toEqual([4, 4, 6, 6]);
    expect(front.index!.count).toBe(6);
    // (the mirrored plane's first triangle, turned about)
    const plane = new PlaneGeometry(2, 2).index!;
    const turned = depth.get(DoubleSide)!.index!;
    expect([turned.getX(0), turned.getX(1), turned.getX(2)]).toEqual([plane.getX(0), plane.getX(2), plane.getX(1)]);
  });

  it('frees the bloom it made and the shimmer\'s materials as it is disposed', () => {
    const render = vi.spyOn(SelectiveBloom.prototype, 'render').mockImplementation(() => {});
    const dispose = vi.spyOn(SelectiveBloom.prototype, 'dispose');
    try {
      const { b, s } = scene();
      b.ships[1]!.decloakTime = b.now - 100;
      s.update(b);
      const glows: Material[] = [];
      holderOf(s, 1)!.traverse(o => { if ((o as Mesh).isMesh && !o.layers.isEnabled(0) && !o.userData.hides) glows.push((o as Mesh).material as Material); });
      expect(glows).toHaveLength(1);
      // (the shimmer glows: it hides nothing)
      holderOf(s, 1)!.traverse(o => { if ((o as Mesh).material === glows[0]) expect(o.layers.isEnabled(HIDES_LAYER)).toBe(false); });
      // (tested against the depth of what hides it)
      expect(glows[0]!.depthTest).toBe(true);
      let freed = 0;
      glows[0]!.addEventListener('dispose', () => { freed++; });
      s.postRender({} as WebGLRenderer);
      expect([render.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 0]);
      s.dispose();
      expect([dispose.mock.calls.length, freed]).toEqual([1, 1]);
      // (a scene that never bloomed made none)
      const quiet = scene();
      quiet.s.update(quiet.b);
      quiet.s.postRender({} as WebGLRenderer);
      quiet.s.dispose();
      expect([render.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 1]);
    } finally {
      render.mockRestore();
      dispose.mockRestore();
    }
  });

  it('tints space in a red flash by its strength (tactical.cpp:484-487), black otherwise', () => {
    const { b, s } = scene();
    s.setOptions({ width: 320, height: 220, parity: false, flash: 1 });
    s.update(b);
    expect((s.scene.background as Color).getHexString(SRGBColorSpace)).toBe('804040');
    s.setOptions({ width: 320, height: 220, parity: false, flash: 0 });
    s.update(b);
    expect((s.scene.background as Color).getHex()).toBe(0);
  });

  it('draws the backdrop plate behind the stars, drifting as they do, only with a plate and never in the parity mode (Decision 14)', () => {
    const { b, set } = scene();
    const plate = new Texture();
    const s = new SpaceScene({ ...set, backdrop: plate }, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    const backdrop = s.scene.getObjectByName('backdrop') as Mesh<PlaneGeometry, ShaderMaterial>;
    // (the camera starts square on: the first frame sets where the drift is from)
    b.view.camera = { ...b.view.camera, axes: fromAngles(0, 0, 0) };
    s.update(b);
    expect([backdrop.visible, backdrop.material.uniforms.map!.value, backdrop.renderOrder < -1]).toEqual([true, plate, true]);
    // (the texture's RepeatWrapping repeats it: a fract() would leave a seam of the smallest mip at each edge, review #6)
    expect(backdrop.material.fragmentShader).not.toMatch(/fract\(/);
    // (the camera turned a sixteenth of a turn to starboard: 1024 angle units of 16384, at STAR_STEP (0.1171732) a unit, so
    // the plate's middle is 119.985 units to port; no roll, so no turn)
    const uniforms = backdrop.material.uniforms;
    b.view.camera = { ...b.view.camera, axes: fromAngles(0x400, 0, 0) };
    s.update(b);
    expect(uniforms.anchor!.value[0]).toBeCloseTo(-119.985, 3);
    expect(uniforms.anchor!.value[1]).toBeCloseTo(0, 6);
    expect(uniforms.angle!.value).toBe(0);
    // (then an eighth of a turn's roll (2048 units): the plate turns by -45 degrees, 7π/4, and its middle with it, to
    // (-119.985 cos 45°, 119.985 sin 45°) = (-84.8425, 84.8425))
    b.view.camera = { ...b.view.camera, axes: fromAngles(0x400, 0, 0x800) };
    s.update(b);
    expect(uniforms.angle!.value).toBeCloseTo(7 * Math.PI / 4, 6);
    expect(uniforms.anchor!.value[0]).toBeCloseTo(-84.8425, 3);
    expect(uniforms.anchor!.value[1]).toBeCloseTo(84.8425, 3);
    s.setOptions({ width: 320, height: 220, parity: true });
    s.update(b);
    expect(backdrop.visible).toBe(false);
    const bare = scene();
    bare.s.update(bare.b);
    expect(bare.s.scene.getObjectByName('backdrop')!.visible).toBe(false);
  });

  it('starts another battle\'s drift from its own first frame: no jump of the stars or the plate by the camera turn between the two (final review M3)', () => {
    const { b, set } = scene();
    const s = new SpaceScene({ ...set, backdrop: new Texture() }, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    const uniforms = (s.scene.getObjectByName('backdrop') as Mesh<PlaneGeometry, ShaderMaterial>).material.uniforms;
    b.view.camera = { ...b.view.camera, axes: fromAngles(0, 0, 0) };
    s.update(b);
    const before = [...(uniforms.anchor!.value as number[])];
    // (a preview of another battle on the same set, its camera a sixteenth of a turn away)
    const other = scene().b;
    other.view.camera = { ...other.view.camera, axes: fromAngles(0x400, 0, 0) };
    s.update(other);
    expect([...(uniforms.anchor!.value as number[])]).toEqual(before);
  });

  it('keeps the plate continuous through a full turn of yaw after a roll: no jump where a star would wrap (Plan 26 Task 6 review #2)', () => {
    const { b, set } = scene();
    const s = new SpaceScene({ ...set, backdrop: new Texture() }, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    const uniforms = (s.scene.getObjectByName('backdrop') as Mesh<PlaneGeometry, ShaderMaterial>).material.uniforms;
    // (where the plate is sampled at the window's middle, in plate units: the shader's q = R(-angle)(0 - anchor))
    const middle = () => {
      const [x, y] = uniforms.anchor!.value as number[];
      const a = uniforms.angle!.value as number;
      return [-(x! * Math.cos(a) + y! * Math.sin(a)), -(y! * Math.cos(a) - x! * Math.sin(a))];
    };
    b.view.camera = { ...b.view.camera, axes: fromAngles(0, 0, 0) };
    s.update(b);
    b.view.camera = { ...b.view.camera, axes: fromAngles(0, 0, 0x800) };
    s.update(b);
    // (a 1/32 turn of yaw a frame moves the plate about 61 units; a jump would be hundreds. The plate repeats every 1920,
    // so a move is measured the short way round)
    let last = middle(), most = 0, travelled = 0;
    for (let k = 1; k <= 40; k++) {
      b.view.camera = { ...b.view.camera, axes: fromAngles(k * 0x200, 0, 0x800) };
      s.update(b);
      const now = middle();
      const d = now.map((v, i) => ((((v - last[i]!) + 960) % 1920) + 1920) % 1920 - 960);
      most = Math.max(most, Math.hypot(d[0]!, d[1]!));
      travelled += Math.hypot(d[0]!, d[1]!);
      last = now;
    }
    expect(travelled).toBeGreaterThan(1920);
    expect(most).toBeLessThan(100);
    // (the anchor is kept small: reduced to a repeat in the plate's frame)
    expect(Math.hypot(...(uniforms.anchor!.value as [number, number]))).toBeLessThanOrEqual(960 * Math.SQRT2 + 1e-6);
  });

  it('tints the backdrop plate in a red flash as space is tinted, so a plate never hides the flash (Plan 26 Task 6 review #1)', () => {
    const { b, set } = scene();
    const s = new SpaceScene({ ...set, backdrop: new Texture() }, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false, flash: 1 });
    const uniforms = (s.scene.getObjectByName('backdrop') as Mesh<PlaneGeometry, ShaderMaterial>).material.uniforms;
    s.update(b);
    expect(uniforms.flash!.value.getHexString(SRGBColorSpace)).toBe('804040');
    expect((uniforms.flash!.value as Color).equals(s.scene.background as Color)).toBe(true);
    s.setOptions({ width: 320, height: 220, parity: false, flash: 0 });
    s.update(b);
    expect((uniforms.flash!.value as Color).getHex()).toBe(0);
  });

  it('leaves the sim\'s C library bound as it found it', () => {
    const { b, s } = scene();
    const mine = { sin: null, cos: null, angle: null };
    bindLibm(mine);
    s.update(b);
    expect(bindLibm(MATH_LIBM)).toBe(mine);
  });

  it('picks the ship drawn under a point of the window, the nearest along the ray first; never the Enterprise, nor a ship it didn\'t draw (Plan 29 R6)', () => {
    const { b, s } = scene(true);
    // (the chodak 6000 ahead and a copy of it, ship 2, 3000 ahead: battle (0, y, 0) is internal (0, 0, y), combat.cpp:107-109.
    // The chase camera looks a little down on the Enterprise, so they are drawn above it, the nearer the larger and over the other)
    b.ships[1]!.pos = { x: 0, y: 6000, z: 0 };
    b.ships.push({ ...structuredClone(b.ships[1]!), index: 2, pos: { x: 0, y: 3000, z: 0 } });
    s.update(b);
    const [one, two, e] = [shown(s, 1)!, shown(s, 2)!, shown(s, 0)!];
    expect([one, two].map(d => [d.x, d.y, d.r].map(n => Math.round(n * 10) / 10))).toEqual([[160.5, 74.7, 8.5], [160.5, 77.7, 15.5]]);
    // (the chodak's centre is inside ship 2's disc: ship 2 is nearer; just past ship 2's edge, nothing; the Enterprise, never)
    expect([s.pick(two.x, two.y), s.pick(one.x, one.y), s.pick(two.x + two.r + 1, two.y), s.pick(e.x, e.y)]).toEqual([2, 2, null, null]);
    // (ship 2 cloaked, not drawn: the ray goes on to the chodak)
    b.ships[2]!.decloakTime = b.now + 1000;
    s.update(b);
    expect([shown(s, 2), s.pick(one.x, one.y)]).toEqual([undefined, 1]);
  });

  it('starts its per-ship state again for another battle drawn with the same set (a preview\'s new state)', () => {
    const one = scene();
    one.b.ships[1]!.decloakTime = one.b.now;
    one.s.update(one.b);
    // (battle 2: the same set, the Enterprise alone, and nothing of the first's chodak or its shimmer)
    const { b: two } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
    two.ships.length = 1;
    one.s.update(two);
    expect(one.s.drawn().map(d => d.index)).toEqual([0]);
    expect(one.s.scene.children.filter(o => o.name.startsWith('ship:'))).toHaveLength(1);
  });

  it('starts it again for another battle of as many ships, too (the battle, not its size, is what the state is for)', () => {
    const one = scene();
    one.b.ships[1]!.decloakTime = one.b.now;
    one.s.update(one.b);
    const before = holderOf(one.s, 1);
    const { b: two } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
    expect(two.ships.length).toBe(one.b.ships.length);
    // (its chodak never decloaks: the first's shimmer, which began at this very time, is not its own)
    for (let k = 0; k < 20; k++) {
      one.s.update(two);
      expect(shown(one.s, 1)).toBeDefined();
    }
    expect(holderOf(one.s, 1)).toBeDefined();
    expect(holderOf(one.s, 1)).not.toBe(before);
  });
});

describe('SpaceScene and the Combat Options (Plan 32 Task 9)', () => {
  const visibleMaterials = (s: SpaceScene, i: number) => {
    const out: Material[] = [];
    holderOf(s, i)!.traverseVisible(o => { if ((o as Mesh).isMesh && o.layers.isEnabled(0)) out.push((o as Mesh).material as Material); });
    return out;
  };

  it('stars off hides the star points and the backdrop; the parity mode keeps its stars', () => {
    const { b, set } = scene();
    const s = new SpaceScene({ ...set, backdrop: new Texture() }, miniCombat(), b.view.seed, { width: 320, height: 220, parity: false });
    const stars = s.scene.children.find((o): o is Points => o instanceof Points)!;
    const backdrop = s.scene.getObjectByName('backdrop')!;
    s.update(b);
    expect([stars.visible, backdrop.visible]).toEqual([true, true]);
    s.setOptions({ width: 320, height: 220, parity: false, stars: false });
    s.update(b);
    expect([stars.visible, backdrop.visible]).toEqual([false, false]);
    s.setOptions({ width: 320, height: 220, parity: true, stars: false });
    s.update(b);
    expect(stars.visible).toBe(true);
  });

  it('low is the flat tier at every distance: a near ship unlit and untextured; never in the parity mode', () => {
    const { b, s } = scene();
    s.setOptions({ width: 320, height: 220, parity: false, detail: 'low' });
    s.update(b);
    expect(shown(s, 1)).toMatchObject({ model: 'mini.3dv', flat: true });
    expect(visibleMaterials(s, 1).every(m => m instanceof MeshBasicMaterial)).toBe(true);
    s.setOptions({ width: 320, height: 220, parity: true, detail: 'low' });
    s.update(b);
    expect(shown(s, 1)).toMatchObject({ model: 'mini.3dv', flat: false });
  });

  it('medium is lit with no texture maps, its damage marks the same; a far ship is still flat', () => {
    const { b, set, s } = scene();
    // (rgb555 0x03e0: green, which the texture's white stood for)
    const textured = (index: number) => new MeshStandardMaterial({ userData: { index, type: 1, colour: 0x03e0 }, map: new Texture() });
    const parts = (...ms: MeshStandardMaterial[]) => {
      const root = new Group();
      for (const m of ms) root.add(new Mesh(new BoxGeometry(10, 10, 10), m));
      return root;
    };
    const own = [textured(0), textured(1)];
    set.models.set('mini.3dv', parts(...own));
    set.models.set('mini.dmg', parts(textured(0), textured(1)));
    s.setOptions({ width: 320, height: 220, parity: false, detail: 'medium' });
    s.update(b);
    const plain = visibleMaterials(s, 1);
    expect(plain).toHaveLength(2);
    for (const [k, m] of plain.entries()) {
      expect(m).toBeInstanceOf(MeshStandardMaterial);
      expect(m).not.toBe(own[k]);
      expect((m as MeshStandardMaterial).map).toBeNull();
      expect((m as MeshStandardMaterial).color.getHexString()).toBe('00ff00');
    }
    // (the set's own keep their textures: high still draws them)
    expect(own.every(m => m.map !== null)).toBe(true);
    // (one cached variant per material: the next frame draws the same)
    s.update(b);
    expect(visibleMaterials(s, 1)).toEqual(plain);
    // (a damaged material's mark is the damage model's material, untextured too)
    b.ships[1]!.damagedMaterials = [1];
    s.update(b);
    const marked = visibleMaterials(s, 1);
    expect(marked[0]).toBe(plain[0]);
    expect(marked[1]).not.toBe(plain[1]);
    expect((marked[1] as MeshStandardMaterial).map).toBeNull();
    b.ships[1]!.pos = { x: 0, y: 70000, z: 0 };
    s.update(b);
    expect(shown(s, 1)).toMatchObject({ flat: true });
  });

  it('high is today\'s: the set\'s own materials, textures and all', () => {
    const { b, set, s } = scene();
    s.setOptions({ width: 320, height: 220, parity: false, detail: 'high' });
    s.update(b);
    const source = (set.models.get('mini.3dv')!.children[0]!.children[0] as Mesh).material;
    expect(visibleMaterials(s, 1)).toEqual([source]);
  });

  it('marks the target with the radar on and the sensors reading; nothing with it off, in the parity mode, or without a target (R4)', () => {
    const { b, s } = scene();
    const layer = s.scene.getObjectByName('targetMarks')!;
    b.target = 1;
    // (the fixture's chodak is above the camera and a little behind it: the arrow, at the top edge)
    s.update(b);
    expect([layer.visible, s.targetMarked()?.kind, s.targetMarked()?.tip?.y]).toEqual([true, 'arrow', MARK_EDGE]);
    // (5000 ahead of the camera: the brackets)
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    s.update(b);
    expect([layer.visible, s.targetMarked()?.kind]).toEqual([true, 'brackets']);
    // (about where the chodak is drawn)
    const box = s.targetMarked()!.box!;
    const at = shown(s, 1)!;
    expect((box[0] + box[2]) / 2).toBeCloseTo(at.x, 1);
    expect((box[1] + box[3]) / 2).toBeCloseTo(at.y, 1);
    b.console.sensorsReliable = false;
    s.update(b);
    expect([layer.visible, s.targetMarked()]).toEqual([false, null]);
    b.console.sensorsReliable = true;
    s.setOptions({ width: 320, height: 220, parity: false, radar: false });
    s.update(b);
    expect(layer.visible).toBe(false);
    s.setOptions({ width: 320, height: 220, parity: true, radar: true });
    s.update(b);
    expect(layer.visible).toBe(false);
    s.setOptions({ width: 320, height: 220, parity: false });
    b.target = null;
    s.update(b);
    expect(layer.visible).toBe(false);
  });
});

/** The meshes of `o` the bloom's pre-pass draws: the merged depth on HIDES_LAYER alone. */
function depthOf(o: Object3D): Mesh[] {
  const out: Mesh[] = [];
  o.traverse(x => { if ((x as Mesh).isMesh && x.userData.hides) out.push(x as Mesh); });
  return out;
}

/** The holder (the node modelMatrix places) of ship `i`'s instances. */
function holderOf(s: SpaceScene, i: number): Object3D | undefined {
  return s.scene.getObjectByName(`ship:${i}`);
}
