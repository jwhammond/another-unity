// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial } from 'three';
import { apply, sub, transpose, type V3 } from '../../sim/combat/math';
import type { CameraPose } from '../../sim/combat/types';
import { COLOUR } from './console';
import { focalLength } from './projection';

/**
 * The target's marks in the view (Plan 32 R4: the F1 options' Radar row): the original's brackets about the target in the 3D
 * view (0x94e89, drawn while the sensors are OK, 0x167f94) and its pointer to a target off the view (0x9694e). Their shapes are
 * the remake's: four corner brackets about the target's projected box, or a chevron at the view's edge toward it, a window pixel
 * thin in the console's light blue (palette entry 0xad, tactical.cpp:165-179). Pure but for the layer that draws them.
 */

/** A line on the window: x0, y0, x1, y1 in the window's units (y down). */
export type Segment = [number, number, number, number];
/** A box on the window, x0, y0, x1, y1 in its units: what the wide view's HUD covers (web/combatView.ts hudKeepOut). */
export type Box = readonly [number, number, number, number];

export interface TargetMarks {
  kind: 'brackets' | 'arrow';
  lines: Segment[];
  /** Brackets: the target's box on the window, x0, y0, x1, y1. */
  box?: [number, number, number, number];
  /** Arrow: its tip on the window and the way it points (radians, 0 to the right, y down). */
  tip?: { x: number; y: number };
  angle?: number;
}

/** How far in from the window's edge the arrow's tip is, in window units. */
export const MARK_EDGE = 6;
/** The smallest half-width of the brackets' box: a far target's never close up on it. */
const MIN_HALF = 6;
/** The arrow's length and its half-width at the base. */
const ARROW_LENGTH = 7;
const ARROW_HALF = 4;

/** A point in the camera's own axes (x right, y down the window, z forward), as drawModel sees it (combat.cpp:1006-1013). */
export function viewPoint(cam: CameraPose, pos: V3): V3 {
  return apply(transpose(cam.axes), sub(pos, cam.pos));
}

/**
 * The marks for a target at `at` (the camera's axes: viewPoint) of size `size` (its model's largest extent) in a window
 * `width` x `height`: brackets about its box when its centre is on the window, else an arrow at the edge toward it, drawn
 * clear of `keepOut` (the wide view's HUD panels: the arrow moves in along its way until no part of it is under one). None
 * without a target or with the sensors down.
 */
export function targetMarks(target: { at: V3; size: number } | null, sensorsOk: boolean, width: number, height: number, keepOut: readonly Box[] = []): TargetMarks | null {
  if (!target || !sensorsOk) return null;
  const { at, size } = target;
  const f = focalLength(width);
  if (at.z > 1) {
    // (project's place, half a pixel right and down: space3d.cpp:278-279, as setProjection's principal point)
    const cx = (at.x * f) / at.z + width / 2 + 0.5, cy = (at.y * f) / at.z + height / 2 + 0.5;
    if (cx >= 0 && cy >= 0 && cx < width && cy < height) return brackets(cx, cy, Math.max(MIN_HALF, (size * f) / at.z));
  }
  return arrow(at, width, height, keepOut);
}

function brackets(cx: number, cy: number, half: number): TargetMarks {
  const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
  const arm = half / 2;
  const lines: Segment[] = [];
  for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
    lines.push([x, y, x + sx * arm, y], [x, y, x, y + sy * arm]);
  }
  return { kind: 'brackets', lines, box: [x0, y0, x1, y1] };
}

/** How far clear of a HUD box the arrow is kept, in window units. */
const KEEP_CLEAR = 2;

/**
 * The pointer: from the window's middle toward the target (the way to turn, in front or behind), at the edge, or, where a box
 * of `keepOut` covers that, moved in along the same way, a unit at a time, until the whole chevron is clear of every box (or
 * it would reach the middle: then where it last was).
 */
function arrow(at: V3, width: number, height: number, keepOut: readonly Box[]): TargetMarks {
  let dx = at.x, dy = at.y;
  // (dead ahead and too near, or dead behind: down, behind)
  if (Math.hypot(dx, dy) < 1e-9) [dx, dy] = [0, 1];
  const hx = width / 2, hy = height / 2;
  const angle = Math.atan2(dy, dx);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  // (how far from the middle to the edge, MARK_EDGE in, along the way)
  const reach = Math.min(ux !== 0 ? (hx - MARK_EDGE) / Math.abs(ux) : Infinity, uy !== 0 ? (hy - MARK_EDGE) / Math.abs(uy) : Infinity);
  const place = (d: number) => chevron({ x: hx + ux * d, y: hy + uy * d }, ux, uy);
  let marks = place(reach);
  for (let d = reach - 1; d > ARROW_LENGTH && covered(marks.lines, keepOut); d--) marks = place(d);
  return { kind: 'arrow', tip: marks.tip, angle, lines: marks.lines };
}

function chevron(tip: { x: number; y: number }, ux: number, uy: number): { tip: { x: number; y: number }; lines: Segment[] } {
  const bx = tip.x - ux * ARROW_LENGTH, by = tip.y - uy * ARROW_LENGTH;
  const left = [bx - uy * ARROW_HALF, by + ux * ARROW_HALF] as const, right = [bx + uy * ARROW_HALF, by - ux * ARROW_HALF] as const;
  return { tip, lines: [[tip.x, tip.y, left[0], left[1]], [tip.x, tip.y, right[0], right[1]], [left[0], left[1], right[0], right[1]]] };
}

/** Whether the chevron's bounds come within KEEP_CLEAR of a box. */
function covered(lines: readonly Segment[], boxes: readonly Box[]): boolean {
  if (boxes.length === 0) return false;
  const xs = lines.flatMap(l => [l[0], l[2]]), ys = lines.flatMap(l => [l[1], l[3]]);
  const x0 = Math.min(...xs) - KEEP_CLEAR, x1 = Math.max(...xs) + KEEP_CLEAR, y0 = Math.min(...ys) - KEEP_CLEAR, y1 = Math.max(...ys) + KEEP_CLEAR;
  return boxes.some(b => x1 >= b[0] && x0 <= b[2] && y1 >= b[1] && y0 <= b[3]);
}

const VERTEX = /* glsl */ `
uniform vec2 window;
void main() {
  gl_Position = vec4(position.x / window.x * 2.0 - 1.0, 1.0 - position.y / window.y * 2.0, 0.0, 1.0);
}`;
/** The palette's colour as it is, as the stars write theirs (no colour-space step). */
const FRAGMENT = /* glsl */ `
uniform vec3 colour;
void main() {
  gl_FragColor = vec4(colour, 1.0);
}`;
/** The most lines a mark has: the brackets' eight. */
const MAX_LINES = 8;
/** The light blue as the space palette has it, without the stills' palette (an estimate). */
const FALLBACK = [59, 127, 191] as const;

/** Draws the marks over the view: each line a quad one window pixel wide, in window units, over everything. */
export class TargetMarksLayer {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly xy = new Float32Array(MAX_LINES * 6 * 3);

  /** `palette`: the stills' (768 bytes), whose light blue the marks are drawn in. */
  constructor(palette: Uint8Array | null) {
    const i = COLOUR.lightBlue * 3;
    const rgb = palette ? [palette[i]!, palette[i + 1]!, palette[i + 2]!] : FALLBACK;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.xy, 3));
    this.mesh = new Mesh(geometry, new ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false, side: DoubleSide,
      uniforms: { window: { value: [320, 220] }, colour: { value: new Color(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255) } },
    }));
    this.mesh.name = 'targetMarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /**
   * Shows `marks` (or nothing) on a window `width` x `height`, `pixelScale` device pixels a window unit as the view is drawn
   * (SpaceScene.setPixelScale's, half at Resolution 2): each line half a unit each side, or a device pixel where that is more,
   * so the lines never break up on a small canvas.
   */
  set(marks: TargetMarks | null, width: number, height: number, pixelScale = 1): void {
    this.mesh.visible = marks !== null;
    if (!marks) return;
    let k = 0;
    const half = Math.max(0.5, 1 / Math.max(pixelScale, 1e-6));
    const put = (x: number, y: number) => { this.xy[k++] = x; this.xy[k++] = y; this.xy[k++] = 0; };
    for (const [x0, y0, x1, y1] of marks.lines.slice(0, MAX_LINES)) {
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      // (`half` each side and past each end, so the corners meet)
      const ux = ((x1 - x0) / len) * half, uy = ((y1 - y0) / len) * half;
      const ax = x0 - ux, ay = y0 - uy, bx = x1 + ux, by = y1 + uy;
      put(ax - uy, ay + ux); put(ax + uy, ay - ux); put(bx - uy, by + ux);
      put(bx - uy, by + ux); put(ax + uy, ay - ux); put(bx + uy, by - ux);
    }
    this.mesh.geometry.setDrawRange(0, k / 3);
    this.mesh.geometry.attributes.position!.needsUpdate = true;
    this.mesh.material.uniforms.window!.value = [width, height];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
