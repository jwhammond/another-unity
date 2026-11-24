// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, Line, LineBasicMaterial, type Scene, type Vector3 } from 'three';
import type { PresentationClock } from './timeline';

export const PHASER_SECONDS = 0.5;

/** A phaser shot: a red line from the shooter to the target, for a moment. */
export async function phaserBeam(scene: Scene, from: Vector3, to: Vector3, clock: PresentationClock): Promise<void> {
  const line = new Line(new BufferGeometry().setFromPoints([from, to]), new LineBasicMaterial({ color: 0xff3322 }));
  scene.add(line);
  await clock.after(PHASER_SECONDS);
  scene.remove(line);
  line.geometry.dispose();
  line.material.dispose();
}
