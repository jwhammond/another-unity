// SPDX-License-Identifier: GPL-3.0-or-later
import { typeOne, typeTwo } from './shipsprite';

/**
 * The animations of engine.spr, which the astrogation course panel runs (drawCoursePanel, engineFrame; sprite.cpp parseBlock): the picture of the
 * engines under Engage and Stop, a few frames each. A sprite is SPRT(u32, LIST(count, offsets, blocks...)); each offset starts an animation, whose
 * frames are the COMP blocks up to the JUMP or EXIT that ends it. A frame can be the same picture as an earlier block (type 3).
 */
export interface EngineFrame {
  width: number; height: number; indices: Uint8Array;
  /** How long the frame shows, from the TIME block after it (sprite.cpp: a wait of 0x10 ticks to the millisecond is `waitMillis`); absent with none. */
  waitMs?: number;
  /** The animation's POSN: where the original draws it (its bottom centre), replacing the object's. */
  at?: [number, number];
}

/** A TIME block's wait in milliseconds (the original's ticks of 291 a second, in sixteenths: sprite.cpp update). */
const waitMillis = (wait: number): number => Math.round(((wait >> 4) * 10000) / 2913);

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** The frames of animation `anim` of a sprite (what `engineFrame(anim, n)` finds): every picture from its start to the first jump or exit. */
export function spriteAnimation(bytes: Uint8Array, anim: number, stopAtPause = false): EngineFrame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== 'TRPS') throw new Error('not a sprite (no SPRT)');
  if (tag(bytes, 12) !== 'TSIL') throw new Error('the sprite has no LIST');
  const listStart = 12 + 8;
  const count = view.getUint32(listStart, true);
  if (anim < 0 || anim >= count) throw new Error(`the sprite has no animation ${anim}`);
  const listEnd = 12 + view.getUint32(16, true);
  const offsets = Array.from({ length: count }, (_, i) => view.getUint32(listStart + 4 + 4 * i, true));
  const offset = offsets[anim]!;
  if (offset === 0) return [];
  const first = 12 + offset;
  const images = new Map<number, EngineFrame>();
  const frames: EngineFrame[] = [];
  let ended = false;
  let at: [number, number] | undefined;
  let pos = listStart + 4 + 4 * count;
  while (pos + 8 <= listEnd) {
    const kind = tag(bytes, pos);
    const size = view.getUint32(pos + 4, true);
    if (size < 8) throw new Error('bad block size');
    // (SCOM, a speech picture, is read as COMP is: sprite.cpp marks it as speech, but it is a picture all the same)
    if (kind === 'PMOC' || kind === 'MOCS') {
      const width = view.getUint32(pos + 8, true), height = view.getUint32(pos + 12, true), type = view.getUint16(pos + 18, true);
      let frame: EngineFrame;
      if (type === 3) {
        const original = images.get(pos - view.getUint32(pos + 20, true));
        if (!original) throw new Error('sprite frame refers to a missing frame');
        frame = original;
      } else if (type === 1 || type === 2) {
        const data = bytes.subarray(pos + 8 + 12, pos + size);
        frame = { width, height, indices: type === 1 ? typeOne(data, width, height) : typeTwo(data, width * height) };
        images.set(pos, frame);
      } else {
        throw new Error(`unknown image type ${type}`);
      }
      if (pos >= first && !ended) frames.push(frame);
    } else if (pos >= first && !ended && kind === 'EMIT' && frames.length > 0) {
      frames[frames.length - 1] = { ...frames[frames.length - 1]!, waitMs: waitMillis(view.getUint32(pos + 8, true)) };
    } else if (pos >= first && !ended && kind === 'NSOP') {
      at = [view.getUint32(pos + 8, true), view.getUint32(pos + 12, true)];
    } else if (pos >= first && (kind === 'PMUJ' || kind === 'TIXE' || (stopAtPause && kind === 'SUAP'))) {
      ended = true;
    }
    pos += size;
    if (ended) break;
  }
  // (a POSN after the picture, as tdoor.spr has it, still places it: the sprite is drawn after the whole entry list of a step has run)
  return at ? frames.map(f => ({ ...f, at })) : frames;
}
