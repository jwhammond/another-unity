// SPDX-License-Identifier: GPL-3.0-or-later
import { FramebufferTexture, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector4, type Camera, type WebGLRenderer } from 'three';
import type { Viewport } from '../shipSet';

/**
 * The Combat Options' Resolution 2 (Plan 32; the F1 options' 1x / 2x, help.cpp 0x211488, the original's pixel doubling): the
 * view drawn at half its pixel scale. Through the app's one renderer (M8 Decision 4: never a second context): the view is
 * drawn into the lower left quarter of its own box on the canvas, copied from there into a texture of that size, and the
 * texture drawn over the whole box, each pixel doubled (nearest). The copy is the canvas's own bytes, drawn back as they are
 * (no colour-space step), so the colours are the full view's.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
}`;

export class ScaledView {
  /** What the frame draws over the box: the picture of the view. */
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private texture: FramebufferTexture | null = null;
  private readonly material = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false, uniforms: { map: { value: null } } });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);

  constructor() {
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * Draws `scene` with `camera` at `scale` of the box `viewport` (device pixels, y up) into its lower left corner, then
   * `after` (the bloom, over what was drawn there), and keeps the picture. The renderer's viewport, scissor rectangle and test,
   * and autoClear are as they were after.
   */
  draw(renderer: WebGLRenderer, scene: Scene, camera: Camera, viewport: Viewport, scale: number, after: (r: WebGLRenderer) => void): void {
    const width = Math.max(1, Math.round(viewport.width * scale)), height = Math.max(1, Math.round(viewport.height * scale));
    if (!this.texture || this.texture.image.width !== width || this.texture.image.height !== height) {
      this.texture?.dispose();
      this.texture = new FramebufferTexture(width, height);
      this.material.uniforms.map!.value = this.texture;
    }
    const px = renderer.getPixelRatio();
    const autoClear = renderer.autoClear, scissor = renderer.getScissorTest();
    const viewportWas = renderer.getViewport(new Vector4()), scissorWas = renderer.getScissor(new Vector4());
    try {
      renderer.autoClear = false;
      renderer.setViewport(viewport.x / px, viewport.y / px, width / px, height / px);
      renderer.setScissor(viewport.x / px, viewport.y / px, width / px, height / px);
      renderer.setScissorTest(true);
      renderer.clear();
      renderer.render(scene, camera);
      after(renderer);
      renderer.copyFramebufferToTexture(this.texture, new Vector2(viewport.x, viewport.y));
    } finally {
      renderer.setScissorTest(scissor);
      renderer.setViewport(viewportWas.x, viewportWas.y, viewportWas.z, viewportWas.w);
      renderer.setScissor(scissorWas.x, scissorWas.y, scissorWas.z, scissorWas.w);
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.texture?.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
