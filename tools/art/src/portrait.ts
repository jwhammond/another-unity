// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pixel work for an avatar whose likeness comes from the base image: a show reference crop is reframed to the game portrait's
 * composition, its subject cut out by an outline and set on a backdrop made from the game portrait's own blue, relit (a warm key on one
 * side, a teal shadow on the other, rims on the shadow edge and the top of the hair), and its colours moved toward the game portrait's
 * (Reinhard transfer in Lab: each channel's mean and spread matched). The model then only repaints a picture that already has the
 * person's proportions and the game's palette and lighting.
 */
import type { Rgba } from './image';

export type Box = [number, number, number, number];
export type Point = [number, number];
type Rgb = [number, number, number];

export function bilinear(img: Rgba, w: number, h: number): Rgba {
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, ((y + 0.5) * img.height) / h - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, ((x + 0.5) * img.width) / w - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      for (let c = 0; c < 4; c++) {
        const p = (xx: number, yy: number): number => img.data[(yy * img.width + xx) * 4 + c]!;
        const top = p(x0, y0) * (1 - (fx - x0)) + p(x1, y0) * (fx - x0);
        const bot = p(x0, y1) * (1 - (fx - x0)) + p(x1, y1) * (fx - x0);
        out.data[(y * w + x) * 4 + c] = Math.round(top * (1 - (fy - y0)) + bot * (fy - y0));
      }
    }
  }
  return out;
}

/** A crop that may reach past the image: the edge pixels repeat out there. */
export function cropPadded(img: Rgba, [x, y, w, h]: Box): Rgba {
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let r = 0; r < h; r++) {
    const sy = Math.max(0, Math.min(img.height - 1, y + r));
    for (let c = 0; c < w; c++) {
      const sx = Math.max(0, Math.min(img.width - 1, x + c));
      out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (r * w + c) * 4);
    }
  }
  return out;
}

/** 1 inside the polygon (even-odd, sampled at pixel centres), 0 outside. */
export function polygonMask(w: number, h: number, poly: Point[]): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i]!;
      const [x1, y1] = poly[(i + 1) % poly.length]!;
      if (y0 <= py !== y1 <= py) xs.push(x0 + ((py - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = a; x <= b; x++) m[y * w + x] = 1;
    }
  }
  return m;
}

/** Three box passes of radius r (close to a Gaussian of sigma ~ r), edges clamped. */
export function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const a = src.slice();
  const b = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[y * w + Math.max(0, Math.min(w - 1, k))]!;
      for (let x = 0; x < w; x++) {
        b[y * w + x] = acc / n;
        acc += a[y * w + Math.min(w - 1, x + r + 1)]! - a[y * w + Math.max(0, x - r)]!;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[Math.max(0, Math.min(h - 1, k)) * w + x]!;
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / n;
        acc += b[Math.min(h - 1, y + r + 1) * w + x]! - b[Math.max(0, y - r) * w + x]!;
      }
    }
  }
  return a;
}

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t: number): number => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab(r: number, g: number, b: number): Rgb {
  const R = lin(r / 255);
  const G = lin(g / 255);
  const B = lin(b / 255);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labToRgb(L: number, a: number, bb: number): Rgb {
  const fy = (L + 16) / 116;
  const X = 0.95047 * fi(fy + a / 500);
  const Y = fi(fy);
  const Z = 1.08883 * fi(fy - bb / 200);
  const to = (v: number): number => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, v)) * 255)));
  return [to(3.2406 * X - 1.5372 * Y - 0.4986 * Z), to(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), to(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}

export interface LabStats {
  mean: Rgb;
  sd: Rgb;
}

/** Each Lab channel's mean and standard deviation, pixels weighted by `weight` (all 1 when omitted). */
export function labStats(img: Rgba, weight?: (i: number) => number): LabStats {
  const s = [0, 0, 0];
  const s2 = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const wt = weight ? weight(i) : 1;
    if (wt <= 0) continue;
    const lab = rgbToLab(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
    for (let c = 0; c < 3; c++) {
      s[c]! += lab[c]! * wt;
      s2[c]! += lab[c]! * lab[c]! * wt;
    }
    n += wt;
  }
  if (n === 0) throw new Error('labStats: no pixels');
  const mean = s.map(v => v / n) as Rgb;
  return { mean, sd: s2.map((v, c) => Math.sqrt(Math.max(1e-6, v / n - mean[c]! ** 2))) as Rgb };
}

/** Moves each pixel's Lab values from `from`'s statistics to `to`'s, by `amount` (0 = unchanged) times `weight` per pixel. */
export function reinhard(img: Rgba, from: LabStats, to: LabStats, amount: number, weight?: (i: number) => number): Rgba {
  const out: Rgba = { width: img.width, height: img.height, data: img.data.slice() };
  for (let i = 0; i < img.width * img.height; i++) {
    const k = amount * (weight ? weight(i) : 1);
    if (k <= 0) continue;
    const lab = rgbToLab(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
    const moved = lab.map((v, c) => (v - from.mean[c]!) * (to.sd[c]! / from.sd[c]!) + to.mean[c]!);
    const rgb = labToRgb(...(lab.map((v, c) => v + (moved[c]! - v) * k) as Rgb));
    out.data.set(rgb, i * 4);
  }
  return out;
}

/** The game portrait's painted backdrop: blue-dominant pixels (its background and blue rims). */
export function isBackdrop(r: number, g: number, b: number): boolean {
  return b > r + 24 && b >= g;
}

/** Which kind of backdrop a game portrait has: the usual painted blue, or a dark one (black, or black and dark grey) behind the head. */
export type BackdropKind = 'blue' | 'dark';

/** A pixel at most this bright (its strongest channel) can be part of a dark backdrop. */
export const DARK_BACKDROP_MAX = 96;

/**
 * The portrait's backdrop pixels (1) and the figure's (0). Blue: every blue-dominant pixel. Dark: the dark pixels (strongest channel at most
 * DARK_BACKDROP_MAX) joined to the picture's edge, so dark hair, beards and outlines inside the figure stay figure.
 */
export function backdropMask(game: Rgba, kind: BackdropKind = 'blue'): Uint8Array {
  const { width: w, height: h } = game;
  const out = new Uint8Array(w * h);
  if (kind === 'blue') {
    for (let i = 0; i < w * h; i++) if (game.data[i * 4 + 3]! > 0 && isBackdrop(game.data[i * 4]!, game.data[i * 4 + 1]!, game.data[i * 4 + 2]!)) out[i] = 1;
    return out;
  }
  const dark = (i: number): boolean => game.data[i * 4 + 3]! > 0 && Math.max(game.data[i * 4]!, game.data[i * 4 + 1]!, game.data[i * 4 + 2]!) <= DARK_BACKDROP_MAX;
  const stack: number[] = [];
  const add = (x: number, y: number): void => {
    const i = y * w + x;
    if (!out[i] && dark(i)) {
      out[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) add(x - 1, y);
    if (x < w - 1) add(x + 1, y);
    if (y > 0) add(x, y - 1);
    if (y < h - 1) add(x, y + 1);
  }
  return out;
}

/** The game portrait's backdrop on a `size` square: its backdrop pixels kept, every other one filled from its backdrop neighbours, then smoothed. */
export function gameBackdrop(game: Rgba, size: number, soften: number, kind: BackdropKind = 'blue'): Rgba {
  const { width: w, height: h } = game;
  const rgb = new Float32Array(w * h * 3);
  const known = backdropMask(game, kind);
  for (let i = 0; i < w * h; i++) if (known[i]) rgb.set([game.data[i * 4]!, game.data[i * 4 + 1]!, game.data[i * 4 + 2]!], i * 3);
  // grow the known pixels inward one ring at a time, each new pixel the mean of its known 8-neighbours
  for (let left = w * h - known.reduce((a, v) => a + v, 0); left > 0; ) {
    const add: [number, Rgb][] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (known[y * w + x]) continue;
        const acc: Rgb = [0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx]) continue;
            for (let c = 0; c < 3; c++) acc[c] += rgb[(yy * w + xx) * 3 + c]!;
            n++;
          }
        if (n) add.push([y * w + x, acc.map(v => v / n) as Rgb]);
      }
    if (add.length === 0) throw new Error(`gameBackdrop: the portrait has no ${kind} backdrop pixels`);
    for (const [i, c] of add) {
      rgb.set(c, i * 3);
      known[i] = 1;
    }
    left -= add.length;
  }
  const small: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) small.data.set([Math.round(rgb[i * 3]!), Math.round(rgb[i * 3 + 1]!), Math.round(rgb[i * 3 + 2]!), 255], i * 4);
  const big = bilinear(small, size, size);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) ch[i] = big.data[i * 4 + c]!;
    const s = blur(ch, size, size, soften);
    for (let i = 0; i < size * size; i++) big.data[i * 4 + c] = Math.round(s[i]!);
  }
  return big;
}

export interface LikenessOptions {
  /** The reference's crop (reference px; may reach past the frame), made square on the work canvas. */
  crop: Box;
  /** The subject's outline in reference px. */
  subject: Point[];
  size: number;
  /** Mask edge softness, work px. */
  feather: number;
  /** 0..1: how far the subject's colours move to the game figure's (non-blue pixels) and the whole picture's to the portrait's. */
  grade: number;
  /** The key light: the subject is darkened and cooled toward `from` (a fraction of the width) and warmed past `to`. */
  light: { strength: number; from: number; to: number; shadow: Rgb; key: Rgb };
  /** Rim lights added along the subject's shadow-side edge and the top of the head; `width` in work px. */
  rim: { strength: number; width: number; side: Rgb; top: Rgb };
}

/** The likeness base: the reference reframed, cut out onto the game's backdrop, relit and graded toward the game portrait. */
export function likenessBase(ref: Rgba, game: Rgba, o: LikenessOptions): Rgba {
  const S = o.size;
  const [cx, cy, cw, ch] = o.crop;
  const photo = bilinear(cropPadded(ref, o.crop), S, S);
  const sx = S / cw;
  const sy = S / ch;
  // the soft edge falls inside the outline, so none of the reference's own background bleeds into it
  const soft = blur(polygonMask(S, S, o.subject.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy])), S, S, o.feather);
  const mask = soft.map(v => {
    const t = Math.max(0, Math.min(1, (v - 0.4) / 0.6));
    return t * t * (3 - 2 * t);
  });
  // relight the subject: a lateral ramp from the shadow tint to the key tint
  const lit: Rgba = { width: S, height: S, data: photo.data.slice() };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const t = Math.max(0, Math.min(1, (x / S - o.light.from) / (o.light.to - o.light.from)));
      const e = t * t * (3 - 2 * t);
      const i = (y * S + x) * 4;
      for (let c = 0; c < 3; c++) {
        const tint = o.light.shadow[c]! * (1 - e) + o.light.key[c]! * e;
        lit.data[i + c] = Math.max(0, Math.min(255, Math.round(photo.data[i + c]! * (1 + (tint - 1) * o.light.strength))));
      }
    }
  // grade the subject toward the game figure's colours (the portrait's non-blue pixels)
  const gameFigure = (i: number): number => (game.data[i * 4 + 3]! > 0 && !isBackdrop(game.data[i * 4]!, game.data[i * 4 + 1]!, game.data[i * 4 + 2]!) ? 1 : 0);
  const inSubject = (i: number): number => mask[i]!;
  const graded = reinhard(lit, labStats(lit, inSubject), labStats(game, gameFigure), o.grade, inSubject);
  // the subject over the game's own backdrop
  const back = gameBackdrop(game, S, Math.round(S / 48));
  const out: Rgba = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  for (let i = 0; i < S * S; i++) {
    const m = mask[i]!;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(graded.data[i * 4 + c]! * m + back.data[i * 4 + c]! * (1 - m));
    out.data[i * 4 + 3] = 255;
  }
  // rims: where the mask is inside but a step toward the shadow side (or up) is outside (the canvas edge repeats, so it lights nothing)
  const d = o.rim.width;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const m = mask[i]!;
      if (m <= 0) continue;
      const side = m * (1 - mask[y * S + Math.max(0, x - d)]!) * Math.max(0, 1 - x / (S * o.light.to));
      const top = m * (1 - mask[Math.max(0, y - d) * S + x]!) * Math.max(0, 1 - x / (S * 0.55));
      for (let c = 0; c < 3; c++) {
        const add = o.rim.strength * (side * o.rim.side[c]! + top * o.rim.top[c]!);
        out.data[i * 4 + c] = Math.min(255, Math.round(out.data[i * 4 + c]! * (1 - Math.min(1, add / 255)) + add));
      }
    }
  return out;
}

/** The post step: the whole picture's Lab statistics moved toward the game portrait's by `amount`. */
export function paletteTransfer(img: Rgba, game: Rgba, amount: number): Rgba {
  if (amount <= 0) return img;
  const opaque = (i: number): number => (game.data[i * 4 + 3]! > 0 ? 1 : 0);
  return reinhard(img, labStats(img), labStats(game, opaque), amount);
}
