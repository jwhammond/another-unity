// SPDX-License-Identifier: GPL-3.0-or-later
import type { PixelFit, Vec2 } from './types';

/** The camera's focal length in pixels: a 60° horizontal field of view over 640 pixels. */
export const FOCAL_PX = 554;
export const CENTER_X = 320;
/** The bottom row of the play area, where z is 0. */
export const NEAR_Y = 399;
/** A flat screen's rows are this much deeper than its columns are wide. */
export const FLAT_DEPTH = 2;
/** Rows closer to the horizon than this are clamped (the floor there is infinitely far). */
const MIN_ROWS = 2;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places + 0;
export const round3 = (v: number) => round(v, 3);

/**
 * A level pinhole camera over a screen's floor, from its fitted pixel metric. A scale s at row y means a pixel there is
 * M·256/s metres wide (walk.cpp Screen::scaleAt; objects drawn at that scale keep their size in metres).
 * The lifter places markers with toWorld; the sim measures in the original's pixels with toPixel.
 */
export class Projection<P extends PixelFit = PixelFit> {
  constructor(readonly params: P) {}

  /** Above the floor's back edge (sky, walls), or too close to the horizon: such rows are placed on the edge. */
  behindFloor(y: number): boolean {
    return y < this.params.topY || (this.params.kind === 'perspective' && y - this.params.horizonY < MIN_ROWS);
  }

  /** The row a position is placed on. */
  protected row(y: number): number {
    const p = this.params;
    const r = Math.max(y, p.topY);
    return p.kind === 'perspective' ? Math.max(r, p.horizonY + MIN_ROWS) : r;
  }

  unitsPerPixel(y: number): number {
    const p = this.params;
    if (p.kind === 'flat') return (p.metersPerPixel * 256) / p.meanScale;
    return (p.metersPerPixel * 256) / (p.slope * (this.row(y) - p.horizonY));
  }

  /** The fitted Screen::scaleAt at row y (unrounded): 256 is full scale. */
  scaleAt(y: number): number {
    const p = this.params;
    return p.kind === 'flat' ? p.meanScale : p.slope * (this.row(y) - p.horizonY);
  }

  /** How many columns' width one row is deep at row y: the sim's metres are round, the original's pixels aren't (Decision 8). */
  depthFactor(y: number): number {
    return this.params.kind === 'flat' ? FLAT_DEPTH : FOCAL_PX / (this.row(y) - this.params.horizonY);
  }

  toWorld(x: number, y: number): Vec2 {
    const r = this.row(y);
    const m = this.unitsPerPixel(r);
    const z = this.params.kind === 'flat'
      ? (r - NEAR_Y) * m * FLAT_DEPTH
      : FOCAL_PX * (this.unitsPerPixel(NEAR_Y) - m);
    return { x: round3((x - CENTER_X) * m), z: round3(z) };
  }

  /** toWorld's inverse (unrounded): the pixel a floor position is drawn at. A row toWorld clamped comes back clamped. */
  toPixel(pos: Vec2): { x: number; y: number } {
    const p = this.params;
    if (p.kind === 'flat') {
      const m = this.unitsPerPixel(NEAR_Y);
      return { x: pos.x / m + CENTER_X, y: NEAR_Y + pos.z / (m * FLAT_DEPTH) };
    }
    const m = this.unitsPerPixel(NEAR_Y) - pos.z / FOCAL_PX;
    return { x: pos.x / m + CENTER_X, y: p.horizonY + (p.metersPerPixel * 256) / (p.slope * m) };
  }

  distance(px: number, y: number): number {
    return round3(px * this.unitsPerPixel(y));
  }
}
