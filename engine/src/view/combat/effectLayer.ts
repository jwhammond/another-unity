// SPDX-License-Identifier: GPL-3.0-or-later
import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, ShaderChunk, Vector3, type Material, type Mesh, type Object3D, type Texture } from 'three';
import type { CombatData } from '../../content/types';
import { length, type V3 } from '../../sim/combat/math';
import type { CameraPose } from '../../sim/combat/types';
import type { BattleAssets } from './assets';
import { BLOOM_LAYER } from './bloom';
import { modelMatrix } from './axes';
import { culled, viewDepth } from './draw';
import { frameUv, materialOpacity, modelRadius, type BeamAim, type EffectDraw, type EffectKind } from './effects';

/**
 * The effects of a battle (effects.ts' EffectDraw list) as three objects: each a clone of its set model (geometry shared,
 * but a beam's, whose tip moves), with materials of its own, so a frame of a sprite or a debris piece's fade changes
 * nothing of the set's. Made as an effect first shows and freed the first frame it doesn't.
 */

/** What the view adds to the original's effects (M8 spec Decision 13): additive blending, unlit. The parity mode draws the original's. */
const ADDITIVE: ReadonlySet<EffectKind> = new Set(['beam', 'torpedo', 'explosion', 'boom', 'shield']);
/** The effects the selective bloom takes (M8 spec §3.2): beams, torpedoes and explosions (and the shimmer: the scene's). */
export const BLOOMS: ReadonlySet<EffectKind> = new Set(['beam', 'torpedo', 'explosion', 'boom']);

/** An effect placed this frame: what, and where (internal), with its size for the window's list, and a beam's aim (EffectDraw.aim). */
export interface PlacedEffect { kind: EffectKind; key: string; model: string; pos: V3; size: number; aim: BeamAim | null }

interface Instance {
  holder: Group;
  meshes: Mesh[];
  /** The materials, textures and geometries the instance made (its own; the set's are the holder's to free). */
  owned: { dispose(): void }[];
  /** Each material whose texture a sprite frame replaces, with the frame's texture (a clone of the sheet's, its transform its own). */
  frames: { material: Material & { map: Texture | null }; sheet: string }[];
  /** The materials a debris fade sets, with their own opacity. */
  fades: { material: Material; own: number }[];
  /** Placed with the camera's axes (a part is a billboard: the whole model, as every effect model has one part). */
  billboard: boolean;
  /** The first part's meshes (a beam's tip is its vertex 0), and that vertex as the model has it. */
  tipMeshes: Mesh[];
  tip0: [number, number, number] | null;
  /**
   * Each first-part mesh's geometry with the tip on it (tipMeshes', in order): the mesh's own, or in the parity mode the
   * source its drawn geometry is clipped from each frame (clipNear).
   */
  tipSources: BufferGeometry[];
  /** The parity mode's beam: each mesh drawn clipped from its source at z = 1 (clipNear), in a geometry of its own. */
  clips: { mesh: Mesh; source: BufferGeometry; /** clip()'s depths, one per source vertex, kept from frame to frame. */ depths: Float64Array }[];
}

export class EffectLayer {
  readonly group = new Group();
  private readonly live = new Map<string, Instance>();
  private placedNow: PlacedEffect[] = [];
  /** Each placed effect's instance (null for a torpedo's batch), for ends(). */
  private placedFrom: (Instance | null)[] = [];

  constructor(private readonly assets: BattleAssets, private readonly combat: CombatData) {}

  /** The effects placed by the last update. */
  placed(): readonly PlacedEffect[] {
    return this.placedNow;
  }

  /**
   * Where each placed effect's far end is drawn (internal): a beam's first vertex, null for anything else. Worked out on
   * request, for the dev hooks and the tests, not each frame.
   */
  ends(): (V3 | null)[] {
    return this.placedFrom.map(inst => (inst ? this.farEnd(inst) : null));
  }

  /**
   * Places this frame's effects, seen by `cam`; frees those no longer drawn. Returns each drawn effect's depth sphere
   * (its centre's view depth and its bound) for fitDepth. A model the set lacks is skipped (the original skips a missing file).
   */
  update(draws: readonly EffectDraw[], cam: CameraPose, parity: boolean): { z: number; size: number }[] {
    const seen = new Set<string>();
    const spheres: { z: number; size: number }[] = [];
    this.placedNow = [];
    this.placedFrom = [];
    this.torpedoes(draws.filter(d => d.kind === 'torpedo'), cam, parity, spheres);
    for (const d of draws) {
      if (d.kind === 'torpedo') continue;
      // (the sprite too: an effect restarted under its key on another sheet (one of the booms) is made again with it)
      const key = `${d.key}|${d.model}|${d.sprite ?? ''}|${parity ? 'p' : 'm'}`;
      const inst = this.live.get(key) ?? this.make(key, d, parity);
      if (!inst) continue;
      seen.add(key);
      const data = this.combat.models[d.model];
      // (drawModel's cull: its largest extent, scaled, combat.cpp:1010-1011)
      const size = data ? Math.max(...data.size) * d.scale : 0;
      const depth = viewDepth(cam, d.pos);
      const opacity = d.alpha >= 0 ? materialOpacity(d.alpha) : 1;
      if (culled(depth, size) || opacity === 0) {
        inst.holder.visible = false;
        continue;
      }
      inst.holder.visible = true;
      modelMatrix(d.pos, inst.billboard ? cam.axes : d.m, inst.holder.matrix, d.scale);
      inst.holder.matrixWorldNeedsUpdate = true;
      this.frame(inst, d);
      for (const f of inst.fades) {
        f.material.opacity = d.alpha >= 0 ? opacity : f.own;
      }
      const tip = this.tip(inst, d.tip);
      if (inst.clips.length > 0) this.clip(inst, cam);
      spheres.push({ z: depth, size: Math.max(data ? modelRadius(data, d.scale) : 0, tip) });
      this.placedNow.push({ kind: d.kind, key: d.key, model: d.model, pos: d.pos, size, aim: d.aim });
      this.placedFrom.push(inst);
    }
    for (const [key, inst] of this.live) {
      if (seen.has(key)) continue;
      this.free(inst);
      this.live.delete(key);
    }
    return spheres;
  }

  /**
   * The torpedoes, as many as 99 at once (kMaxTorpedoes, combat.cpp:52): one InstancedMesh for all of a model and sprite, each
   * torpedo an instance placed as a billboard (its model's part is one) with its own frame (an attribute the material's UVs
   * take: `withFrames`), so a salvo is a draw call, not one each (M8 spec §8's budget).
   */
  private torpedoes(draws: readonly EffectDraw[], cam: CameraPose, parity: boolean, spheres: { z: number; size: number }[]): void {
    const groups = new Map<string, EffectDraw[]>();
    for (const d of draws) {
      const key = `${d.model}|${d.sprite ?? ''}|${parity ? 'p' : 'm'}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    for (const [key, batch] of this.batches) {
      if (groups.has(key)) continue;
      // (the other mode's batches are freed as the parity mode is switched; this mode's kept, hidden, for the next salvo)
      if (!key.endsWith(parity ? '|p' : '|m')) {
        this.freeBatch(batch);
        this.batches.delete(key);
        continue;
      }
      for (const m of batch.meshes) m.visible = false;
    }
    for (const [key, group] of groups) {
      const first = group[0]!;
      const data = this.combat.models[first.model];
      const size = data ? Math.max(...data.size) : 0;
      const shown = group.filter(d => !culled(viewDepth(cam, d.pos), size));
      const batch = this.batch(key, first, parity, group.length);
      if (!batch) continue;
      const sheet = first.sprite !== null ? this.assets.sprites.get(first.sprite) : undefined;
      shown.forEach((d, i) => {
        modelMatrix(d.pos, cam.axes, placeMatrix, 1);
        const uv = sheet ? frameUv(sheet, d.frame) : { offset: [0, 0], repeat: [1, 1] };
        for (const [j, mesh] of batch.meshes.entries()) {
          mesh.setMatrixAt(i, instanceMatrix.multiplyMatrices(placeMatrix, batch.locals[j]!));
          (mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).setXYZW(i, uv.offset[0]!, uv.offset[1]!, uv.repeat[0]!, uv.repeat[1]!);
        }
        spheres.push({ z: viewDepth(cam, d.pos), size: data ? modelRadius(data) : 0 });
        this.placedNow.push({ kind: d.kind, key: d.key, model: d.model, pos: d.pos, size, aim: d.aim });
        this.placedFrom.push(null);
      });
      for (const mesh of batch.meshes) {
        mesh.count = shown.length;
        mesh.visible = shown.length > 0;
        mesh.instanceMatrix.needsUpdate = true;
        (mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).needsUpdate = true;
      }
    }
  }

  /** A batch of torpedoes for at least `count`: made, or made again larger (to a power of two, at most 128), as first needed. */
  private batch(key: string, d: EffectDraw, parity: boolean, count: number): { meshes: InstancedMesh[]; locals: Matrix4[]; capacity: number } | null {
    const old = this.batches.get(key);
    if (old && old.capacity >= count) return old;
    const source = this.assets.models.get(d.model);
    if (!source) return null;
    if (old) this.freeBatch(old);
    const capacity = Math.min(128, 2 ** Math.ceil(Math.log2(Math.max(8, count))));
    const sheet = d.sprite !== null ? this.assets.sprites.get(d.sprite) : undefined;
    const made: { meshes: InstancedMesh[]; locals: Matrix4[]; capacity: number; owned: { dispose(): void }[] } = { meshes: [], locals: [], capacity, owned: [] };
    source.updateMatrixWorld(true);
    source.traverse(o => {
      const mesh = o as Mesh;
      // (a part the model hides is never drawn: SpaceModel::_hidden, space3d.cpp:293; a one-primitive part's node is its mesh)
      if (!mesh.isMesh || partHidden(o)) return;
      const geometry = (mesh.geometry as BufferGeometry).clone();
      geometry.setAttribute('instanceFrame', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      const holder: Instance = { holder: new Group(), meshes: [], owned: [], frames: [], fades: [], billboard: true, tipMeshes: [], tip0: null, tipSources: [], clips: [] };
      const material = this.material(mesh.material as Material, d, parity, sheet?.texture ?? null, holder);
      withFrames(material);
      const batch = new InstancedMesh(geometry, material, capacity);
      batch.frustumCulled = false;
      batch.matrixAutoUpdate = false;
      if (!parity) batch.layers.enable(BLOOM_LAYER);
      made.owned.push(geometry, ...holder.owned);
      made.meshes.push(batch);
      // (where the mesh sits in its model: the space build's root rotation, which modelMatrix undoes)
      made.locals.push(mesh.matrixWorld.clone());
      this.group.add(batch);
    });
    this.batches.set(key, made);
    return made;
  }

  private readonly batches = new Map<string, { meshes: InstancedMesh[]; locals: Matrix4[]; capacity: number; owned: { dispose(): void }[] }>();

  /** Frees every effect's own objects (not the set's). */
  dispose(): void {
    for (const inst of this.live.values()) this.free(inst);
    this.live.clear();
    for (const batch of this.batches.values()) this.freeBatch(batch);
    this.batches.clear();
    this.placedNow = [];
    this.placedFrom = [];
  }

  /**
   * Frees a torpedo batch: its meshes' own dispose (three frees an InstancedMesh's instanceMatrix buffer only on that, not
   * the geometry's), and its geometries (with their instanceFrame), materials and frame textures.
   */
  private freeBatch(batch: { meshes: InstancedMesh[]; owned: { dispose(): void }[] }): void {
    for (const m of batch.meshes) {
      this.group.remove(m);
      m.dispose();
    }
    for (const o of batch.owned) o.dispose();
  }

  private free(inst: Instance): void {
    this.group.remove(inst.holder);
    for (const o of inst.owned) o.dispose();
  }

  /** Shows the effect's sprite frame in the material whose texture it replaces (drawModel's textureName, combat.cpp:1018-1022). */
  private frame(inst: Instance, d: EffectDraw): void {
    for (const f of inst.frames) {
      const sheet = d.sprite !== null ? this.assets.sprites.get(d.sprite) : undefined;
      if (!sheet || !f.material.map || f.sheet !== d.sprite) continue;
      const { offset, repeat } = frameUv(sheet, d.frame);
      f.material.map.offset.set(offset[0], offset[1]);
      f.material.map.repeat.set(repeat[0], repeat[1]);
    }
  }

  /** Moves a beam's first vertex onto its tip (updateBeams, weapons.cpp:378-380), or back to the model's; its distance from the origin. */
  private tip(inst: Instance, tip: V3 | null): number {
    if (!inst.tip0) return 0;
    const [x, y, z] = tip ? [tip.x, tip.y, tip.z] : inst.tip0;
    for (const geometry of inst.tipSources) {
      const position = geometry.getAttribute('position') as BufferAttribute;
      if (position.getX(0) === x && position.getY(0) === y && position.getZ(0) === z) continue;
      position.setXYZ(0, x, y, z);
      position.needsUpdate = true;
    }
    return tip ? length(tip) : 0;
  }

  /**
   * The parity mode's beam, clipped as drawPolygon clips (space3d.cpp:366-387): each source vertex's depth worked out as
   * the renderer places it (through every node between its mesh and the layer, three's axes back to internal), and the
   * drawn geometry made from the parts at z = 1 or more. The GPU clips at its near plane too, but with the corners'
   * attributes in perspective, and the original's texels are lerped along the edge: battle 69's overview, the camera
   * on the shooter, shows nothing of a beam whose bank is behind it, where a GPU-clipped one runs from the screen's edge.
   */
  private clip(inst: Instance, cam: CameraPose): void {
    for (const entry of inst.clips) {
      const { mesh, source } = entry;
      const m = meshToLayer(mesh, this.group, clipMatrix);
      const p = source.getAttribute('position') as BufferAttribute;
      if (entry.depths.length < p.count) entry.depths = new Float64Array(p.count);
      const depths = entry.depths;
      for (let i = 0; i < p.count; i++) {
        const w = clipPoint.fromBufferAttribute(p, i).applyMatrix4(m);
        depths[i] = viewDepth(cam, { x: w.x, y: -w.y, z: -w.z });
      }
      clipNear(source, depths, mesh.geometry as BufferGeometry);
    }
  }

  /**
   * Where a beam's first vertex is drawn, internal: through every node between its mesh and the layer, as the renderer
   * places it (the holder's modelMatrix and the model's own root rotation). Null for an effect with no tip.
   */
  private farEnd(inst: Instance): V3 | null {
    const mesh = inst.tipMeshes[0], source = inst.tipSources[0];
    if (!mesh || !source) return null;
    const m = farMatrix;
    const p = farPoint.fromBufferAttribute(source.getAttribute('position') as BufferAttribute, 0).applyMatrix4(meshToLayer(mesh, this.group, m));
    // (three's axes back to internal: the half turn about x, axes.ts)
    return { x: p.x, y: -p.y, z: -p.z };
  }

  /** A new effect's instance: the model cloned, its materials (and a beam's first part's geometry) its own. */
  private make(key: string, d: EffectDraw, parity: boolean): Instance | null {
    const source = this.assets.models.get(d.model);
    if (!source) return null;
    const clone = source.clone(true);
    const holder = new Group();
    holder.matrixAutoUpdate = false;
    holder.add(clone);
    const inst: Instance = { holder, meshes: [], owned: [], frames: [], fades: [], billboard: false, tipMeshes: [], tip0: null, tipSources: [], clips: [] };
    // (a generic piece has no materials of its own: it takes the dying ship's detailed model's, by index (damage.cpp:486))
    const borrowed = d.borrow !== null ? this.borrowed(d.borrow) : null;
    const sheet = d.sprite !== null ? this.assets.sprites.get(d.sprite) : undefined;
    const made = new Map<Material, Material>();
    clone.traverse(o => {
      // (the whole model placed as a billboard if a part is one: drawObject decides per part (space3d.cpp:300), but every
      // effect model has one part, and none mixes the two (measured: tools/space live-projection.test.ts))
      if (o.userData.part !== undefined && o.userData.billboard) inst.billboard = true;
      if (o.userData.part !== undefined && o.userData.hidden) o.visible = false;
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      inst.meshes.push(mesh);
      // (the beams, torpedoes and explosions glow: bloom.ts)
      if (!parity && BLOOMS.has(d.kind)) mesh.layers.enable(BLOOM_LAYER);
      let base = mesh.material as Material;
      if (borrowed) base = borrowed.get(`${base.userData.index as number}|${base.side}`) ?? borrowed.get(`${base.userData.index as number}`) ?? base;
      let own = made.get(base);
      if (!own) {
        own = this.material(base, d, parity, sheet?.texture ?? null, inst);
        made.set(base, own);
      }
      mesh.material = own;
      // (the beam's first part: a one-primitive part's node is its mesh, as GLTFLoader makes it (the phaser's, as built), a
      // part of several primitives a group of them)
      const part = (o.userData.part ?? o.parent?.userData.part) as number | undefined;
      if (d.kind === 'beam' && part === 0) {
        const source = (mesh.geometry as BufferGeometry).clone();
        inst.owned.push(source);
        inst.tipMeshes.push(mesh);
        inst.tipSources.push(source);
        mesh.geometry = source;
        // (the parity mode draws it clipped as the original does: a geometry of its own, filled each frame)
        if (parity) {
          mesh.geometry = clipTarget(source, mesh.material);
          inst.owned.push(mesh.geometry);
          inst.clips.push({ mesh, source, depths: new Float64Array(0) });
        }
        const p = source.getAttribute('position') as BufferAttribute;
        inst.tip0 ??= [p.getX(0), p.getY(0), p.getZ(0)];
      }
    });
    this.group.add(holder);
    this.live.set(key, inst);
    return inst;
  }

  /**
   * An effect's own material for one of its model's: in the parity mode, or for a debris piece, a copy of the set's (lit,
   * keyed or translucent as the space build made it); else the modern look, unlit and additive, at the material's own
   * opacity (a shield's alpha 0x1000 is three quarters). Its texture, if the effect's sprite replaces it, a clone of the
   * sheet's.
   */
  private material(base: Material, d: EffectDraw, parity: boolean, sheet: Texture | null, inst: Instance): Material {
    const named = (base.userData.texture as string | undefined)?.toLowerCase();
    const replaced = sheet !== null && d.texture !== null && named === d.texture;
    const map = replaced ? sheet.clone() : ((base as Material & { map?: Texture | null }).map ?? null);
    if (replaced) inst.owned.push(map!);
    let own: Material & { map: Texture | null };
    if (parity || !ADDITIVE.has(d.kind)) {
      own = base.clone() as Material & { map: Texture | null };
      own.map = map;
    } else {
      own = new MeshBasicMaterial({ map, transparent: true, blending: AdditiveBlending, depthWrite: false, side: base.side, opacity: base.opacity });
    }
    // (a billboard's faces are drawn whichever way they face: drawObject skips the back-face test for them, space3d.cpp:311)
    if (inst.billboard) own.side = DoubleSide;
    // (the parity mode's beam reads its texture as drawTriangle does: across the screen, with no perspective)
    if (parity && d.kind === 'beam') withAffineMap(own);
    inst.owned.push(own);
    if (replaced) inst.frames.push({ material: own, sheet: d.sprite! });
    if (d.kind === 'debris') {
      // (translucent from the first frame: a program compiled opaque forces alpha to 1, and flipping `transparent` later
      // doesn't rebuild it, so the fade (damage.cpp:584-586) would never show; at opacity 1 this changes only the sorting)
      own.transparent = true;
      inst.fades.push({ material: own, own: base.opacity });
    }
    return own;
  }

  /** A model's materials by index, made once (the dying ship's detailed model's, for its generic debris). */
  private borrowed(model: string): Map<string, Material> {
    let m = this.borrows.get(model);
    if (!m) {
      m = materialsByIndex(this.assets.models.get(model));
      this.borrows.set(model, m);
    }
    return m;
  }

  private readonly borrows = new Map<string, Map<string, Material>>();
}

const placeMatrix = new Matrix4(), instanceMatrix = new Matrix4();
/** farEnd's and clip's scratch. */
const farMatrix = new Matrix4(), farPoint = new Vector3(), clipMatrix = new Matrix4(), clipPoint = new Vector3();

/** The matrix from a mesh's own space to the layer's (every node's between them, as the renderer places it), into `out`. */
function meshToLayer(mesh: Object3D, layer: Object3D, out: Matrix4): Matrix4 {
  out.identity();
  for (let o: Object3D | null = mesh; o && o !== layer; o = o.parent) {
    if (o.matrixAutoUpdate) o.updateMatrix();
    out.premultiply(o.matrix);
  }
  return out;
}

/** The near plane drawPolygon clips at (space3d.cpp:370): view depth 1. */
export const CLIP_DEPTH = 1;

/** A geometry for clipNear's output from `source`: its attributes unindexed, room for each triangle to become two. */
export function clipTarget(source: BufferGeometry, material?: Material | Material[]): BufferGeometry {
  // (clipNear writes one unindexed run under a draw range, which no material groups of the source map through; with one material
  // three ignores the groups, as the beams' own are, so only a material per group is refused)
  if (Array.isArray(material) && source.groups.length > 1) throw new Error(`a parity beam's mesh has ${source.groups.length} material groups: clipNear draws one run, so it cannot keep them`);
  const out = new BufferGeometry();
  const triangles = (source.index ? source.index.count : source.getAttribute('position').count) / 3;
  for (const [name, a] of Object.entries(source.attributes)) {
    out.setAttribute(name, new BufferAttribute(new Float32Array(triangles * 6 * a.itemSize), a.itemSize));
  }
  out.setDrawRange(0, 0);
  return out;
}

/**
 * drawPolygon's clip (space3d.cpp:366-387) of each of `source`'s triangles against view depth 1, given each vertex's
 * depth: a corner at 1 or more kept, and where an edge crosses 1 a new corner, every attribute (place, texel, normal)
 * lerped by the same step, (1 - a.z) / (b.z - a.z); the polygon then a fan of triangles from its first corner
 * (space3d.cpp:395-396), none if fewer than 3 corners are left. Written unindexed into `out` (clipTarget's), its draw
 * range the corners written.
 */
export function clipNear(source: BufferGeometry, depths: ArrayLike<number>, out: BufferGeometry): void {
  const names = Object.keys(source.attributes);
  const from = names.map(n => source.getAttribute(n) as BufferAttribute);
  const to = names.map(n => out.getAttribute(n) as BufferAttribute);
  const corners = source.index ? source.index.count : from[0]!.count;
  const at = (i: number) => (source.index ? source.index.getX(i) : i);
  let written = 0;
  // (a corner: a vertex, or the step `s` from vertex a to b)
  const put = (poly: [number, number, number][]) => {
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const [a, b, s] of [poly[0]!, poly[k]!, poly[k + 1]!]) {
        from.forEach((f, j) => {
          for (let c = 0; c < f.itemSize; c++) {
            const x = f.getComponent(a, c), y = f.getComponent(b, c);
            to[j]!.setComponent(written, c, x + (y - x) * s);
          }
        });
        written++;
      }
    }
  };
  for (let t = 0; t + 2 < corners; t += 3) {
    const tri = [at(t), at(t + 1), at(t + 2)];
    const poly: [number, number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const a = tri[i]!, b = tri[(i + 1) % 3]!;
      const za = depths[a]!, zb = depths[b]!;
      const aIn = za >= CLIP_DEPTH, bIn = zb >= CLIP_DEPTH;
      if (aIn) poly.push([a, a, 0]);
      if (aIn !== bIn) poly.push([a, b, (CLIP_DEPTH - za) / (zb - za)]);
    }
    if (poly.length >= 3) put(poly);
  }
  for (const a of to) a.needsUpdate = true;
  out.setDrawRange(0, written);
}

/**
 * A material whose map is read with no perspective, as drawTriangle interpolates everything across the screen
 * (space3d.cpp:404, 428-430): the map's coordinates carried as (uv * w, w), which the GPU's perspective-correct
 * interpolation turns into the screen's own weights once divided. Only for geometry the GPU doesn't clip (clipNear's).
 */
export function withAffineMap(material: Material): void {
  material.onBeforeCompile = shader => {
    shader.vertexShader = `varying vec3 vAffineUv;\n${shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n#ifdef USE_MAP\n\tvAffineUv = vec3( vMapUv * gl_Position.w, gl_Position.w );\n#endif')}`;
    shader.fragmentShader = `varying vec3 vAffineUv;\n${shader.fragmentShader.replace('#include <map_fragment>', ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vAffineUv.xy / vAffineUv.z )'))}`;
  };
  material.customProgramCacheKey = () => 'affineMap';
}

/** Whether the part a node is or belongs to is hidden (the space build's part extras: the root's `hidden` is the model's list, not a part's). */
function partHidden(o: Object3D): boolean {
  for (let n: Object3D | null = o; n; n = n.parent) if (n.userData.part !== undefined) return Boolean(n.userData.hidden);
  return false;
}

/**
 * A material whose map is read through each instance's `instanceFrame` (offset x, y and repeat x, y: frameUv's) in place of the
 * texture's own transform, so the torpedoes of a batch each show their own frame.
 */
export function withFrames(material: Material): void {
  material.onBeforeCompile = shader => {
    shader.vertexShader = `attribute vec4 instanceFrame;\n${shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = MAP_UV * instanceFrame.zw + instanceFrame.xy;\n#endif')}`;
  };
  material.customProgramCacheKey = () => 'instanceFrame';
}

/** A model's materials by "index|side" and by index alone (the first of each), for a generic debris piece to borrow. */
export function materialsByIndex(model: Object3D | undefined): Map<string, Material> {
  const out = new Map<string, Material>();
  model?.traverse(o => {
    const m = (o as Mesh).material as Material | undefined;
    if (!(o as Mesh).isMesh || !m) return;
    const index = m.userData.index as number | undefined;
    if (index === undefined) return;
    if (!out.has(`${index}|${m.side}`)) out.set(`${index}|${m.side}`, m);
    if (!out.has(`${index}`)) out.set(`${index}`, m);
  });
  return out;
}
