// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { alphaAt } from './card';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { unpackCell } from './atlas';
import { layerResident, type LayerMode, type ResidentStrip } from '../../../engine/src/view/layerMemory';
import type { StripLayout } from './layer';
import { readWebp, toWebp, webpSize } from './webp';

/** [x, y, w, h] in the original's pixels. */
export type MaskRect = [number, number, number, number];

/** A plate is the original at this scale (2560x1920 over 640x480). */
const SCALE = 4;
const QUALITY = 90;

/**
 * Cuts the plate by the mask sprite's alpha at rect x4: the sprite's alpha is upscaled 4x the way a card's is (bilinear,
 * smoothstep over 0.25..0.75, so the edge stays crisp), and the colours are the plate's own. What lies outside the
 * plate is clear.
 */
export function cutMask(plate: Rgba, maskFrame: Rgba, rect: MaskRect): Rgba {
  const [rx, ry, rw, rh] = rect;
  const width = rw * SCALE;
  const height = rh * SCALE;
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const py = ry * SCALE + y;
    for (let x = 0; x < width; x++) {
      const px = rx * SCALE + x;
      if (px < 0 || py < 0 || px >= plate.width || py >= plate.height) continue;
      const s = (py * plate.width + px) * 4;
      const o = (y * width + x) * 4;
      out.data[o] = plate.data[s]!;
      out.data[o + 1] = plate.data[s + 1]!;
      out.data[o + 2] = plate.data[s + 2]!;
      out.data[o + 3] = alphaAt(maskFrame, (x + 0.5) / SCALE - 0.5, (y + 0.5) / SCALE - 0.5);
    }
  }
  return out;
}

/**
 * Where the original draws a sprite frame (graphics.cpp drawSprite, at scale 256): the sprite's own position (POSN)
 * replaces the object's on each axis where it isn't 0; left is the middle less half the width (integer division) and
 * top is the foot row less the height.
 */
export function maskRect(object: { x: number; y: number }, sprite: { x: number; y: number } | undefined, width: number, height: number): MaskRect {
  const x = sprite && sprite.x !== 0 ? sprite.x : object.x;
  const y = sprite && sprite.y !== 0 ? sprite.y : object.y;
  return [x - Math.trunc(width / 2), y - height, width, height];
}

export interface MaskObject {
  /** The object's id in the game. */
  object: string;
  sprite: string;
  /** The first frame's PNG. */
  frame: string;
  rect: MaskRect;
  /** Where the sprite's origin is in the room (its own position where it has one, else the object's): what its frames are placed from. */
  origin: [number, number];
  /** The row the original sorts it by: y_adjust if the object has one, else its y (unity.cpp DrawOrderComparison). */
  depth: number;
  /** The raw objwalktype: 1 is drawn at the floor's scale where it stands, as a walker is (unity.cpp objectScale). */
  walkType: number;
  /**
   * Where the object stands at the start, on each axis the original draws it by (the sprite's own position, where it has one, replaces the object's, and then the
   * object's moves change nothing: null). What a layer is moved from when a rule moves the object.
   */
  home?: [number | null, number | null];
  /** Where a phaser aims at the sprite, from its origin: the animation's `mouthPos` entry (SpritePlayer::getTargetPoint), where it has one that is not 0, 0. */
  mouth?: [number, number];
}

interface SpriteJson {
  anims?: number[];
  entries: { type: string; width?: number; height?: number; png?: string; x?: number; y?: number }[];
}
interface RawObject {
  id: string;
  curr_screen: number;
  x: number;
  y: number;
  y_adjust: number;
  sprite_id: number;
  objwalktype?: number;
}

/** Whether an animation is one still frame (a sprite and nothing that changes it before it pauses). */
function isStill(entries: SpriteJson['entries']): boolean {
  const end = entries.findIndex(e => e.type === 'pause' || e.type === 'exit');
  return entries.slice(0, end < 0 ? undefined : end).filter(e => e.type === 'sprite').length === 1;
}

/**
 * The screen's objects whose sprite is a mask (its first entry says `mask`): from the raw export's objects and sprite
 * names, the images export's sprite files and the game's ids. Sorted by raw id.
 *
 * Some masks are not marked: Mertens' cable masks, Frigis' pillar and pyramid masks are one still frame the original draws over
 * the actors like the marked ones. They are taken when the object is named for a mask, the sprite is a single still and no other
 * object on the screen draws the same sprite (a force field's "mask" is its animation).
 */
export async function findMasks(dirs: { rawDir: string; imagesDir: string; gameDir: string }, screen: string): Promise<MaskObject[]> {
  const marked = await findSpriteObjects(dirs, screen, (_slug, json) => json.entries.some(e => e.type === 'mask'));
  const named = await findSpriteObjects(dirs, screen, (slug, json) => /(^|[._])mask|mask($|[._\d])/.test(slug) && !json.entries.some(e => e.type === 'mask') && isStill(json.entries));
  if (named.length === 0) return marked;
  const all = await findSpriteObjects(dirs, screen, () => true);
  const uses = (sprite: string): number => all.filter(o => o.sprite === sprite).length;
  const keep = new Set([...marked.map(o => o.object), ...named.filter(o => uses(o.sprite) === 1).map(o => o.object)]);
  return all.filter(o => keep.has(o.object));
}

/**
 * A prop's objects on the screen (by id): where the original draws each one's sprite, whatever kind the sprite is. `anim` is the
 * animation whose still the prop shows: Mertens' cable is whole in animation 0 and cut in animation 1, the one o_040307 plays once the
 * phaser has cut it, and its frame is a different size.
 */
export async function findProps(dirs: { rawDir: string; imagesDir: string; gameDir: string }, screen: string, objects: string[], anim = 0, shared = false): Promise<MaskObject[]> {
  const want = new Set(objects);
  const found = await findSpriteObjects(dirs, screen, slug => want.has(slug), anim);
  // (a recipe shared by several rooms lists every room's objects: each room has only some of them)
  const missing = shared ? [] : objects.filter(o => !found.some(f => f.object === o));
  if (missing.length > 0) throw new Error(`${screen}: no sprite object ${missing.join(', ')}`);
  return found;
}

/**
 * The entries an animation plays up to its first pause or exit (sprite_player.cpp: an animation starts at its entry in the file's
 * list and a pause stops it). Animation 0, or a sprite file with no list, is the whole file, as the masks have always read it.
 */
export function animEntries(json: SpriteJson, anim: number): SpriteJson['entries'] {
  const start = anim > 0 ? json.anims?.[anim] : undefined;
  if (start === undefined) return json.entries;
  const rest = json.entries.slice(start);
  const end = rest.findIndex(e => e.type === 'pause' || e.type === 'exit');
  return end < 0 ? rest : rest.slice(0, end);
}

async function findSpriteObjects(dirs: { rawDir: string; imagesDir: string; gameDir: string }, screen: string, pick: (slug: string, json: SpriteJson) => boolean, anim = 0): Promise<MaskObject[]> {
  const m = /^([a-z0-9]+)\.s([0-9a-f]{2})$/.exec(screen);
  if (!m) throw new Error(`"${screen}" isn't a screen id like lab.s02`);
  const world = m[1]!;
  const number = parseInt(m[2]!, 16);
  const ids = (parseYaml(await readFile(join(dirs.gameDir, 'ids.yaml'), 'utf8')) as { objects: Record<string, string> }).objects;
  const names = (JSON.parse(await readFile(join(dirs.rawDir, 'maps', 'sprite.json'), 'utf8')) as { _spriteFilenames: string[] })._spriteFilenames;
  const files = (await readdir(join(dirs.rawDir, 'objects'))).filter(f => /^o_[0-9a-f]+\.json$/.test(f)).sort();
  const out: MaskObject[] = [];
  for (const file of files) {
    const rawId = file.slice(2, -5);
    const slug = ids[rawId];
    if (!slug || !slug.startsWith(`${world}.`)) continue;
    const o = JSON.parse(await readFile(join(dirs.rawDir, 'objects', file), 'utf8')) as RawObject;
    if (o.curr_screen !== number || o.sprite_id >= names.length) continue;
    const sprite = names[o.sprite_id]!.toLowerCase();
    let json: SpriteJson;
    try {
      json = JSON.parse(await readFile(join(dirs.imagesDir, 'images', 'sprites', `${sprite}.spr`, 'sprite.json'), 'utf8')) as SpriteJson;
    } catch {
      continue;
    }
    if (!pick(slug, json)) continue;
    const entries = animEntries(json, anim);
    const frame = entries.find(e => e.type === 'sprite' && e.png && e.width && e.height);
    if (!frame) continue;
    const position = entries.find(e => e.type === 'position');
    out.push({
      object: slug,
      sprite,
      frame: join(dirs.imagesDir, frame.png!),
      rect: maskRect(o, position ? { x: position.x ?? 0, y: position.y ?? 0 } : undefined, frame.width!, frame.height!),
      origin: [position && position.x ? position.x : o.x, position && position.y ? position.y : o.y],
      depth: o.y_adjust === -1 ? o.y : o.y_adjust,
      walkType: o.objwalktype ?? 0,
      ...mouthOf(entries),
      home: [position && position.x ? null : o.x, position && position.y ? null : o.y],
    });
  }
  return out;
}

/** The animation's phaser aim point, if it sets one: its `mouthPos` entry. */
function mouthOf(entries: SpriteJson['entries']): { mouth?: [number, number] } {
  const m = entries.find(e => e.type === 'mouthPos');
  return m && ((m.x ?? 0) !== 0 || (m.y ?? 0) !== 0) ? { mouth: [m.x ?? 0, m.y ?? 0] } : {};
}

/**
 * Where a phaser aims at a sprite (UnityEngine::phaserTarget): the sprite's origin and its aim point scaled by the object's scale, rounded as the original's
 * integers are: (point * scale + 0x80) / 256, truncated.
 */
export function aimPoint(origin: readonly [number, number], mouth: readonly [number, number], scale = 256): [number, number] {
  return [origin[0] + Math.trunc((mouth[0] * scale + 0x80) / 256), origin[1] + Math.trunc((mouth[1] * scale + 0x80) / 256)];
}

/** A prop's layer: the published card strip it copies, and where the original draws it. */
export interface PropLayer {
  object: string;
  /** The published single-cell WebP (games/unity/art/cards/<card>/<anim>.webp), the sprite's frame at 4x. */
  source: string;
  rect: MaskRect;
  depth: number;
  /** The scale (out of 256) the original draws it at: a walker-type object's is the floor's where it stands (Screen::scaleAt). Default 256. */
  scale?: number;
  /** The animation the object starts on (Batch 8: an animated layer). Its strip's first frame is the still. */
  anim?: number;
  /** Every animation whose frames are published: the strip file and where its cells lie. With these the layer draws the frame the object's animation is on. */
  strips?: PropStrip[];
  /** Where the sprite's origin is in the room and its phaser aim point from it (see `aimPoint`): published as the layer's `aim`, the point a shot at the object ends on. */
  origin?: [number, number];
  mouth?: [number, number];
  /** See MaskObject.home. */
  home?: [number | null, number | null];
  /** What it plays while it replies, and the animation it goes back to after the line (-1: it stays on the talk animation): UnityEngine::replyAnims. */
  talk?: { anim: number; idle: number };
}

/** One animation of an animated prop: its published strip and the layout the strip was packed with (`stripLayout`). */
export interface PropStrip {
  anim: number;
  source: string;
  layout: StripLayout;
}

/**
 * Where the original draws a sprite of `rect`'s size at `scale` (Graphics::drawSprite): the size is the integer share of the frame, and
 * it stays centred on the same column and standing on the same row.
 */
export function scaledRect(rect: MaskRect, scale: number): MaskRect {
  if (scale >= 256) return rect;
  const [x, y, w, h] = rect;
  const cx = x + Math.trunc(w / 2);
  const bottom = y + h;
  return [cx - Math.trunc((Math.trunc(w / 2) * scale) / 256), bottom - Math.trunc((h * scale) / 256), Math.trunc((w * scale) / 256), Math.trunc((h * scale) / 256)];
}

/**
 * A rectangle as the original draws it at `scale` (out of 256): every point keeps the same share of its distance from the sprite's origin, so a layer's cell, which is
 * the union of its frames' rectangles, shrinks as one picture and each frame stays where it is inside it. The picture itself is drawn into the smaller rectangle as it is.
 */
export function scaledAbout(rect: MaskRect, origin: readonly [number, number], scale: number): MaskRect {
  if (scale >= 256) return rect;
  const k = scale / 256;
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const [x, y, w, h] = rect;
  return [r2(origin[0] + (x - origin[0]) * k), r2(origin[1] + (y - origin[1]) * k), r2(w * k), r2(h * k)];
}

/** A rectangle of an image, in its pixels. */
function crop(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let row = 0; row < h; row++) out.data.set(img.data.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4), row * w * 4);
  return out;
}

/**
 * What a room's animated layers may keep resident, in bytes (Batch 8c): their atlas pages as the WebP bytes they are fetched as (each file once), and per layer
 * its one texture and staging canvas (the largest cell, twice) and a ring of decoded cells (`layerResident`). A lean phone has a few hundred MB for
 * everything; the room's plate, its depth and normal maps and the crew's cards come first, so the layers get a quarter of a 256 MB device. `art masks` warns
 * over it (docs/unity-sprite-placement.md, "Batch 8b" and "Batch 8c").
 */
export const STRIP_BUDGET_BYTES = 64 * 1024 * 1024;

/** What `publishMasks` reports for a room: what its animated layers keep resident, and the budget. */
export interface StripReport {
  screen: string;
  bytes: number;
  /** Of `bytes`: the encoded pages (each file once). */
  encoded: number;
  budget: number;
  over: boolean;
  /** Per animated object: its resident bytes (its own pages included, so two layers sharing a page each show it). */
  objects: { object: string; bytes: number; mode?: LayerMode }[];
}

/** `objects` carry what each holds beyond its files (`extra`) and with them (`bytes`); `files` are the encoded sizes of the room's pages, each once. */
export function stripReport(screen: string, objects: { object: string; bytes: number; extra?: number; mode?: LayerMode }[], files: Map<string, number>, budget = STRIP_BUDGET_BYTES, decoded: Map<string, number> = new Map()): StripReport {
  // (`files` are the pages streamed layers keep as encoded bytes; `decoded` the pages whole layers upload, each file once)
  const encoded = [...files.values()].reduce((a, b) => a + b, 0);
  const bytes = encoded + [...decoded.values()].reduce((a, b) => a + b, 0) + objects.reduce((n, o) => n + (o.extra ?? o.bytes), 0);
  return { screen, bytes, encoded, budget, over: bytes > budget, objects: objects.map(o => ({ object: o.object, bytes: o.bytes, ...(o.mode ? { mode: o.mode } : {}) })) };
}

export interface MaskDeps {
  /** Told, for a room with animated layers, how much its strips take decoded (and whether that is over the budget). */
  report?: (report: StripReport) => void;
  budget?: number;
  /** Default: Homebrew's cwebp, quality 90 with lossless alpha (-alpha_q 100 -exact). */
  encode?: (png: string, out: string) => Promise<void>;
  /** Default: Homebrew's dwebp. A published WebP's pixels (an animated prop's still is cut from its strip). */
  read?: (webp: string) => Promise<Rgba>;
}

/**
 * Cuts each mask from the plate and writes games/unity/art/rooms/<world>/<sNN>/mask.<object>.webp, then sets
 * art.rooms[screen].masks in presentation.yaml in place (the plate and every other key stay). Returns the files.
 */
export async function publishMasks(gameDir: string, screen: string, plate: Rgba, masks: MaskObject[], deps: MaskDeps = {}, props: PropLayer[] = []): Promise<string[]> {
  const m = /^([a-z0-9]+)\.(s[0-9a-f]{2})$/.exec(screen);
  if (!m) throw new Error(`"${screen}" isn't a screen id like lab.s02`);
  const rel = `art/rooms/${m[1]}/${m[2]}`;
  await mkdir(join(gameDir, rel), { recursive: true });
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: QUALITY, alpha: true }));
  const work = await mkdtemp(join(tmpdir(), 'mask-'));
  const entries: { object: string; image: string; rect: MaskRect; depth: number; card?: boolean; aim?: [number, number]; home?: [number | null, number | null]; talk?: { anim: number; idle: number }; anim?: number; strips?: Record<string, unknown> }[] = [];
  const read = deps.read ?? readWebp;
  const files = new Map<string, number>();
  // (what the room holds: the streamed layers' files encoded, the whole layers' pages decoded; each file once)
  const streamed = new Set<string>();
  const decoded = new Map<string, number>();
  const perObject: { object: string; bytes: number; extra?: number; mode?: LayerMode }[] = [];
  try {
    // (an object a prop draws is not cut from the plate as well: both would be mask.<object>.webp, and two entries for one object leave the
    // stage a quad it does not track, drawn in every room after; Mertens' cable masks are such sprites, the cable itself, with cards)
    for (const mask of masks.filter(m => !props.some(p => p.object === m.object))) {
      const cut = cutMask(plate, decodePng(new Uint8Array(await readFile(mask.frame))), mask.rect);
      const png = join(work, 'cut.png');
      await writeFile(png, encodePng(cut));
      const image = `${rel}/mask.${mask.object}.webp`;
      await encode(png, join(gameDir, image));
      entries.push({ object: mask.object, image, rect: mask.rect, depth: mask.depth });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // (a prop is drawn in a mask's place, but its picture is the repainted sprite, not the plate)
  for (const p of props) {
    const image = `${rel}/mask.${p.object}.webp`;
    if (p.strips && p.strips.length > 0) {
      // (drawn at a scale that leaves under a pixel, as an object at the floor's vanishing end: the original shows nothing of it, so there is no layer to keep)
      const small = scaledRect(p.rect, p.scale ?? 256);
      if (small[2] < 1 || small[3] < 1) continue;
      // an animated prop: the still (the first frame of the animation it starts on) is the fallback, and each animation's strip is the card's own file
      const start = p.anim ?? p.strips[0]!.anim;
      const strips: Record<string, unknown> = {};
      let still: Rgba | null = null;
      const resident: ResidentStrip[] = [];
      const own = new Set<string>();
      const at = (r: MaskRect): MaskRect => (p.scale !== undefined && p.scale < 256 ? scaledAbout(r, p.origin ?? [r[0] + r[2] / 2, r[1] + r[3]], p.scale) : r);
      for (const { anim, source, layout } of [...p.strips].sort((a, b) => a.anim - b.anim)) {
        const mine = layout.atlas
          ? await (async () => {
              // an atlas: its pages are what is published, each as big as the pack says
              const pages: Rgba[] = [];
              for (const [i, image] of layout.atlas!.images.entries()) {
                const page = await read(join(gameDir, image));
                const [w, h] = layout.atlas!.pages[i]!;
                if (page.width !== w || page.height !== h) throw new Error(`${p.object}: ${image} is ${page.width}x${page.height}, but its atlas says ${w}x${h} (published from another sprite or animation: art batch it again)`);
                pages.push(page);
                const size = (await stat(join(gameDir, image))).size;
                files.set(image, size);
                own.add(image);
              }
              resident.push({ cells: layout.atlas!.cells, pages: layout.atlas!.pages, files: layout.atlas!.images });
              return pages;
            })()
          : null;
        if (mine) {
          if (anim === start) {
            const [fx, fy, fw, fh] = layout.rects[0]!;
            still = crop(unpackCell(mine, layout.atlas!, layout.of ? layout.of[0]! : 0, layout.cell), (fx - layout.rect[0]) * SCALE, (fy - layout.rect[1]) * SCALE, fw * SCALE, fh * SCALE);
          }
        } else {
          const strip = await read(source);
          const want: [number, number] = [layout.cell[0] * layout.columns, layout.cell[1] * Math.ceil(layout.cells / layout.columns)];
          if (strip.width !== want[0] || strip.height !== want[1]) throw new Error(`${p.object}: ${source} is ${strip.width}x${strip.height}, but its ${layout.cells} cells of ${layout.cell.join('x')} in rows of ${layout.columns} make ${want.join('x')} (published from another sprite or animation: art batch it again)`);
          resident.push({ gridBytes: strip.width * strip.height * 4 });
          if (anim === start) {
            // (frame 0 inside its cell: the cell is the union of the frames, and the first may be smaller)
            const [fx, fy, fw, fh] = layout.rects[0]!;
            still = crop(strip, (fx - layout.rect[0]) * SCALE, (fy - layout.rect[1]) * SCALE, fw * SCALE, fh * SCALE);
          }
        }
        strips[String(anim)] = {
          ...(layout.atlas ? { images: layout.atlas.images, pages: layout.atlas.pages, cells: layout.atlas.cells } : { image: relative(gameDir, source).split(sep).join('/') }),
          frames: layout.frames,
          ...(layout.of ? { of: layout.of } : {}),
          ...(layout.columns < layout.cells ? { columns: layout.columns } : {}),
          cell: layout.cell,
          rect: at(layout.rect),
          rects: layout.rects.map(at),
          delays: layout.delays,
          loop: layout.loop,
          ...(layout.next !== undefined ? { next: layout.next } : {}),
        };
      }
      if (!still) throw new Error(`${p.object}: it starts on animation ${start}, which has no strip`);
      const dir = await mkdtemp(join(tmpdir(), 'prop-'));
      try {
        await writeFile(join(dir, 'still.png'), encodePng(still));
        await encode(join(dir, 'still.png'), join(gameDir, image));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      entries.push({ object: p.object, image, rect: at(p.rect), depth: p.depth, card: true, ...(p.origin && p.mouth ? { aim: aimPoint(p.origin, p.mouth, p.scale ?? 256) } : {}), ...(p.home ? { home: p.home } : {}), ...(p.talk && strips[String(p.talk.anim)] ? { talk: p.talk } : {}), anim: start, strips });
      const kept = layerResident(resident);
      const extra = kept.ring + kept.surface + kept.grid;
      let pages = 0;
      if (kept.mode === 'whole') for (const [f, b] of kept.pages) { decoded.set(f, b); pages += b; }
      else for (const f of own) { streamed.add(f); pages += files.get(f) ?? 0; }
      perObject.push({ object: p.object, bytes: extra + pages, extra, mode: kept.mode });
      continue;
    }
    const rect = scaledRect(p.rect, p.scale ?? 256);
    // (drawn at a scale that leaves under a pixel, as an object at the floor's vanishing end: the original shows nothing of it)
    if (rect[2] < 1 || rect[3] < 1) continue;
    const size = webpSize(new Uint8Array(await readFile(p.source)));
    if (!size || (rect === p.rect && size.width === rect[2] * SCALE && size.height === rect[3] * SCALE)) await copyFile(p.source, join(gameDir, image));
    else {
      // an animation's strip: frame 0, its first cell, is the still; a walker-type object is drawn smaller (its card is resampled to that size)
      const strip = await readWebp(p.source);
      const w = p.rect[2] * SCALE;
      const h = p.rect[3] * SCALE;
      let cell: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
      for (let y = 0; y < h; y++) cell.data.set(strip.data.subarray(y * strip.width * 4, (y * strip.width + w) * 4), y * w * 4);
      if (rect !== p.rect) cell = areaResize(cell, rect[2] * SCALE, rect[3] * SCALE);
      const dir = await mkdtemp(join(tmpdir(), 'prop-'));
      try {
        await writeFile(join(dir, 'cell.png'), encodePng(cell));
        await encode(join(dir, 'cell.png'), join(gameDir, image));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    entries.push({ object: p.object, image, rect, depth: p.depth, card: true, ...(p.origin && p.mouth ? { aim: aimPoint(p.origin, p.mouth, p.scale ?? 256) } : {}), ...(p.home ? { home: p.home } : {}) });
  }
  if (perObject.length > 0) deps.report?.(stripReport(screen, perObject, new Map([...files].filter(([f]) => streamed.has(f))), deps.budget, decoded));
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  // (masks the room no longer has go too)
  const old = (doc.getIn(['art', 'rooms', screen, 'masks']) as { items?: { get(k: string): string }[] } | undefined)?.items ?? [];
  for (const o of old) {
    const image = o.get('image');
    if (!entries.some(e => e.image === image)) await rm(join(gameDir, image), { force: true });
  }
  if (entries.length > 0) doc.setIn(['art', 'rooms', screen, 'masks'], entries);
  else doc.deleteIn(['art', 'rooms', screen, 'masks']);
  await writeFile(path, String(doc));
  return entries.map(e => e.image);
}

