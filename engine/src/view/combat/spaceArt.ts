// SPDX-License-Identifier: GPL-3.0-or-later
import type { Material, Mesh, Object3D, Texture } from 'three';
import { IndexedScreen, type IndexedImage } from '../indexed';
import type { PresentationConfig } from '../package';

/**
 * Combat's art (Plan 30): which of `art.space`'s packs a battle loads, the repainted textures put on a model's materials by the
 * original texture's name, and how the console's indexed frame lets the repaint show through. Pure but for three's objects: no DOM.
 */

export type SpaceArt = NonNullable<PresentationConfig['art']['space']>;

/** The palette entries the console changes as it runs (Plan 30 R6): the red flash's 0 and 0xac (tactical.cpp:487-492) and the scanner's 245-255 (:1193). */
export const LIVE_ENTRIES: ReadonlySet<number> = new Set([0, 0xac, ...Array.from({ length: 11 }, (_, k) => 245 + k)]);

/** The packs a battle of these kinds loads: each kind's that has one, once, in kind order, then the effects'. */
export function spaceArtPacks(space: SpaceArt, types: readonly number[]): string[] {
  const kinds = [...new Set(types)].sort((a, b) => a - b).map(t => space.kinds[String(t)]).filter((p): p is string => p !== undefined);
  return [...kinds, ...(space.effects ? [space.effects] : [])];
}

/** A pack entry's name for a texture (`tex:<lower-case original name>`) and for a sprite's sheet (`sheet:<lower-case sprite file>`). */
export const texEntry = (name: string): string => `tex:${name.toLowerCase()}`;
export const sheetEntry = (file: string): string => `sheet:${file.toLowerCase()}`;

/**
 * Puts the repainted textures on a model (Plan 30 R15): each material whose original texture (`userData.texture`, the space build's
 * extras) has one takes it as its map, with the sampler of the map it replaces; the maps replaced are returned for the caller to
 * free (each .glb embeds its own copy). A material without a map (flat, Gouraud) or a texture without a repaint keeps its own.
 */
export function swapMaps(root: Object3D, art: ReadonlyMap<string, Texture>): { swapped: number; replaced: Texture[] } {
  const replaced = new Set<Texture>();
  let swapped = 0;
  root.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as (Material & { map?: Texture | null })[]) {
      const name = (m.userData.texture as string | undefined)?.toLowerCase();
      const next = name === undefined ? undefined : art.get(name);
      const old = m.map;
      if (!next || !old || old === next) continue;
      next.wrapS = old.wrapS;
      next.wrapT = old.wrapT;
      next.flipY = old.flipY;
      next.colorSpace = old.colorSpace;
      m.map = next;
      m.needsUpdate = true;
      replaced.add(old);
      swapped++;
    }
  });
  return { swapped, replaced: [...replaced] };
}

/** One picture the console drew this frame: space.mrg's entry, where (drawMRG's x, y). */
export interface ConsoleBlit { image: number; x: number; y: number }

/** An indexed screen that remembers which of the console's pictures each frame drew (cleared by `set`, the frame's background). */
export class RecordingScreen extends IndexedScreen {
  readonly blits: ConsoleBlit[] = [];
  private index = new Map<IndexedImage, number>();

  /** The console's pictures, so a blit is known by its entry. */
  pictures(images: readonly IndexedImage[]): void {
    this.index = new Map(images.map((im, i) => [im, i]));
  }

  override set(image: IndexedImage): void {
    this.blits.length = 0;
    super.set(image);
  }

  override blit(image: IndexedImage, x: number, y: number, transparent?: number): void {
    const i = this.index.get(image);
    if (i !== undefined) this.blits.push({ image: i, x, y });
    super.blit(image, x, y, transparent);
  }
}

/**
 * Where the console's indexed frame lets the repaint under it show (Plan 30 R7): a pixel is clear when it is still the plate's own (the
 * same index as the original plate there) or the pixel of a repainted picture the frame drew there (`repainted`), unless its index is a
 * live entry (LIVE_ENTRIES) or it lies in one of `opaque` (the areas the console draws from its indices: [x, y, w, h]). Writes 0 into
 * `rgba`'s alpha there and leaves the rest; returns how many pixels it cleared.
 */
export function seeThrough(
  screen: { readonly pixels: Uint8Array; readonly width: number },
  plate: IndexedImage,
  blits: readonly ConsoleBlit[],
  images: readonly IndexedImage[],
  repainted: { has(image: number): boolean },
  opaque: readonly (readonly [number, number, number, number])[],
  rgba: Uint8ClampedArray | Uint8Array,
): number {
  const w = screen.width, h = screen.pixels.length / w;
  const art = new Uint8Array(w * h);
  for (let i = 0; i < art.length; i++) if (screen.pixels[i] === plate.pixels[i]) art[i] = 1;
  for (const b of blits) {
    if (!repainted.has(b.image)) continue;
    const im = images[b.image];
    if (!im) continue;
    for (let y = Math.max(0, b.y); y < Math.min(h, b.y + im.height); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(w, b.x + im.width); x++) {
        const v = im.pixels[(y - b.y) * im.width + (x - b.x)]!;
        if (v !== 13 && screen.pixels[y * w + x] === v) art[y * w + x] = 1;
      }
    }
  }
  for (const [x0, y0, rw, rh] of opaque) {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++) art.fill(0, y * w + Math.max(0, x0), y * w + Math.min(w, x0 + rw));
  }
  let cleared = 0;
  for (let i = 0; i < art.length; i++) {
    if (!art[i] || LIVE_ENTRIES.has(screen.pixels[i]!)) continue;
    rgba[i * 4 + 3] = 0;
    cleared++;
  }
  return cleared;
}

/** The repainted pictures a frame drew, as a key: the art layer is redrawn only when it changes. */
export const blitKey = (blits: readonly ConsoleBlit[], repainted: { has(image: number): boolean }): string =>
  blits.filter(b => repainted.has(b.image)).map(b => `${b.image}@${b.x},${b.y}`).join(' ');

/** A decoded picture the art layer draws (an ImageBitmap in the browser). */
export interface ArtPicture { readonly width: number; readonly height: number }

/** The console's repaint, loaded (Plan 30 R7): the plate's URL, space.mrg's pictures at `scale` times by entry, and the areas always drawn from the indices. */
export interface ConsoleRepaint {
  plate: string;
  images: ReadonlyMap<number, ArtPicture>;
  scale: number;
  opaque: readonly (readonly [number, number, number, number])[];
}

/** What the art layer draws with: a 2D context's two calls. */
export interface ArtContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: ArtPicture, x: number, y: number): void;
}

/** The art layer (Plan 30 R7): cleared, then each picture the frame drew that has a repaint, at `scale` times its place, in the frame's order. */
export function drawArtLayer(g: ArtContext, repaint: ConsoleRepaint, blits: readonly ConsoleBlit[]): void {
  g.clearRect(0, 0, 640 * repaint.scale, 480 * repaint.scale);
  for (const b of blits) {
    const im = repaint.images.get(b.image);
    if (im) g.drawImage(im, b.x * repaint.scale, b.y * repaint.scale);
  }
}

/** What the screenshot check's console is drawn with: a 2D context's scaled drawImage and its smoothing switch. */
export interface ShotContext {
  imageSmoothingEnabled: boolean;
  drawImage(image: ArtPicture, x: number, y: number, w: number, h: number): void;
}

/**
 * The console as the game shows it, for the screenshot check's port side (Plan 30 R17), into `g` at w x h: with the art on (`art`), the
 * repaint's plate and then its art layer (drawArtLayer's), smoothed as the browser scales them, and over both the indexed frame (the
 * session's previewConsole, clear where the repaint shows through) texel for texel; with the art off, the frame alone.
 */
export function drawConsoleShot(g: ShotContext, w: number, h: number, frame: ArtPicture, art: { plate: ArtPicture; layer: ArtPicture } | null): void {
  if (art) {
    g.imageSmoothingEnabled = true;
    g.drawImage(art.plate, 0, 0, w, h);
    g.drawImage(art.layer, 0, 0, w, h);
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(frame, 0, 0, w, h);
}
