// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewFrame, PlayedFrames, Repaint } from './bridgeanim';
import { headBoxes, repaintAnim } from './cardrepaint';
import type { CardChecks } from './cardchecks';
import type { Generator } from './generator';
import type { Models } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import type { ArtCache } from './cache';
import type { ModelsFile } from './models';
import { labToRgb, rgbToLab } from './portrait';
import { parseRecipe, type BridgeCrewRecipe, type CardRecipe } from './recipe';
import { refFile } from './refs';
import { checkPins, choiceFor } from './run';
import { modelsFor } from './select';

/** The card recipe repaintAnim paints a bridge crew frame with: one frame a canvas. */
export function cardFor(r: BridgeCrewRecipe): CardRecipe {
  return {
    ...r,
    id: r.id,
    kind: 'card',
    repaint: true,
    anims: 'used',
    group: 1,
    groupOverrides: {},
    seedOverrides: {},
    checks: gateChecks(r),
  };
}

/** The card checks a bridge strip is gated on (gateStrip): the recipe's absolute limits, and no flicker ratio. */
export function gateChecks(r: BridgeCrewRecipe): CardChecks {
  return { flickerRatio: Infinity, flickerMax: r.checks.flickerMax, deltaE: r.checks.deltaE, ...(r.checks.speckle !== undefined ? { speckle: r.checks.speckle } : {}) };
}

/**
 * What a frame's first (whole figure) repaint depends on in the recipe's text: everything but its comments and the keys that only change what
 * is done after it (`face`, `hold`, `checks`, `fixups`, on one line or as an indented block or list), so a face pass, a hold, a fix-up or a gate
 * tried another way doesn't paint the figure again.
 */
export const paintText = (text: string): string =>
  text.replace(/^\s*#.*$/gm, '').replace(/^(face|hold|checks|fixups|master):.*(\n(?:[ \t]+|-[ \t]).*)*/gm, '').replace(/\n+/g, '\n').trim();

type FaceSpec = NonNullable<BridgeCrewRecipe['face']>;

/** An image resized to `width` x `height`, bilinear (the head pass's crops brought to one size for a shared canvas). */
function resized(img: Rgba, width: number, height: number): Rgba {
  if (img.width === width && img.height === height) return img;
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, ((y + 0.5) * img.height) / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, ((x + 0.5) * img.width) / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const v = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 4 + c]!;
        out.data[(y * width + x) * 4 + c] = Math.round((v(y0, x0) * (1 - tx) + v(y0, x1) * tx) * (1 - ty) + (v(y1, x0) * (1 - tx) + v(y1, x1) * tx) * ty);
      }
    }
  }
  return out;
}

/** Images side by side, top-aligned: a cache file for several at once. */
function besideEachOther(imgs: Rgba[]): Rgba {
  const width = imgs.reduce((s, i) => s + i.width, 0);
  const height = Math.max(...imgs.map(i => i.height));
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  let x0 = 0;
  for (const img of imgs) {
    for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * width + x0) * 4);
    x0 += img.width;
  }
  return out;
}

/** A box of an image, as an image of its own. */
function cropOf(img: Rgba, box: { x: number; y: number; w: number; h: number }): Rgba {
  const out: Rgba = { width: box.w, height: box.h, data: new Uint8Array(box.w * box.h * 4) };
  for (let y = 0; y < box.h; y++) out.data.set(img.data.subarray(((box.y + y) * img.width + box.x) * 4, ((box.y + y) * img.width + box.x + box.w) * 4), y * box.w * 4);
  return out;
}

/** The head pass's crop of a frame: its head box grown by `pad` each side, square where the frame has room, in the frame's pixels. */
export function faceBox(frame: Rgba, pad: number): { x: number; y: number; w: number; h: number } | null {
  const [hx, hy, hw, hh] = headBoxes([frame])[0]!;
  if (hw === 0 || hh === 0) return null;
  const side = Math.round(Math.max(hw, hh) * (1 + 2 * pad));
  const x = Math.max(0, Math.min(frame.width - side, Math.round(hx + hw / 2 - side / 2)));
  const y = Math.max(0, Math.min(frame.height - side, Math.round(hy + hh / 2 - side / 2)));
  return { x, y, w: Math.min(side, frame.width - x), h: Math.min(side, frame.height - y) };
}

/**
 * Blends the head pass's crop back into the frame: full weight inside, falling to 0 over `feather` of the box's size at its edges (an edge on the
 * frame's own border takes it whole there). Colour only: the alpha stays the frame's.
 */
export function blendFace(frame: Rgba, face: Rgba, box: { x: number; y: number; w: number; h: number }, feather: number): Rgba {
  const out: Rgba = { width: frame.width, height: frame.height, data: new Uint8Array(frame.data) };
  const f = Math.max(1, feather * Math.max(box.w, box.h));
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const edges = [box.x > 0 ? x + 0.5 : Infinity, box.x + box.w < frame.width ? box.w - x - 0.5 : Infinity, box.y > 0 ? y + 0.5 : Infinity, box.y + box.h < frame.height ? box.h - y - 0.5 : Infinity];
      const t = Math.min(1, Math.min(...edges) / f);
      const s = t * t * (3 - 2 * t);
      const o = ((box.y + y) * frame.width + box.x + x) * 4;
      const k = (y * box.w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(frame.data[o + c]! * (1 - s) + face.data[k + c]! * s);
    }
  }
  return out;
}

/** The head pass's card: the face references alone, acting over the whole crop, at the face pass's denoise. */
export function faceCard(r: BridgeCrewRecipe, face: FaceSpec): CardRecipe {
  return { ...cardFor(r), denoise: face.denoise, reference: r.reference.filter(x => x.model === 'face').map(x => ({ ...x, mask: 'figure' as const, weight: face.weight ?? x.weight })) };
}
/** The face references' bytes from all of them (in the recipe's order). */
const faceRefs = (r: BridgeCrewRecipe, refs: Uint8Array[]): Uint8Array[] => {
  let at = 0;
  return r.reference.flatMap(x => {
    const mine = refs.slice(at, at + x.refs.length);
    at += x.refs.length;
    return x.model === 'face' ? mine : [];
  });
};

/** Where a frame's top left is, in upscaled pixels from the origin. */
const corner = (f: CrewFrame, scale: number): [number, number] => [(f.dx - Math.trunc(f.png.width / scale / 2)) * scale, (f.dy - f.png.height / scale) * scale];

/** Which pixels of `f` are the same as in `base` at the same place from the origin: for each, base's pixel offset, else -1 (or -2 where `f` is clear). */
function stillAgainst(f: CrewFrame, base: CrewFrame, scale: number, tolerance: number): { from: Int32Array; count: number } {
  const { width: w, height: h } = f.png;
  const [bx, by] = corner(base, scale);
  const [fx, fy] = corner(f, scale);
  const from = new Int32Array(w * h).fill(-1);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = f.png.data[o + 3]!;
      if (a === 0) {
        from[y * w + x] = -2;
        continue;
      }
      const u = fx + x - bx;
      const v = fy + y - by;
      if (u < 0 || v < 0 || u >= base.png.width || v >= base.png.height) continue;
      const p = (v * base.png.width + u) * 4;
      if (base.png.data[p + 3] !== a) continue;
      if (Math.abs(base.png.data[p]! - f.png.data[o]!) > tolerance || Math.abs(base.png.data[p + 1]! - f.png.data[o + 1]!) > tolerance || Math.abs(base.png.data[p + 2]! - f.png.data[o + 2]!) > tolerance) continue;
      from[y * w + x] = p;
      count++;
    }
  }
  return { from, count };
}

/** Each pixel's distance to the nearest that differs (`from` -1): a two-pass chamfer, 1 straight and 1.4 diagonal; 1e9 with none. */
export function distanceToDiffering(from: Int32Array, w: number, h: number): Float32Array {
  const dist = new Float32Array(w * h).fill(1e9);
  for (let k = 0; k < w * h; k++) if (from[k] === -1) dist[k] = 0;
  const relax = (k: number, x: number, y: number, dx: number, dy: number, cost: number): void => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
    const d = dist[ny * w + nx]! + cost;
    if (d < dist[k]!) dist[k] = d;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      relax(k, x, y, -1, 0, 1);
      relax(k, x, y, 0, -1, 1);
      relax(k, x, y, -1, -1, 1.4);
      relax(k, x, y, 1, -1, 1.4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      relax(k, x, y, 1, 0, 1);
      relax(k, x, y, 0, 1, 1);
      relax(k, x, y, 1, 1, 1.4);
      relax(k, x, y, -1, 1, 1.4);
    }
  }
  return dist;
}

/** How a frame is painted from a master (BridgeCrewRecipe.master), with the hold's tolerance for "the same pixel". */
export interface MasterOpts {
  maxChange: number;
  grow: number;
  feather: number;
  tolerance: number;
  /** With MasterPainters.heads: how many heads are painted together on one canvas. */
  headGroup?: number;
}

/** The ways a frame is painted: whole (a master), or only where `mask` says (0-1 a pixel) over `init`; and, optionally, heads in groups. */
export interface MasterPainters {
  whole(frame: CrewFrame): Promise<Rgba>;
  /** `master` is the master's paint, for a painter that takes its likeness from it. */
  part(init: Rgba, mask: Float32Array, master: Rgba): Promise<Rgba>;
  /**
   * The head pass over several painted frames at once (one canvas: they come out as one face), each back with its head repainted. With it,
   * `whole` paints the body alone, and the heads of the masters and of every frame whose head moved (`headMoved`) are painted here, a master's
   * with those of its own frames.
   */
  heads?(bodies: Rgba[]): Promise<Rgba[]>;
  headMoved?(frame: Rgba, mask: Float32Array): boolean;
}

/** A frame's place in the plan: a master of its own, or painted from master `master` where `from` maps its unchanged pixels, repainting `mask`. */
type Planned = { master: null } | { master: number; from: Int32Array; mask: Float32Array; changed: number };

/**
 * Which frames are masters and how every other frame comes from one (paintFromMasters). Each frame is matched against every master so far, at the
 * same place from the origin (stillAgainst: a pixel the same in both, alpha and colour within `tolerance`); the one it shares most with is its
 * master if no more than `maxChange` of its figure differs, and otherwise it is a master itself. A frame's mask is 1 on what differs and `grow`
 * round it, falling to 0 over `feather`.
 */
export function planMasters(frames: CrewFrame[], scale: number, o: MasterOpts): Planned[] {
  const plan: Planned[] = [];
  const masters: number[] = [];
  for (const f of frames) {
    const { width: w, height: h } = f.png;
    let opaque = 0;
    for (let k = 0; k < w * h; k++) if (f.png.data[k * 4 + 3]! > 0) opaque++;
    let best: { j: number; from: Int32Array; changed: number } | null = null;
    for (const j of masters) {
      const s = stillAgainst(f, frames[j]!, scale, o.tolerance);
      let changed = 0;
      for (let k = 0; k < w * h; k++) if (s.from[k] === -1) changed++;
      if (!best || changed < best.changed) best = { j, from: s.from, changed };
    }
    if (!best || opaque === 0 || best.changed / opaque > o.maxChange) {
      masters.push(plan.length);
      plan.push({ master: null });
      continue;
    }
    const dist = distanceToDiffering(best.from, w, h);
    const mask = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) mask[k] = dist[k]! <= o.grow ? 1 : Math.max(0, 1 - (dist[k]! - o.grow) / o.feather);
    plan.push({ master: best.j, from: best.from, mask, changed: best.changed });
  }
  return plan;
}

/** A frame from its master's paint where it is the same, and `own` elsewhere and as `mask` says; the alpha is the frame's own. */
function fromMaster(frame: Rgba, base: Rgba, from: Int32Array, mask: Float32Array, own: Rgba): Rgba {
  const out: Rgba = { width: frame.width, height: frame.height, data: new Uint8Array(frame.data) };
  for (let k = 0; k < frame.width * frame.height; k++) {
    const q = from[k]!;
    const m = q >= 0 ? mask[k]! : 1;
    for (let c = 0; c < 3; c++) out.data[k * 4 + c] = Math.round((q >= 0 ? base.data[q + c]! : own.data[k * 4 + c]!) * (1 - m) + own.data[k * 4 + c]! * m);
  }
  return out;
}

/**
 * Paints a sprite's distinct frames from masters (planMasters). A master is painted whole. A frame with a master starts from the master's paint
 * where they are the same and its own upscale where they differ, and only its mask is repainted; the pixels that stay the same are the master's
 * paint exactly, so nothing that doesn't move can change between frames. The alpha is always the frame's own. With `heads`, the heads are
 * painted last, a master's together with those of its frames whose head moved, `headGroup` to a canvas, and a frame whose head stayed takes its
 * master's.
 */
export async function paintFromMasters(frames: CrewFrame[], scale: number, o: MasterOpts, p: MasterPainters, log?: (line: string) => void): Promise<Rgba[]> {
  const plan = planMasters(frames, scale, o);
  const bodies: Rgba[] = [];
  for (const [i, f] of frames.entries()) {
    const at = plan[i]!;
    if (at.master === null) {
      log?.(`frame ${i + 1}/${frames.length}: a master`);
      bodies.push(await p.whole(f));
      continue;
    }
    const init = fromMaster(f.png, bodies[at.master]!, at.from, new Float32Array(at.mask.length), f.png);
    if (at.changed === 0) {
      log?.(`frame ${i + 1}/${frames.length}: the same as master ${at.master + 1}`);
      bodies.push(init);
      continue;
    }
    let opaque = 0;
    for (let k = 3; k < f.png.data.length; k += 4) if (f.png.data[k]! > 0) opaque++;
    log?.(`frame ${i + 1}/${frames.length}: from master ${at.master + 1}, ${((100 * at.changed) / Math.max(1, opaque)).toFixed(0)}% repainted`);
    bodies.push(fromMaster(f.png, bodies[at.master]!, at.from, at.mask, await p.part(init, at.mask, bodies[at.master]!)));
  }
  if (!p.heads) return bodies;
  // the heads: each master's with those of its frames whose head moved, a canvas of headGroup at a time
  const out = [...bodies];
  const groupSize = Math.max(1, o.headGroup ?? 4);
  for (const [m, at] of plan.entries()) {
    if (at.master !== null) continue;
    const mine = [m, ...plan.flatMap((q, i) => (q.master === m && q.changed > 0 && (p.headMoved?.(bodies[i]!, q.mask) ?? true) ? [i] : []))];
    for (let s = 0; s < mine.length; s += groupSize) {
      const chunk = mine.slice(s, s + groupSize);
      log?.(`heads of frames ${chunk.map(i => i + 1).join(', ')} painted together`);
      const headed = await p.heads(chunk.map(i => bodies[i]!));
      chunk.forEach((i, k) => (out[i] = headed[k]!));
    }
  }
  // (a frame whose head was not painted takes its master's, finished: what it shares with it is the master's; what moved stays its own)
  for (const [i, at] of plan.entries()) {
    if (at.master === null || out[i] !== bodies[i]) continue;
    out[i] = fromMaster(frames[i]!.png, out[at.master]!, at.from, at.mask, bodies[i]!);
  }
  return out;
}

/**
 * Holds what doesn't move on an earlier frame's repaint. Each frame after the first is matched against every earlier one, at the same place
 * from the origin, and held on the one it has most in common with (a talking frame on the last mouth, not on an idle pose drawn anew): a pixel
 * the two share (alpha equal and not clear, each colour channel of the upscaled frames within `tolerance`) takes that frame's held repaint;
 * its weight rises from 0 to 1 over `feather` upscaled pixels from the nearest pixel that differs, so the moving part (a mouth, a head that
 * turns) keeps its own repaint and blends in. The alpha is each frame's own. The first frame, and a frame with nothing in common with any
 * earlier one, come back as painted.
 */
export function holdStill(frames: CrewFrame[], painted: Rgba[], scale: number, hold: { tolerance: number; feather: number }): Rgba[] {
  if (frames.length !== painted.length) throw new Error('holdStill: a repaint for each frame');
  if (frames.length === 0 || hold.feather <= 0) return painted;
  const held: Rgba[] = [];
  frames.forEach((f, i) => {
    const rep = painted[i]!;
    let best: { j: number; from: Int32Array; count: number } | null = null;
    for (let j = 0; j < i; j++) {
      const s = stillAgainst(f, frames[j]!, scale, hold.tolerance);
      if (s.count > 0 && (!best || s.count > best.count)) best = { j, ...s };
    }
    if (!best) {
      held.push(rep);
      return;
    }
    const { width: w, height: h } = f.png;
    const { from } = best;
    const baseRep = held[best.j]!;
    const dist = distanceToDiffering(from, w, h);
    const out: Rgba = { width: w, height: h, data: new Uint8Array(rep.data) };
    for (let k = 0; k < w * h; k++) {
      const p = from[k]!;
      if (p < 0) continue;
      const t = Math.min(1, dist[k]! / hold.feather);
      for (let c = 0; c < 3; c++) out.data[k * 4 + c] = Math.round(rep.data[k * 4 + c]! * (1 - t) + baseRep.data[p + c]! * t);
    }
    held.push(out);
  });
  return held;
}

type Fixup = NonNullable<BridgeCrewRecipe['fixups']>[number];

/** A fix-up's box edge is blended over this many pixels, so no box shows. */
const FIXUP_FEATHER = 2;
/** A tone fix-up's lightness bands (CIELAB L, 0-100), and how much of each pixel's own a, b deviation from its band's mean it keeps. */
const TONE_BANDS = 10;
const TONE_KEEP = 0.3;

/**
 * A tone fix-up's colours for the target's pixels (their offsets), from the source's, in CIELAB. The lightness is matched by rank (each
 * pixel takes the source's lightness at its own rank), then the chroma by lightness band: a pixel's a, b go to the source band's mean, keeping
 * TONE_KEEP of its own deviation from its band's. A tint the head pass gave one frame (a green-yellow face with violet eyes, the highlights the
 * most off) is in its bands' means, so it goes, and the face's own shading stays. A band either frame lacks takes the frame's overall mean.
 */
function tone(target: Rgba, source: Rgba, targets: readonly number[], sources: readonly number[]): Map<number, number[]> {
  const lab = (img: Rgba, i: number): number[] => rgbToLab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
  const mine = targets.map(o => lab(target, o));
  const theirs = sources.map(p => lab(source, p));
  const ranks = mine.map((_, i) => i).sort((x, y) => mine[x]![0]! - mine[y]![0]!);
  const ls = theirs.map(v => v[0]!).sort((x, y) => x - y);
  const L = new Array<number>(mine.length);
  ranks.forEach((i, r) => (L[i] = ls[Math.round((r / Math.max(1, ranks.length - 1)) * (ls.length - 1))]!));
  const band = (l: number): number => Math.max(0, Math.min(TONE_BANDS - 1, Math.floor((l / 100) * TONE_BANDS)));
  const means = (v: number[][], lightness: (i: number) => number): number[][] => {
    const sum = Array.from({ length: TONE_BANDS + 1 }, () => [0, 0, 0]);
    v.forEach((x, i) => { for (const k of [band(lightness(i)), TONE_BANDS]) (sum[k]![0]! += x[1]!, sum[k]![1]! += x[2]!, sum[k]![2]!++); });
    return sum.map((m, k) => (m[2]! > 0 ? [m[0]! / m[2]!, m[1]! / m[2]!] : sum[TONE_BANDS]!.slice(0, 2).map(t => t / Math.max(1, sum[TONE_BANDS]![2]!))));
  };
  const A = means(mine, i => L[i]!);
  const B = means(theirs, i => theirs[i]![0]!);
  const out = new Map<number, number[]>();
  targets.forEach((o, i) => {
    const k = band(L[i]!);
    out.set(o, labToRgb(L[i]!, B[k]![0]! + TONE_KEEP * (mine[i]![1]! - A[k]![0]!), B[k]![1]! + TONE_KEEP * (mine[i]![2]! - A[k]![1]!)));
  });
  return out;
}

/**
 * The recipe's colour fix-ups (a flaw one frame's paint has): each changes the colour in its box of frame `frame` of animation `anim` from frame
 * `from` of the same animation. The box is in the animation's cell pixels, as its published strip has them, and the frames are placed in it as
 * packAnim lays them out. A frame other animations play too is fixed in them as well. Only opaque pixels of both frames take part, the alpha is
 * never touched, and the box's edge is blended in over FIXUP_FEATHER pixels.
 * - `copy` (a black mouth, a stray fleck): the source's colour at the same place.
 * - `tone` (a face drawn in the wrong tint, a pose that won't line up for a copy): the box's colours matched to the source box's (tone).
 * The sources are the paints as they came; two fix-ups on one frame apply in the recipe's order (a tone, then a copy over its eyes). A fix-up
 * that changes nothing (a box off both frames, or on pixels that already match) throws: it is a recipe error.
 */
export function applyFixups(frames: CrewFrame[], painted: Rgba[], scale: number, fixups: readonly Fixup[], played: readonly PlayedFrames[], id = 'the recipe'): Rgba[] {
  const out = [...painted];
  for (const fx of fixups) {
    const anim = played.find(p => p.anim === fx.anim);
    if (!anim) throw new Error(`${id}: fixup: no animation ${fx.anim}`);
    const t = anim.frames[fx.frame];
    const s = anim.frames[fx.from];
    if (t === undefined || s === undefined) throw new Error(`${id}: fixup: animation ${fx.anim} has ${anim.frames.length} frames (frame ${fx.frame}, from ${fx.from})`);
    const dst = out[t] === painted[t] ? { ...painted[t]!, data: new Uint8Array(painted[t]!.data) } : out[t]!;
    const from = dst;
    const src = painted[s]!;
    // (the cell's top left is the animation's frames' least corner, as packAnim lays them out)
    const corners = anim.frames.map(i => corner(frames[i]!, scale));
    const left = Math.min(...corners.map(c => c[0]));
    const top = Math.min(...corners.map(c => c[1]));
    const [tx, ty] = corner(frames[t]!, scale);
    const [sx, sy] = corner(frames[s]!, scale);
    const [bx, by, bw, bh] = fx.box;
    // (each box pixel's offset in the target (o) and in the source (p), -1 where that frame has no opaque pixel there)
    const at = (img: Rgba, x: number, y: number): number => (x < 0 || y < 0 || x >= img.width || y >= img.height || img.data[(y * img.width + x) * 4 + 3] === 0 ? -1 : (y * img.width + x) * 4);
    const cells: { o: number; p: number; w: number }[] = [];
    for (let cy = by; cy < by + bh; cy++)
      for (let cx = bx; cx < bx + bw; cx++) {
        const edge = Math.min(cx - bx, bx + bw - 1 - cx, cy - by, by + bh - 1 - cy);
        cells.push({ o: at(from, cx + left - tx, cy + top - ty), p: at(src, cx + left - sx, cy + top - sy), w: Math.min(1, (edge + 1) / (FIXUP_FEATHER + 1)) });
      }
    // (a copy takes the pixels both frames have; a tone, every pixel the target has, from every pixel the source has: the poses differ)
    const toning = (fx.mode ?? 'copy') === 'tone';
    const sources = cells.filter(e => e.p >= 0).map(e => e.p);
    const live = sources.length === 0 ? [] : cells.filter(e => e.o >= 0 && (toning || e.p >= 0));
    const toned = toning && live.length > 0 ? tone(from, src, live.map(e => e.o), sources) : null;
    const colour = (o: number, p: number, c: number): number => (toned ? toned.get(o)![c]! : src.data[p + c]!);
    let changed = 0;
    for (const { o, p, w } of live) {
      for (let c = 0; c < 3; c++) {
        const v = Math.round(Math.max(0, Math.min(255, from.data[o + c]! * (1 - w) + colour(o, p, c) * w)));
        if (v !== dst.data[o + c]) changed++;
        dst.data[o + c] = v;
      }
    }
    if (changed === 0) throw new Error(`${id}: fixup for animation ${fx.anim} frame ${fx.frame} changes nothing (its box is off the frames, or on pixels that already match)`);
    out[t] = dst;
  }
  return out;
}

export interface CrewRepaintDeps {
  generator: Generator;
  models: Models;
  recipe: BridgeCrewRecipe;
  /** The reference crops' bytes, in the order of the recipe's `reference[].refs`. */
  refs: Uint8Array[];
  /** What every frame's repaint depends on besides its own pixels: paintText, the models' and the references' hashes. */
  key: string;
  /** Where the painted frames are kept, by key and pixels. */
  dir: string;
  scale: number;
  log?: (line: string) => void;
}

/**
 * A bridge crew sprite's repaint (bridgeStrips' `repaint`): each distinct frame painted alone with the recipe's seed, its head painted again
 * larger when the recipe has a `face` pass (each pass kept by its key and input, and used again), its `fixups` applied (applyFixups), then held
 * on the earlier frames (holdStill).
 */
export function crewRepaint(d: CrewRepaintDeps): Repaint {
  return { checks: gateChecks(d.recipe), log: d.log, paint: async (frames, played = []) => {
    mkdirSync(d.dir, { recursive: true });
    const card = cardFor(d.recipe);
    const face = d.recipe.face;
    const stamp = `bridge-${d.recipe.object}-${process.pid}`;
    const cached = async (key: string, input: Rgba, paint: () => Promise<Rgba>): Promise<Rgba> => {
      const file = join(d.dir, `${createHash('sha256').update(key).update('\0').update(encodePng(input)).digest('hex')}.png`);
      if (existsSync(file)) return decodePng(new Uint8Array(readFileSync(file)));
      const t0 = Date.now();
      const out = await paint();
      writeFileSync(file, encodePng(out));
      made++;
      d.log?.(`${d.recipe.id}: frame ${painted.length + 1}/${frames.length} ${key === d.key ? 'painted' : 'face painted'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return out;
    };
    const painted: Rgba[] = [];
    let made = 0;
    /** The head pass (the recipe's `face`) over a painted frame, or the frame as it is without one. */
    const headPass = async (body: Rgba): Promise<Rgba> => {
      const box = face ? faceBox(body, face.pad) : null;
      if (!face || !box) return body;
      return cached(`${d.key}\0face=${JSON.stringify(face)}`, body, async () => {
        const [head] = await repaintAnim(d.generator, d.models, faceCard(d.recipe, face), [cropOf(body, box)], faceRefs(d.recipe, d.refs), { stamp });
        return blendFace(body, head!, box, face.feather);
      });
    };
    /** A frame painted whole, with its head pass. */
    const whole = async (f: CrewFrame): Promise<Rgba> => headPass(await cached(d.key, f.png, async () => (await repaintAnim(d.generator, d.models, card, [f.png], d.refs, { stamp }))[0]!));
    /** Whether a frame's mask touches its head box: its head moved. */
    const headMoved = (frame: Rgba, mask: Float32Array): boolean => {
      const box = face ? faceBox(frame, face.pad) : null;
      if (!box) return false;
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (mask[y * frame.width + x]! >= 1) return true;
      return false;
    };
    /** The head pass over several bodies on one canvas (master.headGroup): the crops brought to one size, painted together, and blended back. */
    const headsTogether = async (bodies: Rgba[]): Promise<Rgba[]> => {
      if (!face) return bodies;
      const boxes = bodies.map(b => faceBox(b, face.pad));
      const with_ = bodies.flatMap((_, i) => (boxes[i] ? [i] : []));
      if (with_.length === 0) return bodies;
      const side = Math.max(...with_.map(i => Math.max(boxes[i]!.w, boxes[i]!.h)));
      const crops = with_.map(i => resized(cropOf(bodies[i]!, boxes[i]!), side, side));
      const file = join(d.dir, `${createHash('sha256').update(`${d.key}\0faces=${JSON.stringify(face)}`).update('\0').update(encodePng(besideEachOther(crops))).digest('hex')}.png`);
      let heads: Rgba[];
      if (existsSync(file)) {
        const all = decodePng(new Uint8Array(readFileSync(file)));
        heads = crops.map((_, k) => cropOf(all, { x: k * side, y: 0, w: side, h: side }));
      } else {
        const t0 = Date.now();
        heads = await repaintAnim(d.generator, d.models, { ...faceCard(d.recipe, face), group: crops.length }, crops, faceRefs(d.recipe, d.refs), { stamp });
        writeFileSync(file, encodePng(besideEachOther(heads)));
        made++;
        d.log?.(`${d.recipe.id}: ${crops.length} heads painted together in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
      const out = [...bodies];
      with_.forEach((i, k) => {
        const box = boxes[i]!;
        out[i] = blendFace(bodies[i]!, resized(heads[k]!, box.w, box.h), box, face.feather);
      });
      return out;
    };
    /** A frame's body alone (the head comes later, with others: headsTogether). */
    const body = (f: CrewFrame): Promise<Rgba> => cached(d.key, f.png, async () => (await repaintAnim(d.generator, d.models, card, [f.png], d.refs, { stamp }))[0]!);
    const master = d.recipe.master;
    if (master) {
      const grouped = master.headGroup !== undefined && face !== undefined;
      const partCard = { ...card, denoise: master.denoise ?? card.denoise };
      // (faceFromMaster: the face references give way to the master's painted head)
      const ownFace = master.faceFromMaster && d.recipe.reference.some(x => x.model === 'face');
      if (ownFace) partCard.reference = d.recipe.reference.map(x => (x.model === 'face' ? { ...x, refs: ['master'], weight: master.faceWeight ?? x.weight } : x));
      const partRefs = (base: Rgba): Uint8Array[] => {
        if (!ownFace) return d.refs;
        const box = faceBox(base, d.recipe.face?.pad ?? 0.3);
        const head = box ? encodePng(cropOf(base, box)) : encodePng(base);
        let at = 0;
        return d.recipe.reference.flatMap(x => {
          const mine = d.refs.slice(at, at + x.refs.length);
          at += x.refs.length;
          return x.model === 'face' ? [head] : mine;
        });
      };
      const out = await paintFromMasters(frames, d.scale, { ...master, tolerance: d.recipe.hold.tolerance }, {
        whole: async f => {
          const p = grouped ? await body(f) : await whole(f);
          painted.push(p);
          return p;
        },
        ...(grouped ? { heads: headsTogether, headMoved } : {}),
        part: async (init, mask, base) => {
          const maskKey = createHash('sha256').update(new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength)).digest('hex');
          const baseKey = ownFace ? createHash('sha256').update(base.data).digest('hex') : '';
          let p = await cached(`${d.key}\0part=${JSON.stringify(master)}\0${maskKey}\0${baseKey}`, init, async () => (await repaintAnim(d.generator, d.models, partCard, [init], partRefs(base), { stamp, masks: [mask] }))[0]!);
          // (facePass: a head that moved is painted again as a master's is)
          if (!grouped && master.facePass && headMoved(init, mask)) p = await headPass(p);
          painted.push(p);
          return p;
        },
      }, line => d.log?.(`${d.recipe.id}: ${line}`));
      if (made === 0) d.log?.(`${d.recipe.id}: ${frames.length} frames, all painted before`);
      // (the recipe's colour fix-ups, as without masters: a flaw one frame's paint has)
      return applyFixups(frames, out, d.scale, d.recipe.fixups ?? [], played, d.recipe.id);
    }
    for (const f of frames) painted.push(await whole(f));
    if (made === 0) d.log?.(`${d.recipe.id}: ${frames.length} frames, all painted before`);
    return holdStill(frames, applyFixups(frames, painted, d.scale, d.recipe.fixups ?? [], played, d.recipe.id), d.scale, d.recipe.hold);
  } };
}

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/**
 * The repaint for a bridge object, from its recipe (`<recipes>/bridgecrew.<object>.yaml`), or undefined when it has none (its strips are the
 * upscaled frames). The models it uses are checked against their pins first, and with the references they are in each frame's key.
 */
export async function recipeRepaint(recipes: string, object: string, deps: RepaintDeps): Promise<Repaint | undefined> {
  const file = join(recipes, `bridgecrew.${object}.yaml`);
  return existsSync(file) ? repaintFromFile(file, object, deps) : undefined;
}

type RepaintDeps = { generator: Generator; models: ModelsFile; cache: ArtCache; scale: number; log?: (line: string) => void };

/** The repaint a bridge crew recipe file describes, for `object` (recipeRepaint's, and `art bridge trial`'s from a file of its own). */
export async function repaintFromFile(file: string, object: string, deps: RepaintDeps): Promise<Repaint> {
  const text = readFileSync(file, 'utf8');
  const recipe = parseRecipe(text, file);
  if (recipe.kind !== 'bridgecrew' || recipe.object !== object) throw new Error(`${file} is not the bridge crew recipe for ${object}`);
  const choice = choiceFor(recipe, deps.models);
  const need = new Set<string>(recipe.reference.map(r => (r.model === 'style' ? 'ipadapterStyle' : 'ipadapterFace')));
  if (need.size > 0) need.add('clipVision');
  const core = ['checkpoint', 'vae', 'lora', 'depth', 'lineart', 'depthAnnotator', 'lineartAnnotator', 'upscaler'] as const;
  const used = await checkPins(choice, { generator: deps.generator, models: deps.models, cache: deps.cache, external: !!process.env.COMFY_URL, warn: deps.log }, [...core, ...(need as Set<never>)]);
  const refsDir = join(deps.cache.root, 'refs');
  const refs = recipe.reference.flatMap(r => r.refs).map(id => new Uint8Array(readFileSync(refFile(refsDir, id))));
  const key = [paintText(text), JSON.stringify(used), ...refs.map(sha)].join('\0');
  return crewRepaint({ generator: deps.generator, models: modelsFor(deps.models, choice), recipe, refs, key, dir: join(deps.cache.work, 'cards', 'bridge-crew', 'repaint', object), scale: deps.scale, log: deps.log });
}
