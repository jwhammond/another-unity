// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import type { Rgba } from './image';

/** sprite.h: the index the original never draws. */
export const COLOUR_BLANK = 13;

/**
 * The first image (a COMP block) of a .spr, as palette indices, ported from sprite.cpp readCompressedImage and its two decoders.
 * A sprite is SPRT(u32, LIST(count, offsets, blocks...)); each block is <4-byte type> <u32 size incl. header> <data>.
 */
export function firstSpriteFrame(bytes: Uint8Array): { width: number; height: number; indices: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'TRPS') throw new Error('not a sprite (no SPRT)');
  // (SPRT header, its u32, then the LIST's header)
  if (tag(12) !== 'TSIL') throw new Error('the sprite has no LIST');
  let pos = 20 + 4 * view.getUint32(20, true) + 4;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos + 4, true);
    if (size < 8) throw new Error('bad block size');
    if (tag(pos) === 'PMOC') {
      const width = view.getUint32(pos + 8, true);
      const height = view.getUint32(pos + 12, true);
      const kind = view.getUint16(pos + 18, true);
      if (kind !== 1 && kind !== 2) throw new Error(`first frame is a reference (type ${kind})`);
      const data = bytes.subarray(pos + 8 + 12, pos + size);
      return { width, height, indices: kind === 1 ? typeOne(data, width, height) : typeTwo(data, width * height) };
    }
    pos += size;
  }
  throw new Error('the sprite has no image');
}

/** 8 bits at a bit offset, as NEXT_BITS reads them. */
function bitsAt(buf: Uint8Array, bit: number): number {
  const i = bit >> 3;
  const shift = bit & 7;
  let x = (buf[i] ?? 0) << shift;
  if (shift > 0 && i + 1 < buf.length) x += buf[i + 1]! >> (8 - shift);
  return x & 0xff;
}

export function typeTwo(buf: Uint8Array, target: number): Uint8Array {
  const out = new Uint8Array(target);
  let bit = 0;
  let n = 0;
  const run = (colour: number, length: number): void => {
    if (n + length > target) throw new Error('sprite run past the image');
    out.fill(colour, n, n + length);
    n += length;
  };
  while (n !== target) {
    if (bit >= 8 * buf.length) throw new Error('sprite data ends early');
    const kind = bitsAt(buf, bit) >> 6;
    bit += 2;
    if (kind === 0) { run(COLOUR_BLANK, bitsAt(buf, bit) + 1); bit += 8; }
    else if (kind === 1) { run(bitsAt(buf, bit), 1); bit += 8; }
    else if (kind === 2) { const c = bitsAt(buf, bit); bit += 8; run(c, (bitsAt(buf, bit) >> 5) + 1); bit += 3; }
    else { const c = bitsAt(buf, bit); bit += 8; run(c, bitsAt(buf, bit) + 1); bit += 8; }
  }
  return out;
}

export function typeOne(buf: Uint8Array, width: number, height: number): Uint8Array {
  const target = width * height;
  const out = new Uint8Array(target);
  let bit = 0;
  let n = 0;
  let last = 0;
  const run = (colour: number, length: number): void => {
    if (n + length > target) throw new Error('sprite run past the image');
    out.fill(colour & 0xff, n, n + length);
    n += length;
    last = colour;
  };
  while (n !== target) {
    if (bit >= 8 * buf.length) throw new Error('sprite data ends early');
    const type = bitsAt(buf, bit) >> 2;
    if ((type & 0x20) === 0) {
      bit += 1;
      const c = bitsAt(buf, bit) >> 5;
      bit += 3;
      run((c & 4) === 0 ? last + 1 + c : last - 1 - (c & 3), 1);
    } else if ((type & 0x10) === 0) {
      bit += 2;
      let c = bitsAt(buf, bit) >> 6;
      bit += 2;
      const length = (bitsAt(buf, bit) >> 5) + 1;
      bit += 3;
      c = (c & 2) === 0 ? last + 1 + c : last + 1 - c;
      run(c, length);
    } else if ((type & 0x8) === 0) {
      bit += 3;
      const c = (bitsAt(buf, bit) >> 1) + 128;
      bit += 7;
      const length = (bitsAt(buf, bit) >> 7) + 1;
      bit += 1;
      run(c, length);
    } else if ((type & 0x4) === 0) {
      bit += 4;
      const length = (bitsAt(buf, bit) >> 3) + 1;
      bit += 5;
      run(COLOUR_BLANK, length);
    } else if ((type & 0x2) === 0) {
      bit += 5;
      const c = (bitsAt(buf, bit) >> 1) + 128;
      bit += 7;
      const length = (bitsAt(buf, bit) >> 4) + 1;
      bit += 4;
      run(c, length);
    } else if ((type & 0x1) === 0) {
      bit += 6;
      const c = bitsAt(buf, bit);
      bit += 8;
      const length = bitsAt(buf, bit) + 1;
      bit += 8;
      run(c, length);
    } else {
      bit += 7;
      run(COLOUR_BLANK, width);
    }
  }
  return out;
}

/**
 * The palette the bridge draws its sprites with (graphics.cpp setBackgroundImage): bridge.rm's own 128 entries, then STANDARD.PAL's
 * first 128, all 6-bit and shifted left by 2. The images export gives a sprite no screen shows only the standard half (the rest
 * black), so a bridge sprite's low indices come out black there.
 */
export function bridgePalette(bridgeRm: Uint8Array, standardPal: Uint8Array): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  pal.set(bridgeRm.subarray(0, 128 * 3));
  pal.set(standardPal.subarray(0, 128 * 3), 128 * 3);
  for (let i = 0; i < pal.length; i++) pal[i] = (pal[i]! << 2) & 0xff;
  return pal;
}

/** A sprite's first frame in a palette, the blank index transparent. */
export function colourFrame(frame: { width: number; height: number; indices: Uint8Array }, palette: Uint8Array): Rgba {
  const data = new Uint8Array(frame.width * frame.height * 4);
  for (let i = 0; i < frame.indices.length; i++) {
    const c = frame.indices[i]!;
    if (c === COLOUR_BLANK) continue;
    data.set([palette[c * 3]!, palette[c * 3 + 1]!, palette[c * 3 + 2]!, 255], i * 4);
  }
  return { width: frame.width, height: frame.height, data };
}

/** Every block of a .spr's LIST, in order: its 4-character tag (as the file spells it, reversed) and its body. */
function* blocks(bytes: Uint8Array): Generator<{ tag: string; body: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'TRPS' || tag(12) !== 'TSIL') throw new Error('not a sprite (no SPRT and LIST)');
  let pos = 20 + 4 * view.getUint32(20, true) + 4;
  while (pos + 8 <= bytes.length) {
    const size = view.getUint32(pos + 4, true);
    if (size < 8) throw new Error('bad block size');
    yield { tag: tag(pos), body: bytes.subarray(pos + 8, pos + size) };
    pos += size;
  }
}

/**
 * The palette a sprite carries (an RGBP block: 256 entries, 6-bit; graphics.cpp drawSprite replaces the whole palette with it, so the
 * sprite's own entries colour it, not the screen's), shifted left by 2 like every other palette. Undefined for a sprite without one.
 */
export function spritePalette(spr: Uint8Array): Uint8Array | undefined {
  for (const b of blocks(spr)) {
    if (b.tag !== 'PBGR' || b.body.length !== 256 * 3) continue;
    return Uint8Array.from(b.body, v => (v << 2) & 0xff);
  }
  return undefined;
}

/** The first POSN block: where the original draws the sprite (its bottom centre, graphics.cpp drawSprite), 640x480 pixels. */
export function firstSpritePosition(spr: Uint8Array): [number, number] | undefined {
  for (const b of blocks(spr)) {
    if (b.tag !== 'NSOP' || b.body.length < 8) continue;
    const v = new DataView(b.body.buffer, b.body.byteOffset, b.body.byteLength);
    return [v.getUint32(0, true), v.getUint32(4, true)];
  }
  return undefined;
}

/**
 * A hail's picture (viewscreen.cpp start): a sprite the ViewscreenScreen draws over viewscr.rm. Drawing it replaces the palette with the
 * sprite's own RGBP block when it has one (graphics.cpp drawSprite, as the intro does), so that colours it; a sprite without one takes
 * viewscr.rm's own 128 entries and the standard half (setBackgroundImage("viewscr.rm")). The export colours it with the standard half
 * alone, so its low indices are black there. Its first frame, decoded again from the game's .spr.
 */
export function viewFrame(spr: Uint8Array, viewscrRm: Uint8Array, standardPal: Uint8Array): Rgba {
  return colourFrame(firstSpriteFrame(spr), viewPalette(spr, viewscrRm, standardPal));
}

/** The palette the viewscreen draws a sprite with (viewFrame's): its own RGBP block, else viewscr.rm's 128 entries and the standard half. */
export function viewPalette(spr: Uint8Array, viewscrRm: Uint8Array, standardPal: Uint8Array): Uint8Array {
  return spritePalette(spr) ?? bridgePalette(viewscrRm, standardPal);
}

/**
 * STTNG.ZIP in GAMEDATA_DIR. Publishing a ship sprite without it is an error, not a warning: the images export colours these sprites with
 * the standard half of the palette alone, so they come out black where the ship screen's own entries are.
 */
export function shipGameZip(dir: string | undefined): string {
  if (!dir) throw new Error('art ship publish needs GAMEDATA_DIR (the game\'s folder with STTNG.ZIP, e.g. ~/pcode/unity-gamedata/cd): a ship sprite is coloured with its screen\'s own palette, which the images export lacks');
  return join(dir, 'STTNG.ZIP');
}
