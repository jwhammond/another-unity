// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The `grab` avatar: a real picture of the person set into the game portrait's frame, no model repaint. The source is the full frame
 * behind a show ref (art/refs/show.yaml; cached by art refs grab) or another variant's newest picture (a generated face for a
 * game-only character). Its InsightFace face box is scaled and moved onto the game portrait's face box (`gameFace`) on a square canvas
 * that holds the game portrait centred; a portrait matting model (face/matte.py: rembg's BiRefNet portrait, then pymatting's
 * foreground estimate, so edge colours carry none of the old background) cuts the person out; the matte keeps only the part joined to
 * the face (other people and stray patches go) and any `remove` / `keep` boxes; the person's colours move toward the game figure's
 * (Lab mean and spread, by `grade`); and the cut-out goes over the game portrait's own mottled blue backdrop. The recipe's `pixel` step
 * makes the avatar. Deterministic: InsightFace and the matting model run on the CPU, and nothing here draws random numbers.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { pixelate, pixelOptions, type PixelOptions } from './pixel';
import { backdropMask, blur, cropPadded, gameBackdrop, labStats, reinhard, type BackdropKind, type Box } from './portrait';

const box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
/** [x, y, w, h] in game portrait pixels. */
const rect = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

export const MATTE_MODELS = ['birefnet-portrait', 'birefnet-general', 'u2net_human_seg'] as const;

export const grabSchema = z
  .object({
    /** A show ref id: the picture is the full frame behind its crop. */
    ref: z.string().optional(),
    /** Instead: another variant's newest picture (avatar.png). */
    from: z.string().regex(/^[a-z0-9-]+$/).optional(),
    /** The game portrait's face box [x0, y0, x1, y1] in its own pixels (InsightFace's box on the portrait scaled up 10x, divided back). */
    gameFace: box,
    /** The source's face box [x0, y0, x1, y1] in source pixels; InsightFace's largest face when omitted (in the ref's crop, for a ref). */
    face: box.optional(),
    /** The canvas side (px): the game portrait's longer side scaled to it. */
    size: z.number().int().min(64).max(2048).default(1000),
    matte: z
      .object({
        model: z.enum(MATTE_MODELS).default('birefnet-portrait'),
        /** Alpha blur radius, canvas px (0: the model's own edge). */
        feather: z.number().int().min(0).max(16).default(1),
        /** Alpha above this joins a region; only regions joined to the face's centre stay. */
        threshold: z.number().min(0.01).max(0.9).default(0.1),
      })
      .strict()
      .default({}),
    /** The game portrait's backdrop: its painted blue, or `dark` (black, or black and dark grey, behind the head: the dark pixels joined to the picture's edge). */
    backdrop: z.enum(['blue', 'dark']).default('blue'),
    /** 0..1: how far the person's Lab mean and spread move to the game figure's (the portrait's non-blue pixels). */
    grade: z.number().min(0).max(1).default(0.5),
    /** Game-pixel boxes [x, y, w, h] where the matte is cleared, or (keep) made solid. */
    remove: z.array(rect).default([]),
    keep: z.array(rect).default([]),
    /** Overrides the recipe's `pixel` step. */
    pixel: pixelOptions.optional(),
  })
  .strict()
  .refine(g => !!g.ref !== !!g.from, { message: 'a grab names its picture: one of ref or from' });
export type GrabOptions = z.infer<typeof grabSchema>;

/** Where the game portrait sits on the canvas: scale k (canvas px per game px) and its top-left offset. */
export function canvasLayout(gameW: number, gameH: number, side: number): { k: number; ox: number; oy: number } {
  const k = side / Math.max(gameW, gameH);
  return { k, ox: (side - gameW * k) / 2, oy: (side - gameH * k) / 2 };
}

/** A box in game pixels, on the canvas. */
export function onCanvas(b: Box, l: { k: number; ox: number; oy: number }): Box {
  return [l.ox + b[0] * l.k, l.oy + b[1] * l.k, l.ox + b[2] * l.k, l.oy + b[3] * l.k];
}

/** The scale-and-move taking one face box onto another: dst = s * src + t, s the mean of the width and height ratios, centres matched. */
export function fitFace(src: Box, dst: Box): { s: number; tx: number; ty: number } {
  const s = ((dst[2] - dst[0]) / (src[2] - src[0]) + (dst[3] - dst[1]) / (src[3] - src[1])) / 2;
  return { s, tx: (dst[0] + dst[2]) / 2 - (s * (src[0] + src[2])) / 2, ty: (dst[1] + dst[3]) / 2 - (s * (src[1] + src[3])) / 2 };
}

/** The source drawn on a side x height canvas through the fit (bilinear, area-reduced first when it shrinks; edges repeat past the source). */
export function warp(img: Rgba, fit: { s: number; tx: number; ty: number }, side: number, height = side): Rgba {
  let src = img;
  if (fit.s < 1) src = areaResize(img, Math.max(1, Math.round(img.width * fit.s)), Math.max(1, Math.round(img.height * fit.s)));
  const fx = src.width / img.width;
  const fy = src.height / img.height;
  const out: Rgba = { width: side, height, data: new Uint8Array(side * height * 4) };
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(src.height - 1, ((y + 0.5 - fit.ty) / fit.s) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    for (let x = 0; x < side; x++) {
      const sx = Math.max(0, Math.min(src.width - 1, ((x + 0.5 - fit.tx) / fit.s) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      for (let c = 0; c < 3; c++) {
        const p = (xx: number, yy: number): number => src.data[(yy * src.width + xx) * 4 + c]!;
        const top = p(x0, y0) * (1 - (sx - x0)) + p(x1, y0) * (sx - x0);
        const bot = p(x0, y1) * (1 - (sx - x0)) + p(x1, y1) * (sx - x0);
        out.data[(y * side + x) * 4 + c] = Math.round(top * (1 - (sy - y0)) + bot * (sy - y0));
      }
      out.data[(y * side + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** The canvas pixels [x, y, w, h] whose centres fall inside the source: the part the matting model sees (no repeated edge). */
export function validRect(srcW: number, srcH: number, fit: { s: number; tx: number; ty: number }, side: number, height = side): Box {
  const x0 = Math.max(0, Math.ceil(fit.tx - 0.5));
  const y0 = Math.max(0, Math.ceil(fit.ty - 0.5));
  const x1 = Math.min(side, Math.floor(fit.tx + srcW * fit.s - 0.5) + 1);
  const y1 = Math.min(height, Math.floor(fit.ty + srcH * fit.s - 0.5) + 1);
  if (x1 <= x0 || y1 <= y0) throw new Error('the source misses the canvas');
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The alpha left after dropping every region (alpha > threshold, 4-connected) not joined to `seed`; a `grow`-px fringe round the kept region stays. */
export function keepJoined(alpha: Float32Array, w: number, h: number, seed: [number, number], threshold: number, grow: number): Float32Array {
  const on = (i: number): boolean => alpha[i]! > threshold;
  const kept = new Float32Array(w * h);
  const sx = Math.max(0, Math.min(w - 1, Math.round(seed[0])));
  const sy = Math.max(0, Math.min(h - 1, Math.round(seed[1])));
  if (!on(sy * w + sx)) throw new Error(`the matte is empty at the face centre (${sx}, ${sy})`);
  const stack = [sy * w + sx];
  kept[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
      if (j >= 0 && !kept[j] && on(j)) {
        kept[j] = 1;
        stack.push(j);
      }
  }
  const near = grow > 0 ? blur(kept, w, h, grow) : kept;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = kept[i] || near[i]! > 1e-4 ? alpha[i]! : 0;
  return out;
}

/** Boxes (canvas px [x, y, w, h]) where the alpha is set to `value`. */
export function fillBoxes(alpha: Float32Array, w: number, h: number, boxes: Box[], value: number): void {
  for (const [bx, by, bw, bh] of boxes)
    for (let y = Math.max(0, Math.floor(by)); y < Math.min(h, Math.ceil(by + bh)); y++)
      for (let x = Math.max(0, Math.floor(bx)); x < Math.min(w, Math.ceil(bx + bw)); x++) alpha[y * w + x] = value;
}

/**
 * The game portrait with its backdrop pixels within `ring` px of the figure made unknown (grey), so the backdrop is filled over them
 * from farther out: the figure's pale blue rim lights count as backdrop blue and would otherwise glow round the new person.
 */
export function withoutRims(game: Rgba, ring: number, kind: BackdropKind = 'blue'): Rgba {
  const { width: w, height: h } = game;
  const mask = backdropMask(game, kind);
  const back = (i: number): boolean => mask[i] === 1;
  const out: Rgba = { width: w, height: h, data: game.data.slice() };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!back(y * w + x)) continue;
      let near = false;
      for (let dy = -ring; dy <= ring && !near; dy++)
        for (let dx = -ring; dx <= ring && !near; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && !back(yy * w + xx)) near = true;
        }
      if (near) out.data.set([128, 128, 128, 255], (y * w + x) * 4);
    }
  // a portrait that is all rim keeps its own pixels (gameBackdrop needs some blue to start from)
  if (backdropMask(out, kind).some(v => v === 1)) return out;
  return game;
}

/** Past the source's edge (canvas px outside `valid` [x, y, w, h]) the picture and alpha are its edge repeated: blurred there by `r`, so no streaks show. */
export function softenOutside(img: Rgba, alpha: Float32Array, valid: Box, r: number): void {
  const { width: w, height: h } = img;
  const outside = (x: number, y: number): boolean => x < valid[0] || y < valid[1] || x >= valid[0] + valid[2] || y >= valid[1] + valid[3];
  let any = false;
  for (let y = 0; y < h && !any; y++) for (let x = 0; x < w && !any; x++) any = outside(x, y);
  if (!any) return;
  const chans = [0, 1, 2].map(c => {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = img.data[i * 4 + c]!;
    return blur(ch, w, h, r);
  });
  const a = blur(alpha, w, h, r);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!outside(x, y)) continue;
      const i = y * w + x;
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round(chans[c]![i]!);
      alpha[i] = a[i]!;
    }
}

export interface GrabPictures {
  /** The finished smooth portrait (canvas size). */
  portrait: Rgba;
  /** The cleaned alpha, as a grey picture. */
  matte: Rgba;
  /** The graded cut-out over black (a check of the edges). */
  cutout: Rgba;
}

/** Everything after the matting model: matte clean-up, the grade, and the backdrop. `fg` and `alpha` are canvas size. */
export function finishGrab(fg: Rgba, alphaIn: Float32Array, game: Rgba, o: Pick<GrabOptions, 'gameFace' | 'matte' | 'grade' | 'remove' | 'keep'> & { backdrop?: BackdropKind }): GrabPictures {
  const S = fg.width;
  const l = canvasLayout(game.width, game.height, S);
  const face = onCanvas(o.gameFace as Box, l);
  let alpha = keepJoined(alphaIn, S, S, [(face[0] + face[2]) / 2, (face[1] + face[3]) / 2], o.matte.threshold, Math.round(S / 100));
  const toCanvas = (r: number[]): Box => [l.ox + r[0]! * l.k, l.oy + r[1]! * l.k, r[2]! * l.k, r[3]! * l.k];
  fillBoxes(alpha, S, S, o.remove.map(toCanvas), 0);
  fillBoxes(alpha, S, S, o.keep.map(toCanvas), 1);
  if (o.matte.feather > 0) alpha = blur(alpha, S, S, o.matte.feather);
  const kind = o.backdrop ?? 'blue';
  const gameBack = backdropMask(game, kind);
  const gameFigure = (i: number): number => (game.data[i * 4 + 3]! > 0 && !gameBack[i] ? 1 : 0);
  const solid = (i: number): number => (alpha[i]! > 0.5 ? 1 : 0);
  const graded = o.grade > 0 ? reinhard(fg, labStats(fg, solid), labStats(game, gameFigure), o.grade) : fg;
  const back = gameBackdrop(withoutRims(game, 2, kind), S, Math.round(S / 32), kind);
  const portrait: Rgba = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  const matte: Rgba = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  const cutout: Rgba = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  for (let i = 0; i < S * S; i++) {
    const a = Math.max(0, Math.min(1, alpha[i]!));
    for (let c = 0; c < 3; c++) {
      portrait.data[i * 4 + c] = Math.round(graded.data[i * 4 + c]! * a + back.data[i * 4 + c]! * (1 - a));
      cutout.data[i * 4 + c] = Math.round(graded.data[i * 4 + c]! * a);
      matte.data[i * 4 + c] = Math.round(a * 255);
    }
    portrait.data[i * 4 + 3] = matte.data[i * 4 + 3] = cutout.data[i * 4 + 3] = 255;
  }
  return { portrait, matte, cutout };
}

const MATTE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'face', 'matte.py');

/** Runs face/matte.py (the face venv) on each job: writes `alpha` and `fg` PNGs the size of `in`. `modelHome`: where rembg keeps its models. */
export function runMatte(python: string, model: string, jobs: { in: string; alpha: string; fg: string }[], modelHome: string, run: typeof spawnSync = spawnSync): void {
  const r = run(python, ['-I', MATTE_SCRIPT], { input: JSON.stringify({ model, images: jobs }), encoding: 'utf8', maxBuffer: 16 << 20, env: { PATH: process.env.PATH, HOME: process.env.HOME, U2NET_HOME: modelHome } });
  if (r.status !== 0) throw new Error(`face/matte.py exited ${r.status}: ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
}

export interface GrabSource {
  /** The source picture's file. */
  file: string;
  /** Its face box [x0, y0, x1, y1] in its pixels. */
  face: Box;
}

export interface GrabRun {
  dir: string;
  /** The smooth portrait (canvas size), the pixel avatar (out size) and the sheet-size smooth picture. */
  png: string;
  small: string;
  smooth: string;
}

/**
 * The whole grab into `dir`: the canvas (source.png), what the matting model saw (matte.in.png), its raw alpha and foreground, the
 * cleaned matte (matte.png), the graded cut-out (cutout.png) and the avatar files. `matte` runs the model.
 */
export function runGrab(
  o: GrabOptions,
  src: GrabSource,
  game: Rgba,
  dir: string,
  sizes: { out: number; smooth: number; pixel?: PixelOptions },
  matte: (jobs: { in: string; alpha: string; fg: string }[]) => void,
): GrabRun {
  mkdirSync(dir, { recursive: true });
  const S = o.size;
  const l = canvasLayout(game.width, game.height, S);
  const img = decodePng(new Uint8Array(readFileSync(src.file)));
  const fit = fitFace(src.face, onCanvas(o.gameFace as Box, l));
  const canvas = warp(img, fit, S);
  writeFileSync(join(dir, 'source.png'), encodePng(canvas));
  // the model sees the canvas with a margin of half its side all round (context: a head filling the canvas is matted badly), real
  // pixels only; its alpha and foreground are then cut back to the canvas and repeated out past the source's edge, as the picture was
  const M = Math.round(S / 2);
  const wide = { s: fit.s, tx: fit.tx + M, ty: fit.ty + M };
  const v = validRect(img.width, img.height, wide, S + 2 * M);
  const job = { in: join(dir, 'matte.in.png'), alpha: join(dir, 'matte.raw.png'), fg: join(dir, 'fg.raw.png') };
  writeFileSync(job.in, encodePng(cropPadded(warp(img, wide, S + 2 * M), v)));
  matte([job]);
  const back: Box = [M - v[0], M - v[1], S, S];
  const rawAlpha = cropPadded(decodePng(new Uint8Array(readFileSync(job.alpha))), back);
  const fg = cropPadded(decodePng(new Uint8Array(readFileSync(job.fg))), back);
  const alpha = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) alpha[i] = rawAlpha.data[i * 4]! / 255;
  softenOutside(fg, alpha, validRect(img.width, img.height, fit, S), Math.round(S / 40));
  const p = finishGrab(fg, alpha, game, o);
  writeFileSync(join(dir, 'matte.png'), encodePng(p.matte));
  writeFileSync(join(dir, 'cutout.png'), encodePng(p.cutout));
  const out = { dir, png: join(dir, 'avatar.png'), small: join(dir, 'avatar.small.png'), smooth: join(dir, 'avatar.smooth.png') };
  writeFileSync(out.png, encodePng(p.portrait));
  const px = o.pixel ?? sizes.pixel;
  writeFileSync(out.small, encodePng(px ? pixelate(p.portrait, game, px, [sizes.out, sizes.out]) : areaResize(p.portrait, sizes.out, sizes.out)));
  writeFileSync(out.smooth, encodePng(areaResize(p.portrait, sizes.smooth, sizes.smooth)));
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({ ...(o.ref ? { ref: o.ref } : { from: o.from }), sourceSha256: createHash('sha256').update(readFileSync(src.file)).digest('hex'), face: src.face, fit, valid: v, matte: o.matte, grade: o.grade }, null, 2)}\n`,
  );
  return out;
}
