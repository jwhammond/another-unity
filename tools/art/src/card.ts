// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { ArtCache } from './cache';
import type { Generator } from './generator';
import { upscaleGraph, type Models } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import { FIRE_ANIMS, USED_ANIMS, usedBodies, type SpriteJson } from './sprites';
import { findFootShadow, overlayFrame, packAnim, scaleMask, smoothShadow } from './strips';
import { toWebp } from './webp';

const IN = 'card-in';
/** A name for this process's uploads that no other run on the same ComfyUI shares. */
export const STRIP_INPUT = `card-in-${process.pid}-${Date.now().toString(36)}`;
export const CARD_SCALE = 4;
/** A strip wraps into rows rather than run wider than this: every GPU the browser meets takes a texture this wide. */
export const MAX_STRIP_WIDTH = 4096;

/** How a card's alpha is made at 4x. */
export interface CardOptions {
  /**
   * 'resampled' (the default): the frame's alpha, bilinear and tightened (alphaAt). 'upscaled': the mask goes through the upscaler with the
   * colours (white on black, beside them in the same job), then is smoothed, thresholded and feathered (alphaFromUpscaled), so the edge follows the figure's shape
   * rather than its 1x pixels; and a clear pixel keeps the colour it was given (prepareCrewFrame bleeds the figure's into it).
   */
  alpha?: 'resampled' | 'upscaled';
}

/**
 * A crew card from one original sprite frame: the colours go through the upscaler (4x), the alpha is resampled
 * bilinearly and tightened, so the edge stays crisp, or upscaled with them (CardOptions). No repaint (Plan 15). The upscaler sees no halo: pixels with
 * no alpha are given the frame's mean colour first. `input` names the frame on the server: a run beside another on the same
 * ComfyUI gives its own, or the two overwrite each other's upload.
 */
export async function makeCard(g: Generator, models: Pick<Models, 'upscaler'>, frame: Uint8Array, input = IN, opts: CardOptions = {}): Promise<Uint8Array> {
  const src = decodePng(frame);
  const { width: w, height: h } = src;
  const upscaled = opts.alpha === 'upscaled';
  let r = 0, gr = 0, b = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (src.data[i * 4 + 3]! < 128) continue;
    r += src.data[i * 4]!;
    gr += src.data[i * 4 + 1]!;
    b += src.data[i * 4 + 2]!;
    n++;
  }
  const mean = n ? [r / n, gr / n, b / n] : [128, 128, 128];
  const flat = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const solid = src.data[i * 4 + 3]! >= 128;
    const bled = upscaled && src.data[i * 4]! + src.data[i * 4 + 1]! + src.data[i * 4 + 2]! > 0;
    for (let c = 0; c < 3; c++) flat[i * 4 + c] = solid || bled ? src.data[i * 4 + c]! : Math.round(mean[c]!);
    flat[i * 4 + 3] = 255;
  }
  if (upscaled) {
    // (one job: the colours, a gap of black, and the mask white on black beside them, so the mask is upscaled by the same model in the same pass)
    const W = 2 * w + MASK_GAP;
    const both = new Uint8Array(W * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        both[o + 3] = 255;
        if (x < w) both.set(flat.subarray((y * w + x) * 4, (y * w + x) * 4 + 3), o);
        else if (x >= w + MASK_GAP && src.data[(y * w + x - w - MASK_GAP) * 4 + 3]! >= 128) both.fill(255, o, o + 3);
      }
    const up = decodePng((await g.run({ ...upscaleGraph(models, input), inputs: { [input]: encodePng({ width: W, height: h, data: both }) } })).image!);
    if (up.width !== W * CARD_SCALE || up.height !== h * CARD_SCALE) throw new Error(`the upscaler returned ${up.width}x${up.height} for a ${W}x${h} frame and mask`);
    const cw = w * CARD_SCALE;
    const ch = h * CARD_SCALE;
    const colour: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
    const mask: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
    for (let y = 0; y < ch; y++) {
      colour.data.set(up.data.subarray(y * up.width * 4, (y * up.width + cw) * 4), y * cw * 4);
      mask.data.set(up.data.subarray((y * up.width + up.width - cw) * 4, (y + 1) * up.width * 4), y * cw * 4);
    }
    const a = alphaFromUpscaled(mask);
    for (let i = 0; i < a.length; i++) colour.data[i * 4 + 3] = a[i]!;
    return encodePng(colour);
  }
  const up = decodePng((await g.run({ ...upscaleGraph(models, input), inputs: { [input]: encodePng({ width: w, height: h, data: flat }) } })).image!);
  if (up.width !== w * CARD_SCALE || up.height !== h * CARD_SCALE) throw new Error(`the upscaler returned ${up.width}x${up.height} for a ${w}x${h} frame`);
  const out: Rgba = { width: up.width, height: up.height, data: new Uint8Array(up.data) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      out.data[(y * out.width + x) * 4 + 3] = alphaAt(src, (x + 0.5) / CARD_SCALE - 0.5, (y + 0.5) / CARD_SCALE - 0.5);
    }
  }
  return encodePng(out);
}

/** What an upscaled-alpha card depends on beyond its frame and the model: a cache of cards keys on it, so a change here makes them again. */
export const upscaledAlphaKey = (): string => `alpha:upscaled:gap${MASK_GAP}:sigma${EDGE_SIGMA}:feather${EDGE_FEATHER}`;

/** Original pixels of black between the frame and its mask in the one picture the upscaler gets (its receptive field doesn't carry colour across). */
const MASK_GAP = 8;
/** The upscaled mask is smoothed this much (a Gaussian's sigma, in card pixels: under two thirds of an original pixel, so a one-pixel line stays) before its threshold... */
const EDGE_SIGMA = 2.5;
/** ... and feathered over this much either side of half. */
const EDGE_FEATHER = 0.15;

/**
 * A card's alpha from its mask as the upscaler drew it (white figure on black, at card scale): smoothed (EDGE_SIGMA), so whatever steps
 * the upscaler kept of the 1x pixels round off, then thresholded at half and feathered (smoothstep over EDGE_FEATHER), so the edge is
 * crisp, a pixel or two wide, and follows a smooth line.
 */
export function alphaFromUpscaled(up: Rgba): Uint8Array {
  const { width: w, height: h } = up;
  const radius = Math.ceil(EDGE_SIGMA * 3);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * EDGE_SIGMA * EDGE_SIGMA)));
  const total = kernel.reduce((s, v) => s + v, 0);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.299 * up.data[i * 4]! + 0.587 * up.data[i * 4 + 1]! + 0.114 * up.data[i * 4 + 2]!) / 255;
  // (separable: rows then columns, the edge clamped)
  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          s += src[sy * w + sx]! * kernel[k + radius]!;
        }
        dst[y * w + x] = s / total;
      }
    return dst;
  };
  const soft = pass(pass(lum, true), false);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const t = Math.min(1, Math.max(0, (soft[i]! - (0.5 - EDGE_FEATHER)) / (2 * EDGE_FEATHER)));
    out[i] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return out;
}

/** Bilinear alpha at a fractional source position, then pushed away from the middle (smoothstep over 0.25..0.75). */
export function alphaAt(img: Rgba, fx: number, fy: number): number {
  const px = (x: number, y: number): number => img.data[(Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4 + 3]! / 255;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = (px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx) * (1 - ty) + (px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx) * ty;
  const t = Math.min(1, Math.max(0, (a - 0.25) / 0.5));
  return Math.round(t * t * (3 - 2 * t) * 255);
}

/** Copies a card to games/unity/art/cards/<object>.png and sets presentation.yaml's art.cards[object] (header and other keys stay). */
export async function publishCard(gameDir: string, object: string, png: Uint8Array, anchor: [number, number] = [0.5, 1]): Promise<{ file: string }> {
  if (!/^[a-z0-9_]+$/.test(object)) throw new Error(`"${object}" isn't an object id`);
  const rel = `art/cards/${object}.png`;
  await mkdir(join(gameDir, 'art', 'cards'), { recursive: true });
  await writeFile(join(gameDir, rel), png);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  doc.setIn(['art', 'cards', object], { image: rel, frames: 1, anchor });
  await writeFile(path, String(doc));
  return { file: rel };
}


/** work/cards/<object>/<run-stamp>/meta.json: the model hashes, the source frame's sha256, the card's and ComfyUI's version. */
export async function writeCardMeta(
  cache: ArtCache,
  object: string,
  info: { models: Record<string, { file: string; sha256: string }>; frame: Uint8Array; card: Uint8Array; comfyui: string; torch: string; now: number },
): Promise<string> {
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const dir = join(cache.work, 'cards', object, new Date(info.now).toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  const meta = { object, models: info.models, frameSha256: sha(info.frame), cardSha256: sha(info.card), comfyui: info.comfyui, torch: info.torch };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return dir;
}

/** One animation, made: its strip of equal cells at card scale, and what the engine needs to play it. */
export interface MadeAnim {
  strip: Rgba;
  /** The same cells with the sprite's own pixels at 1x (the card checks compare against them). */
  original: Rgba;
  /** A speech animation only: the same cells with the marked frame alone, no mouth (what a card repaints; the mouths go back over the repaint, `mouthOver`). */
  base?: Rgba;
  frames: number;
  /** Cells to a row of the strip (it wraps to stay under MAX_STRIP_WIDTH). */
  columns: number;
  cell: [number, number];
  anchor: [number, number];
  delays: number[];
  loop: boolean;
  next?: number;
}

export interface MadeStrips {
  /** By canonical animation index. */
  anims: Map<number, MadeAnim>;
  /** An animation's index to the one that holds its frames (an animation that only jumps is another name). */
  alias: Map<number, number>;
  /** The standing frame's height in the original's pixels. */
  pixelHeight: number;
  /** Dither pixels taken out of the frames and turned into the smooth shadow, in all. */
  shadowPixels: number;
  frames: number;
}

/**
 * Every animation of a sprite that Plan 15 plays (R8) as upscaled strips, with no repaint: each distinct frame goes
 * through makeCard (x4plus, original alpha), its dithered foot shadow taken out first and laid back as a smooth
 * translucent one, and a speech frame is its marked frame with the mouth drawn on. `readFrame` gives a frame's PNG by
 * its path in the sprite's JSON; `cached` lets a rerun skip the frames it has made.
 */
export async function makeStrips(
  g: Generator,
  models: Pick<Models, 'upscaler'>,
  sprite: SpriteJson,
  readFrame: (png: string) => Promise<Uint8Array>,
  opts: { shadowColours: [number, number, number][]; roots?: readonly number[]; cached?: { get(key: string): Promise<Uint8Array | null>; put(key: string, png: Uint8Array): Promise<void> }; log?: (m: string) => void },
): Promise<MadeStrips> {
  const { bodies, alias } = usedBodies(sprite, opts.roots ?? [...USED_ANIMS, ...FIRE_ANIMS]);
  const made = new Map<string, Rgba>();
  const origs = new Map<string, Rgba>();
  let shadowPixels = 0;
  let count = 0;
  const cardOf = async (f: { png: string; overlay?: { png: string; x: number; y: number } }): Promise<Rgba> => {
    const key = `${f.png}+${f.overlay ? `${f.overlay.png}@${f.overlay.x},${f.overlay.y}` : ''}`;
    const have = made.get(key);
    if (have) return have;
    let src = decodePng(await readFrame(f.png));
    if (f.overlay) src = overlayFrame(src, decodePng(await readFrame(f.overlay.png)), f.overlay.x, f.overlay.y);
    const mask = findFootShadow(src, opts.shadowColours);
    const lit = { width: src.width, height: src.height, data: new Uint8Array(src.data) };
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        lit.data[i * 4 + 3] = 0;
        shadowPixels++;
      }
    }
    const input = encodePng(lit);
    const sha = createHash('sha256').update(input).digest('hex');
    let card = await opts.cached?.get(sha);
    if (!card) {
      card = await makeCard(g, models, input, STRIP_INPUT);
      await opts.cached?.put(sha, card);
    }
    const out = mask.some(v => v) ? smoothShadow(decodePng(card), scaleMask(mask, src.width, src.height, CARD_SCALE), opts.shadowColours[0] ?? [0, 0, 0], CARD_SCALE) : decodePng(card);
    made.set(key, out);
    origs.set(key, src);
    if (++count % 25 === 0) opts.log?.(`${count} frames`);
    return out;
  };
  const anims = new Map<number, MadeAnim>();
  for (const [index, body] of [...bodies].sort((a, b) => a[0] - b[0])) {
    if (body.frames.length === 0) continue;
    const frames = [];
    const originals = [];
    const bases = [];
    for (const f of body.frames) {
      frames.push({ png: await cardOf(f), dx: f.dx, dy: f.dy, wait: f.wait });
      if (body.frames.some(x => x.overlay)) bases.push({ png: await cardOf({ png: f.png }), dx: f.dx, dy: f.dy, wait: f.wait });
      originals.push({ png: origs.get(`${f.png}+${f.overlay ? `${f.overlay.png}@${f.overlay.x},${f.overlay.y}` : ''}`)!, dx: f.dx, dy: f.dy, wait: f.wait });
    }
    const packed = packAnim(frames, CARD_SCALE, MAX_STRIP_WIDTH);
    const base = bases.length > 0 ? packAnim(bases, CARD_SCALE, MAX_STRIP_WIDTH) : null;
    if (base && (base.cell[0] !== packed.cell[0] || base.cell[1] !== packed.cell[1])) throw new Error(`animation ${index}: the frames without their mouths are cells of ${base.cell.join('x')}, the frames with them ${packed.cell.join('x')}`);
    anims.set(index, { strip: packed.strip, original: packAnim(originals, 1, MAX_STRIP_WIDTH / CARD_SCALE).strip, ...(base ? { base: base.strip } : {}), frames: frames.length, columns: packed.columns, cell: packed.cell, anchor: packed.anchor, delays: packed.delays, loop: body.loop, ...(body.next !== undefined ? { next: body.next } : {}) });
  }
  const stand = bodies.get(alias.get(27) ?? 27);
  const pixelHeight = stand?.frames[0]?.height ?? 0;
  return { anims, alias, pixelHeight, shadowPixels, frames: count };
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Writes a card's strips to games/unity/art/cards/<object>/<anim>.webp (R10: -q 90 -alpha_q 100 -exact) and sets
 * presentation.yaml's art.cards[object].anims and pixelHeight. The card's still (`image`) stays as it was.
 */
export async function publishStrips(gameDir: string, object: string, strips: MadeStrips, encode?: (png: string, out: string) => Promise<void>): Promise<string[]> {
  if (!/^[a-z0-9_]+$/.test(object)) throw new Error(`"${object}" isn't an object id`);
  const rel = `art/cards/${object}`;
  await mkdir(join(gameDir, rel), { recursive: true });
  const enc = encode ?? ((png, out) => toWebp(png, out, { quality: 90, alpha: true }));
  const work = await mkdtemp(join(tmpdir(), 'strip-'));
  const files: string[] = [];
  const record: Record<string, unknown> = {};
  try {
    for (const [index, a] of strips.anims) {
      const png = join(work, 'strip.png');
      await writeFile(png, encodePng(a.strip));
      const image = `${rel}/${index}.webp`;
      await enc(png, join(gameDir, image));
      files.push(image);
      record[index] = { image, frames: a.frames, ...(a.columns < a.frames ? { columns: a.columns } : {}), cell: a.cell, anchor: [round4(a.anchor[0]), round4(a.anchor[1])], delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}) };
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // (an animation that only jumps shares its target's strip)
  for (const [index, target] of strips.alias) if (index !== target && record[target]) record[index] = structuredClone(record[target]);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  const was = doc.getIn(['art', 'cards', object]) as { toJSON(): Record<string, unknown> } | undefined;
  const entry = was ? was.toJSON() : { image: files[0] ?? '', frames: 1, anchor: [0.5, 1] };
  // (a sprite with no standing frame, an effect's, has no height: the schema wants a positive one or none)
  const { pixelHeight: _was, ...rest } = entry as Record<string, unknown>;
  doc.setIn(['art', 'cards', object], { ...rest, ...(strips.pixelHeight > 0 ? { pixelHeight: strips.pixelHeight } : _was !== undefined && Number(_was) > 0 ? { pixelHeight: _was } : {}), anims: record });
  await writeFile(path, String(doc));
  return files;
}

/**
 * Publishes one animation's strip (the repainted one replaces the upscaled-only one) and sets its entry, and its aliases'
 * (animations that only jump into it), in presentation.yaml, leaving every other animation as it was.
 */
export async function publishAnimStrip(gameDir: string, object: string, index: number, anim: MadeAnim, aliases: number[], pixelHeight?: number, encode?: (png: string, out: string) => Promise<void>, opts: { presentation?: boolean; of?: number[] } = {}): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(object)) throw new Error(`"${object}" isn't an object id`);
  const rel = `art/cards/${object}`;
  await mkdir(join(gameDir, rel), { recursive: true });
  const enc = encode ?? ((png, out) => toWebp(png, out, { quality: 90, alpha: true }));
  const work = await mkdtemp(join(tmpdir(), 'strip-'));
  const image = `${rel}/${index}.webp`;
  try {
    const png = join(work, 'strip.png');
    await writeFile(png, encodePng(anim.strip));
    await enc(png, join(gameDir, image));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // (a prop's card is no crew card: `art masks` reads its file and puts it in the room's masks. A strip of only the distinct frames says which cell
  // each frame is beside it, for `art masks` to read, as the cells alone cannot)
  if (opts.of) await writeFile(join(gameDir, rel, `${index}.json`), `${JSON.stringify({ frames: opts.of.length, of: opts.of, columns: anim.columns })}\n`);
  else if (opts.presentation === false) await rm(join(gameDir, rel, `${index}.json`), { force: true });
  if (opts.presentation === false) return image;
  const entry = { image, frames: anim.frames, ...(anim.columns < anim.frames ? { columns: anim.columns } : {}), cell: anim.cell, anchor: [round4(anim.anchor[0]), round4(anim.anchor[1])], delays: anim.delays, loop: anim.loop, ...(anim.next !== undefined ? { next: anim.next } : {}) };
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  doc.setIn(['art', 'cards', object, 'anims', String(index)], entry);
  for (const a of aliases) doc.setIn(['art', 'cards', object, 'anims', String(a)], structuredClone(entry));
  // (a run that never played the standing animation can't know the height: it leaves the recorded one, and never writes 0)
  if (pixelHeight !== undefined && pixelHeight > 0) doc.setIn(['art', 'cards', object, 'pixelHeight'], pixelHeight);
  await writeFile(path, String(doc));
  return image;
}
