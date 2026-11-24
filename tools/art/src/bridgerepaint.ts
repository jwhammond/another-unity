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
  text.replace(/^\s*#.*$/gm, '').replace(/^(face|hold|checks|fixups):.*(\n(?:[ \t]+|-[ \t]).*)*/gm, '').replace(/\n+/g, '\n').trim();

type FaceSpec = NonNullable<BridgeCrewRecipe['face']>;

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
    // (the distance to the nearest pixel that differs: a two-pass chamfer, 1 straight and 1.4 diagonal)
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
    for (const f of frames) {
      let out = await cached(d.key, f.png, async () => (await repaintAnim(d.generator, d.models, card, [f.png], d.refs, { stamp }))[0]!);
      const box = face ? faceBox(out, face.pad) : null;
      if (face && box) {
        const body = out;
        out = await cached(`${d.key}\0face=${JSON.stringify(face)}`, body, async () => {
          const crop: Rgba = { width: box.w, height: box.h, data: new Uint8Array(box.w * box.h * 4) };
          for (let y = 0; y < box.h; y++) crop.data.set(body.data.subarray(((box.y + y) * body.width + box.x) * 4, ((box.y + y) * body.width + box.x + box.w) * 4), y * box.w * 4);
          const [head] = await repaintAnim(d.generator, d.models, faceCard(d.recipe, face), [crop], faceRefs(d.recipe, d.refs), { stamp });
          return blendFace(body, head!, box, face.feather);
        });
      }
      painted.push(out);
    }
    if (made === 0) d.log?.(`${d.recipe.id}: ${frames.length} frames, all painted before`);
    return holdStill(frames, applyFixups(frames, painted, d.scale, d.recipe.fixups ?? [], played, d.recipe.id), d.scale, d.recipe.hold);
  } };
}

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/**
 * The repaint for a bridge object, from its recipe (`<recipes>/bridgecrew.<object>.yaml`), or undefined when it has none (its strips are the
 * upscaled frames). The models it uses are checked against their pins first, and with the references they are in each frame's key.
 */
export async function recipeRepaint(recipes: string, object: string, deps: { generator: Generator; models: ModelsFile; cache: ArtCache; scale: number; log?: (line: string) => void }): Promise<Repaint | undefined> {
  const file = join(recipes, `bridgecrew.${object}.yaml`);
  if (!existsSync(file)) return undefined;
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
