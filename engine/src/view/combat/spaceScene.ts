// SPDX-License-Identifier: GPL-3.0-or-later
import {
  AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry, Color, DataTexture, DirectionalLight, DoubleSide, Float32BufferAttribute, FrontSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, PerspectiveCamera, Points, Scene,
  Mesh, PlaneGeometry, Raycaster, ShaderMaterial, Sphere, SRGBColorSpace, Vector2, Vector3, type Material, type Object3D, type Side, type WebGLRenderer,
} from 'three';
import type { CombatData } from '../../content/types';
import { angleToRadians, bindLibm, MATH_LIBM, type M3, type V3 } from '../../sim/combat/math';
import { trigTables } from '../../sim/combat/libm';
import type { RandomState } from '../../sim/combat/random';
import type { BattleState, CameraPose } from '../../sim/combat/types';
import type { BattleAssets } from './assets';
import { cameraMatrix, modelMatrix, toThree } from './axes';
import { cameraDistance, cameraPose, culled, shimmerAt, shipPose, shipShown, shipTier, stepFraction, viewDepth } from './draw';
import { BLOOM_LAYER, compileFor, HIDES_LAYER, SelectiveBloom } from './bloom';
import { BLOOMS, EffectLayer, withFrames } from './effectLayer';
import { effectsOf, flashColour, StepMemory, type BeamAim, type EffectKind } from './effects';
import { fitDepth, setProjection } from './projection';
import { TargetMarksLayer, targetMarks, viewPoint, type Box, type TargetMarks } from './targetMarks';
import { driftStars, makeStars, presentationInt, presentationRandom, STAR_RANGE, STAR_STEP, starDrift, starPixel, twinkle, type Star } from './stars';

/** The warp overlay, in the combat chunk with the view (the host makes it from the module: combatView.ts). */
export { WarpOverlay } from './warpOverlay';
/** The half-resolution view (the Combat Options' Resolution 2), in the chunk too: the host makes it from the module. */
export { ScaledView } from './scaledView';
// (the console, which the combat chunk carries too: Plan 27 R2)
export { CombatConsole } from '../../ui/combat/console';
// (the console's picture for a preview's state, the screenshot check's: Plan 27 R17)
export { consolePalette, drawConsole } from './consoleFrame';

/**
 * The space view (M8 spec §3): a battle drawn by three from the battle's set (Plan 24's BattleAssets), through the
 * app's one renderer. It reads the battle and never writes it. Each ship is a clone of its set's model (sharing its
 * geometry and materials), placed by axes.ts; the level of detail, the cull and the cloak are drawShip's (draw.ts); the
 * camera is the sim's (camera.ts), between the last two steps unless in the parity mode; the stars are drawStars'.
 */

/** The original's light (combat.cpp:76): from above and behind, internal (0, -0.7071, -0.7071). */
export const LIGHT_DIRECTION = { x: 0, y: -0.7071, z: -0.7071 } as const;
/**
 * The lights' strengths (M8 spec §3.1): the original lights a colour by 0.55 + n·L in its palette's (sRGB) values
 * (space3d.cpp:264-269, its tables' rows, space3d.cpp:228-233); three lights in linear values, a Lambert surface
 * taking 1/π of a light. 0.196 and 1.99 are the least-squares fit, over n·L 0 to 1 and albedos a quarter, half and
 * three quarters, of three's sRGB output to the original's (largest difference 0.06 of full scale, at n·L 0 and 1).
 */
export const AMBIENT_LIGHT = 0.196 * Math.PI;
export const KEY_LIGHT = 1.99 * Math.PI;

/** The stars' palette entries (tactical.cpp:173-179): dim, grey, bright, red and blue. */
export const STAR_COLOURS = { dim: 0x82, grey: 0x84, bright: 0x87, red: 0xa1, blue: 0xa9 } as const;
/** Without the stills' palette: the entries as the space palette has them (measured), close enough for greys. */
const STAR_FALLBACK = { dim: [31, 31, 31], grey: [67, 67, 67], bright: [119, 119, 119], red: [75, 15, 15], blue: [15, 47, 71] } as const;

/** How the view is drawn: the window it fills, and the parity mode (M8 spec §9.3: no interpolation, no shimmer). */
export interface SpaceSceneOptions {
  /** The window in the original's units: Split's 320 x 220, or 640 across for the wide view (its height by the viewport's aspect). */
  width: number;
  height: number;
  parity: boolean;
  /** prefers-reduced-motion: the shimmer steady, the red flash at 40% (M8 spec §3.2). */
  reducedMotion?: boolean;
  /** The red flash's strength this frame (0 none, 1 the original's): space's background tinted (effects.ts flashColour). */
  flash?: number;
  /**
   * The Combat Options (Plan 32; the F1 options', help.cpp 0x98042), each today's look unless given, and never in the parity
   * mode: the stars (and the plate behind them); the detail, High lit and textured, Medium lit and untextured, Low flat at
   * every distance; the radar, the target's marks (targetMarks.ts).
   */
  stars?: boolean;
  detail?: 'high' | 'medium' | 'low';
  radar?: boolean;
  /** The boxes of the window the wide view's HUD covers (window units), which the target's arrow keeps clear of. */
  keepOut?: readonly Box[];
}

/** How a ship's instance is drawn: the set's own materials, untextured copies (Medium), or the flat tier's. */
type Look = 'lit' | 'plain' | 'flat';

/**
 * What of a ship's instance hides a glow's halo (bloom.ts), as depth alone: the triangles of its solid parts (no alpha cutout,
 * not translucent: a glow seen through a keyed hole keeps its halo) that the model shows, merged into one geometry for each
 * side they are drawn with, in `inst`'s own space. The bloom's pre-pass then draws a ship in a draw or two, not one for each
 * of its meshes: a ship model is some thirty meshes, so battle 82's three ships drew some ninety calls more in each frame
 * that glowed (210 against the budget's 150), when a draw for each mesh. A triangle of a part mirrored within the model is
 * turned about, as three turns a mirrored mesh's faces. A mesh of several materials is drawn both sides when they differ
 * (none of the shipped ships' is: markDamage takes one material a mesh).
 */
export function hidingDepth(inst: Object3D): Map<Side, BufferGeometry> {
  inst.updateMatrixWorld(true);
  const inverse = inst.matrixWorld.clone().invert();
  const into = new Map<Side, { positions: number[]; indices: number[] }>();
  const m = new Matrix4(), v = new Vector3();
  const solid = (x: Material) => x.alphaTest === 0 && !x.transparent;
  const shown = (o: Object3D) => {
    for (let n: Object3D | null = o; n && n !== inst; n = n.parent) if (!n.visible) return false;
    return inst.visible;
  };
  inst.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !shown(o)) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const position = mesh.geometry.getAttribute('position');
    if (materials.length === 0 || !materials.every(solid) || !position) return;
    const side = materials.every(x => x.side === materials[0]!.side) ? materials[0]!.side : DoubleSide;
    const part = into.get(side) ?? { positions: [], indices: [] };
    into.set(side, part);
    m.multiplyMatrices(inverse, mesh.matrixWorld);
    const base = part.positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(m);
      part.positions.push(v.x, v.y, v.z);
    }
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    const at = (i: number) => base + (index ? index.getX(i) : i);
    const mirrored = m.determinant() < 0;
    for (let i = 0; i + 2 < count; i += 3) {
      if (mirrored) part.indices.push(at(i), at(i + 2), at(i + 1));
      else part.indices.push(at(i), at(i + 1), at(i + 2));
    }
  });
  const out = new Map<Side, BufferGeometry>();
  for (const [side, { positions, indices }] of into) {
    if (indices.length === 0) continue;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeBoundingSphere();
    out.set(side, g);
  }
  return out;
}

/** The shimmer's colour: a pale blue-white (not the original's: it has no shimmer). */
export const SHIMMER_COLOUR = 0xa8d8ff;

/** A ship drawn this frame: which, with what, and where on the window (its centre and its size's radius, in the window's units). */
export interface DrawnShip { index: number; model: string; flat: boolean; x: number; y: number; r: number }

/**
 * An effect drawn this frame (effects.ts): what, and where on the window, as DrawnShip says it; a beam with a tip and a
 * target, also where its far end is drawn on the window and how it was aimed (BeamAim): `off`, how far the end is drawn
 * from the target's drawn centre, `radius` the target's and `lag` the length of its lag, internal units; for the tests.
 */
export interface DrawnEffect {
  kind: EffectKind; key: string; model: string; x: number; y: number; r: number;
  end?: { x: number; y: number };
  aim?: { to: number; kind: BeamAim['kind']; stale: boolean; off: number; radius: number; lag: number };
}

/** rgb555 (SpaceTables::rgb555, space3d.h:121) as a colour. */
function rgb555(c: number): Color {
  return new Color().setRGB(((c >> 10) & 31) / 31, ((c >> 5) & 31) / 31, (c & 31) / 31, SRGBColorSpace);
}

const STAR_VERTEX = /* glsl */ `
attribute float kind;
attribute float bright;
uniform vec2 window;
uniform float cell;
varying float vKind;
varying float vBright;
void main() {
  vKind = kind;
  vBright = bright;
  // (the star's pixel's middle, in the window's units, to clip space: y down)
  vec2 p = position.xy + 0.5;
  gl_Position = vec4(p.x / window.x * 2.0 - 1.0, 1.0 - p.y / window.y * 2.0, 0.0, 1.0);
  gl_PointSize = cell * 5.0;
}`;
/** drawStars' shapes (tactical.cpp:914-948) on a 5 x 5 grid of the window's pixels about the star. */
const STAR_FRAGMENT = /* glsl */ `
uniform vec3 dim;
uniform vec3 grey;
uniform vec3 bright;
uniform vec3 red;
uniform vec3 blue;
varying float vKind;
varying float vBright;
void main() {
  ivec2 c = ivec2(floor(gl_PointCoord * 5.0)) - 2;
  int k = int(vKind + 0.5);
  bool middle = c.x == 0 && c.y == 0;
  int ax = abs(c.x), ay = abs(c.y);
  vec3 col;
  if (k == 1) {
    if (middle) col = bright;
    else if (c.y == 0 && ax == 1) col = grey;
    else if ((c.y == 0 && ax == 2) || (c.x == 0 && ay == 1)) col = dim;
    else discard;
  } else if (k == 2) { if (!middle) discard; col = red; }
  else if (k == 3) { if (!middle) discard; col = blue; }
  else if (k == 4) { if (middle) col = grey; else if (ax == 1 && ay == 1) col = dim; else discard; }
  else if (k == 5) { if (middle) col = grey; else if (ax + ay == 1) col = dim; else discard; }
  else if (k == 6) { if (middle) col = grey; else if (c.y == 0 && ax == 1) col = dim; else discard; }
  else { if (!middle) discard; col = vBright > 0.5 ? bright : grey; }
  gl_FragColor = vec4(col, 1.0);
}`;

const BACKDROP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
/**
 * The plate behind the stars: a picture 1920 units square (the stars' wrap, kStarRange each way), repeated by the texture's
 * RepeatWrapping (no fract: its jump at the edge would pick the smallest mip along a line), its middle at `anchor` and
 * turned by `angle` as driftStars moves and turns a star, at the stars' scale. `flash` is space's background (linear),
 * added as the red flash tints entry 0: where the plate is black it is exactly the background.
 */
const BACKDROP_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform vec2 window;
uniform float scale;
uniform vec2 anchor;
uniform float angle;
uniform vec3 flash;
varying vec2 vUv;
void main() {
  vec2 p = (vec2(vUv.x, 1.0 - vUv.y) * window - window * 0.5) / scale - anchor;
  float c = cos(angle), s = sin(angle);
  vec2 q = vec2(p.x * c + p.y * s, p.y * c - p.x * s);
  gl_FragColor = vec4(min(texture2D(map, q / 1920.0 + 0.5).rgb + flash, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

/** One battle's scene: build it from the set, `update` it each frame, draw `scene` with `camera`, `dispose` it as the battle ends. */
export class SpaceScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera();
  private readonly holders: Group[] = [];
  /** Each ship's instances by "model|look", made as first needed. */
  private readonly instances: Map<string, Object3D>[] = [];
  /** The flat tier's materials (kFlatFlags, combat.cpp:55: unlit, untextured), one per model material: the scene's own. */
  private readonly flatMaterials = new Map<Material, MeshBasicMaterial>();
  /** Medium detail's materials: each a copy of a model material without its texture, lit as it is; the scene's own. */
  private readonly plainMaterials = new Map<Material, Material>();
  /** The target's marks (the Radar option), over the view. */
  private readonly marks: TargetMarksLayer;
  private marked: TargetMarks | null = null;
  /** Device pixels a window unit (setPixelScale), which the marks' lines are at least a pixel of. */
  private pixelScale = 1;
  /** When each ship last had a decloak time: its shimmer starts there. */
  private readonly decloakAt: number[] = [];
  private readonly random: RandomState;
  /** The backdrop slot (M8 spec Decision 14): the battle's plate, if its set has one, behind the stars, drifting with them. */
  private readonly backdrop: Mesh<PlaneGeometry, ShaderMaterial>;
  /**
   * Where the plate's middle is (window units about the middle), moved as a star is but without the stars' ±960 wrap on
   * the screen's axes, and how far the roll has turned it (radians, in [0, 2π)); see driftBackdrop.
   */
  private readonly anchor = { x: 0, y: 0 };
  private backdropAngle = 0;
  /** The beams, shields, explosions, torpedoes and debris (effectLayer.ts), and where the torpedoes and pieces were a step ago. */
  private readonly effects: EffectLayer;
  private memory = new StepMemory();
  /** The last update's effects on the window, once asked for (effectsDrawn); null until then. */
  private drawnEffects: DrawnEffect[] | null = [];
  private effectsWindow = { width: 0, height: 0 };
  private readonly stars: Star[];
  private readonly starPoints: Points;
  private readonly starGeometry = new BufferGeometry();
  private readonly starMaterial: ShaderMaterial;
  private readonly starXY: Float32Array;
  private readonly starBright: Uint8Array;
  private lastAxes: M3 | null = null;
  private drawnShips: DrawnShip[] = [];
  /** The ships the last update drew, each where it was drawn and its size: what a click can pick (pick). */
  private pickable: { index: number; pos: V3; size: number }[] = [];
  /** Each ship's shimmers by "model|look": a copy of its instance in a shimmer material of its own, made as first needed. */
  private readonly glows: Map<string, { glow: Object3D; material: MeshBasicMaterial }>[] = [];
  /** Each "model|look"'s depth for the bloom's pre-pass (hidingDepth), by side: made as first needed, freed with the battle's state. */
  private readonly hiding = new Map<string, Map<Side, BufferGeometry>>();
  /** The pre-pass's meshes' own materials, by side: never drawn (the bloom's depth material overrides them), but the side it takes. */
  private readonly hidingMaterials = new Map<Side, MeshBasicMaterial>();
  /** Something is on the bloom layer this frame. */
  private blooming = false;
  private bloom: SelectiveBloom | null = null;
  /** The battle the per-ship state is for. */
  private battle: BattleState | null = null;
  /** Each ship's detailed instance's meshes and their own materials, for the damage textures: made as first needed. */
  private readonly damage = new WeakMap<Object3D, { mesh: Mesh; own: Material }[]>();
  /** A damage model's textured materials by "index|side" (its file's materials, SpaceResources::materials of `<base>.dmg`). */
  private readonly damageSets = new Map<string, Map<string, Material>>();
  private readonly trig: { sin: Float32Array; cos: Float32Array } | null;

  constructor(
    private readonly assets: BattleAssets,
    private readonly combat: CombatData,
    seed: number,
    private options: SpaceSceneOptions,
  ) {
    this.trig = trigTables(combat);
    this.camera.matrixAutoUpdate = false;
    // (space is the palette's colour 0, black: SpaceRenderer::clear, space3d.cpp:261-264)
    this.scene.background = new Color(0, 0, 0);
    this.scene.add(new AmbientLight(0xffffff, AMBIENT_LIGHT));
    const key = new DirectionalLight(0xffffff, KEY_LIGHT);
    key.position.copy(toThree(LIGHT_DIRECTION));
    this.scene.add(key);
    this.random = presentationRandom(seed);
    this.stars = makeStars(this.random);
    this.starXY = new Float32Array(this.stars.length * 3);
    this.starBright = new Uint8Array(this.stars.length).fill(1);
    this.starGeometry.setAttribute('position', new BufferAttribute(this.starXY, 3));
    this.starGeometry.setAttribute('kind', new BufferAttribute(new Float32Array(this.stars.map(s => s.type)), 1));
    this.starGeometry.setAttribute('bright', new BufferAttribute(this.starBright, 1, true));
    const palette = assets.stills?.palette;
    const colour = (name: keyof typeof STAR_COLOURS) => {
      const i = STAR_COLOURS[name];
      const rgb = palette ? [palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!] : STAR_FALLBACK[name];
      // (the palette's values as they are: the stars' shader writes its colour straight out, with no colour-space step)
      return new Color(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255);
    };
    this.starMaterial = new ShaderMaterial({
      vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: {
        window: { value: [options.width, options.height] }, cell: { value: 1 },
        dim: { value: colour('dim') }, grey: { value: colour('grey') }, bright: { value: colour('bright') }, red: { value: colour('red') }, blue: { value: colour('blue') },
      },
    });
    this.starPoints = new Points(this.starGeometry, this.starMaterial);
    this.starPoints.frustumCulled = false;
    this.starPoints.renderOrder = -1;
    this.backdrop = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      vertexShader: BACKDROP_VERTEX, fragmentShader: BACKDROP_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: { map: { value: assets.backdrop ?? null }, window: { value: [options.width, options.height] }, scale: { value: 1 }, anchor: { value: [0, 0] }, angle: { value: 0 }, flash: { value: new Color(0, 0, 0) } },
    }));
    this.backdrop.name = 'backdrop';
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -2;
    this.backdrop.visible = false;
    this.scene.add(this.backdrop);
    this.effects = new EffectLayer(assets, combat);
    this.effects.group.name = 'effects';
    this.scene.add(this.effects.group);
    this.scene.add(this.starPoints);
    this.marks = new TargetMarksLayer(assets.stills?.palette ?? null);
    this.scene.add(this.marks.mesh);
  }

  /** Changes the window (Split or wide, or the viewport's aspect) or the parity mode. */
  setOptions(options: SpaceSceneOptions): void {
    this.options = options;
  }

  /** The effects drawn by the last update, for the dev hooks and the tests. */
  effectsDrawn(): readonly DrawnEffect[] {
    if (!this.drawnEffects) {
      const { width, height } = this.effectsWindow;
      const ends = this.effects.ends();
      this.drawnEffects = this.effects.placed().map((e, i) => {
        const drawn: DrawnEffect = { kind: e.kind, key: e.key, model: e.model, ...this.onWindow(e.pos, e.size, width, height) };
        const end = ends[i];
        if (!end || !e.aim) return drawn;
        const at = this.onWindow(end, 0, width, height);
        const { to, kind, stale, lag, radius } = e.aim, c = e.aim.at;
        // (how far the end is drawn from the target's centre, in space: the window's disc is the sphere's projection at the
        // centre's depth, which a point on its near side overhangs)
        const off = Math.hypot(end.x - c.x, end.y - c.y, end.z - c.z);
        return { ...drawn, end: { x: at.x, y: at.y }, aim: { to, kind, stale, off, radius, lag: lag ? Math.hypot(lag.x, lag.y, lag.z) : 0 } };
      });
    }
    return this.drawnEffects;
  }

  /** The target's marks the last update drew, or null: for the tests. */
  targetMarked(): TargetMarks | null {
    return this.marked;
  }

  /** The ships drawn by the last update, for the dev hooks and the tests. */
  drawn(): readonly DrawnShip[] {
    return this.drawnShips;
  }

  /**
   * The ship under (x, y) of the window (its units, y down), for a click or a tap on the view (M8 spec §6.1; Plan 29 R6): a ray
   * from the camera through that point against each ship the last update drew, as a sphere about its drawn centre of its size
   * (the cull's, drawShip's `size`), the nearest along the ray first. Only what was drawn: a cloaked ship, one culled or past the
   * flat tier can't be picked. Never the Enterprise, which mouseClick never makes the target (`blip.ship > 0`, tactical.cpp:696),
   * and which doesn't hide what is behind it. Null when no ship is there.
   */
  pick(x: number, y: number): number | null {
    const { width, height } = this.options;
    const caster = new Raycaster();
    caster.setFromCamera(new Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), this.camera);
    const hit = new Vector3();
    let best: number | null = null, nearest = Infinity;
    for (const p of this.pickable) {
      if (p.index === 0) continue;
      if (!caster.ray.intersectSphere(new Sphere(toThree(p.pos), p.size), hit)) continue;
      const d = hit.distanceTo(caster.ray.origin);
      if (d < nearest) [best, nearest] = [p.index, d];
    }
    return best;
  }

  /** How many device pixels a window unit is: the stars' cell (one of the original's pixels). */
  setPixelScale(devicePixelsPerUnit: number): void {
    this.starMaterial.uniforms.cell!.value = devicePixelsPerUnit;
    this.pixelScale = devicePixelsPerUnit;
  }

  /** Places everything for the battle as it is now. */
  update(b: BattleState): void {
    // (the sim's maths in the battle's own C library: the lifted trig table, as each sim entry binds it; what was bound is
    // bound again after, so maths run outside a sim entry never meets the view's)
    const was = bindLibm(this.trig ? { sin: this.trig.sin, cos: this.trig.cos, angle: null } : MATH_LIBM);
    try {
      this.place(b);
    } finally {
      bindLibm(was);
    }
  }

  /** Forgets what the scene kept of another battle (a preview's new state with the same set): its ships' instances, decloak times and effects, and its camera's last axes. */
  private forget(): void {
    for (const h of this.holders) this.scene.remove(h);
    for (const depth of this.hiding.values()) for (const g of depth.values()) g.dispose();
    this.hiding.clear();
    this.holders.length = 0;
    this.instances.length = 0;
    for (const ship of this.glows) for (const { material } of ship?.values() ?? []) material.dispose();
    this.glows.length = 0;
    this.decloakAt.length = 0;
    this.effects.dispose();
    this.memory = new StepMemory();
    // (and the camera the stars last drifted from: another battle's first frame starts its own drift, not one from this one's turn)
    this.lastAxes = null;
  }

  private place(b: BattleState): void {
    // (the per-ship state is by index in b.ships, which a battle never shrinks or reorders (a ship is removed, not taken out);
    // another battle, or fewer ships, starts it again)
    if (b !== this.battle || b.ships.length < this.holders.length) {
      this.forget();
      this.battle = b;
    }
    const { width, height, parity } = this.options;
    // (the Combat Options, or today's look in the parity mode)
    const detail = parity ? 'high' : this.options.detail ?? 'high';
    const t = stepFraction(b, parity);
    const cam = cameraPose(b, t);
    cameraMatrix(cam.pos, cam.axes, this.camera.matrix);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    // (space is palette entry 0: black, or red in a flash, tactical.cpp:484-493)
    (this.scene.background as Color).setRGB(...flashColour(this.options.flash ?? 0), SRGBColorSpace);
    // (the plate covers space, so it takes the same tint)
    (this.backdrop.material.uniforms.flash!.value as Color).copy(this.scene.background as Color);
    const spheres: { z: number; size: number }[] = [];
    const placed: { index: number; model: string; flat: boolean; pos: V3; size: number }[] = [];
    this.blooming = false;
    b.ships.forEach((ship, i) => {
      const holder = this.holder(i);
      for (const inst of this.instances[i]!.values()) inst.visible = false;
      for (const { glow } of this.glows[i]!.values()) glow.visible = false;
      if (ship.decloakTime) this.decloakAt[i] = ship.decloakTime;
      if (!shipShown(ship, b.now)) return;
      const shimmer = parity ? null : shimmerAt(this.decloakAt[i] ?? -Infinity, b.now);
      const pose = shipPose(ship, t);
      const kind = this.combat.kinds[ship.type];
      const tier = kind ? shipTier(kind, ship.models, cameraDistance(cam, pose.pos), detail === 'low') : null;
      if (!tier) return;
      const s = this.combat.models[tier.model]?.size;
      const size = s ? Math.max(s[0], s[1], s[2]) : ship.radius;
      const depth = viewDepth(cam, pose.pos);
      if (culled(depth, size)) return;
      const look: Look = tier.flat ? 'flat' : detail === 'medium' ? 'plain' : 'lit';
      const inst = this.instance(i, tier.model, look);
      if (!inst) return;
      inst.visible = true;
      // (hits leave their marks on the detailed model: combat.cpp:1045-1053)
      if (!tier.flat && tier.model === ship.models.detail) this.markDamage(inst, ship.models.damaged, ship.damagedMaterials, look === 'plain');
      if (shimmer !== null) this.shimmer(i, `${tier.model}|${look}`, inst, shimmer);
      modelMatrix(pose.pos, pose.m, holder.matrix);
      holder.matrixWorldNeedsUpdate = true;
      spheres.push({ z: depth, size });
      placed.push({ index: i, model: tier.model, flat: tier.flat, pos: pose.pos, size });
    });
    spheres.push(...this.effects.update(effectsOf(b, this.combat, t, this.memory), cam, parity));
    if (!parity && this.effects.placed().some(e => BLOOMS.has(e.kind))) this.blooming = true;
    const { near, far } = fitDepth(spheres);
    setProjection(this.camera, width, height, near, far);
    this.drawnShips = placed.map(p => ({ index: p.index, model: p.model, flat: p.flat, ...this.onWindow(p.pos, p.size, width, height) }));
    this.pickable = placed.map(({ index, pos, size }) => ({ index, pos, size }));
    // (the effects' list is the dev hooks' and the tests': worked out when asked, from this update's placing and camera)
    this.drawnEffects = null;
    this.effectsWindow = { width, height };
    this.updateStars(cam.axes, width, height);
    this.markTarget(b, cam, t, width, height);
    this.scene.updateMatrixWorld();
  }

  /**
   * The target's marks (the Radar option, R4): the brackets about it, or the arrow toward it, while it shows and the sensors read
   * (0x167f94: checkSensors' reliable, weapons.cpp). Not in the parity mode.
   */
  private markTarget(b: BattleState, cam: CameraPose, t: number, width: number, height: number): void {
    const ship = b.target === null ? undefined : b.ships[b.target];
    let target: { at: V3; size: number } | null = null;
    if (!this.options.parity && (this.options.radar ?? true) && ship && shipShown(ship, b.now)) {
      const s = this.combat.models[ship.models.detail ?? '']?.size;
      target = { at: viewPoint(cam, shipPose(ship, t).pos), size: s ? Math.max(s[0], s[1], s[2]) : ship.radius };
    }
    this.marked = targetMarks(target, b.console.sensorsReliable, width, height, this.options.keepOut);
    this.marks.set(this.marked, width, height, this.pixelScale);
  }

  /** A ship's holder, made as first needed: the node its instances hang from, placed by modelMatrix. */
  private holder(i: number): Group {
    let h = this.holders[i];
    if (!h) {
      h = new Group();
      h.name = `ship:${i}`;
      h.matrixAutoUpdate = false;
      this.holders[i] = h;
      this.instances[i] = new Map();
      this.glows[i] = new Map();
      this.scene.add(h);
    }
    return h;
  }

  /**
   * Ship i's instance of a model, lit, plain (Medium detail) or flat: a clone of the set's (its geometry shared, and its
   * materials too when lit), made once.
   */
  private instance(i: number, model: string, look: Look): Object3D | null {
    const key = `${model}|${look}`;
    const map = this.instances[i]!;
    let inst = map.get(key);
    if (inst) return inst;
    const source = this.assets.models.get(model);
    if (!source) return null;
    inst = source.clone(true);
    inst.traverse(o => {
      // (a part the model hides is never drawn: SpaceModel::_hidden, space3d.cpp:283-284)
      if (o.userData.part !== undefined && o.userData.hidden) o.visible = false;
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (look !== 'lit') {
        const swap = (m: Material) => look === 'flat' ? this.flatMaterial(m) : this.plainMaterial(m);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      }
    });
    // (the ship hides the halo of what glows behind it (bloom.ts), but for a keyed or translucent part, which shows it through:
    // its solid parts' depth, merged, a draw or two a ship (hidingDepth), on HIDES_LAYER alone, which the frame doesn't draw)
    let depth = this.hiding.get(key);
    if (!depth) {
      depth = hidingDepth(inst);
      this.hiding.set(key, depth);
    }
    for (const [side, geometry] of depth) {
      const hides = new Mesh(geometry, this.hidingMaterial(side));
      hides.layers.set(HIDES_LAYER);
      hides.userData.hides = true;
      inst.add(hides);
    }
    map.set(key, inst);
    this.holders[i]!.add(inst);
    return inst;
  }

  /**
   * Combat::drawShip's damage (combat.cpp:1045-1053): each of the ship's damaged materials that its damage model has a texture
   * for is drawn with the damage model's material instead (the `.dmg` file's, which the space build put on the detailed
   * geometry: the same material indices); every other keeps its own. The set's materials, shared, not copied. (ScummVM swaps
   * only the texture of the ship's own material; this port swaps the whole `.dmg` material. On the shipped models the two agree:
   * every `.dmg` material that has a texture matches the ship's own in type, alpha and flags, and the one colour difference is
   * on an untextured material, which is never swapped.)
   */
  private markDamage(inst: Object3D, damagedModel: string | null, damaged: readonly number[], plain: boolean): void {
    let meshes = this.damage.get(inst);
    if (!meshes) {
      meshes = [];
      inst.traverse(o => { if ((o as Mesh).isMesh && !o.userData.hides) meshes!.push({ mesh: o as Mesh, own: (o as Mesh).material as Material }); });
      this.damage.set(inst, meshes);
    }
    const swaps = damagedModel !== null && damaged.length > 0 ? this.damageSet(damagedModel) : null;
    for (const { mesh, own } of meshes) {
      const index = own.userData.index as number | undefined;
      const swap = swaps && index !== undefined && damaged.includes(index) ? swaps.get(`${index}|${own.side}`) : undefined;
      // (Medium: the damage model's material untextured too, as the instance's own are)
      mesh.material = swap ? (plain ? this.plainMaterial(swap) : swap) : own;
    }
  }

  private damageSet(model: string): Map<string, Material> {
    let set = this.damageSets.get(model);
    if (!set) {
      set = new Map();
      this.assets.models.get(model)?.traverse(o => {
        const m = (o as Mesh).material as Material | undefined;
        if (!(o as Mesh).isMesh || !m || !(m as Material & { map?: unknown }).map) return;
        set!.set(`${m.userData.index as number}|${m.side}`, m);
      });
      this.damageSets.set(model, set);
    }
    return set;
  }

  /**
   * The decloak's shimmer (M8 spec Decision 8): about the ship, shown as the sim shows it, a glow of its own shape that only
   * the bloom draws (bloom.ts), fading over the shimmer's 400 ms (`p` 0 to 1), flickering by the view's own generator
   * (Decision 10), or steady under prefers-reduced-motion. Not the original's: the parity mode has none.
   */
  private shimmer(i: number, key: string, inst: Object3D, p: number): void {
    let made = this.glows[i]!.get(key);
    if (!made) {
      const material = new MeshBasicMaterial({ color: SHIMMER_COLOUR, transparent: true, blending: AdditiveBlending, depthWrite: false });
      const glow = inst.clone(true);
      // (the shape the ship shows: not its depth for the bloom's pre-pass)
      const depth: Object3D[] = [];
      glow.traverse(o => { if (o.userData.hides) depth.push(o); });
      for (const o of depth) o.removeFromParent();
      // (on the bloom's layer alone: the ship is drawn as it is, and its glow is the bloom's halo about it)
      glow.traverse(o => {
        o.layers.set(BLOOM_LAYER);
        if ((o as Mesh).isMesh) (o as Mesh).material = material;
      });
      made = { glow, material };
      this.glows[i]!.set(key, made);
      this.holders[i]!.add(glow);
    }
    made.glow.visible = true;
    // (half to full strength each frame, by the view's own generator; steady under prefers-reduced-motion)
    const flicker = this.options.reducedMotion ? 1 : 0.5 + presentationInt(this.random, 50) / 100;
    made.material.opacity = (1 - p) * flicker;
    this.blooming = true;
  }

  /**
   * Draws the bloom (bloom.ts) over what the renderer just drew of the scene, in its viewport, when something glows this
   * frame: the view's `after` step. Nothing in the parity mode.
   */
  postRender(renderer: WebGLRenderer): void {
    if (!this.blooming || this.options.parity) return;
    (this.bloom ??= new SelectiveBloom()).render(renderer, this.scene, this.camera);
  }

  /**
   * Readies the view before its first frame (Plan 34 Task 8), which would otherwise stall on its first use of each program and
   * texture, and on the bloom's build at the first glow: every program its frames draw with compiled (the scene's own; each
   * of the set's models as the view draws it, lit or Medium's plain, and flat; the effects' additive look, a torpedo
   * batch's, and the shimmer's; the bloom's, which it builds now, but in the parity mode, which has none), the bloom's targets made for a view `viewport` device
   * pixels on the canvas, and then the set's textures uploaded, one at a time, a task each, so no one stretch blocks the
   * page. The host draws nothing of the battle until it is done (combatView.ts).
   */
  async warm(renderer: WebGLRenderer, viewport: { width: number; height: number }): Promise<void> {
    const detail = this.options.parity ? 'high' : this.options.detail ?? 'high';
    const ships = new Group();
    for (const source of this.assets.models.values()) {
      source.traverse(o => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const own = mesh.material;
        const swap = (f: (m: Material) => Material) => (Array.isArray(own) ? own.map(f) : f(own));
        ships.add(new Mesh(mesh.geometry, detail === 'medium' ? swap(m => this.plainMaterial(m)) : own));
        ships.add(new Mesh(mesh.geometry, swap(m => this.flatMaterial(m))));
      });
    }
    const waits: Promise<unknown>[] = [compileFor(renderer, this.scene, this.camera, this.scene), compileFor(renderer, ships, this.camera, this.scene)];
    if (!this.options.parity) {
      // (the effects' modern look, on the canvas and into the bloom's target: a program for each)
      const glows = this.glowSamples();
      waits.push(compileFor(renderer, glows, this.camera, this.scene));
      waits.push((this.bloom ??= new SelectiveBloom()).warm(renderer, viewport.width, viewport.height, glows, this.scene, this.camera));
    }
    await Promise.all(waits);
    const textures = [...this.assets.textures, ...(this.assets.backdrop ? [this.assets.backdrop] : [])];
    for (const t of textures) {
      if (this.disposed) return;
      renderer.initTexture(t);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /**
   * One of each program the effects' modern look and the shimmer draw with (effectLayer.ts' material: unlit, additive,
   * with a map or none, one-sided or a billboard's two; a torpedo batch's frames), as meshes to compile. Their materials are
   * kept until dispose, so the programs stay while the battle does, not freed and compiled again each time the last beam goes.
   */
  private glowSamples(): Group {
    const group = new Group();
    const quad = new PlaneGeometry(1, 1);
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const additive = (withMap: boolean, side: typeof FrontSide | typeof DoubleSide) => {
      const m = new MeshBasicMaterial({ map: withMap ? map : null, transparent: true, blending: AdditiveBlending, depthWrite: false, side });
      this.warmed.push(m);
      return m;
    };
    for (const withMap of [false, true]) for (const side of [FrontSide, DoubleSide]) group.add(new Mesh(quad, additive(withMap, side)));
    const torpedo = additive(true, DoubleSide);
    withFrames(torpedo);
    const batch = quad.clone();
    batch.setAttribute('instanceFrame', new InstancedBufferAttribute(new Float32Array(4), 4));
    group.add(new InstancedMesh(batch, torpedo, 1));
    this.warmed.push(quad, batch, map);
    return group;
  }

  /** What warm() made to compile, kept until dispose; and whether the scene is freed (a warm-up still going stops). */
  private readonly warmed: { dispose(): void }[] = [];
  private disposed = false;

  /** Whether the last update drew something on the bloom layer (an effect that glows, a shimmer): postRender blooms only then. */
  blooms(): boolean {
    return this.blooming;
  }

  /** The flat tier's material for a model's: its raw colour (material.colour, rgb555), unlit (kFlatFlags: kRenderUnlit, kRenderNoTexture). */
  private flatMaterial(m: Material): MeshBasicMaterial {
    let f = this.flatMaterials.get(m);
    if (!f) {
      const colour = m.userData.colour as number | undefined;
      f = new MeshBasicMaterial({ color: colour === undefined ? new Color(0.5, 0.5, 0.5) : rgb555(colour), side: m.side });
      this.flatMaterials.set(m, f);
    }
    return f;
  }

  /**
   * Medium detail's material for a model's (the F1 options' Medium: Gouraud, no textures): a copy without its texture, lit, in
   * the material's raw colour (material.colour, as the flat tier's) where the texture gave it its colour.
   */
  private plainMaterial(m: Material): Material {
    let p = this.plainMaterials.get(m);
    if (!p) {
      const copy = m.clone() as Material & { map?: unknown; color?: Color };
      if (copy.map) {
        copy.map = null;
        const colour = m.userData.colour as number | undefined;
        if (colour !== undefined && copy.color) copy.color.copy(rgb555(colour));
      }
      p = copy;
      this.plainMaterials.set(m, p);
    }
    return p;
  }

  /** A point's place on the window (units) and the radius `size` makes there, for the drawn list. */
  private onWindow(pos: { x: number; y: number; z: number }, size: number, width: number, height: number): { x: number; y: number; r: number } {
    const p = toThree(pos).project(this.camera);
    const edge = toThree(pos).add(new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(size)).project(this.camera);
    const x = ((p.x + 1) / 2) * width, y = ((1 - p.y) / 2) * height;
    return { x, y, r: Math.hypot(((edge.x + 1) / 2) * width - x, ((1 - edge.y) / 2) * height - y) };
  }

  /**
   * Moves the plate as driftStars moves a star at its middle: by the yaw and pitch (signed, the short way round, where the
   * stars' unsigned step relies on their wrap), then turned by the roll (-drift[2]). No wrap on the screen's axes: once the
   * roll has turned the plate, a shift of 1920 along a screen axis is not one of the plate's repeats, and would jump it.
   * Instead the anchor is reduced modulo 1920 in the plate's own (turned) frame, which keeps it small.
   */
  private driftBackdrop(drift: readonly [number, number, number]): void {
    const signed = (a: number) => ((a + 0x2000) & 0x3fff) - 0x2000;
    let x = this.anchor.x + signed(-drift[0]) * STAR_STEP;
    let y = this.anchor.y + signed(drift[1]) * STAR_STEP;
    if (drift[2] !== 0) {
      const turn = angleToRadians(-drift[2]);
      const c = Math.cos(turn), s = Math.sin(turn);
      [x, y] = [x * c - y * s, y * c + x * s];
      this.backdropAngle = (this.backdropAngle + turn) % (2 * Math.PI);
    }
    // (the shader's q = R(-angle)(p - anchor): the anchor in the plate's frame, wrapped to a repeat, and back)
    const c = Math.cos(this.backdropAngle), s = Math.sin(this.backdropAngle);
    const period = 2 * STAR_RANGE;
    const wrap = (v: number) => ((((v + STAR_RANGE) % period) + period) % period) - STAR_RANGE;
    const u = wrap(x * c + y * s), v = wrap(y * c - x * s);
    this.anchor.x = u * c - v * s;
    this.anchor.y = v * c + u * s;
  }

  /** The stars this frame: drifted by the camera's turn since the last frame, twinkled, and placed on the window. */
  private updateStars(axes: M3, width: number, height: number): void {
    if (this.lastAxes) {
      const drift = starDrift(axes, this.lastAxes);
      driftStars(this.stars, drift);
      this.driftBackdrop(drift);
    }
    this.lastAxes = [...axes];
    const backdrop = this.backdrop.material;
    backdrop.uniforms.window!.value = [width, height];
    backdrop.uniforms.scale!.value = Math.max(1, Math.floor(width / 320));
    backdrop.uniforms.anchor!.value = [this.anchor.x, this.anchor.y];
    backdrop.uniforms.angle!.value = this.backdropAngle;
    const stars = this.options.parity || (this.options.stars ?? true);
    this.backdrop.visible = backdrop.uniforms.map!.value !== null && !this.options.parity && stars;
    this.starPoints.visible = stars;
    twinkle(this.stars, this.random, this.starBright);
    const scale = Math.max(1, Math.floor(width / 320));
    this.stars.forEach((s, i) => {
      const { x, y } = starPixel(s, width, height, scale);
      // (not within 4 pixels of the window's edge: tactical.cpp:912-913)
      const inside = x >= 4 && y >= 4 && x < width - 4 && y < height - 4;
      this.starXY[i * 3] = inside ? x : -1e4;
      this.starXY[i * 3 + 1] = inside ? y : -1e4;
    });
    this.starMaterial.uniforms.window!.value = [width, height];
    this.starGeometry.attributes.position!.needsUpdate = true;
    this.starGeometry.attributes.bright!.needsUpdate = true;
  }

  /** Frees what the scene made: its clones (not the set's geometry, materials or textures: the set's holder frees those), the flat and plain materials, the stars and the marks. */
  dispose(): void {
    this.disposed = true;
    for (const w of this.warmed) w.dispose();
    this.warmed.length = 0;
    for (const f of this.flatMaterials.values()) f.dispose();
    this.flatMaterials.clear();
    for (const p of this.plainMaterials.values()) p.dispose();
    this.plainMaterials.clear();
    this.marks.dispose();
    this.starGeometry.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
    this.starMaterial.dispose();
    this.forget();
    for (const m of this.hidingMaterials.values()) m.dispose();
    this.hidingMaterials.clear();
    this.bloom?.dispose();
    this.bloom = null;
  }

  private hidingMaterial(side: Side): MeshBasicMaterial {
    let m = this.hidingMaterials.get(side);
    if (!m) {
      m = new MeshBasicMaterial({ colorWrite: false, side });
      this.hidingMaterials.set(side, m);
    }
    return m;
  }
}
