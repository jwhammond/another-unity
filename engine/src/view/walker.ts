// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../content/types';

/** Metres a second: the headless presenter's speed, so walks take about as long in both. */
export const WALK_SPEED = 2;

/** How many times faster a walk goes while the player holds Shift to hurry. */
export const HURRY = 2.5;

/** Moves along a route's corners as presentation time passes. */
export class Walker {
  /** The direction of travel, as a rotation about y (0 faces +z). */
  heading = 0;
  private pos: Vec2;
  private next = 0;

  constructor(from: Vec2, private readonly points: Vec2[], private readonly speed = WALK_SPEED) {
    this.pos = { ...from };
  }

  get position(): Vec2 {
    return { ...this.pos };
  }

  get done(): boolean {
    return this.next >= this.points.length;
  }

  advance(dt: number): void {
    let left = this.speed * Math.max(0, dt);
    while (left > 0 && !this.done) {
      const target = this.points[this.next];
      const dx = target.x - this.pos.x;
      const dz = target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-9) this.heading = Math.atan2(dx, dz);
      if (d <= left) {
        this.pos = { ...target };
        this.next++;
        left -= d;
      } else {
        this.pos = { x: this.pos.x + (dx / d) * left, z: this.pos.z + (dz / d) * left };
        left = 0;
      }
    }
  }
}
