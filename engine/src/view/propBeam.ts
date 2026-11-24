// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, Mesh, Object3D, Texture } from 'three';
import type { RoomMask } from './art';
import { setDissolve, type BeamTarget, type SparkleFrame } from './beam';
import { maskQuad } from './masks';

/**
 * A prop in the transporter's beam: the quads that draw it (its still and its layers' strips) dissolve, and the sparkle is a quad over the room's
 * picture at the object's place, as the original draws it just after the sprite (UnityEngine::drawObjects: drawSprite(effect, obj->x, obj->y, scale),
 * which stands the effect's origin, the middle of its bottom edge, on the object).
 */
export class PropBeam implements BeamTarget {
  private sparkleQuad: Mesh | null = null;

  /** `foot` is the object's place in the original's pixels, `depth` the row it is sorted by. */
  constructor(
    private readonly camera: Camera,
    private readonly scene: Object3D,
    private readonly quads: () => Mesh[],
    private readonly foot: { x: number; y: number },
    private readonly object: string,
  ) {}

  dissolve(level: number): void {
    for (const q of this.quads()) setDissolve(q, level);
  }

  sparkle(texture: Texture | undefined, frame: SparkleFrame | null): void {
    if (!texture || !frame) {
      if (this.sparkleQuad) this.sparkleQuad.visible = false;
      return;
    }
    if (!this.sparkleQuad) {
      const [w, h] = frame.cell;
      const mask: RoomMask = {
        object: `${this.object}:beam`, texture, alpha: null, card: true,
        rect: [Math.round(this.foot.x - w * frame.anchor[0]), Math.round(this.foot.y - h * frame.anchor[1]), w, h],
        depth: this.foot.y + 0.5,
      };
      const quad = maskQuad(this.camera, mask);
      if (!quad) return;
      quad.name = `beam:${this.object}`;
      this.sparkleQuad = quad;
      this.scene.add(quad);
    }
    const quad = this.sparkleQuad;
    quad.visible = true;
    const material = quad.material as unknown as { map: Texture | null };
    if (material.map !== texture) material.map = texture;
    const uv = quad.geometry.getAttribute('uv');
    uv.setXY(0, frame.uv[0], frame.uv[3]);
    uv.setXY(1, frame.uv[2], frame.uv[3]);
    uv.setXY(2, frame.uv[2], frame.uv[1]);
    uv.setXY(3, frame.uv[0], frame.uv[1]);
    uv.needsUpdate = true;
  }

  clear(): void {
    const q = this.sparkleQuad;
    if (!q) return;
    this.scene.remove(q);
    q.geometry.dispose();
    (q.material as unknown as { dispose(): void }).dispose();
    this.sparkleQuad = null;
  }
}
