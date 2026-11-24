// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, type Camera, type Object3D } from 'three';
import { pixelPoint } from './masks';

/**
 * A phaser shot as the original draws it (UnityEngine::phaserShot, awayteam.cpp:1184-1215): a beam from the shooter to the target, a line three
 * pixels wide (a core with an edge either side) that is drawn on every other step, with a pulse running back along it in segments, over 16 steps of
 * 6 ticks of the original's 291 a second. All in the original's 640x480 pixels, each line one pixel.
 */
export const BEAM_STEPS = 16;
export const BEAM_STEP_MS = Math.round((6 * 1000) / 291);
export const BEAM_MS = BEAM_STEPS * BEAM_STEP_MS;

export interface Px { x: number; y: number }
export type BeamColour = 'beam' | 'beamEdge' | 'pulse' | 'pulseEdge';
export interface BeamLine { colour: BeamColour; a: Px; b: Px }

/** The palette colours of a beam (kColourBeam 0xcd, kColourBeamEdge 0xa6, kColourPulse 0xa5, kColourPulseEdge 0xa7), as [r, g, b]. */
export type BeamColours = Record<BeamColour, [number, number, number]>;

/** A crew member's muzzle: where the beam leaves the sprite (pixels right of and up from its feet, at full size), and the frame of the firing animation it shows on. */
export interface Muzzle { x: number; y: number; frame: number }
/** Each crew member has this many muzzles, one for each direction (NUM_PHASER_MUZZLE_DIRECTIONS). */
export const MUZZLE_DIRECTIONS = 12;
/** The crew ids that have muzzles (NUM_PHASER_MUZZLE_CREW): the first ten objects of the ship world. */
export const MUZZLE_CREW = 10;

const DIRECTIONS = [[7, 6, 5], [9, 6, 5], [10, 0, 2]] as const;

/**
 * Which way a crew member fires at a target, as the original picks the firing animation: the column is the target left of, over or right of the shooter's
 * width (a crew member's is none: the half width 0), the row below, level with or above its feet (and its half height, also 0).
 */
export function muzzleDirection(shooter: Px, target: Px, halfWidth = 0, halfHeight = 0): number {
  const column = target.x < shooter.x - halfWidth ? 0 : target.x < shooter.x + halfWidth ? 1 : 2;
  const row = target.y > shooter.y ? 0 : target.y >= shooter.y - halfHeight ? 1 : 2;
  return DIRECTIONS[row]![column]!;
}

/** Where the beam starts for a crew member at `scale` (out of 256): the muzzle's offset from the feet, scaled with the sprite (ints, as the original's). */
export function muzzleStart(feet: Px, muzzle: Muzzle, scale: number): Px {
  return { x: feet.x + Math.trunc((muzzle.x * scale) / 256), y: feet.y - Math.trunc((muzzle.y * scale) / 256) };
}

/** The beam's lines on one step (0 to 15): what `drawScene` and the lines after it show for that step of the shot. */
export function beamLines(step: number, start: Px, target: Px): BeamLine[] {
  const distance = Math.abs(start.x - target.x) + Math.abs(start.y - target.y);
  const segments = distance <= 0x78 ? 8 : distance <= 0xf0 ? 16 : distance <= 0x1e0 ? 32 : 64;
  const points: Px[] = [];
  for (let i = 0; i <= segments; i++) {
    points.push({ x: target.x + Math.trunc(((start.x - target.x) * i) / segments), y: target.y + Math.trunc(((start.y - target.y) * i) / segments) });
  }
  const side: Px = Math.abs(start.x - target.x) > Math.abs(start.y - target.y) ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const move = (p: Px, k: number): Px => ({ x: p.x + side.x * k, y: p.y + side.y * k });
  const phase = step % 4;
  const lines: BeamLine[] = [];
  const both = phase === 0 || phase === 2;
  if (both) lines.push({ colour: 'beamEdge', a: move(target, -1), b: move(start, -1) });
  lines.push({ colour: 'beam', a: target, b: start });
  if (both) lines.push({ colour: 'beamEdge', a: move(target, 1), b: move(start, 1) });
  for (let s = phase; s <= segments - 2; s += 4) {
    if (both) lines.push({ colour: 'pulseEdge', a: move(points[s]!, -1), b: move(points[s + 1]!, -1) });
    lines.push({ colour: 'pulse', a: points[s]!, b: points[s + 1]! });
    if (both) lines.push({ colour: 'pulseEdge', a: move(points[s]!, 1), b: move(points[s + 1]!, 1) });
  }
  return lines;
}

/** The step a shot is on `ms` after it began, or null once it is over. */
export function beamStep(ms: number): number | null {
  const step = Math.floor(ms / BEAM_STEP_MS);
  return step < BEAM_STEPS ? Math.max(0, step) : null;
}

/** The beam drawn over the room: each line is a quad one pixel wide in the original's picture, on a plane in front of the camera. */
export class BeamView {
  private readonly meshes = new Map<BeamColour, Mesh>();

  constructor(private readonly camera: Camera, private readonly parent: Object3D, private readonly colours: BeamColours) {}

  /** Draws these lines in place of the last step's. */
  show(lines: readonly BeamLine[]): void {
    for (const colour of Object.keys(this.colours) as BeamColour[]) {
      const mine = lines.filter(l => l.colour === colour);
      let mesh = this.meshes.get(colour);
      if (mine.length === 0) {
        if (mesh) mesh.visible = false;
        continue;
      }
      const positions: number[] = [];
      const index: number[] = [];
      mine.forEach((l, i) => {
        // (the line's pixels, from the middle of the first to the middle of the last: a quad one pixel across)
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 0.5;
        const ny = (dx / len) * 0.5;
        const ex = (dx / len) * 0.5;
        const ey = (dy / len) * 0.5;
        const a = { x: l.a.x + 0.5 - ex, y: l.a.y + 0.5 - ey };
        const b = { x: l.b.x + 0.5 + ex, y: l.b.y + 0.5 + ey };
        for (const [x, y] of [[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny]] as const) {
          const p = pixelPoint(this.camera, x, y);
          if (!p) return;
          positions.push(p.x, p.y, p.z);
        }
        index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      });
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setIndex(index);
      if (!mesh) {
        const [r, g, b] = this.colours[colour];
        mesh = new Mesh(geometry, new MeshBasicMaterial({ color: (r << 16) | (g << 8) | b, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false }));
        mesh.name = `phaser:${colour}`;
        mesh.renderOrder = 10_000;
        mesh.frustumCulled = false;
        mesh.raycast = () => {};
        this.meshes.set(colour, mesh);
        this.parent.add(mesh);
      } else {
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      }
      mesh.visible = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      this.parent.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
    this.meshes.clear();
  }
}
