// SPDX-License-Identifier: GPL-3.0-or-later
import { Vector4, type Mesh, type Sprite, type Material, type Texture, type WebGLRenderer } from 'three';
import type { CardAnim } from './art';

/**
 * The transporter's effect as the original draws it (UnityEngine::beamEffect, awayteam.cpp:1082-1127; the dissolve is Graphics::blit's,
 * graphics.cpp:352-385). First the sparkle (teffect.spr's animation 0, or the Chodak's chodbeam.spr) plays with the objects all there (out) or
 * not yet (in); then animation 1 plays while they dissolve out or in over seven steps. The objects' own pictures are hidden a few pixels
 * at a time: each 4x4 block of the picture takes one of four masks at random, and the level picks the mask's column.
 */
export const DISSOLVE_LEVELS = 7;
/** A dissolve step: 0x3c ticks of the original's 291 a second. */
export const DISSOLVE_STEP_MS = Math.round((0x3c * 1000) / 291);
/** The sparkle is waited for at most this long (the original gives up at 5 s). */
export const SPARKLE_MAX_MS = 5000;
/** What the first phase lasts without the sparkle's art: teffect's animation 0 runs about this long. */
export const SPARKLE_FALLBACK_MS = 1100;

/** The original's masks, by row and level: a set bit hides that pixel of a 4x4 block (graphics.cpp kDissolveMasks). */
export const DISSOLVE_MASKS: readonly (readonly number[])[] = [
  [0xffff, 0xfbef, 0xdf6b, 0x3869, 0x8142, 0x0410, 0x0000],
  [0xffff, 0xfd7f, 0xbf6d, 0xc169, 0x1824, 0x0280, 0x0000],
  [0xffff, 0xfebf, 0xb6fd, 0x9683, 0x2418, 0x0140, 0x0000],
  [0xffff, 0xf7df, 0xd6fb, 0x961c, 0x4281, 0x0820, 0x0000],
];

/** Whether a pixel is hidden: `px`, `py` in the original's picture, `row` the block's random row (0 to 3), `level` 0 (all hidden) to 6 (none). */
export function dissolveHides(px: number, py: number, row: number, level: number): boolean {
  if (level < 0) return false;
  const mask = DISSOLVE_MASKS[row]![Math.min(level, DISSOLVE_LEVELS - 1)]!;
  return (mask & (1 << ((py & 3) * 4 + (px & 3)))) !== 0;
}

export interface BeamPhase {
  /** The sparkle's animation, and how long it has been playing. */
  sparkle: 0 | 1;
  sparkleMs: number;
  /** The dissolve level: 0 (hidden) to 6 (whole). */
  level: number;
  done: boolean;
}

/** How long a beam takes: the sparkle, then the seven dissolve steps. */
export function beamMillis(firstMs: number): number {
  return Math.min(firstMs, SPARKLE_MAX_MS) + DISSOLVE_LEVELS * DISSOLVE_STEP_MS;
}

/**
 * Where a beam is `ms` after it began. Beaming in, the objects are hidden while the sparkle plays and come up a level a step; beaming out they
 * are whole while it plays and go down a level a step.
 */
export function beamPhase(out: boolean, ms: number, firstMs: number): BeamPhase {
  const first = Math.min(firstMs, SPARKLE_MAX_MS);
  if (ms < first) return { sparkle: 0, sparkleMs: Math.max(0, ms), level: out ? DISSOLVE_LEVELS - 1 : 0, done: false };
  const t = ms - first;
  const step = Math.floor(t / DISSOLVE_STEP_MS);
  const done = step >= DISSOLVE_LEVELS;
  const k = Math.min(DISSOLVE_LEVELS - 1, step);
  return { sparkle: 1, sparkleMs: t, level: out ? DISSOLVE_LEVELS - 1 - k : k, done };
}

/** The sparkle's art: the animations of a card (art.cards) and their strips' textures, once loaded. */
export interface SparkleArt {
  anims: Record<number, CardAnim>;
  texture(anim: number): Texture | undefined;
}

export interface SparkleFrame {
  index: number;
  /** The strip's uv window: [u0, v0, u1, v1], v up. */
  uv: [number, number, number, number];
  /** One cell in the original's pixels, and where its origin is (fractions of the cell). */
  cell: [number, number];
  anchor: [number, number];
}

/** The frame an animation shows `ms` in: each for its delay, the last held. */
export function sparkleFrame(anim: CardAnim, ms: number): SparkleFrame {
  let index = 0;
  for (let acc = 0; index < anim.frames - 1; index++) {
    acc += anim.delays[index] ?? 0;
    if (ms < acc) break;
  }
  const columns = Math.min(anim.frames, anim.columns ?? anim.frames);
  const rows = Math.ceil(anim.frames / columns);
  const col = index % columns;
  const row = Math.floor(index / columns);
  const scale = anim.scale ?? 4;
  return { index, uv: [col / columns, 1 - (row + 1) / rows, (col + 1) / columns, 1 - row / rows], cell: [anim.cell[0] / scale, anim.cell[1] / scale], anchor: anim.anchor };
}

/** How long the sparkle's first animation runs, from its delays; the fallback without art. */
export function firstMillis(art: SparkleArt | undefined): number {
  const a = art?.anims[0];
  return a ? a.delays.reduce((x, y) => x + y, 0) : SPARKLE_FALLBACK_MS;
}

/**
 * Something beamed: it dissolves, and has a sparkle drawn in front. The stage makes one for a crew member (a card on the floor) and for a prop
 * (a layer in the room); the ship's transporter room makes one for a pad's card.
 */
export interface BeamTarget {
  /** Hides this much of the picture: 0 (all) to 6 (none), or -1 for the picture as it is. */
  dissolve(level: number): void;
  /** Shows the sparkle's frame in front of the target, or nothing for null. */
  sparkle(texture: Texture | undefined, frame: SparkleFrame | null): void;
  /** Takes the sparkle away. */
  clear(): void;
}

/** A beam under way: its targets follow the phase of the time since it began. */
export class BeamRun {
  readonly firstMs: number;
  readonly totalMs: number;
  private last = -2;

  constructor(readonly out: boolean, readonly targets: readonly BeamTarget[], readonly art: SparkleArt | undefined, readonly startMs: number, readonly objects: readonly string[] = []) {
    this.firstMs = Math.min(firstMillis(art), SPARKLE_MAX_MS);
    this.totalMs = beamMillis(this.firstMs);
  }

  /** The phase at presentation time `now` (ms). */
  phase(now: number): BeamPhase {
    return beamPhase(this.out, now - this.startMs, this.firstMs);
  }

  /** Shows the beam at `now`; true once it has ended. */
  update(now: number): boolean {
    const p = this.phase(now);
    const level = p.done ? (this.out ? 0 : -1) : p.level;
    // (the dissolve is drawn again each frame: the blocks' masks change from one draw to the next, as the original's do)
    for (const t of this.targets) t.dissolve(level);
    this.last = level;
    const anim = this.art?.anims[p.sparkle];
    const texture = anim ? this.art?.texture(p.sparkle) : undefined;
    const frame = anim && texture && !p.done ? sparkleFrame(anim, p.sparkleMs) : null;
    for (const t of this.targets) t.sparkle(texture, frame);
    return p.done;
  }

  /** The level the beam last drew. */
  get level(): number {
    return this.last;
  }

  /** Ends the beam where it stands: an out beam leaves its targets hidden (the sim moves them), an in beam whole. */
  finish(): void {
    for (const t of this.targets) {
      t.dissolve(this.out ? 0 : -1);
      t.clear();
    }
  }
}

/** What the dissolve's shader needs from the draw: where the picture is on the drawing buffer. Set per object as it is drawn. */
interface DissolveUniforms {
  uDissolve: { value: number };
  uDView: { value: Vector4 };
  uDSeed: { value: number };
}

const states = new WeakMap<Material, DissolveUniforms>();
const viewportScratch = new Vector4();
let seed = 0;

/** Moves the dissolve's random blocks on: once a drawn frame. */
export function dissolveTick(): void {
  seed = (seed + 1) % 4096;
}

const SHADER_HEAD = `
uniform float uDissolve;
uniform vec4 uDView;
uniform float uDSeed;
const uint DM[28] = uint[28](${DISSOLVE_MASKS.flat().map(m => `${m}u`).join(', ')});
`;

/** The test before the pixel is written: its place in the original's 640x480 picture picks the block's mask and the pixel's bit. */
const SHADER_TEST = `
if (uDissolve >= 0.0) {
  vec2 dq = floor((gl_FragCoord.xy - uDView.xy) / (uDView.z / 640.0));
  int dx = int(dq.x);
  int dy = 479 - int(dq.y);
  uint bx = uint(dx >> 2);
  uint by = uint(dy >> 2);
  uint h = bx * 73856093u ^ by * 19349663u ^ uint(uDSeed) * 83492791u;
  h ^= h >> 13; h *= 1274126177u; h ^= h >> 16;
  uint m = DM[int(h & 3u) * 7 + int(uDissolve)];
  if ((m & (1u << uint((dy & 3) * 4 + (dx & 3)))) != 0u) discard;
}
`;

/**
 * Lets a mesh or sprite be dissolved (`setDissolve`): its material's shader gets the original's test, and the object says where the picture is
 * as it is drawn. A material already patched is left as it is.
 */
export function makeDissolvable(object: Mesh | Sprite): void {
  const material = object.material as Material;
  if (states.has(material)) return;
  const u: DissolveUniforms = { uDissolve: { value: -1 }, uDView: { value: new Vector4(0, 0, 640, 480) }, uDSeed: { value: 0 } };
  states.set(material, u);
  const was = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    was.call(material, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${SHADER_HEAD}\nvoid main() {`)
      .replace('#include <opaque_fragment>', `${SHADER_TEST}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'dissolve';
  material.needsUpdate = true;
  const before = object.onBeforeRender;
  object.onBeforeRender = (renderer: WebGLRenderer, ...rest: unknown[]) => {
    const vp = renderer.getCurrentViewport(viewportScratch);
    u.uDView.value.copy(vp);
    u.uDSeed.value = seed;
    (before as (...a: unknown[]) => void).call(object, renderer, ...rest);
  };
}

/** Sets how much of a dissolvable object's picture is hidden: -1 (none) or 0 to 6. */
export function setDissolve(object: Mesh | Sprite, level: number): void {
  const u = states.get(object.material as Material);
  if (u) u.uDissolve.value = level;
  else if (level >= 0) {
    makeDissolvable(object);
    states.get(object.material as Material)!.uDissolve.value = level;
  }
}

/** The level an object is dissolved to now (-1: not at all). */
export function dissolveLevel(object: Mesh | Sprite): number {
  return states.get(object.material as Material)?.uDissolve.value ?? -1;
}
