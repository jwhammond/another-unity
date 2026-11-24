// SPDX-License-Identifier: GPL-3.0-or-later
import { CanvasTexture, LinearFilter, SRGBColorSpace, Texture, TextureLoader, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AssetIndex } from './assets';
import type { PresentationConfig } from './package';
import type { LayerStrip } from './layerAnim';
import type { BeamColours, Muzzle } from './phaserFx';
import { layerMode } from './layerMemory';
import { textureLedger } from './textureMemory';

/** URLs of one room's art layers (R9). */
export interface RoomArtUrls {
  plate?: string;
  depth?: string;
  normal?: string;
  gltf?: string;
  masks?: MaskUrl[];
}
/** One occlusion layer: its image's URL, where the original draws it ([x, y, w, h]) and the row it is sorted by. */
export interface MaskUrl {
  object: string;
  url: string;
  rect: [number, number, number, number];
  depth: number;
  /** A prop's card, not a cut of the plate. */
  card?: boolean;
  /** Where a phaser aims at it ([x, y] in the original's pixels): the sprite's own aim point. Without it the shot aims at the middle of `rect`. */
  aim?: [number, number];
  /** Where the object stood at the start ([x, y] in the original's pixels, null on an axis the sprite has its own position for): what a move of the object is measured from. */
  home?: [number | null, number | null];
  /** What it plays while its object replies, and the animation it goes back to after the line (-1: it stays on the talk animation). */
  talk?: { anim: number; idle: number };
  /** An animated prop: the animation its object starts on (its still `url` is that animation's first frame), and the strips it draws by animation. */
  anim?: number;
  strips?: Record<number, LayerStrip & { url: string; urls?: string[]; of?: number[] }>;
}
export interface RoomMask extends Omit<MaskUrl, 'url' | 'strips'> {
  texture: Texture;
  /**
   * The animation strips that loaded; an animation with none is drawn as the still. A grid strip is a texture (`texture`, `textures`); an atlas is not uploaded:
   * its pages are `data`, the bytes as fetched, and the stage decodes the cell it needs into the layer's own texture (Batch 8c).
   */
  strips?: Record<number, LayerStrip & { texture?: Texture; textures?: Texture[]; data?: PageData[] }>;
  /** The mask's alpha at the original's pixels over its rect (w x h, row by row), where the page could read it: what hides a name tag. */
  alpha: Uint8Array | null;
}
/** One animation of a card: a strip of equal cells (R8), by the original's animation index. */
export interface CardAnim {
  url: string;
  frames: number;
  /** Cells to a row of the image; the image wraps into rows when it is wide. */
  columns?: number;
  /** Card pixels to the original's: 4 when it isn't given (the away team's cards), 1 for a strip of the sprite's own pixels. */
  scale?: number;
  /** One cell in card pixels. */
  cell: [number, number];
  /** The feet, in fractions of a cell. */
  anchor: [number, number];
  /** Milliseconds each frame shows. */
  delays: number[];
  loop: boolean;
  /** The animation it falls into when it ends. */
  next?: number;
}
/** A crew member's card: its still, and when it has them, its animations. */
export interface CardArt {
  url: string;
  frames: number;
  anchor: [number, number];
  /** The standing frame's height in the original's pixels (R9); a card without one is drawn ACTOR_HEIGHT tall. */
  pixelHeight?: number;
  anims?: Record<number, CardAnim>;
}
/** How a phaser shot is drawn (presentation.art.phaser). */
export interface PhaserArt {
  /** By crew member (`crew`'s order) and direction (12 each): where the beam leaves the sprite. */
  muzzles: Muzzle[];
  /** The crew the muzzles go by: the first ten objects of the ship world. */
  crew: string[];
  colours: BeamColours;
}
export interface ArtSource {
  room(screen: string): RoomArtUrls | undefined;
  card(object: string): CardArt | undefined;
  /** How a phaser shot is drawn, where the package has it. */
  phaser?(): PhaserArt | undefined;
}

/** A plate's half-resolution variant: `plate.webp` is also published as `plate.half.webp` (1280x960 for 2560x1920), which phones load. */
export function halfPath(path: string): string | undefined {
  return /\/plate\.webp$/.test(path) ? path.replace(/plate\.webp$/, 'plate.half.webp') : undefined;
}

/** The URL of a plate's half-resolution variant, when the game was published with one; undefined for any other file. */
export function halfResUrl(path: string, assets: AssetIndex): string | undefined {
  const half = halfPath(path);
  return half === undefined ? undefined : assets.url(half);
}

/** Resolves presentation.art's paths through the asset index; a path the index lacks warns once and is left out. */
export function artFromPresentation(config: PresentationConfig, assets: AssetIndex, warn: (message: string) => void = () => {}, opts: { lowRes?: boolean } = {}): ArtSource {
  const warned = new Set<string>();
  const resolve = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    const url = (opts.lowRes ? halfResUrl(path, assets) : undefined) ?? assets.url(path);
    if (url === undefined && !warned.has(path)) {
      warned.add(path);
      warn(`art file ${path} is not there: using greybox`);
    }
    return url;
  };
  const rooms = new Map<string, RoomArtUrls>();
  for (const [screen, r] of Object.entries(config.art.rooms)) {
    const urls: RoomArtUrls = {};
    for (const key of ['plate', 'depth', 'normal', 'gltf'] as const) {
      const url = resolve(r[key]);
      if (url !== undefined) urls[key] = url;
    }
    const masks: MaskUrl[] = [];
    for (const m of r.masks) {
      const url = resolve(m.image);
      if (url === undefined) continue;
      const strips: NonNullable<MaskUrl['strips']> = {};
      for (const [anim, a] of Object.entries(m.strips ?? {})) {
        // (an atlas has several pages: one that is missing leaves the strip out, and the layer draws the still; one of clear cells has none, and draws nothing)
        const pageUrls = a.images?.map(resolve);
        const stripUrl = pageUrls ? (pageUrls.every(u => u !== undefined) ? (pageUrls[0] ?? '') : undefined) : resolve(a.image);
        if (stripUrl !== undefined) strips[Number(anim)] = { url: stripUrl, ...(pageUrls ? { urls: pageUrls as string[], cell: a.cell, ...(a.pages ? { pages: a.pages } : {}), ...(a.cells ? { cells: a.cells } : {}) } : {}), frames: a.frames, ...(a.of ? { of: a.of } : {}), ...(a.columns !== undefined ? { columns: a.columns } : {}), delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}), rect: a.rect };
      }
      masks.push({ object: m.object, url, rect: m.rect, depth: m.depth, ...(m.card ? { card: true } : {}), ...(m.aim ? { aim: m.aim } : {}), ...(m.home ? { home: m.home } : {}), ...(m.talk ? { talk: m.talk } : {}), ...(m.anim !== undefined ? { anim: m.anim } : {}), ...(Object.keys(strips).length > 0 ? { strips } : {}) });
    }
    if (masks.length > 0) urls.masks = masks;
    rooms.set(screen, urls);
  }
  const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  return {
    room: screen => rooms.get(screen),
    phaser: () => {
      const p = config.art.phaser;
      if (!p) return undefined;
      return {
        muzzles: p.muzzles.map(([x, y, frame]) => ({ x, y, frame })),
        crew: p.crew,
        colours: { beam: hex(p.colours.beam), beamEdge: hex(p.colours.beamEdge), pulse: hex(p.colours.pulse), pulseEdge: hex(p.colours.pulseEdge) },
      };
    },
    card: object => {
      const c = config.art.cards[object];
      const url = c && resolve(c.image);
      if (!c || url === undefined) return undefined;
      const anims: Record<number, CardAnim> = {};
      for (const [index, a] of Object.entries(c.anims)) {
        const animUrl = resolve(a.image);
        if (animUrl !== undefined) anims[Number(index)] = { url: animUrl, frames: a.frames, ...(a.columns !== undefined ? { columns: a.columns } : {}), ...(a.scale !== undefined ? { scale: a.scale } : {}), cell: a.cell, anchor: a.anchor, delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}) };
      }
      return {
        url, frames: c.frames, anchor: c.anchor,
        ...(c.pixelHeight !== undefined ? { pixelHeight: c.pixelHeight } : {}),
        ...(Object.keys(anims).length > 0 ? { anims } : {}),
      };
    },
  };
}

/** A mask image's alpha channel at w x h (the original's pixels), through a canvas; null where there isn't one to draw on. */
export function maskAlpha(texture: Texture, w: number, h: number): Uint8Array | null {
  const image = texture.image as CanvasImageSource | undefined;
  if (!image || typeof document === 'undefined' || w <= 0 || h <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, w, h);
    const data = context.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]!;
    return out;
  } catch {
    return null;
  }
}

/** A decoded cell of an atlas page: what the layer's surface draws, and what must be closed when the ring lets go of it. */
export interface CellBitmap {
  close(): void;
}
/** An atlas page kept as its encoded bytes: `crop` decodes one rectangle of it (x, y, w, h in the page's pixels). */
export interface PageData {
  /** The encoded size in bytes: what the page costs while it is resident. */
  bytes: number;
  crop(x: number, y: number, w: number, h: number): Promise<CellBitmap>;
}
/** A layer's one texture, as big as its largest cell: `draw` replaces its picture with a decoded cell (at the top left) and has it uploaded. */
export interface LayerSurface {
  texture: Texture;
  draw(cell: CellBitmap): void;
  dispose(): void;
}

export interface ArtLoaders {
  /** An atlas page's bytes (default: fetch it); decoding is `crop`'s (default: createImageBitmap of the rectangle). */
  page?(url: string): Promise<PageData>;
  /** The texture a layer's cells are drawn into, w x h (default: a canvas texture, no mips). */
  surface?(width: number, height: number, name: string): LayerSurface;
  /** `color` is true for what is looked at (plates, cards), false for data (depth, normal). */
  texture(url: string, color: boolean): Promise<Texture>;
  model(url: string): Promise<Object3D>;
  /** A mask's alpha at w x h (tests give their own); maskAlpha if absent. */
  alpha?(texture: Texture, w: number, h: number): Uint8Array | null;
}

/**
 * A pack's picture (Plan 30) decoded at `size` into a colour texture, counted in the texture ledger: flipped as TextureLoader's are
 * (a sprite sheet) or not, as glTF's (a model's texture). The browser's decoder resizes it (a low resolution's half).
 */
export async function imageTexture(bytes: Uint8Array, type: string, size: [number, number], o: { name: string; flipY: boolean }): Promise<Texture> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }), {
    resizeWidth: size[0], resizeHeight: size[1], resizeQuality: 'high', imageOrientation: o.flipY ? 'flipY' : 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  const t = new Texture(bitmap as unknown as HTMLImageElement);
  t.name = o.name;
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return textureLedger.track(t, o.name);
}

/** A pack's picture decoded at `size` for the console's art layer (Plan 30 R7): an ImageBitmap, not a texture. */
export function artPicture(bytes: Uint8Array, type: string, size: [number, number]): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as BlobPart], { type }), { resizeWidth: size[0], resizeHeight: size[1], resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** A page fetched as a Blob and kept so; a cell is cut out of it by the browser's decoder, off the main thread. */
export async function fetchPage(url: string): Promise<PageData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const blob = await response.blob();
  return { bytes: blob.size, crop: (x, y, w, h) => createImageBitmap(blob, x, y, w, h) };
}

/** A canvas of the layer's largest cell, as a texture with no mip chain: a cell is drawn on it and the texture re-uploaded (three updates the part it has already allocated). */
export function canvasSurface(width: number, height: number, name: string): LayerSurface {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas to stage the frames on');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  textureLedger.track(texture, name);
  return {
    texture,
    draw: cell => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(cell as unknown as ImageBitmap, 0, 0);
      texture.needsUpdate = true;
    },
    dispose: () => {
      texture.dispose();
      // (the canvas's backing store goes with the last reference to it; a size of 0 lets the browser have it at once)
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

export const defaultLoaders: ArtLoaders = {
  page: fetchPage,
  surface: canvasSurface,
  texture: async (url, color) => {
    const texture = await new TextureLoader().loadAsync(url);
    if (color) texture.colorSpace = SRGBColorSpace;
    return textureLedger.track(texture, url);
  },
  model: async url => (await new GLTFLoader().loadAsync(url)).scene,
};

/**
 * Loaders for a device short of memory: a colour texture that is not a plate (a card's still or strip, a mask) is never drawn
 * smaller than it is, so it gets no mip chain, a third less memory for the same picture. Plates are shown smaller and keep theirs.
 */
export function leanLoaders(base: ArtLoaders): ArtLoaders {
  return {
    ...base,
    texture: async (url, color) => {
      const texture = await base.texture(url, color);
      if (color && !/plate(\.half)?\.webp$/.test(url)) {
        texture.generateMipmaps = false;
        texture.minFilter = LinearFilter;
      }
      return texture;
    },
  };
}

export interface RoomArt {
  plate: Texture | null;
  depth: Texture | null;
  normal: Texture | null;
  model: Object3D | null;
  /** The ones that loaded (a mask that fails warns and is left out). */
  masks: RoomMask[];
}

export const noArt = (): RoomArt => ({ plate: null, depth: null, normal: null, model: null, masks: [] });

/** Loads what's there; each layer that fails warns and is null (R9). */
export async function loadRoomArt(urls: RoomArtUrls, loaders: ArtLoaders, warn: (message: string) => void, onItem?: (done: number, total: number) => void): Promise<RoomArt> {
  // (the files there are to load, and how many have been: `onItem` is how a loading screen sees inside this one await)
  const total = [urls.plate, urls.depth, urls.normal, urls.gltf].filter(u => u !== undefined).length + (urls.masks?.length ?? 0) + (urls.masks ?? []).reduce((n, m) => n + Object.keys(m.strips ?? {}).length, 0);
  let done = 0;
  const attempt = async <T>(what: string, url: string | undefined, load: (u: string) => Promise<T>): Promise<T | null> => {
    if (url === undefined) return null;
    try {
      return await load(url);
    } catch (err) {
      warn(`could not load the ${what} (${err instanceof Error ? err.message : String(err)}): using greybox`);
      return null;
    } finally {
      onItem?.(++done, total);
    }
  };
  // (two layers on one card's strip share its texture: it is loaded once; a page of an atlas is fetched once and kept as bytes)
  const strips = new Map<string, Promise<Texture>>();
  const pages = new Map<string, Promise<PageData>>();
  // (every file is asked for at once, the masks and their strips beside the plate: one after another, a room's art took as long as all its files' round trips, B5)
  const loadMask = async (m: NonNullable<RoomArtUrls['masks']>[number]): Promise<RoomMask | null> => {
    const texture = await attempt(`mask of ${m.object}`, m.url, u => loaders.texture(u, true));
    if (!texture) return null;
    const loadedStrips: NonNullable<RoomMask['strips']> = {};
    // (per layer, whichever of streaming and uploading the pages whole costs less: `layerMemory`'s call, as `art masks` budgets it)
    const mode = layerMode(Object.values(m.strips ?? {}).flatMap(s => (s.urls && s.cells && s.pages ? [{ cells: s.cells, pages: s.pages, files: s.urls }] : [])));
    await Promise.all(Object.entries(m.strips ?? {}).map(async ([anim, { url, urls: pageUrls, ...strip }]) => {
      const shared = (u: string): Promise<Texture> => {
        if (!strips.has(u)) strips.set(u, loaders.texture(u, true));
        return strips.get(u)!;
      };
      const sharedPage = (u: string): Promise<PageData> => {
        if (!pages.has(u)) pages.set(u, (loaders.page ?? fetchPage)(u));
        return pages.get(u)!;
      };
      if (pageUrls && strip.cells && strip.pages && mode === 'stream') {
        // (an atlas is all its pages or none: a layer with one page missing would draw holes; a layer whose pages cost less whole takes the texture path below)
        const data = await attempt(`strip of ${m.object}, animation ${anim}`, url, async () => {
          const all = await Promise.allSettled(pageUrls.map(sharedPage));
          const bad = all.find((r): r is PromiseRejectedResult => r.status === 'rejected');
          if (bad) throw bad.reason;
          return all.map(r => (r as PromiseFulfilledResult<PageData>).value);
        });
        if (data) loadedStrips[Number(anim)] = { ...strip, data };
        return;
      }
      const t = await attempt(`strip of ${m.object}, animation ${anim}`, url, async () => {
        const all = await Promise.allSettled((pageUrls ?? [url]).map(shared));
        const bad = all.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (bad) {
          for (const r of all) if (r.status === 'fulfilled') r.value.dispose();
          throw bad.reason;
        }
        return all.map(r => (r as PromiseFulfilledResult<Texture>).value);
      });
      if (t) loadedStrips[Number(anim)] = { ...strip, texture: t[0]!, textures: t };
    }));
    return { object: m.object, texture, rect: m.rect, depth: m.depth, ...(m.card ? { card: true } : {}), ...(m.aim ? { aim: m.aim } : {}), ...(m.home ? { home: m.home } : {}), ...(m.talk ? { talk: m.talk } : {}), ...(m.anim !== undefined ? { anim: m.anim } : {}), ...(Object.keys(loadedStrips).length > 0 ? { strips: loadedStrips } : {}), alpha: (loaders.alpha ?? maskAlpha)(texture, Math.round(m.rect[2]), Math.round(m.rect[3])) };
  };
  const [plate, depth, normal, model, masks] = await Promise.all([
    attempt('plate', urls.plate, u => loaders.texture(u, true)),
    attempt('depth map', urls.depth, u => loaders.texture(u, false)),
    attempt('normal map', urls.normal, u => loaders.texture(u, false)),
    attempt('art model', urls.gltf, u => loaders.model(u)),
    Promise.all((urls.masks ?? []).map(loadMask)).then(all => all.filter((m): m is RoomMask => m !== null)),
  ]);
  return { plate, depth, normal, model, masks };
}

/** Frees the GPU side of a room's art: its textures, and the model's geometry, materials and textures. */
export function disposeRoomArt(art: RoomArt): void {
  art.plate?.dispose();
  art.depth?.dispose();
  art.normal?.dispose();
  const freed = new Set<Texture>();
  for (const m of art.masks) {
    m.texture.dispose();
    for (const s of Object.values(m.strips ?? {})) {
      for (const t of s.textures ?? []) {
        if (!freed.has(t)) t.dispose();
        freed.add(t);
      }
    }
  }
  art.model?.traverse(node => {
    const { geometry, material } = node as { geometry?: { dispose(): void }; material?: unknown };
    geometry?.dispose();
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m as object)) if (value instanceof Texture) value.dispose();
      (m as { dispose(): void }).dispose();
    }
  });
}

export type Rect = [number, number, number, number];
/** What a ship station is drawn from (R14): a repainted plate with its areas and crew, or a 3D set's glb, its camera node and its viewscreen mesh. */
export type ShipArt =
  | { kind: 'plate'; plate: string; window?: string; areas: Record<string, Rect>; crew: { object: string; at: [number, number]; depth: number }[] }
  | { kind: 'set'; gltf: string; camera: string; viewscreen?: string };
export type ShipStation = keyof PresentationConfig['art']['ship'];

/**
 * Resolves presentation.art.ship through the asset index. The plate wins, unless `set3d` is on and the entry has a glb; without `set3d` an entry with no plate is the flat panel. A file the
 * index lacks warns once and the station has no art (the flat panel stays).
 */
export function shipArtFromPresentation(config: PresentationConfig, assets: AssetIndex, warn: (message: string) => void = () => {}, opts: { set3d?: boolean; lowRes?: boolean } = {}): (station: string) => ShipArt | undefined {
  const warned = new Set<string>();
  const url = (path: string): string | undefined => {
    const found = (opts.lowRes ? halfResUrl(path, assets) : undefined) ?? assets.url(path);
    if (found === undefined && !warned.has(path)) {
      warned.add(path);
      warn(`art file ${path} is not there: using the flat panel`);
    }
    return found;
  };
  return station => {
    const entry = (config.art.ship as Record<string, PresentationConfig['art']['ship'][ShipStation]>)[station];
    if (!entry) return undefined;
    if (entry.gltf !== undefined && opts.set3d === true) {
      const gltf = url(entry.gltf);
      if (gltf === undefined) return undefined;
      return { kind: 'set', gltf, camera: entry.camera, ...(entry.viewscreen !== undefined ? { viewscreen: entry.viewscreen } : {}) };
    }
    // (the 3D set is dev-only: a glb with no plate is the flat panel until the flag is on)
    if (entry.plate === undefined) return undefined;
    const plate = url(entry.plate);
    if (plate === undefined) return undefined;
    // (a window layer that is missing warns and is left out: the plate still draws)
    const window = entry.window !== undefined ? url(entry.window) : undefined;
    return { kind: 'plate', plate, ...(window !== undefined ? { window } : {}), areas: entry.areas as Record<string, Rect>, crew: entry.crew as { object: string; at: [number, number]; depth: number }[] };
  };
}
