// SPDX-License-Identifier: GPL-3.0-or-later
import { CanvasTexture, Color, LinearFilter, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, SRGBColorSpace } from 'three';
import type { AstroMapArt } from '../ui/faces';
import { entryAt, layoutMap, MAP_WINDOW, type MapEntry, type MapFont, type MapInput, type MapLayout } from './astroLayout';
import { measurer, paintMap, type Paint2D, type PaintSprite } from './astroPaint';
import { ASTRO_FONT, textImage, type AstroFonts } from './bitmapText';

/** Device pixels to an original pixel on the map's canvas: the plate is a repaint at several times the original's size. */
const PIXEL_SCALE = 3;
const WINDOW_ASPECT = MAP_WINDOW.width / MAP_WINDOW.height;

export interface AstroScene {
  scene: Scene;
  camera: OrthographicCamera;
  /** Lays the map out for the state (astroLayout.ts), paints it on the canvas and brings the texture up to date. `ticks` is the original's clock, which turns a planet. */
  update(input: MapInput, ticks: number): void;
  /** The last layout, for what is on the map to click on. */
  layout(): MapLayout;
  /** The pictures the map draws, when published (art.astro); without them it draws shapes. */
  setArt(art: AstroMapArt | undefined): void;
  /** The game's bitmap fonts (art.fonts) for the map's text, when they are loaded; without them the text is drawn in the browser's font. */
  setFonts(fonts: AstroFonts | null): void;
  /** The map's background colour beside the window (the flat panel's by default; the plate's own black when the window sits in the plate). */
  setBackground(hex: number): void;
  /** The entry under a point in normalized device coordinates, or -1; the point in the original's pixels (null outside the map). */
  entryAtNdc(x: number, y: number): number;
  toMapPoint(x: number, y: number): { x: number; y: number } | null;
  /** An entry's place in normalized device coordinates (what `entryAtNdc` takes), or null when it is not on the map. */
  ndcOf(entry: MapEntry): { x: number; y: number };
  setAspect(aspect: number): void;
  zoom(factor: number): void;
  /** How far the camera is pulled back (the wheel). */
  zoomFactor(): number;
}

export interface AstroSceneOptions {
  /** Makes the canvas the map is painted on (the browser's `document.createElement('canvas')`); a test passes its own, or none to only lay out. */
  makeCanvas?: (width: number, height: number) => HTMLCanvasElement | null;
}

const browserCanvas = (width: number, height: number): HTMLCanvasElement | null => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * The astrogation map: the original's 2D drawing (astroLayout.ts, painted by astroPaint.ts) on a canvas, shown on a plane that a fixed orthographic
 * camera fills, so the session's plate and viewport code draws it as it did the 3D greybox map.
 */
export function createAstroScene(options: AstroSceneOptions = {}): AstroScene {
  const scene = new Scene();
  scene.background = new Color(0x0a0d14);
  const camera = new OrthographicCamera(-WINDOW_ASPECT, WINDOW_ASPECT, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const width = MAP_WINDOW.width * PIXEL_SCALE, height = MAP_WINDOW.height * PIXEL_SCALE;
  const canvas = (options.makeCanvas ?? browserCanvas)(width, height);
  const ctx = (canvas?.getContext('2d') ?? null) as (Paint2D & { putImageData(d: unknown, x: number, y: number): void }) | null;
  const texture = canvas ? new CanvasTexture(canvas) : null;
  if (texture) {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
  }
  const plane = new Mesh(new PlaneGeometry(2 * WINDOW_ASPECT, 2), new MeshBasicMaterial({ ...(texture ? { map: texture } : { color: 0x000000 }), toneMapped: false }));
  scene.add(plane);

  let art: AstroMapArt | undefined;
  const images = new Map<string, HTMLImageElement>();
  let artVersion = 0;
  let aspect = WINDOW_ASPECT;
  let zoomed = 1;
  let last: MapLayout = { commands: [], entries: [], shown: false, name: '' };
  let lastKey = '';
  const browserMeasure = ctx ? measurer(ctx) : undefined;
  let fonts: AstroFonts | null = null;
  // (with the game's fonts the layout measures with them, as the original's drawMapText and the labels do, and the text is their pictures)
  const measure = (font: MapFont, text: string): number => {
    const f = fonts?.fonts[ASTRO_FONT[font]];
    return f ? f.stringWidth(text) : browserMeasure ? browserMeasure(font, text) : 0;
  };
  const pictures = new Map<string, PaintSprite>();
  const picture = (font: MapFont, text: string, colour: string): PaintSprite | undefined => {
    const f = fonts?.fonts[ASTRO_FONT[font]];
    if (!fonts || !f) return undefined;
    const key = `${font}|${colour}|${text}`;
    let found = pictures.get(key);
    if (!found) {
      const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
      const image = textImage(f, text, fonts.palette, rgb ? [parseInt(rgb[1]!, 16), parseInt(rgb[2]!, 16), parseInt(rgb[3]!, 16)] : 0xff);
      const canvas = (options.makeCanvas ?? browserCanvas)(image.width, image.height);
      const g = canvas?.getContext('2d');
      if (!canvas || !g) return undefined;
      g.putImageData(new ImageData(image.data as never, image.width, image.height), 0, 0);
      found = { image: canvas, width: image.width, height: image.height };
      pictures.set(key, found);
    }
    return found;
  };

  /** A picture by name: loaded on first use (the map shows a shape until it is there, or nothing if it is on its way). */
  const sprite = (name: string): PaintSprite | undefined => {
    if (!art) return undefined;
    const found = art.sprite(name);
    let img = images.get(name);
    if (!img) {
      img = new Image();
      img.onload = () => { artVersion++; };
      img.src = found.url;
      images.set(name, img);
    }
    return { image: img.complete && img.naturalWidth > 0 ? img : null, width: found.width, height: found.height };
  };

  // (what the window shows of the viewport: the whole plane, with the camera's frustum widened on the longer side)
  const frame = (): { halfW: number; halfH: number } => (aspect >= WINDOW_ASPECT ? { halfW: aspect, halfH: 1 } : { halfW: WINDOW_ASPECT, halfH: WINDOW_ASPECT / aspect });
  const toMap = (x: number, y: number): { x: number; y: number } | null => {
    const { halfW, halfH } = frame();
    const u = (x * halfW) / (2 * WINDOW_ASPECT) + 0.5, v = 0.5 - (y * halfH) / 2;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { x: MAP_WINDOW.x + u * MAP_WINDOW.width, y: MAP_WINDOW.y + v * MAP_WINDOW.height };
  };

  return {
    scene, camera,
    update(input, ticks) {
      last = layoutMap({ ...input, zoom: zoomed, ...(ctx || fonts ? { measure } : {}) });
      if (!ctx || !texture) return;
      const hasGlobe = last.commands.some(c => c.kind === 'globe');
      const key = `${JSON.stringify(last.commands)}|${hasGlobe ? ticks >> 4 : ''}|${artVersion}`;
      if (key === lastKey) return;
      lastKey = key;
      paintMap(ctx, last, {
        scale: PIXEL_SCALE, ticks, sprite, ...(fonts ? { text: picture } : {}),
        makeCanvas: (w, h) => { const c = (options.makeCanvas ?? browserCanvas)(w, h); return c as never; },
        makeImageData: (data, w, h) => new ImageData(data as never, w, h),
      });
      texture.needsUpdate = true;
    },
    layout: () => last,
    setArt(next) {
      if (next === art) return;
      art = next;
      images.clear();
      artVersion++;
    },
    setFonts(next) {
      if (next === fonts) return;
      fonts = next;
      pictures.clear();
      artVersion++;
    },
    setBackground: hex => { (scene.background as Color).setHex(hex); },
    entryAtNdc(x, y) {
      const p = toMap(x, y);
      return p ? entryAt(last, p.x, p.y) : -1;
    },
    toMapPoint: toMap,
    ndcOf(entry) {
      const { halfW, halfH } = frame();
      const u = (entry.x - MAP_WINDOW.x) / MAP_WINDOW.width, v = (entry.y - MAP_WINDOW.y) / MAP_WINDOW.height;
      return { x: ((u - 0.5) * 2 * WINDOW_ASPECT) / halfW, y: ((0.5 - v) * 2) / halfH };
    },
    setAspect(next) {
      if (!(next > 0) || next === aspect) return;
      aspect = next;
      const { halfW, halfH } = frame();
      camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
      camera.updateProjectionMatrix();
    },
    zoom(factor) { zoomed = Math.max(0.1, Math.min(3, zoomed * factor)); },
    zoomFactor: () => zoomed,
  };
}
