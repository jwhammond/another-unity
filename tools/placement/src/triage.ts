// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Triage of the sprites `compare` reports as `no-art` / `later-no-art`: does the published art need anything for them?
 * The classifier is pure (pixels in, a bucket out); the CLI feeds it the sprite's frames, the room's original background and its rect.
 */

export interface Pixels {
  width: number;
  height: number;
  /** 4 bytes per pixel. */
  data: Uint8Array;
}

export type Bucket = 'in-plate' | 'static-missing' | 'animated' | 'invisible';

export interface Triage {
  bucket: Bucket;
  /** One short phrase: what decided it. */
  why: string;
}

/** Fewer opaque pixels than this (at the drawn scale) and the sprite is a speck. */
export const TINY_PIXELS = 16;
/** A pixel of the sprite matches the background when every channel is within this. */
export const MATCH_TOLERANCE = 24;
/** The share of a sprite's opaque pixels that must match the background for it to be baked in. */
export const MATCH_SHARE = 0.9;
/** Two frames are the same picture when this share of their pixels (alpha and colour) are within `MATCH_TOLERANCE`. */
export const SAME_SHARE = 0.98;

function opaque(f: Pixels, i: number): boolean {
  return f.data[i * 4 + 3]! >= 128;
}

export function opaqueCount(f: Pixels): number {
  let n = 0;
  for (let i = 0; i < f.width * f.height; i++) if (opaque(f, i)) n++;
  return n;
}

/** Share of the frame's opaque pixels that the background shows within tolerance at `rect` ([x, y, w, h], the frame's own size). Off-screen pixels do not match. */
export function backgroundMatch(frame: Pixels, bg: Pixels, rect: [number, number, number, number]): number {
  let total = 0;
  let hit = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = y * frame.width + x;
      if (!opaque(frame, i)) continue;
      total++;
      const bx = rect[0] + x;
      const by = rect[1] + y;
      if (bx < 0 || by < 0 || bx >= bg.width || by >= bg.height) continue;
      const b = (by * bg.width + bx) * 4;
      if (Math.abs(frame.data[i * 4]! - bg.data[b]!) <= MATCH_TOLERANCE && Math.abs(frame.data[i * 4 + 1]! - bg.data[b + 1]!) <= MATCH_TOLERANCE && Math.abs(frame.data[i * 4 + 2]! - bg.data[b + 2]!) <= MATCH_TOLERANCE) hit++;
    }
  }
  return total === 0 ? 0 : hit / total;
}

/** Whether two frames show the same picture (same size, and almost every pixel alike in alpha and colour). */
export function sameFrame(a: Pixels, b: Pixels): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const n = a.width * a.height;
  let alike = 0;
  for (let i = 0; i < n; i++) {
    const oa = opaque(a, i);
    if (oa !== opaque(b, i)) continue;
    if (!oa || (Math.abs(a.data[i * 4]! - b.data[i * 4]!) <= MATCH_TOLERANCE && Math.abs(a.data[i * 4 + 1]! - b.data[i * 4 + 1]!) <= MATCH_TOLERANCE && Math.abs(a.data[i * 4 + 2]! - b.data[i * 4 + 2]!) <= MATCH_TOLERANCE)) alike++;
  }
  return alike / n >= SAME_SHARE;
}

export interface TriageInput {
  /** The frames the animation plays before it pauses or exits, in order (a looping animation's whole loop). */
  frames: Pixels[];
  /** Where the first frame is drawn (the original's pixels, scale 256). */
  rect: [number, number, number, number];
  /** The room's original background, 640x480; null when it could not be read. */
  background: Pixels | null;
  /** The scale (out of 256) the original draws it at; default 256. */
  scale?: number;
}

/** Sorts one sprite into the bucket that says what the art still needs. */
export function triage(input: TriageInput): Triage {
  const { frames, rect, background } = input;
  const scale = input.scale ?? 256;
  if (frames.length === 0) return { bucket: 'invisible', why: 'no frame' };
  if (scale < 8) return { bucket: 'invisible', why: `drawn at ${scale}/256` };
  const speck = TINY_PIXELS * (scale / 256) ** 2;
  const solid = frames.map(opaqueCount);
  if (Math.max(...solid) === 0) return { bucket: 'invisible', why: 'fully transparent' };
  if (Math.max(...solid) < speck) return { bucket: 'invisible', why: `${Math.max(...solid)} opaque pixels` };
  const distinct: Pixels[] = [];
  for (const f of frames) if (!distinct.some(d => sameFrame(d, f))) distinct.push(f);
  const matches = background ? distinct.map(f => backgroundMatch(f, background, rect)) : distinct.map(() => 0);
  const baked = matches.every(m => m >= MATCH_SHARE);
  if (baked) return { bucket: 'in-plate', why: `${distinct.length === 1 ? 'the frame' : `all ${distinct.length} frames`} match the background (${Math.round(Math.min(...matches) * 100)}%)` };
  if (distinct.length > 1) return { bucket: 'animated', why: `${distinct.length} distinct frames` };
  return { bucket: 'static-missing', why: `one frame, ${Math.round(matches[0]! * 100)}% of it in the background` };
}

export const BUCKETS: Bucket[] = ['in-plate', 'static-missing', 'animated', 'invisible'];
