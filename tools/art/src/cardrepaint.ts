// SPDX-License-Identifier: GPL-3.0-or-later
import { repaintGraph, type Models } from './graphs';
import type { Generator } from './generator';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import type { CardRecipe } from './recipe';
import { controlWindow } from './sigmas';
import { familyRepaintGraph, noiseFor, type FamilyModels } from './families';

/** Plan 15 R6: the canvas every group of frames is repainted on. */
export const CANVAS = 1024;
/** The figure's height, at most, on the canvas (a group of 4 wide frames is limited by width instead). */
const FIGURE = 930;
const GROUND = 128;
const OPAQUE = 128;

type Box = [number, number, number, number];

/**
 * Head boxes per frame, [x, y, w, h], from the sprite's alpha: the top 22% of the opaque height, as wide as the opaque pixels
 * there are, widened by 20%. A frame with no opaque pixel has an empty box.
 */
export function headBoxes(frames: Rgba[]): Box[] {
  return frames.map(f => {
    let top = f.height;
    let bottom = -1;
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        if (f.data[(y * f.width + x) * 4 + 3]! >= OPAQUE) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (bottom < 0) return [0, 0, 0, 0] as Box;
    const rows = Math.max(1, Math.round((bottom - top + 1) * 0.22));
    let x0 = f.width;
    let x1 = -1;
    for (let y = top; y < top + rows; y++) {
      for (let x = 0; x < f.width; x++) {
        if (f.data[(y * f.width + x) * 4 + 3]! >= OPAQUE) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
        }
      }
    }
    const w = x1 - x0 + 1;
    const grow = Math.round(w * 0.1);
    const left = Math.max(0, x0 - grow);
    const right = Math.min(f.width, x1 + 1 + grow);
    return [left, top, right - left, rows] as Box;
  });
}

/** Where a frame of the group went on the canvas. */
interface Slot {
  /** The crop (the animation's opaque union) in the cell, in the cell's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The slot on the canvas: the crop scaled to (cw, ch) at (cx, cy). */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
}

/** The smallest rectangle holding every pixel with alpha in any frame (shadow included). */
export function unionBox(frames: Rgba[]): { x: number; y: number; w: number; h: number } {
  const { width, height } = frames[0]!;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (const f of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (f.data[(y * width + x) * 4 + 3]! > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) throw new Error('a frame group with no pixels');
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function sampleBilinear(img: Rgba, fx: number, fy: number, out: number[]): void {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number, c: number): number => img.data[(Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4 + c]!;
  for (let c = 0; c < 4; c++) {
    out[c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
  }
}

/** Separable box blur of a 0..1 plane, `r` px each side, twice (about a Gaussian). */
function blur(plane: Float32Array, w: number, h: number, r: number): Float32Array {
  let src = plane;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]!;
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += src[y * w + Math.min(w - 1, x + r + 1)]! - src[y * w + Math.max(0, x - r)]!;
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
      }
    }
    src = out;
  }
  return src;
}

const planePng = (plane: Float32Array, size: number): Uint8Array => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([Math.round(plane[i]! * 255), Math.round(plane[i]! * 255), Math.round(plane[i]! * 255), 255], i * 4);
  return encodePng({ width: size, height: size, data });
};

export interface Canvas {
  /** The work canvas (frames over neutral grey). */
  png: Uint8Array;
  /** Attention masks: where the face reference acts (the heads) and where the body reference does (the figures), grey PNGs. */
  head: Uint8Array;
  figure: Uint8Array;
  slots: Slot[];
}

/**
 * R6 step 2: a group of consecutive frames of one animation, side by side on one CANVAS square. Each frame is cut to the
 * animation's opaque union (so a frame keeps its place in the walk), scaled by one factor so the figure is about 930 px
 * tall (less if four wide frames need the room), and laid over neutral grey. Two masks come with it.
 */
export function layoutCanvas(frames: Rgba[], crop: { x: number; y: number; w: number; h: number }): Canvas {
  const n = frames.length;
  const s = Math.min(FIGURE / crop.h, (CANVAS * 0.97) / (n * crop.w));
  const cw = Math.round(crop.w * s);
  const ch = Math.round(crop.h * s);
  const gap = Math.floor((CANVAS - n * cw) / (n + 1));
  const cy = Math.floor((CANVAS - ch) / 2);
  const data = new Uint8Array(CANVAS * CANVAS * 4);
  for (let i = 0; i < CANVAS * CANVAS; i++) data.set([GROUND, GROUND, GROUND, 255], i * 4);
  const head = new Float32Array(CANVAS * CANVAS);
  const figure = new Float32Array(CANVAS * CANVAS);
  const heads = headBoxes(frames);
  const slots: Slot[] = [];
  const px = [0, 0, 0, 0];
  frames.forEach((f, i) => {
    const cx = gap + i * (cw + gap);
    slots.push({ ...crop, cx, cy, cw, ch });
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        sampleBilinear(f, crop.x + (x + 0.5) / s - 0.5, crop.y + (y + 0.5) / s - 0.5, px);
        const a = px[3]! / 255;
        const o = ((cy + y) * CANVAS + cx + x) * 4;
        for (let c = 0; c < 3; c++) data[o + c] = Math.round(px[c]! * a + GROUND * (1 - a));
        if (px[3]! >= OPAQUE) figure[(cy + y) * CANVAS + cx + x] = 1;
      }
    }
    const [hx, hy, hw, hh] = heads[i]!;
    const x0 = Math.max(0, Math.round(cx + (hx - crop.x) * s));
    const x1 = Math.min(CANVAS, Math.round(cx + (hx + hw - crop.x) * s));
    const y0 = Math.max(0, Math.round(cy + (hy - crop.y) * s));
    const y1 = Math.min(CANVAS, Math.round(cy + (hy + hh - crop.y) * s));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) head[y * CANVAS + x] = 1;
  });
  return { png: encodePng({ width: CANVAS, height: CANVAS, data }), head: planePng(blur(head, CANVAS, CANVAS, 6), CANVAS), figure: planePng(blur(figure, CANVAS, CANVAS, 4), CANVAS), slots };
}

/**
 * R6 step 4 for one frame: the canvas's slot, area-downscaled to the frame's crop and set into a cell. The alpha is the
 * upscaled original's, exactly. Colour is the repaint where the frame is opaque and the original's where it is not (the
 * edge's antialiasing and the foot shadow keep the sprite's own colour, so no grey ground bleeds in).
 */
export function cutBack(canvas: Rgba, slot: Slot, up: Rgba): Rgba {
  const crop: Rgba = { width: slot.cw, height: slot.ch, data: new Uint8Array(slot.cw * slot.ch * 4) };
  for (let y = 0; y < slot.ch; y++) {
    crop.data.set(canvas.data.subarray(((slot.cy + y) * canvas.width + slot.cx) * 4, ((slot.cy + y) * canvas.width + slot.cx + slot.cw) * 4), y * slot.cw * 4);
  }
  const small = areaResize(crop, slot.w, slot.h);
  const out: Rgba = { width: up.width, height: up.height, data: new Uint8Array(up.data) };
  for (let y = 0; y < slot.h; y++) {
    for (let x = 0; x < slot.w; x++) {
      const o = ((slot.y + y) * up.width + slot.x + x) * 4;
      const a = up.data[o + 3]! / 255;
      const k = (y * slot.w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(up.data[o + c]! * (1 - a) + small.data[k + c]! * a);
    }
  }
  // (every other byte of `out` is up's: alpha included)
  return out;
}

export interface RepaintOpts {
  /** Upload names carry the run stamp (M8). */
  stamp?: string;
  /** Called per canvas with its frame count and seconds. */
  onCanvas?: (info: { canvas: number; of: number; frames: number; seconds: number }) => void;
  /** Test hook: the clock. */
  now?: () => number;
  /** Keeps the work canvases and what came back (for sheets). */
  keep?: (c: { frames: number[]; work: Uint8Array; out: Uint8Array; head: Uint8Array; figure: Uint8Array }) => void;
  /** An experimental family's models, for a recipe whose `model` isn't sdxl (Redux takes the references, unmasked). */
  family?: FamilyModels;
}

/** Consecutive groups of at most `group`, as even as can be (6 frames at 4 make 3 and 3, not 4 and 2). */
export function groupsOf(count: number, group: number): number[][] {
  const canvases = Math.ceil(count / group);
  const per = Math.ceil(count / canvases);
  const out: number[][] = [];
  for (let i = 0; i < count; i += per) out.push(Array.from({ length: Math.min(per, count - i) }, (_, j) => i + j));
  return out;
}

/**
 * R6 for one animation: groups frames (the upscaled originals, equal cells) on 1024x1024 canvases, repaints each with the
 * recipe's seed, prompt, ControlNets and references (the same on every canvas), cuts the frames back and forces the
 * original alpha. `refs` are the reference crops' bytes, flattened in the order of the recipe's `reference[].refs`.
 */
export async function repaintAnim(g: Generator, m: Models, r: CardRecipe, frames: Rgba[], refs: Uint8Array[], opts: RepaintOpts = {}): Promise<Rgba[]> {
  if (frames.length === 0) return [];
  const stamp = opts.stamp ?? 'run';
  const now = opts.now ?? Date.now;
  const { width, height } = frames[0]!;
  for (const f of frames) if (f.width !== width || f.height !== height) throw new Error('repaintAnim: the frames are not in equal cells');
  const total = r.reference.reduce((n, x) => n + x.refs.length, 0);
  if (refs.length !== total) throw new Error(`repaintAnim: the recipe names ${total} reference crops, ${refs.length} were given`);
  // (an animation of clear frames, a door gone from its frame, has nothing to repaint: the frames are what they are)
  if (frames.every(f => !f.data.some((v, i) => i % 4 === 3 && v > 0))) return frames.map(f => ({ ...f, data: f.data.slice() }));
  const crop = unionBox(frames);
  const groups = groupsOf(frames.length, r.group);
  const out: Rgba[] = new Array<Rgba>(frames.length);

  // the recipe's windows are relative to the sampled steps (R3): ComfyUI gets the absolute percents
  const fm = opts.family;
  if (r.model !== 'sdxl' && fm?.family !== r.model) throw new Error(`${r.id} is model ${r.model}, but no ${r.model} models were given`);
  const noise = noiseFor(r.model, r.shift);
  const window = (c: { start: number; end: number }) => controlWindow(r.sampling.steps, r.denoise, r.sampling.scheduler, c, noise);
  const absolute = (name: 'depth' | 'lineart'): { strength: number; start: number; end: number } | undefined => {
    const c = r[name];
    if (!c || (r.model === 'sdxl' ? !m[name] : !fm?.controlnet)) return undefined;
    const w = window(c);
    return { strength: c.strength, start: w.startPercent, end: w.endPercent };
  };
  const CANVAS_IN = `card-work-${stamp}.png`;
  const HEAD = `card-head-${stamp}.png`;
  const FIGURE_MASK = `card-figure-${stamp}.png`;

  for (const [gi, group] of groups.entries()) {
    const t0 = now();
    const canvas = layoutCanvas(group.map(i => frames[i]!), crop);
    const inputs: Record<string, Uint8Array> = { [CANVAS_IN]: canvas.png, [HEAD]: canvas.head, [FIGURE_MASK]: canvas.figure };
    let next = 0;
    if (r.model !== 'sdxl') {
      // flux: each reference's crops through Redux at its weight (no attention mask: StyleModelApply has none); qwen-image: none (recipe.ts)
      const redux = r.reference.map((spec, si) => ({
        strength: spec.weight,
        images: spec.refs.map((_, j) => {
          const name = `card-ref-${stamp}-${si}-${j}.png`;
          inputs[name] = refs[next++]!;
          return name;
        }),
      }));
      const job = familyRepaintGraph(fm!, r.sampling, { prompt: r.prompt, negative: r.negative, denoise: r.denoise, size: [CANVAS, CANVAS], depth: absolute('depth'), lineart: absolute('lineart'), guidance: r.guidance, shift: r.shift, redux }, CANVAS_IN, CANVAS_IN);
      for (const [name, bytes] of Object.entries(inputs)) job.inputs[name] = bytes;
      finish(gi, group, canvas, (await g.run(job)).image!, t0);
      continue;
    }
    const references = r.reference.map((spec, si) => {
      const file = m.ipadapter?.[spec.model];
      if (!m.ipadapter || !file) throw new Error(`recipe ${r.id} has a ${spec.model} reference, but models.yaml's selected names no ipadapter${spec.model === 'style' ? 'Style' : 'Face'} (and clipVision)`);
      const w = window(spec);
      const images = spec.refs.map((_, j) => {
        const name = `card-ref-${stamp}-${si}-${j}.png`;
        inputs[name] = refs[next++]!;
        return name;
      });
      return { params: { ipadapter: file, clipVision: m.ipadapter.clipVision, weight: spec.weight, weightType: spec.weightType }, images, startPercent: w.startPercent, endPercent: w.endPercent, mask: spec.mask === 'head' ? HEAD : spec.mask === 'figure' ? FIGURE_MASK : undefined };
    });
    const job = repaintGraph(
      m,
      r.sampling,
      { prompt: r.prompt, negative: r.negative, denoise: r.denoise, size: [CANVAS, CANVAS], depth: absolute('depth'), lineart: absolute('lineart'), references },
      CANVAS_IN,
      CANVAS_IN,
    );
    for (const [name, bytes] of Object.entries(inputs)) job.inputs[name] = bytes;
    finish(gi, group, canvas, (await g.run(job)).image!, t0);
  }
  return out;

  function finish(gi: number, group: number[], canvas: Canvas, result: Uint8Array, t0: number): void {
    const canvasOut = decodePng(result);
    if (canvasOut.width !== CANVAS || canvasOut.height !== CANVAS) throw new Error(`the repaint came back ${canvasOut.width}x${canvasOut.height}, not ${CANVAS}x${CANVAS}`);
    group.forEach((i, k) => {
      out[i] = cutBack(canvasOut, canvas.slots[k]!, frames[i]!);
    });
    opts.keep?.({ frames: group, work: canvas.png, out: result, head: canvas.head, figure: canvas.figure });
    opts.onCanvas?.({ canvas: gi + 1, of: groups.length, frames: group.length, seconds: (now() - t0) / 1000 });
  }
}
