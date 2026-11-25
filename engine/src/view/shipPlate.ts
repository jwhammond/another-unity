// SPDX-License-Identifier: GPL-3.0-or-later
import { DoubleSide, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, SRGBColorSpace, type Texture } from 'three';
import { CardPlayer } from './actors';
import type { ArtLoaders, CardAnim, CardArt, Rect, ShipArt } from './art';
import { BeamRun, dissolveLevel, dissolveTick, setDissolve, type BeamTarget, type SparkleFrame } from './beam';
import { applyLook, placeShadow, setCell, shadowMesh, type CardLook, type CardShadow, type LookUniforms } from './cardLook';
import type { PresentationClock } from './timeline';
import type { ShipSet, Viewport } from './shipSet';

/** The original's screens, in pixels: a plate is drawn as a quad this size. */
export const PLATE_W = 640;
export const PLATE_H = 480;

/**
 * The original's pixels: (x, y) is at (x, -y), so the plate (a 640x480 quad from the origin down) fills the box's viewport.
 * Drawn in a viewport of the box's size, one unit is one original pixel.
 */
export function plateCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(0, PLATE_W, 0, -PLATE_H, -10, 10);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * An area of the 640x480 picture as a rectangle of the drawing buffer inside `box` (x from the left, y from the bottom), rounded as
 * screenViewport rounds: each edge is rounded on its own, so the area is as big as the page paints it and touches its neighbour's edge.
 */
export function areaViewport(box: Viewport, area: Rect): Viewport {
  const edge = (v: number, size: number, extent: number): number => Math.round((v / size) * extent);
  const left = box.x + edge(area[0], PLATE_W, box.width);
  const right = box.x + edge(area[0] + area[2], PLATE_W, box.width);
  const top = edge(area[1], PLATE_H, box.height);
  const bottom = edge(area[1] + area[3], PLATE_H, box.height);
  return { x: left, y: box.y + box.height - bottom, width: right - left, height: bottom - top };
}

/**
 * Where a pointer is in a viewport of the drawing buffer, as normalized device coordinates (y up), and whether it is inside.
 * `canvas` is the canvas's client rect (the buffer is `canvas.height` css px high, `dpr` device pixels to a css pixel).
 */
export function pointerInViewport(vp: Viewport, canvas: { left: number; top: number; height: number }, dpr: number, clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
  const px = (clientX - canvas.left) * dpr;
  const py = Math.round(canvas.height * dpr) - (clientY - canvas.top) * dpr;
  const x = ((px - vp.x) / vp.width) * 2 - 1;
  const y = ((py - vp.y) / vp.height) * 2 - 1;
  return { x, y, inside: vp.width > 0 && vp.height > 0 && x >= -1 && x <= 1 && y >= -1 && y <= 1 };
}

/** A card standing on the plate: its art, where its feet are (the original's pixels), and a draw order (a larger depth draws earlier). */
export interface PlateCard {
  key: string;
  art: CardArt;
  at: [number, number];
  scale?: number;
  depth: number;
  /** The animation index of the art's strips to play; without it the card shows its first frame. */
  anim?: number;
  /** With `anim`: every animation of the art is loaded, so `playCards` can switch between them (the bridge's crew). */
  all?: boolean;
  /**
   * With `anim` and `all`: only these animations, and the ones they fall into (`next`), are loaded, not every strip the art has. The bridge's
   * crew use two of their six, and a strip is megabytes.
   */
  only?: number[];
  /** How it is set into the plate: its edge, its colours (cardLook.ts). Without it, drawn as published. */
  look?: CardLook;
  /** A soft shadow on the floor at its feet. */
  shadow?: CardShadow;
}

/** The animations to load for a card: `only` and the chain each falls into, or all of them. */
export function animsToLoad(anims: NonNullable<CardArt['anims']>, only?: number[]): number[] {
  if (!only) return Object.keys(anims).map(Number);
  const wanted = new Set<number>();
  const visit = (i: number | undefined): void => {
    if (i === undefined || wanted.has(i) || anims[i] === undefined) return;
    wanted.add(i);
    visit(anims[i]!.next);
  };
  for (const i of only) visit(i);
  return [...wanted].sort((a, b) => a - b);
}

export interface ShipPlate extends ShipSet {
  /** Replaces the cards with these keys; the others stay. */
  placeCards(cards: PlateCard[]): Promise<void>;
  /**
   * The transporter's effect on the cards with these keys (beam.ts): the sparkle in front of each, then the dissolve; it ends when the effect has played on
   * `clock`. `anims` are the sparkle's strips (art.cards); without them the cards only dissolve. An out beam leaves the cards hidden.
   */
  beam(keys: string[], out: boolean, anims: Record<number, CardAnim> | undefined, clock: PresentationClock): Promise<void>;
  /** The cards a beam is dissolving now, with their level (0 hidden to 6 whole), and the sparkles drawn: for tests. */
  beamState(): { cards: { key: string; level: number }[]; sparkles: string[] };
  removeCards(keys: string[]): void;
  /**
   * Where the cards with these keys are now, and whether they are drawn at all: a card that walks (the transporter's crew, which `walkers` of the room moves a
   * step a frame) has its feet at `at`, its size `scale` (1 is full size) and is sorted by its row. A key with no card is passed over; a card not named stays.
   */
  moveCards(moves: Record<string, { at: [number, number]; scale: number; visible: boolean }>): void;
  /**
   * Draws a rectangle of the plate over the cards, as the original's tdoor.spr is drawn over the crew who walk in from behind the doorway (transporter.cpp:222):
   * a crew member walking through it is covered by the wall. null takes it away.
   */
  setOccluder(rect: Rect | null): void;
  /** Switches the cards that loaded all their animations to the one `pick` names for each key (null: leaves it); a repeat is a no-op. */
  playCards(pick: (key: string) => number | null): void;
  /** The render target's texture in the window layer, over the window's box, with window.webp as alpha (R15); null takes it away. */
  setWindow(texture: Texture | null): void;
  /**
   * Draws a viewscreen plate's rows 0-363 over this plate (the bridge with the viewscreen up: where viewscr.spr sits), and its window box
   * and alpha become this plate's window's (a later setWindow fills it). null takes the frame away.
   */
  setFrame(viewscreen: ShipPlate | null): void;
  /** What another plate needs to draw this one as a frame: the plate's texture, and the window layer's box and alpha, if there is one. */
  frameParts(): { plate: Texture; window: { rect: [number, number, number, number]; alpha: Texture | null } | null };
}

/** The rows of a viewscreen plate that the bridge draws over its own: viewscr.spr is 640x364, with its top left at (0, 0). */
export const FRAME_ROWS = 364;

interface Placed {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  textures: Texture[];
  /** Where its feet are and how big it is drawn (the pad's scale): the sparkle stands there at that size. */
  at: [number, number];
  scale: number;
  depth: number;
  /** A card that does not animate: its height at full size and its aspect, to lay it out again where it is moved. */
  still?: { heightPx: number; aspect: number; anchor: [number, number] };
  /** Its look's uniforms (PlateCard.look), kept on the frame it shows. */
  look?: LookUniforms;
  /** Its shadow (PlateCard.shadow), and the shadow's own shape. */
  shadow?: { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; shape: CardShadow };
  /** What it plays, if it is animated. */
  play?: { player: CardPlayer; anims: NonNullable<CardArt['anims']>; textures: Map<number, Texture>; scale: number; at: [number, number] };
}

/** One card's mesh is `(heightPx) x scale` original pixels high, with the art's anchor on `at`. */
function layout(mesh: Mesh, at: [number, number], widthPx: number, heightPx: number, anchor: [number, number]): void {
  mesh.scale.set(widthPx, heightPx, 1);
  // (the anchor is a fraction of the frame from its top left; y goes up on the screen)
  mesh.position.set(at[0] + (0.5 - anchor[0]) * widthPx, -at[1] + (anchor[1] - 0.5) * heightPx, 0);
}

const flat = (map: Texture, transparent: boolean): MeshBasicMaterial =>
  new MeshBasicMaterial({ map, transparent, alphaTest: transparent ? 0.05 : 0, side: DoubleSide, depthTest: false, depthWrite: false });

/**
 * A station's plate as a scene (R14): the repainted background as a 640x480 quad, the window layer over it and the cards over
 * that, all in the original's pixels. The camera is `plateCamera()`.
 */
export async function loadShipPlate(art: Extract<ShipArt, { kind: 'plate' }>, loaders: ArtLoaders): Promise<ShipPlate> {
  const plateTexture = await loaders.texture(art.plate, true);
  plateTexture.colorSpace = SRGBColorSpace;
  plateTexture.generateMipmaps = true;
  plateTexture.minFilter = LinearMipmapLinearFilter;
  plateTexture.magFilter = LinearFilter;
  const scene = new Scene();
  const camera = plateCamera();
  const plate = new Mesh(new PlaneGeometry(PLATE_W, PLATE_H), new MeshBasicMaterial({ map: plateTexture, depthTest: false, depthWrite: false }));
  plate.position.set(PLATE_W / 2, -PLATE_H / 2, 0);
  plate.renderOrder = 0;
  plate.name = 'plate';
  scene.add(plate);

  const owned: Texture[] = [];
  // R15: the window layer: the render target over the window's box, with window.webp's alpha (sampled with the box's UVs)
  let window: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  let windowAlpha: Texture | null = null;
  if (art.window !== undefined) {
    windowAlpha = await loaders.texture(art.window, false);
    owned.push(windowAlpha);
  }
  const ownRect = art.areas.window as [number, number, number, number] | undefined;
  const ownWindow = ownRect ? { rect: ownRect, alpha: windowAlpha } : null;
  // the frame over the plate (setFrame): a UV crop of the viewscreen plate's texture, at rows 0-363
  let frame: { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; texture: Texture; parts: ReturnType<ShipPlate['frameParts']> } | null = null;
  let windowTarget: Texture | null = null;
  const dropWindow = (): void => {
    if (!window) return;
    scene.remove(window);
    window.geometry.dispose();
    window.material.dispose();
    window = null;
  };
  /** (Re)builds the window layer from the target and the box in force: this plate's own, or its frame's. */
  const syncWindow = (): void => {
    dropWindow();
    const w = ownWindow ?? frame?.parts.window ?? null;
    if (!windowTarget || !w) return;
    const [x, y, ww, wh] = w.rect;
    const material = new MeshBasicMaterial({ map: windowTarget, transparent: w.alpha !== null, depthTest: false, depthWrite: false });
    if (w.alpha) {
      // (window.webp's alpha, not the green channel an alphaMap reads)
      material.alphaMap = w.alpha;
      material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', 'diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;');
      };
    }
    window = new Mesh(new PlaneGeometry(ww, wh), material);
    window.position.set(x + ww / 2, -(y + wh / 2), 0);
    window.renderOrder = 2;
    window.name = 'window';
    scene.add(window);
  };
  const dropFrame = (): void => {
    if (!frame) return;
    scene.remove(frame.mesh);
    frame.mesh.geometry.dispose();
    frame.mesh.material.dispose();
    frame.texture.dispose();
    frame = null;
  };

  let occluder: { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; texture: Texture } | null = null;
  const dropOccluder = (): void => {
    if (!occluder) return;
    scene.remove(occluder.mesh);
    occluder.mesh.geometry.dispose();
    occluder.mesh.material.dispose();
    occluder.texture.dispose();
    occluder = null;
  };

  const placed = new Map<string, Placed>();
  const drop = (key: string): void => {
    const p = placed.get(key);
    if (!p) return;
    placed.delete(key);
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    for (const t of p.textures) t.dispose();
    if (p.shadow) {
      scene.remove(p.shadow.mesh);
      p.shadow.mesh.geometry.dispose();
      // (the soft disc is shared: only the material goes)
      p.shadow.mesh.material.dispose();
    }
  };
  let clock = 0;

  const place = async (c: PlateCard): Promise<void> => {
    const scale = c.scale ?? 1;
    const anim = c.anim !== undefined ? c.art.anims?.[c.anim] : undefined;
    // (a card that plays one animation loads its strip; one that switches loads them all)
    const wanted = anim ? (c.all ? animsToLoad(c.art.anims!, c.only) : [c.anim!]) : [];
    const loaded = await Promise.all(wanted.map(async i => [i, await loaders.texture(c.art.anims![i]!.url, true)] as const));
    const texture = anim ? loaded.find(([i]) => i === c.anim)![1] : await loaders.texture(c.art.url, true);
    const mesh = new Mesh(new PlaneGeometry(1, 1), flat(texture, true));
    mesh.renderOrder = 1000 - c.depth;
    mesh.name = `card:${c.key}`;
    const entry: Placed = { mesh, textures: anim ? loaded.map(([, t]) => t) : [texture], at: c.at, scale, depth: c.depth };
    if (c.look) entry.look = applyLook(mesh.material, c.look);
    if (c.shadow) {
      const s = shadowMesh(c.shadow, c.at, scale);
      // (on the floor, under the card and any card in front of it)
      s.renderOrder = 1000 - c.depth - 0.5;
      s.name = `shadow:${c.key}`;
      entry.shadow = { mesh: s, shape: c.shadow };
    }
    if (anim) {
      // (a strip of equal cells: its cell, in the original's pixels, is the cell over its scale)
      const anims = c.all ? Object.fromEntries(wanted.map(i => [i, c.art.anims![i]!])) : { [c.anim!]: anim };
      const player = new CardPlayer({ anims }, () => clock);
      player.set({ kind: 'anim', index: c.anim! });
      entry.play = { player, anims, textures: new Map(loaded), scale, at: c.at };
      applyFrame(entry);
    } else {
      const img = texture.image as { width?: number; height?: number } | undefined;
      const frameW = (img?.width ?? 1) / c.art.frames;
      const frameH = img?.height ?? 1;
      const heightPx = (c.art.pixelHeight ?? frameH) * scale;
      layout(mesh, c.at, (heightPx * frameW) / frameH, heightPx, c.art.anchor);
      entry.still = { heightPx: c.art.pixelHeight ?? frameH, aspect: frameW / frameH, anchor: c.art.anchor };
      texture.repeat.set(1 / c.art.frames, 1);
      texture.offset.set(0, 0);
      if (entry.look) setCell(entry.look, texture);
    }
    drop(c.key);
    placed.set(c.key, entry);
    if (entry.shadow) scene.add(entry.shadow.mesh);
    scene.add(mesh);
  };

  const CARD_SCALE = 4;
  function applyFrame(p: Placed): void {
    if (!p.play) return;
    const f = p.play.player.frame();
    if (!f) return;
    const k = p.play.anims[f.anim]?.scale ?? CARD_SCALE;
    const [w, h] = [(f.cell[0] / k) * p.play.scale, (f.cell[1] / k) * p.play.scale];
    layout(p.mesh, p.play.at, w, h, f.anchor);
    // (each animation is its own strip, so its own texture)
    const texture = p.play.textures.get(f.anim);
    if (!texture) return;
    if (p.mesh.material.map !== texture) p.mesh.material.map = texture;
    texture.repeat.set(f.uv[2] - f.uv[0], f.uv[3] - f.uv[1]);
    texture.offset.set(f.uv[0], f.uv[1]);
    if (p.look) setCell(p.look, texture);
  }

  const beams: BeamRun[] = [];
  /** A card in a beam: it dissolves, and the sparkle is a quad over it at the card's feet, a frame of the strip at the card's scale. */
  const beamTarget = (p: Placed, key: string): BeamTarget => {
    let fx: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
    return {
      dissolve: level => setDissolve(p.mesh, level),
      sparkle: (texture: Texture | undefined, frame: SparkleFrame | null) => {
        if (!texture || !frame) {
          if (fx) fx.visible = false;
          return;
        }
        if (!fx) {
          fx = new Mesh(new PlaneGeometry(1, 1), flat(texture, true));
          fx.name = `beam:${key}`;
          // (just in front of the card)
          fx.renderOrder = 1000 - p.depth + 0.5;
          scene.add(fx);
        }
        fx.visible = true;
        if (fx.material.map !== texture) fx.material.map = texture;
        layout(fx, p.at, frame.cell[0] * p.scale, frame.cell[1] * p.scale, frame.anchor);
        const uv = fx.geometry.getAttribute('uv');
        // (a plane's uv: top left first)
        uv.setXY(0, frame.uv[0], frame.uv[3]);
        uv.setXY(1, frame.uv[2], frame.uv[3]);
        uv.setXY(2, frame.uv[0], frame.uv[1]);
        uv.setXY(3, frame.uv[2], frame.uv[1]);
        uv.needsUpdate = true;
      },
      clear: () => {
        if (!fx) return;
        scene.remove(fx);
        fx.geometry.dispose();
        fx.material.dispose();
        fx = null;
      },
    };
  };

  return {
    scene,
    camera,
    node: name => scene.getObjectByName(name),
    update: dt => {
      clock += dt * 1000;
      dissolveTick();
      for (const b of beams) b.update(clock);
      for (const p of placed.values()) applyFrame(p);
    },
    beamState: () => ({
      cards: [...placed].map(([key, p]) => ({ key, level: dissolveLevel(p.mesh) })).filter(c => c.level >= 0),
      sparkles: scene.children.filter(c => c.name.startsWith('beam:') && c.visible).map(c => c.name.slice(5)),
    }),
    beam: async (keys, out, anims, time) => {
      const targets = keys.flatMap(k => { const p = placed.get(k); return p ? [beamTarget(p, k)] : []; });
      if (targets.length === 0) return;
      const textures = new Map<number, Texture>();
      if (anims) {
        try {
          for (const [i, a] of Object.entries(anims)) textures.set(Number(i), await loaders.texture(a.url, true));
        } catch {
          // (no sparkle: the cards only dissolve)
          for (const t of textures.values()) t.dispose();
          textures.clear();
        }
      }
      const art = textures.size > 0 && anims ? { anims, texture: (a: number) => textures.get(a) } : undefined;
      const run = new BeamRun(out, targets, art, clock, keys);
      beams.push(run);
      // (an in beam hides the cards from now; an out beam leaves them hidden: the screen changes next)
      run.update(clock);
      await time.after(run.totalMs / 1000);
      run.finish();
      beams.splice(beams.indexOf(run), 1);
      for (const t of textures.values()) t.dispose();
    },
    cards: () => [...placed.keys()],
    card: key => placed.get(key)?.mesh,
    showCards: shown => { for (const [key, p] of placed) p.mesh.visible = shown(key); },
    placeCards: async cards => { await Promise.all(cards.map(place)); },
    removeCards: keys => keys.forEach(drop),
    moveCards: moves => {
      for (const [key, m] of Object.entries(moves)) {
        const p = placed.get(key);
        if (!p) continue;
        p.at = m.at;
        p.scale = m.scale;
        p.depth = m.at[1];
        p.mesh.renderOrder = 1000 - p.depth;
        p.mesh.visible = m.visible;
        if (p.shadow) {
          placeShadow(p.shadow.mesh, p.shadow.shape, m.at, m.scale);
          p.shadow.mesh.renderOrder = 1000 - p.depth - 0.5;
          p.shadow.mesh.visible = m.visible;
        }
        if (p.play) {
          p.play.at = m.at;
          p.play.scale = m.scale;
          applyFrame(p);
        } else if (p.still) {
          const h = p.still.heightPx * m.scale;
          layout(p.mesh, m.at, h * p.still.aspect, h, p.still.anchor);
        }
      }
    },
    setOccluder: rect => {
      dropOccluder();
      if (!rect) return;
      // (a clone shares the image, so the one upload serves both; its UVs take the rectangle)
      const texture = plateTexture.clone();
      texture.repeat.set(rect[2] / PLATE_W, rect[3] / PLATE_H);
      texture.offset.set(rect[0] / PLATE_W, 1 - (rect[1] + rect[3]) / PLATE_H);
      texture.needsUpdate = true;
      const mesh = new Mesh(new PlaneGeometry(rect[2], rect[3]), new MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false }));
      mesh.position.set(rect[0] + rect[2] / 2, -(rect[1] + rect[3] / 2), 0);
      mesh.renderOrder = 1990;
      mesh.name = 'occluder';
      scene.add(mesh);
      occluder = { mesh, texture };
    },
    playCards: pick => {
      for (const [key, p] of placed) {
        const index = p.play ? pick(key) : null;
        if (index !== null && p.play!.anims[index]) p.play!.player.set({ kind: 'anim', index });
      }
    },
    setWindow: texture => {
      windowTarget = texture;
      syncWindow();
    },
    setFrame: viewscreen => {
      dropFrame();
      if (viewscreen) {
        const parts = viewscreen.frameParts();
        // (a clone shares the image, so the one upload serves both plates; its UVs take the top 364 of 480 rows)
        const texture = parts.plate.clone();
        texture.repeat.set(1, FRAME_ROWS / PLATE_H);
        texture.offset.set(0, 1 - FRAME_ROWS / PLATE_H);
        texture.needsUpdate = true;
        const mesh = new Mesh(new PlaneGeometry(PLATE_W, FRAME_ROWS), new MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false }));
        mesh.position.set(PLATE_W / 2, -FRAME_ROWS / 2, 0);
        mesh.renderOrder = 1;
        mesh.name = 'frame';
        scene.add(mesh);
        frame = { mesh, texture, parts };
      }
      syncWindow();
    },
    frameParts: () => ({ plate: plateTexture, window: ownWindow }),
    dispose: () => {
      for (const key of [...placed.keys()]) drop(key);
      dropWindow();
      dropFrame();
      dropOccluder();
      plate.geometry.dispose();
      plate.material.dispose();
      plateTexture.dispose();
      for (const t of owned) t.dispose();
      scene.clear();
    },
  };
}
