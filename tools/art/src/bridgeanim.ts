// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { colourFrame, COLOUR_BLANK, typeOne, typeTwo } from './shipsprite';
import { crewMattes, cutsFor, prepareCrewFrame, type FrameBackground } from './crewframe';
import { cellGeometry, packAnim } from './strips';
import { MAX_ATLAS_SIDE, packAtlas, type Atlas } from './atlas';
import { checkAnim, type CardChecks } from './cardchecks';
import { waitMillis } from './sprites';
import type { Rgba } from './image';

/**
 * A bridge crew sprite's animations, played as the original plays them (ScummVM sprite_player.cpp, read-only): the .spr's own script, decoded
 * from the game's file with the bridge's palette (the images export colours these with half a palette), each frame placed by the
 * sprite's own POSN, RPOS and speech positions. The frames are the original's pixels, cleaned, upscaled and (with a recipe) repainted.
 */

interface Image { width: number; height: number; indices: Uint8Array }

/** One entry of a sprite's script, in block order. */
export type ScriptEntry =
  | ({ type: 'sprite' } & Image)
  | ({ type: 'speechSprite' } & Image)
  | { type: 'wait'; wait: number }
  | { type: 'randomWait'; base: number; amount: number }
  | { type: 'jump'; target: number }
  | { type: 'position' | 'relPos'; x: number; y: number }
  | { type: 'mark' }
  | { type: 'other' };

export interface Script {
  /** The entry each animation starts at (-1: no data). */
  anims: number[];
  entries: ScriptEntry[];
}

/** A .spr's script (sprite.cpp readBlock): the LIST's blocks, with image blocks decoded and references resolved. */
export function readScript(bytes: Uint8Array): Script {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'TRPS' || tag(12) !== 'TSIL') throw new Error('not a sprite (no SPRT and LIST)');
  const count = view.getUint32(20, true);
  const offsets = Array.from({ length: count }, (_, i) => view.getUint32(24 + 4 * i, true)).map(o => (o === 0 ? 0 : o + 12));
  const end = Math.min(bytes.length, 12 + view.getUint32(16, true));
  const entries: ScriptEntry[] = [];
  const starts = new Map<number, number>();
  const images = new Map<number, { width: number; height: number; indices: Uint8Array }>();
  for (let pos = 24 + 4 * count; pos + 8 <= end;) {
    const size = view.getUint32(pos + 4, true);
    if (size < 8) throw new Error('bad block size');
    starts.set(pos, entries.length);
    const t = tag(pos);
    const u = (n: number): number => view.getUint32(pos + 8 + n, true);
    if (t === 'PMOC' || t === 'MOCS') {
      const width = u(0);
      const height = u(4);
      const kind = view.getUint16(pos + 18, true);
      let image: { width: number; height: number; indices: Uint8Array };
      if (kind === 3) {
        const ref = images.get(pos - view.getUint32(pos + 20, true));
        if (!ref) throw new Error('a sprite frame refers to a missing frame');
        image = ref;
      } else if (kind === 1 || kind === 2) {
        const data = bytes.subarray(pos + 20, pos + size);
        image = { width, height, indices: kind === 1 ? typeOne(data, width, height) : typeTwo(data, width * height) };
      } else throw new Error(`unknown image type ${kind}`);
      images.set(pos, image);
      entries.push(t === 'PMOC' ? { type: 'sprite', ...image } : { type: 'speechSprite', ...image });
    } else if (t === 'EMIT') entries.push({ type: 'wait', wait: u(0) });
    else if (t === 'DNAR') entries.push({ type: 'randomWait', amount: u(0), base: u(4) });
    else if (t === 'PMUJ') entries.push({ type: 'jump', target: u(0) });
    else if (t === 'NSOP') entries.push({ type: 'position', x: u(0), y: u(4) });
    else if (t === 'SOPR') entries.push({ type: 'relPos', x: view.getInt32(pos + 8, true), y: view.getInt32(pos + 12, true) });
    else if (t === 'KRAM') entries.push({ type: 'mark' });
    else entries.push({ type: 'other' });
    pos += size;
  }
  return { anims: offsets.map(o => (o === 0 ? -1 : (starts.get(o) ?? -1))), entries };
}

/** One frame as the player shows it: the base frame with any speech frame over it, and where it sits from the object's feet. */
export interface PlayedFrame {
  /** Palette indices of the union rectangle, blank where nothing is drawn. */
  width: number;
  height: number;
  indices: Uint8Array;
  /** The rectangle's top left from the origin (the object's x, y), in the original's pixels. */
  left: number;
  top: number;
  /** Milliseconds shown. */
  wait: number;
}

export interface PlayedAnim {
  frames: PlayedFrame[];
  loop: boolean;
  next?: number;
}

const DEFAULT_WAIT_MS = 50;
interface Pos { xpos: number; ypos: number; xadj: number; yadj: number }

/** Composites a base frame and its speech frame (blank is transparent, the speech frame over the base). */
function composite(parts: { image: { width: number; height: number; indices: Uint8Array }; left: number; top: number }[]): Omit<PlayedFrame, 'wait'> {
  const left = Math.min(...parts.map(p => p.left));
  const top = Math.min(...parts.map(p => p.top));
  const right = Math.max(...parts.map(p => p.left + p.image.width));
  const bottom = Math.max(...parts.map(p => p.top + p.image.height));
  const width = right - left;
  const height = bottom - top;
  const indices = new Uint8Array(width * height).fill(COLOUR_BLANK);
  for (const p of parts) {
    for (let y = 0; y < p.image.height; y++)
      for (let x = 0; x < p.image.width; x++) {
        const c = p.image.indices[y * p.image.width + x]!;
        if (c !== COLOUR_BLANK) indices[(p.top - top + y) * width + (p.left - left + x)] = c;
      }
  }
  return { width, height, indices, left, top };
}

/**
 * Plays animation `root` as SpritePlayer::update does, and every animation it jumps into, until one repeats. `object` is the object's x, y:
 * a sprite with no POSN of its own is drawn there, and `origin` is what the frames' offsets are from (the card's anchor). A wait ends
 * a frame; a random wait is its middle. The offsets follow graphics.cpp drawSprite: left = x + xadjust - trunc(width / 2), top = y + yadjust -
 * height, and a speech frame has its own position, which a POSN sets absolutely.
 */
export function playBridgeAnim(script: Script, root: number, object: [number, number], origin: [number, number]): Map<number, PlayedAnim> {
  const out = new Map<number, PlayedAnim>();
  const { entries } = script;
  const normal: Pos = { xpos: 0, ypos: 0, xadj: 0, yadj: 0 };
  const speech: Pos = { xpos: 0, ypos: 0, xadj: 0, yadj: 0 };
  let rel: [number, number] = [0, 0];
  let current: ({ type: 'sprite' } & Image) | null = null;
  let speaking: ({ type: 'speechSprite' } & Image) | null = null;
  let marked: { sprite: { type: 'sprite' } & Image; at: Pos } | null = null;
  let wasSpeech = false;
  const reset = (): void => {
    normal.xadj = normal.yadj = 0;
    speech.xadj -= rel[0];
    speech.yadj -= rel[1];
    rel = [0, 0];
  };
  const place = (image: { width: number; height: number }, at: Pos): { left: number; top: number } => ({
    left: (at.xpos || object[0]) + at.xadj - Math.trunc(image.width / 2) - origin[0],
    top: (at.ypos || object[1]) + at.yadj - image.height - origin[1],
  });
  const snapshot = (waitMs: number, into: PlayedAnim): void => {
    if (!current) return;
    const parts: { image: Image; left: number; top: number }[] = [{ image: current, ...place(current, normal) }];
    if (speaking) parts.push({ image: speaking, ...place(speaking, speech) });
    into.frames.push({ ...composite(parts), wait: waitMs });
  };

  let a = root;
  while (!out.has(a)) {
    const start = script.anims[a];
    if (start === undefined || start < 0) break;
    const body: PlayedAnim = { frames: [], loop: false };
    out.set(a, body);
    // (startAnim: the new animation begins with no moves)
    reset();
    let jumped: number | null = null;
    for (let i = start, steps = 0; i < entries.length && steps++ < 4000; i++) {
      const e = entries[i]!;
      if (e.type === 'sprite') {
        current = e;
        wasSpeech = false;
        speaking = null;
      } else if (e.type === 'speechSprite') {
        if (!marked) continue;
        speaking = e;
        current = marked.sprite;
        if (!wasSpeech) {
          Object.assign(speech, normal);
          Object.assign(normal, marked.at);
        }
        wasSpeech = true;
      } else if (e.type === 'position') {
        const p = wasSpeech ? speech : normal;
        p.xpos = e.x;
        p.ypos = e.y;
        if (wasSpeech) speech.xadj = speech.yadj = 0;
      } else if (e.type === 'relPos') {
        if (wasSpeech) {
          speech.xadj += e.x;
          speech.yadj += e.y;
        } else {
          normal.xadj = e.x;
          normal.yadj = e.y;
        }
        rel = [e.x, e.y];
      } else if (e.type === 'mark') {
        if (current) marked = { sprite: current, at: { ...normal } };
      } else if (e.type === 'wait') snapshot(Math.max(1, waitMillis(e.wait)), body);
      else if (e.type === 'randomWait') snapshot(Math.max(1, waitMillis(e.base + e.amount / 2)), body);
      else if (e.type === 'jump') {
        jumped = e.target;
        break;
      }
    }
    if (jumped === null) break;
    // (a frame that ran into the jump with no wait shows for a moment)
    if (body.frames.length === 0) snapshot(DEFAULT_WAIT_MS, body);
    if (jumped === a) {
      body.loop = true;
      break;
    }
    body.next = jumped;
    a = jumped;
  }
  return out;
}

/** The animations the bridge plays for a crew member: idle (the start, 0, and what it falls into), ship idle 1 and ship talk 2 (talk.cpp). */
export const BRIDGE_ROOTS = [0, 1, 2];

/** One bridge animation, ready to publish: the strip of equal cells at the sprite's own pixels, with what the engine needs to play it. */
export interface BridgeStrip {
  /** Strip pixels to an original pixel (1: the sprite's own pixels; 4: upscaled). */
  scale: number;
  strip: Rgba;
  frames: number;
  columns: number;
  cell: [number, number];
  anchor: [number, number];
  delays: number[];
  loop: boolean;
  next?: number;
}

const MAX_STRIP_WIDTH = 4096;

/** Makes a cleaned frame `scale` times as large (the card upscaler: smooth colours, the original's alpha edge). */
export interface Upscale { scale: number; run(frame: Rgba): Promise<Rgba> }

/** A distinct frame of a sprite, upscaled: `dx`, `dy` are its origin offsets in original pixels (packAnim's). */
export interface CrewFrame { png: Rgba; dx: number; dy: number }
/** The distinct frames (their indices) an animation plays, in order. */
export interface PlayedFrames { anim: number; frames: number[] }
/** A sprite's repaint (bridgerepaint.ts crewRepaint). */
export interface Repaint {
  /**
   * Repaints the sprite's distinct upscaled frames, all at once so they can be held together: the first is the first played frame of the
   * first animation. Each comes back the same size, with its alpha. `played` says which of them each animation plays, in order (its frames'
   * indices in `frames`), for the recipe's fix-ups.
   */
  paint(frames: CrewFrame[], played?: PlayedFrames[]): Promise<Rgba[]>;
  /** What each repainted strip must pass (gateStrip), or it is published as the upscale. */
  checks: CardChecks;
  log?: (line: string) => void;
}

/** An animation's frames as equal cells (packAnim's), for the checks. */
function cellsOf(frames: { png: Rgba; dx: number; dy: number }[], scale: number): Rgba[] {
  const packed = packAnim(frames.map(f => ({ ...f, wait: 0 })), scale);
  const [cw, ch] = packed.cell;
  return frames.map((_, i) => {
    const data = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) data.set(packed.strip.data.subarray((y * packed.strip.width + i * cw) * 4, (y * packed.strip.width + (i + 1) * cw) * 4), y * cw * 4);
    return { width: cw, height: ch, data };
  });
}

/**
 * The gate a repainted strip passes before it is published (null), or why it fails: the card checks (checkAnim) on its cells, the original's,
 * the upscale's and the repaint's, at their absolute limits: the alpha the upscale's exactly, the outline in place, the colour within `deltaE`,
 * the flicker's median and every pair of consecutive frames within `flickerMax`. `checks.flickerRatio` is what the caller makes it (Infinity: none).
 */
export function gateStrip(original: { png: Rgba; dx: number; dy: number }[], upscaled: { png: Rgba; dx: number; dy: number }[], repainted: Rgba[], scale: number, checks: CardChecks): string | null {
  const orig = cellsOf(original, 1);
  const up = cellsOf(upscaled, scale);
  const rep = cellsOf(upscaled.map((f, i) => ({ ...f, png: repainted[i]! })), scale);
  const c = checkAnim(orig, up, rep, checks, { skipAlign: false });
  const why = c.ok ? [] : [c.why ?? 'failed'];
  c.flicker.forEach((f, i) => {
    if (f > checks.flickerMax) why.push(`frames ${i}-${i + 1} flicker ${f.toFixed(1)}/255 (limit ${checks.flickerMax})`);
  });
  return why.length > 0 ? why.join('; ') : null;
}

const same = (a: Rgba, b: Rgba): boolean => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

/**
 * The strips for a crew sprite's animations: each frame coloured with the bridge palette and cleaned up as the still is (prepareCrewFrame,
 * with the picture behind it matted out), and a frame the next repeats exactly is held longer, not stored twice. Every cell holds a frame
 * at its own offset from the one anchor, so each frame's offset is honoured. `sprite` (its file) picks the cuts traced for it (CREW_CUTS).
 * `repaint` (with `upscale`) gets every distinct upscaled frame of the sprite once, whichever animations play it, so a frame two animations
 * share is painted the same in both.
 */
export async function bridgeStrips(
  script: Script,
  palette: Uint8Array,
  object: [number, number],
  origin: [number, number],
  background?: Rgba,
  roots: readonly number[] = BRIDGE_ROOTS,
  upscale?: Upscale,
  sprite?: string,
  repaint?: Repaint,
): Promise<Map<number, BridgeStrip>> {
  const played = new Map<number, PlayedAnim>();
  for (const root of roots) for (const [index, body] of playBridgeAnim(script, root, object, origin)) if (!played.has(index)) played.set(index, body);
  // (the figure's mask in each frame, from all the frames it plays: what moves is the figure, crewMattes)
  const all = [...played.values()].flatMap(b => b.frames);
  const coloured = new Map(all.map(f => [f, colourFrame(f, palette)]));
  const mattes = background ? crewMattes(all.map(f => ({ img: coloured.get(f)!, left: origin[0] + f.left, top: origin[1] + f.top })), background, sprite ? cutsFor(sprite) : []) : [];
  const matteOf = new Map(all.map((f, i) => [f, mattes[i]]));
  const anims: { index: number; body: PlayedAnim; frames: { png: Rgba; dx: number; dy: number; wait: number }[]; original: Rgba[] }[] = [];
  for (const [index, body] of [...played].sort((x, y) => x[0] - y[0])) {
    const frames: { png: Rgba; dx: number; dy: number; wait: number }[] = [];
    // (the cleaned frames at the sprite's own pixels: a frame the next repeats is held longer, and only the distinct ones are upscaled)
    for (const f of body.frames) {
      const bg: FrameBackground | undefined = background && { pixels: background, left: origin[0] + f.left, top: origin[1] + f.top };
      const png = prepareCrewFrame(coloured.get(f)!, bg, matteOf.get(f));
      const dx = f.left + Math.trunc(f.width / 2);
      const dy = f.top + f.height;
      const last = frames[frames.length - 1];
      if (last && last.dx === dx && last.dy === dy && same(last.png, png)) last.wait += f.wait;
      else frames.push({ png, dx, dy, wait: f.wait });
    }
    if (frames.length === 0) continue;
    const original = frames.map(f => f.png);
    if (upscale) for (const f of frames) f.png = await upscale.run(f.png);
    anims.push({ index, body, frames, original });
  }
  if (upscale && repaint) {
    // (each distinct frame once, by its place and its pixels, in the order played)
    const key = (f: { png: Rgba; dx: number; dy: number }): string => `${f.dx},${f.dy},${f.png.width}x${f.png.height},${createHash('sha256').update(f.png.data).digest('hex')}`;
    const keyOf = new Map(anims.flatMap(a => a.frames.map(f => [f, key(f)] as const)));
    const distinct = new Map<string, CrewFrame>();
    for (const a of anims) for (const f of a.frames) if (!distinct.has(keyOf.get(f)!)) distinct.set(keyOf.get(f)!, { png: f.png, dx: f.dx, dy: f.dy });
    const index = new Map([...distinct.keys()].map((k, i) => [k, i]));
    const painted = await repaint.paint([...distinct.values()], anims.map(a => ({ anim: a.index, frames: a.frames.map(f => index.get(keyOf.get(f)!)!) })));
    // (a strip that fails the gate keeps the upscale, whole: a strip half repainted would jump where it changes)
    for (const a of anims) {
      const rep = a.frames.map(f => painted[index.get(keyOf.get(f)!)!]!);
      const why = gateStrip(a.frames.map((f, i) => ({ png: a.original[i]!, dx: f.dx, dy: f.dy })), a.frames, rep, upscale.scale, repaint.checks);
      if (why) repaint.log?.(`${sprite ?? 'sprite'} anim ${a.index}: the repaint is refused (${why}); its strip is the upscale`);
      else a.frames.forEach((f, i) => (f.png = rep[i]!));
    }
  }
  const strips = new Map<number, BridgeStrip>();
  const scale = upscale?.scale ?? 1;
  for (const { index, body, frames } of anims) {
    const packed = packAnim(frames, scale, MAX_STRIP_WIDTH);
    strips.set(index, { scale, strip: packed.strip, frames: frames.length, columns: packed.columns, cell: packed.cell, anchor: packed.anchor, delays: packed.delays, loop: body.loop, ...(body.next !== undefined ? { next: body.next } : {}) });
  }
  return strips;
}

/**
 * One viewscreen animation, ready to publish: its frames as cells of one size (the union of the frames, the sprite's own pixels), packed as an
 * atlas (packAtlas: each cell cropped to its own opaque bounds, pages no side over MAX_ATLAS_SIDE), with what the engine needs to play it.
 */
export interface ViewStrip {
  pages: Rgba[];
  atlas: Atlas;
  frames: number;
  /** One cell, in the sprite's own pixels. */
  cell: [number, number];
  /** Where the viewscreen's object is in the cell, as fractions of it. */
  anchor: [number, number];
  delays: number[];
  loop: boolean;
  next?: number;
}

/**
 * A viewscreen sprite's sheets (the Enterprise's own views, and a caller's picture): the animation the viewscreen starts (ViewscreenScreen::start
 * startAnim(0), viewscreen.cpp) and every one it jumps into, played as SpritePlayer::update does (playBridgeAnim), each frame coloured with
 * `palette` at the sprite's own pixels. A frame the next repeats exactly is held longer, not stored twice. The delays are the sprite's own
 * waits (waitMillis: sprite_player.cpp's clock), as the crew's strips take theirs. Each animation's cells go into an atlas of pages no side over
 * `maxSide`, as a lean device's textures must be. A sprite whose animation 0 never waits has no sheet.
 */
export function viewStrips(script: Script, palette: Uint8Array, maxSide = MAX_ATLAS_SIDE): Map<number, ViewStrip> {
  const strips = new Map<number, ViewStrip>();
  // (the viewscreen's object stands at 320, 240: a sprite with no POSN of its own is drawn there, and the cells are placed from it)
  const at: [number, number] = [320, 240];
  for (const [index, body] of [...playBridgeAnim(script, 0, at, at)].sort((x, y) => x[0] - y[0])) {
    const frames: { png: Rgba; dx: number; dy: number; wait: number }[] = [];
    for (const f of body.frames) {
      const png = colourFrame(f, palette);
      const dx = f.left + Math.trunc(f.width / 2);
      const dy = f.top + f.height;
      const last = frames[frames.length - 1];
      if (last && last.dx === dx && last.dy === dy && same(last.png, png)) last.wait += f.wait;
      else frames.push({ png, dx, dy, wait: f.wait });
    }
    if (frames.length === 0) continue;
    // (every frame laid into the union's cell at its own offset, then cropped and packed)
    const geometry = cellGeometry(frames.map(f => ({ width: f.png.width, height: f.png.height, dx: f.dx, dy: f.dy })));
    const [cw, ch] = geometry.cell;
    const cells = frames.map((f, i) => {
      const cell: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
      const [ox, oy] = geometry.offsets[i]!;
      for (let y = 0; y < f.png.height; y++) cell.data.set(f.png.data.subarray(y * f.png.width * 4, (y + 1) * f.png.width * 4), ((oy + y) * cw + ox) * 4);
      return cell;
    });
    const { atlas, pages } = packAtlas(cells, maxSide);
    strips.set(index, { pages, atlas, frames: frames.length, cell: [cw, ch], anchor: geometry.anchor, delays: frames.map(f => f.wait), loop: body.loop, ...(body.next !== undefined ? { next: body.next } : {}) });
  }
  return strips;
}
