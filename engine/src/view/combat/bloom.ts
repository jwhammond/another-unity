// SPDX-License-Identifier: GPL-3.0-or-later
import { AdditiveBlending, BackSide, Color, DoubleSide, FrontSide, Group, HalfFloatType, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget, type Camera, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The selective bloom (M8 spec §3.2, Decision 13): three's UnrealBloomPass over what is on the bloom layer only (beams,
 * torpedoes, explosions and the shimmer), added over the view. Not the original's (a 256-colour renderer has no glow): the
 * modern look, never in the parity mode. The glows are drawn over the depth of what hides them (the ships, on HIDES_LAYER),
 * drawn first into the bloom's target with no colour, so a ship in front of what glows hides its halo there too (Plan 34
 * Task 7). WebGL shares no depth buffer between the canvas and a target, so the ships' depth is drawn again: a draw or two for
 * each ship on the window (its solid parts merged, spaceScene.ts's hidingDepth: a draw for each of its meshes took battle 82
 * to 210 calls), and none when nothing glows. The debris, which hides what is behind it in the frame, is left out of it (R5:
 * the draw budget; battle 7's 42 pieces would take it over), so a halo still shows through a piece of debris.
 * The bloom is sized in CSS pixels (the view's device pixels over the renderer's pixel ratio), so the halo is as wide on
 * screen at any device pixel ratio; the blur, linear in its HalfFloat targets, is converted to the output's colour space
 * (the sRGB canvas) as it is added.
 */

/** The layer the glowing things are on (as well as the default layer 0 the view draws, but for the shimmer's glow: the bloom's alone). */
export const BLOOM_LAYER = 1;
/** The layer of what hides a glow's halo (the ships' meshes, as well as layer 0): drawn as depth alone before the glows. */
export const HIDES_LAYER = 2;
/** The bloom's strength, radius and threshold (UnrealBloomPass's): everything on the layer glows, so no threshold. */
export const BLOOM = { strength: 1.2, radius: 0.4, threshold: 0 } as const;

const viewport = new Vector4();
const clear = new Color();

/**
 * Compiles the programs `object`'s materials need, drawn with `scene`'s lights into the renderer's target as it is now,
 * and resolves once each is linked (Plan 34 Task 8's warm-up, before a battle's first frame). With
 * KHR_parallel_shader_compile the browser links them off the main thread and they are polled every 10 ms, as three's
 * compileAsync does; without it, compile has linked them already. Unlike compileAsync, a material freed meanwhile (the
 * battle left mid-warm-up: its scene and its set freed) is dropped from the wait rather than read: three forgets a freed
 * material's program, and compileAsync's next poll would throw on it. Each of a material's programs is waited for (one
 * material compiled for the canvas and for a target has two).
 */
export function compileFor(renderer: WebGLRenderer, object: Object3D, camera: Camera, scene: Scene): Promise<void> {
  const pending = renderer.compile(object, camera, scene);
  return new Promise(resolve => {
    const check = () => {
      for (const m of pending) {
        const programs = (renderer.properties.get(m) as { programs?: Map<string, { isReady(): boolean }> }).programs;
        if (!programs || [...programs.values()].every(p => p.isReady())) pending.delete(m);
      }
      if (pending.size === 0) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

/** The pass's copy (CopyShader), added, converted from linear to the output's colour space (three's colorspace_fragment). */
function addMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
    fragmentShader: 'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = texture2D(tDiffuse, vUv);\n  #include <colorspace_fragment>\n}',
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

/** The depth pass's material (SelectiveBloom.depth). */
function depthMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
  m.onBeforeRender = (_r, _s, _c, _g, object, group) => {
    const own = (object as Mesh).material as Material | Material[];
    const index = (group as unknown as { materialIndex?: number } | null)?.materialIndex ?? 0;
    m.side = (Array.isArray(own) ? own[index] ?? own[0]! : own).side;
  };
  return m;
}

export class SelectiveBloom {
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly pass = new UnrealBloomPass(new Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  private readonly add = addMaterial();
  /**
   * The depth pass's material: depth alone, of the faces the frame draws (each mesh's own material's side, set as it is
   * drawn), pushed a little back so that a ship's own shimmer, drawn over the same faces by another program, is never
   * hidden by the ship.
   */
  private readonly depth = depthMaterial();

  /**
   * Adds the glow of `scene`'s bloom layer over what the renderer drew in its current viewport, as the view's `after`
   * step: the depth of what hides them (HIDES_LAYER's), then the glowing things tested against it, into a target of the
   * viewport's size (in CSS pixels), the pass's blur of it, and that blur added over the viewport of the target the frame
   * is drawn into. The renderer's target (and so its viewport), clear colour, autoClear, the scene's background and
   * override, and the camera's layers are as they were after.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const frame = renderer.getRenderTarget();
    renderer.getCurrentViewport(viewport);
    // (the canvas's viewport is in device pixels; an offscreen target's in its own)
    const ratio = frame === null ? renderer.getPixelRatio() : 1;
    const width = Math.max(1, Math.round(viewport.z / ratio)), height = Math.max(1, Math.round(viewport.w / ratio));
    this.setSize(width, height);
    const background = scene.background, override = scene.overrideMaterial, layers = camera.layers.mask;
    const autoClear = renderer.autoClear, alpha = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      scene.background = null;
      // (what hides the glows, as depth alone)
      camera.layers.set(HIDES_LAYER);
      scene.overrideMaterial = this.depth;
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      camera.layers.set(BLOOM_LAYER);
      renderer.render(scene, camera);
      // (the pass leaves its blur in renderTargetsHorizontal[0], then adds it into the target, which is not drawn)
      this.pass.render(renderer, null as unknown as WebGLRenderTarget, this.target, 0, false);
      renderer.setRenderTarget(frame);
      this.add.uniforms.tDiffuse!.value = this.pass.renderTargetsHorizontal[0]!.texture;
      this.pass.fsQuad.material = this.add;
      this.pass.fsQuad.render(renderer);
    } finally {
      scene.overrideMaterial = override;
      scene.background = background;
      camera.layers.mask = layers;
      renderer.setClearColor(clear, alpha);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(frame);
    }
  }

  /**
   * Readies the bloom before its first glow (Plan 34 Task 8), for a view `width` x `height` device pixels on the canvas:
   * its targets sized and allocated as render() would size them, and every program it draws with compiled (the depth
   * pass's, for each side a mesh has; the pass's blurs; the add over the canvas), with `glows`' (what the view will draw on
   * the bloom layer) as drawn into its target. The renderer's target is as it was after. The materials compiled for it
   * are kept until dispose, so a program they share with an effect's own is not freed and compiled again when that effect goes.
   */
  warm(renderer: WebGLRenderer, width: number, height: number, glows: Object3D, scene: Scene, camera: Camera): Promise<unknown[]> {
    const ratio = renderer.getPixelRatio();
    this.setSize(Math.max(1, Math.round(width / ratio)), Math.max(1, Math.round(height / ratio)));
    const quad = new PlaneGeometry(2, 2);
    const into = new Group();
    for (const side of [FrontSide, BackSide, DoubleSide]) {
      const depth = depthMaterial();
      depth.side = side;
      this.warmed.push(depth);
      into.add(new Mesh(quad, depth));
    }
    const pass = this.pass;
    for (const m of [pass.materialHighPassFilter, ...pass.separableBlurMaterials, pass.compositeMaterial, pass.blendMaterial]) into.add(new Mesh(quad, m));
    into.add(glows);
    const frame = renderer.getRenderTarget();
    const waits: Promise<unknown>[] = [];
    try {
      for (const t of [this.target, pass.renderTargetBright, ...pass.renderTargetsHorizontal, ...pass.renderTargetsVertical]) renderer.initRenderTarget?.(t);
      renderer.setRenderTarget(this.target);
      waits.push(compileFor(renderer, into, camera, scene));
      renderer.setRenderTarget(frame);
      waits.push(compileFor(renderer, new Mesh(quad, this.add), camera, scene));
    } finally {
      renderer.setRenderTarget(frame);
      into.remove(glows);
      quad.dispose();
    }
    return Promise.all(waits);
  }

  /** The depth materials warm() compiled, kept until dispose (see warm). */
  private readonly warmed: Material[] = [];

  private setSize(width: number, height: number): void {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
    this.pass.setSize(width, height);
  }

  dispose(): void {
    for (const m of this.warmed) m.dispose();
    this.target.dispose();
    this.pass.dispose();
    // (the pass's own dispose misses its high-pass material)
    this.pass.materialHighPassFilter.dispose();
    this.add.dispose();
    this.depth.dispose();
  }
}
