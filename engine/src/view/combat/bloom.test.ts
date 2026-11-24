// SPDX-License-Identifier: GPL-3.0-or-later
import { AdditiveBlending, BackSide, BoxGeometry, DoubleSide, FrontSide, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Points, Scene, ShaderMaterial, WebGLRenderTarget, type Material, type Object3D, type Vector4, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BLOOM_LAYER, HIDES_LAYER, SelectiveBloom } from './bloom';

/**
 * A renderer that records what it is asked to draw, into which target, with which layers, override and material; its viewport
 * (device pixels), pixel ratio and the target it starts bound to are the test's.
 */
function recorder(o: { viewport?: [number, number]; ratio?: number; bound?: WebGLRenderTarget | null } = {}) {
  const draws: { what: string; target: string; layers?: number; override?: boolean; blending?: number }[] = [];
  /** Each scene draw's meshes (by name: those visible on the camera's layers) and its override's colour and depth writes. */
  const scenes: { target: string; drawn: string[]; override: { colorWrite: boolean; depthWrite: boolean } | null; clears: number }[] = [];
  let clears = 0;
  const materials: Material[] = [];
  let target: WebGLRenderTarget | null = o.bound ?? null;
  const r = {
    autoClear: true,
    clearColor: new Color(0.1, 0.2, 0.3),
    clearAlpha: 1,
    viewport: o.viewport ?? [640, 440],
    ratio: o.ratio ?? 1,
    getCurrentViewport: (v: Vector4) => v.set(319, 237, r.viewport[0]!, r.viewport[1]!),
    getPixelRatio: () => r.ratio,
    getClearColor: (c: Color) => c.copy(r.clearColor),
    getClearAlpha: () => r.clearAlpha,
    setClearColor: (c: Color | number, a = 1) => { r.clearColor = new Color(c); r.clearAlpha = a; },
    getRenderTarget: () => target,
    setRenderTarget: (t: WebGLRenderTarget | null) => { target = t; },
    clear: () => { clears++; },
    render: (scene: Object3D, camera: PerspectiveCamera) => {
      const at = target === null ? 'screen' : target === o.bound ? 'bound' : `${target.width}x${target.height}`;
      if (scene instanceof Scene) {
        draws.push({ what: 'scene', target: at, layers: camera.layers.mask, override: scene.overrideMaterial !== null });
        const drawn: string[] = [];
        scene.traverseVisible(o => { if (((o as Mesh).isMesh || (o as Points).isPoints) && camera.layers.test(o.layers)) drawn.push(o.name); });
        const m = scene.overrideMaterial;
        scenes.push({ target: at, drawn, override: m && { colorWrite: m.colorWrite, depthWrite: m.depthWrite }, clears });
      }
      else {
        const material = (scene as Mesh).material as Material;
        materials.push(material);
        draws.push({ what: 'quad', target: at, blending: material.blending });
      }
    },
  };
  return { renderer: r as unknown as WebGLRenderer, draws, scenes, materials, state: r, target: () => target };
}

describe('SelectiveBloom (M8 spec §3.2)', () => {
  it('draws the bloom layer into a target of the viewport\'s size, and adds the pass\'s blur of it over the viewport', () => {
    const { renderer, draws, state } = recorder();
    const scene = new Scene();
    scene.background = new Color(0, 0, 0);
    const camera = new PerspectiveCamera();
    new SelectiveBloom().render(renderer, scene, camera);
    // (what hides the glows, as depth, and then the glows alone, in the 640 x 440 target)
    expect(draws.slice(0, 2)).toEqual([
      { what: 'scene', target: '640x440', layers: 1 << HIDES_LAYER, override: true },
      { what: 'scene', target: '640x440', layers: 1 << BLOOM_LAYER, override: false },
    ]);
    // (the pass's own 13 passes go to its targets; the last draw adds the blur over the screen's viewport)
    expect(draws.slice(2, -1).every(d => d.what === 'quad' && d.target !== 'screen')).toBe(true);
    expect(draws).toHaveLength(16);
    expect(draws.at(-1)).toEqual({ what: 'quad', target: 'screen', blending: AdditiveBlending });
    // (everything as it was)
    expect([camera.layers.mask, scene.background, scene.overrideMaterial, state.autoClear, state.clearColor.getHex(), state.clearAlpha]).toEqual([1, new Color(0, 0, 0), null, true, new Color(0.1, 0.2, 0.3).getHex(), 1]);
  });

  it('sizes its target and the pass to the viewport, again as the viewport changes (the high pass at half its size)', () => {
    const { renderer, draws, state } = recorder();
    const bloom = new SelectiveBloom();
    const scene = new Scene(), camera = new PerspectiveCamera();
    bloom.render(renderer, scene, camera);
    expect([draws[1]!.target, draws[2]!.target]).toEqual(['640x440', '320x220']);
    draws.length = 0;
    state.viewport = [320, 220];
    bloom.render(renderer, scene, camera);
    expect([draws[1]!.target, draws[2]!.target]).toEqual(['320x220', '160x110']);
  });

  it('sizes them in CSS pixels, so the halo is as wide on screen at any device pixel ratio', () => {
    const { renderer, draws } = recorder({ viewport: [1280, 880], ratio: 2 });
    new SelectiveBloom().render(renderer, new Scene(), new PerspectiveCamera());
    expect([draws[1]!.target, draws[2]!.target]).toEqual(['640x440', '320x220']);
  });

  it('adds the blur over the target the frame was drawn into, and leaves that bound', () => {
    const bound = new WebGLRenderTarget(800, 600);
    const { renderer, draws, target } = recorder({ bound });
    new SelectiveBloom().render(renderer, new Scene(), new PerspectiveCamera());
    expect([draws.at(-1)!.target, target() === bound]).toEqual(['bound', true]);
  });

  it('converts the blur to the output\'s colour space as it adds it (the canvas is sRGB, the blur linear)', () => {
    const { renderer, materials } = recorder();
    new SelectiveBloom().render(renderer, new Scene(), new PerspectiveCamera());
    const last = materials.at(-1) as ShaderMaterial;
    expect([last.isShaderMaterial, last.fragmentShader.includes('#include <colorspace_fragment>'), last.blending, last.depthTest, last.depthWrite])
      .toEqual([true, true, AdditiveBlending, false, false]);
  });

  /** A ship (on layer 0 and the one that hides), a beam's glow behind it (on layer 0 and the bloom's), and the view's other things. */
  function battle(o: { ship: boolean }) {
    const scene = new Scene();
    const glow = new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }));
    glow.name = 'glow';
    glow.position.z = -5;
    glow.layers.enable(BLOOM_LAYER);
    scene.add(glow);
    // (the shimmer's glow, on the bloom's layer alone; the stars, which write no depth; a piece of debris, which hides nothing)
    const shimmer = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ transparent: true, depthWrite: false }));
    shimmer.name = 'shimmer';
    shimmer.layers.set(BLOOM_LAYER);
    scene.add(shimmer);
    const stars = new Points(undefined, new ShaderMaterial({ depthTest: false, depthWrite: false }));
    stars.name = 'stars';
    scene.add(stars);
    const debris = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    debris.name = 'debris';
    scene.add(debris);
    const ship = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    ship.name = 'ship';
    ship.position.z = -2;
    ship.layers.enable(HIDES_LAYER);
    ship.visible = o.ship;
    scene.add(ship);
    return { scene, glow, ship };
  }

  it('a glow behind a ship is hidden where the ship covers it: the ship\'s depth alone first, then the glows tested against it', () => {
    const { renderer, draws, scenes } = recorder();
    const { scene, glow, ship } = battle({ ship: true });
    const camera = new PerspectiveCamera();
    new SelectiveBloom().render(renderer, scene, camera);
    // (into the bloom's target, cleared once: the ship's depth, with no colour, and then what glows)
    expect(scenes).toEqual([
      { target: '640x440', drawn: ['ship'], override: { colorWrite: false, depthWrite: true }, clears: 1 },
      { target: '640x440', drawn: ['glow', 'shimmer'], override: null, clears: 1 },
    ]);
    expect(glow.material.depthTest).toBe(true);
    // (the pass and the add as before)
    expect(draws.slice(2).every(d => d.what === 'quad')).toBe(true);
    expect(draws).toHaveLength(16);
    expect(draws.at(-1)).toEqual({ what: 'quad', target: 'screen', blending: AdditiveBlending });
    // (everything as it was)
    expect([ship.visible, scene.overrideMaterial, camera.layers.mask]).toEqual([true, null, 1]);
  });

  it('a glow with nothing in front of it keeps its halo: no depth drawn, the glows drawn and blurred as before', () => {
    const { renderer, draws, scenes } = recorder();
    const { scene } = battle({ ship: false });
    new SelectiveBloom().render(renderer, scene, new PerspectiveCamera());
    expect(scenes).toEqual([
      { target: '640x440', drawn: [], override: { colorWrite: false, depthWrite: true }, clears: 1 },
      { target: '640x440', drawn: ['glow', 'shimmer'], override: null, clears: 1 },
    ]);
    expect(draws.slice(2).every(d => d.what === 'quad')).toBe(true);
    expect(draws).toHaveLength(16);
    expect(draws.at(-1)).toEqual({ what: 'quad', target: 'screen', blending: AdditiveBlending });
  });

  it('draws the depth of the faces the frame draws, each mesh\'s own side, a little back (for a ship\'s own shimmer)', () => {
    const { depth } = new SelectiveBloom() as unknown as { depth: MeshBasicMaterial };
    expect([depth.colorWrite, depth.depthWrite, depth.depthTest, depth.polygonOffset, depth.polygonOffsetFactor, depth.polygonOffsetUnits]).toEqual([false, true, true, true, 1, 4]);
    const sides: number[] = [];
    const before = (o: Mesh, group: { materialIndex: number } | null = null) => {
      depth.onBeforeRender(null!, null!, null!, o.geometry, o, group as never);
      sides.push(depth.side);
    };
    const parts = new Mesh(new BoxGeometry(), [new MeshBasicMaterial({ side: FrontSide }), new MeshBasicMaterial({ side: DoubleSide })]);
    before(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: DoubleSide })));
    before(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    before(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: BackSide })));
    before(parts, { materialIndex: 1 });
    before(parts, { materialIndex: 0 });
    expect(sides).toEqual([DoubleSide, FrontSide, BackSide, DoubleSide, FrontSide]);
  });

  it('frees its target and the pass\'s targets and materials as it is disposed', () => {
    const bloom = new SelectiveBloom();
    const { target, pass, add, depth } = bloom as unknown as { target: WebGLRenderTarget; pass: UnrealBloomPass; add: ShaderMaterial; depth: Material };
    const owned: { addEventListener(t: 'dispose', f: () => void): void }[] = [
      target, ...pass.renderTargetsHorizontal, ...pass.renderTargetsVertical, pass.renderTargetBright,
      ...pass.separableBlurMaterials, pass.compositeMaterial, pass.blendMaterial, pass.basic, pass.materialHighPassFilter, add, depth,
    ];
    let freed = 0;
    for (const o of owned) o.addEventListener('dispose', () => { freed++; });
    bloom.dispose();
    expect(freed).toBe(owned.length);
  });
});
