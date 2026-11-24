// SPDX-License-Identifier: GPL-3.0-or-later
import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, DataTexture, DirectionalLight, Float32BufferAttribute, Group, LineBasicMaterial,
  LineSegments, LinearFilter, Mesh, MeshBasicMaterial, MeshLambertMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry, Points,
  PointsMaterial, RepeatWrapping, RGBAFormat, Scene, SphereGeometry, SRGBColorSpace, UnsignedByteType, type Texture,
} from 'three';
import type { ArtLoaders } from './art';
import { layerFrame, type LayerStrip } from './layerAnim';

/** What the viewscreen shows (R7, unity.cpp:604): the sim's pick, as the ship port reports it. */
export type ViewscreenImage =
  | { kind: 'space' }
  | { kind: 'warp' }
  | { kind: 'planet'; colours: [string, string] }
  | { kind: 'sprite'; sprite: string };

/**
 * A sprite's animations as sheets (a views entry): each animation's atlas pages' files and how it plays (its `pages` and `cells`), by the
 * original's animation index. `rect`'s size is a cell's, in the sprite's own pixels; `anchor` is where the viewscreen's object (VIEW_ORIGIN) is
 * in the cell, as fractions of it.
 */
export interface SpriteSheet {
  urls: Record<number, string[]>;
  strips: Record<number, LayerStrip & { anchor: [number, number] }>;
}

/** Where the viewscreen's object stands on the original's 640x480 screen: what a sheet's frames are placed from (viewscreen.cpp start). */
export const VIEW_ORIGIN: [number, number] = [320, 240];

/**
 * R7: the viewscreen's picture as a small scene, drawn into a render target by the session. One of a seeded starfield, warp streaks, a lit
 * two-tone sphere, or a sprite on a quad (the original's pixels, linear filtered, under a faint scan overlay): its first frame, or its
 * animation from a sheet, stepped as a crew strip is (layerFrame, on the sprite's own delays). All of them
 * are made once: `set` only shows one and hides the rest, so a change never allocates geometry.
 */
export interface SpaceView {
  scene: Scene;
  camera: PerspectiveCamera;
  /**
   * Chooses the picture. `spriteUrl` is the frame's file for a sprite; a frame that can't be loaded leaves space. A repainted `still` is
   * `scale` times the sprite's pixels and goes where the original draws the sprite (`at`, its bottom centre, in the picture's pixels, with
   * `boxCentre` the window's centre in the same); without one the frame is centred 1:1. A `sheet` (with no still) plays animation 0 from the
   * moment it shows, 1:1, each frame where the original draws it from VIEW_ORIGIN (`boxCentre` as the still's); one that can't be loaded
   * leaves the frame at `spriteUrl`.
   */
  set(image: ViewscreenImage, spriteUrl?: string, still?: { scale: number; at: [number, number]; boxCentre: [number, number] }, sheet?: SpriteSheet & { boxCentre: [number, number] }): void;
  /** The window's size in the original's pixels: the camera's aspect, and the sprite quad's scale (1 sprite pixel = 1 original pixel). */
  setBox(width: number, height: number): void;
  update(dt: number): void;
  /** Which picture is up: 'space', 'warp', 'planet' or 'sprite'. */
  shown(): ViewscreenImage['kind'];
  /** The sheet's frame on show (its animation and the frame's index), or null with no sheet up. */
  sheetFrame(): { anim: number; index: number } | null;
  dispose(): void;
}

/** A small seeded generator (mulberry32): the same seed gives the same sky. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOV = 50;
const STARS = 500;
const STREAKS = 160;
const STREAK_DEPTH = 60;

export function createSpaceView(seed: number, loaders: ArtLoaders, warn: (message: string) => void = () => {}): SpaceView {
  const rand = rng(seed);
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new PerspectiveCamera(FOV, 2, 0.1, 4000);
  camera.position.set(0, 0, 0);
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    owned.push(o);
    return o;
  };

  // the starfield: points on a sphere around the camera, drifting slowly
  const stars = new Group();
  {
    const pos = new Float32Array(STARS * 3);
    const col = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos.set([r * Math.cos(a) * 50, z * 50, r * Math.sin(a) * 50], i * 3);
      const v = 0.45 + rand() * 0.55;
      col.set([v, v, Math.min(1, v + 0.15 * rand())], i * 3);
    }
    const g = keep(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    stars.add(new Points(g, keep(new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }))));
  }
  scene.add(stars);

  // warp streaks: segments along the view axis, rushing past the camera
  const streaks = new Group();
  const streakGeo = keep(new BufferGeometry());
  const streakPos = new Float32Array(STREAKS * 6);
  const streakXY: [number, number][] = [];
  const streakZ = new Float32Array(STREAKS);
  const streakLen = new Float32Array(STREAKS);
  for (let i = 0; i < STREAKS; i++) {
    const a = rand() * Math.PI * 2;
    const r = 0.4 + rand() * 7;
    streakXY.push([Math.cos(a) * r, Math.sin(a) * r]);
    streakZ[i] = -rand() * STREAK_DEPTH;
    streakLen[i] = 3 + rand() * 9;
  }
  const writeStreaks = (): void => {
    for (let i = 0; i < STREAKS; i++) {
      const [x, y] = streakXY[i]!;
      streakPos.set([x, y, streakZ[i]!, x, y, streakZ[i]! - streakLen[i]!], i * 6);
    }
  };
  writeStreaks();
  streakGeo.setAttribute('position', new BufferAttribute(streakPos, 3));
  streaks.add(new LineSegments(streakGeo, keep(new LineBasicMaterial({ color: 0xbcd4ff, transparent: true, opacity: 0.85 }))));
  streaks.visible = false;
  scene.add(streaks);

  // a lit sphere in two tones: vertex colours from a smooth hash of the position, a key light and a dim fill
  const planet = new Group();
  const sphereGeo = keep(new SphereGeometry(1, 128, 64));
  const sphereColours = new Float32BufferAttribute(new Float32Array(sphereGeo.getAttribute('position').count * 3), 3);
  sphereGeo.setAttribute('color', sphereColours);
  const bands = rand() * 6 + 4;
  const phase = rand() * Math.PI * 2;
  /** 0..1: where on the sphere the second tone is. */
  const tone = (x: number, y: number, z: number): number => {
    const v = 0.5 + 0.5 * Math.sin(y * bands + 1.7 * Math.sin(x * 3 + phase) + 1.3 * Math.sin(z * 4 - phase));
    return Math.min(1, Math.max(0, (v - 0.25) / 0.5));
  };
  const paint = (a: Color, b: Color): void => {
    const p = sphereGeo.getAttribute('position');
    const c = new Color();
    for (let i = 0; i < p.count; i++) {
      c.copy(a).lerp(b, tone(p.getX(i), p.getY(i), p.getZ(i)));
      sphereColours.setXYZ(i, c.r, c.g, c.b);
    }
    sphereColours.needsUpdate = true;
  };
  paint(new Color('#7a5a3a'), new Color('#2a3a5a'));
  const sphere = new Mesh(sphereGeo, keep(new MeshLambertMaterial({ vertexColors: true })));
  sphere.position.set(0, 0, -3.2);
  sphere.rotation.z = 0.35;
  planet.add(sphere);
  const key = new DirectionalLight(0xffffff, 3.2);
  key.position.set(-4, 2.5, 1.5);
  planet.add(key);
  planet.add(new AmbientLight(0x303848, 1.2));
  planet.visible = false;
  scene.add(planet);

  // a sprite's first frame, at its own pixels, and the faint scan lines over it
  const spriteGroup = new Group();
  const spriteMaterial = keep(new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
  const sprite = new Mesh(keep(new PlaneGeometry(1, 1)), spriteMaterial);
  sprite.renderOrder = 1;
  sprite.visible = false;
  const scanTexture = keep(new DataTexture(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 56]), 1, 2, RGBAFormat, UnsignedByteType));
  scanTexture.wrapS = scanTexture.wrapT = RepeatWrapping;
  scanTexture.magFilter = scanTexture.minFilter = NearestFilter;
  scanTexture.needsUpdate = true;
  const scan = new Mesh(keep(new PlaneGeometry(1, 1)), keep(new MeshBasicMaterial({ map: scanTexture, transparent: true, depthTest: false, depthWrite: false })));
  scan.renderOrder = 2;
  spriteGroup.add(sprite, scan);
  spriteGroup.visible = false;
  scene.add(spriteGroup);

  let box: [number, number] = [519, 238];
  let frameSize: [number, number] = [1, 1];
  let placement: { scale: number; at: [number, number]; boxCentre: [number, number] } | undefined;
  let texture: Texture | null = null;
  /** The sheet up (its strips and each animation's texture), and how long it has played, in milliseconds. */
  let sheet: { strips: SpriteSheet['strips']; textures: Record<number, Texture[]>; boxCentre: [number, number] } | null = null;
  let sheetMs = 0;
  let sheetAt: { anim: number; index: number } | null = null;
  /** The part of the cell the frame's stored pixels cover ([left, top, right, bottom], fractions; layerFrame's `sub`). */
  let sheetSub: [number, number, number, number] = [0, 0, 1, 1];
  let kind: ViewscreenImage['kind'] = 'space';
  // (a load that finishes after another picture was chosen is dropped)
  let want = 0;
  /** The distance at which the view is `box[1]` units high: one unit is then one original pixel. */
  const distance = (): number => box[1] / 2 / Math.tan((FOV * Math.PI) / 360);
  const layoutSprite = (): void => {
    const d = distance();
    const k = placement?.scale ?? 1;
    const [cw, ch] = [frameSize[0] / k, frameSize[1] / k];
    // (a sheet's frame is the part of its cell its atlas stores)
    const [w, h] = sheet && !placement ? [cw * (sheetSub[2] - sheetSub[0]), ch * (sheetSub[3] - sheetSub[1])] : [cw, ch];
    // (the original puts the sprite's bottom centre at `at`; the quad's centre is half its height above, and y goes down on the screen)
    // (a sheet's cell has the object's place at its anchor: the quad's centre is the middle of the stored part, measured from there)
    const anchor = sheet && sheetAt ? sheet.strips[sheetAt.anim]?.anchor : undefined;
    const [dx, dy] = placement
      ? [placement.at[0] - placement.boxCentre[0], placement.at[1] - h / 2 - placement.boxCentre[1]]
      : sheet && anchor
        ? [VIEW_ORIGIN[0] + (((sheetSub[0] + sheetSub[2]) / 2 - anchor[0]) * cw) - sheet.boxCentre[0], VIEW_ORIGIN[1] + (((sheetSub[1] + sheetSub[3]) / 2 - anchor[1]) * ch) - sheet.boxCentre[1]]
        : [0, 0];
    sprite.position.set(dx, -dy, -d);
    sprite.scale.set(w, h, 1);
    scan.position.set(0, 0, -d);
    scan.scale.set(box[0], box[1], 1);
    scanTexture.repeat.set(1, box[1] / 2);
    scanTexture.needsUpdate = true;
  };
  layoutSprite();

  const show = (k: ViewscreenImage['kind']): void => {
    kind = k;
    stars.visible = k === 'space' || k === 'planet';
    streaks.visible = k === 'warp';
    planet.visible = k === 'planet';
    spriteGroup.visible = k === 'sprite';
    sprite.visible = k === 'sprite';
  };
  show('space');

  /** Frees the sprite's textures: its frame's, or its sheet's. */
  const freeTextures = (): void => {
    texture?.dispose();
    texture = null;
    for (const pages of Object.values(sheet?.textures ?? {})) for (const t of pages) t.dispose();
    sheet = null;
    sheetAt = null;
    sheetSub = [0, 0, 1, 1];
    if (spriteMaterial.map !== null) {
      spriteMaterial.map = null;
      spriteMaterial.needsUpdate = true;
    }
  };
  /** Shows the sheet's frame at `sheetMs` (layerFrame: the crew strips' rule, on the sprite's own delays), from animation 0, from the page that holds it. */
  const stepSheet = (): void => {
    if (!sheet) return;
    const f = layerFrame(sheet.strips, 0, sheetMs);
    const t = f ? sheet.textures[f.anim]?.[f.page] : undefined;
    if (!f || !t) return;
    // (a frame with nothing visible draws nothing)
    sprite.visible = !f.empty;
    if (spriteMaterial.map !== t) {
      spriteMaterial.map = t;
      spriteMaterial.needsUpdate = true;
    }
    t.offset.set(f.uv[0], f.uv[1]);
    t.repeat.set(f.uv[2] - f.uv[0], f.uv[3] - f.uv[1]);
    const moved = sheetAt?.anim !== f.anim || f.sub.some((v, i) => v !== sheetSub[i]);
    sheetAt = { anim: f.anim, index: f.index };
    sheetSub = f.sub;
    if (moved || frameSize[0] !== f.rect[2] || frameSize[1] !== f.rect[3]) {
      frameSize = [f.rect[2], f.rect[3]];
      layoutSprite();
    }
  };

  return {
    scene,
    camera,
    shown: () => kind,
    setBox: (w, h) => {
      box = [w, h];
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      layoutSprite();
    },
    sheetFrame: () => (sheet && kind === 'sprite' ? sheetAt : null),
    set: (image, spriteUrl, still, sheetIn) => {
      const mine = ++want;
      placement = still;
      if (image.kind === 'planet') paint(new Color(image.colours[0]), new Color(image.colours[1]));
      if (image.kind !== 'sprite') {
        // (the sprite's frame or sheet pages go as the view changes)
        freeTextures();
        show(image.kind);
        return;
      }
      if (spriteUrl === undefined) {
        warn(`the viewscreen's sprite ${image.sprite} has no frame: showing space`);
        freeTextures();
        show('space');
        return;
      }
      // (until the frame is in, space shows)
      show('space');
      const prepare = (t: Texture): Texture => {
        t.colorSpace = SRGBColorSpace;
        t.magFilter = LinearFilter;
        t.minFilter = LinearFilter;
        t.generateMipmaps = false;
        return t;
      };
      const showFrame = (t: Texture): void => {
        const img = t.image as { width?: number; height?: number } | undefined;
        frameSize = [img?.width ?? 1, img?.height ?? 1];
        freeTextures();
        texture = t;
        spriteMaterial.map = t;
        spriteMaterial.needsUpdate = true;
        layoutSprite();
        show('sprite');
      };
      const frame = (): void => {
        loaders.texture(spriteUrl, true).then(t => {
          if (mine !== want) {
            t.dispose();
            return;
          }
          showFrame(prepare(t));
        }, (err: unknown) => {
          if (mine === want) warn(`the viewscreen's frame ${spriteUrl} could not be loaded (${err instanceof Error ? err.message : String(err)}): showing space`);
        });
      };
      if (sheetIn === undefined || still !== undefined) {
        frame();
        return;
      }
      // (every page of every animation at once: a view's frames change every few tens of milliseconds, and a page fetched as its first
      // frame comes up would leave a hole in the loop; the pages are at most 4096 a side, and all are freed as the view changes)
      const anims = Object.keys(sheetIn.urls).map(Number);
      const wanted = anims.flatMap(a => sheetIn.urls[a]!.map(url => ({ a, url })));
      Promise.allSettled(wanted.map(w => loaders.texture(w.url, true))).then(results => {
        const loaded = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
        if (mine !== want) {
          for (const t of loaded) t.dispose();
          return;
        }
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) {
          for (const t of loaded) t.dispose();
          warn(`the viewscreen's sheet for ${image.sprite} could not be loaded (${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}): showing its frame`);
          frame();
          return;
        }
        freeTextures();
        const textures: Record<number, Texture[]> = {};
        wanted.forEach((w, i) => (textures[w.a] ??= []).push(prepare(loaded[i]!)));
        sheet = { strips: sheetIn.strips, textures, boxCentre: sheetIn.boxCentre };
        sheetMs = 0;
        show('sprite');
        stepSheet();
      });
    },
    update: dt => {
      stars.rotation.y += dt * 0.01;
      if (sheet && kind === 'sprite') {
        sheetMs += dt * 1000;
        stepSheet();
      }
      if (kind === 'warp') {
        for (let i = 0; i < STREAKS; i++) {
          streakZ[i] = streakZ[i]! + dt * 55;
          if (streakZ[i]! - streakLen[i]! > -1) streakZ[i] = -STREAK_DEPTH;
        }
        writeStreaks();
        (streakGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
      }
      if (kind === 'planet') sphere.rotation.y += dt * 0.08;
    },
    dispose: () => {
      // (a frame still loading is stale now: its .then frees it)
      want++;
      freeTextures();
      for (const o of owned) o.dispose();
      scene.clear();
    },
  };
}
