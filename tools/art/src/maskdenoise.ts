// SPDX-License-Identifier: GPL-3.0-or-later
import { edgeMap } from './align';
import { type Gray, type Rgba } from './image';

/** Where a plate must stay put: the lifted room's hotspot rects and the walk polygons, in the original's 640x480 pixels. */
export interface MaskGeometry {
  /** [x0, y0, x1, y1] */
  rects: [number, number, number, number][];
  polygons: { x: number; y: number }[][];
  /** Plan 16 R12: interface the original paints into its background, [x, y, w, h] in original pixels. The mask is 0 inside. */
  keep?: [number, number, number, number][];
  /** Plan 16 R15: the viewscreen's window, a mask the size of the original (1 inside). Like a keep rect, it is 0 in the denoise mask. */
  keepMask?: { mask: Uint8Array; width: number; height: number };
}

/**
 * Masked denoise (Plan 15 Task 5 amendment). The mask is a per-pixel denoise as a fraction of the recipe's denoise (the
 * KSampler's), for differential diffusion: 1 repaints freely, `protect` keeps the original's structure.
 */
export interface MaskOptions {
  /** The mask value in protected zones (the recipe's denoise times this is what they get). */
  protect: number;
  /** The mask value on open surfaces. */
  open: number;
  /** Radius of the disk kept around every hotspot corner and floor vertex (original px): the alignment windows' reach. */
  pointRadius: number;
  /** Width of the band kept along each rect's outline and each floor edge. */
  band: number;
  /** A hotspot rect smaller than this (px^2) is protected whole: it is an object, not a surface. */
  smallRect: number;
  /** Normalised Sobel strengths (0..1) where protection starts and is complete. */
  edgeLow: number;
  edgeHigh: number;
  /** How far the strong edges' protection is grown. */
  edgeGrow: number;
  /** Blur sigma of the finished protection (original px). */
  feather: number;
  /**
   * Emissive regions (monitors, glowing pads, lights) are kept: a pixel of the original that is saturated and not dark
   * (HSV saturation >= emissiveSat at value >= emissiveVal) or very bright (luminance >= emissiveLum) is protected, grown by
   * emissiveGrow px. emissiveSat > 1 turns the saturated test off; emissiveLum > 1 turns the bright test off.
   */
  emissiveSat: number;
  emissiveVal: number;
  emissiveLum: number;
  emissiveGrow: number;
}
export const MASK_DEFAULTS: MaskOptions = { protect: 0.5, open: 1, pointRadius: 18, band: 8, smallRect: 6000, edgeLow: 0.12, edgeHigh: 0.3, edgeGrow: 2, feather: 4, emissiveSat: 0.35, emissiveVal: 0.3, emissiveLum: 0.88, emissiveGrow: 3 };

/** 1 where the original glows: saturated and not dark, or very bright. */
export function emissiveMap(img: Rgba, o: MaskOptions): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const r = img.data[i * 4]! / 255;
    const g = img.data[i * 4 + 1]! / 255;
    const b = img.data[i * 4 + 2]! / 255;
    const mx = Math.max(r, g, b);
    const sat = mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if ((sat >= o.emissiveSat && mx >= o.emissiveVal) || lum >= o.emissiveLum) out[i] = 1;
  }
  return out;
}

function disk(p: Float32Array, w: number, h: number, cx: number, cy: number, r: number): void {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) if (Math.hypot(x - cx, y - cy) <= r) p[y * w + x] = 1;
}
function box(p: Float32Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1)); x++) p[y * w + x] = 1;
}
function line(p: Float32Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, half: number): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    disk(p, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, half);
  }
}
/** Max filter over a square window, separable. */
function dilate(p: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = Math.max(m, p[y * w + i]!);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = Math.max(m, tmp[j * w + x]!);
      out[y * w + x] = m;
    }
  return out;
}
function blur(p: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return p;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += p[y * w + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!;
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!;
    out[y * w + x] = a;
  }
  return out;
}
function bilinear(g: Gray, w: number, h: number): Gray {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.height - 1, Math.max(0, ((y + 0.5) * g.height) / h - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(g.height - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.width - 1, Math.max(0, ((x + 0.5) * g.width) / w - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(g.width - 1, x0 + 1);
      const a = g.data[y0 * g.width + x0]! * (1 - (sx - x0)) + g.data[y0 * g.width + x1]! * (sx - x0);
      const b = g.data[y1 * g.width + x0]! * (1 - (sx - x0)) + g.data[y1 * g.width + x1]! * (sx - x0);
      out[y * w + x] = a * (1 - (sy - y0)) + b * (sy - y0);
    }
  }
  return { width: w, height: h, data: out };
}

/** The protection (0 open .. 1 kept) at the original's size. */
export function protection(original: Rgba, geom: MaskGeometry, o: MaskOptions = MASK_DEFAULTS): Gray {
  const { width: w, height: h } = original;
  const p = new Float32Array(w * h);
  const half = o.band / 2;
  for (const [x0, y0, x1, y1] of geom.rects) {
    disk(p, w, h, x0, y0, o.pointRadius);
    disk(p, w, h, x1, y0, o.pointRadius);
    disk(p, w, h, x0, y1, o.pointRadius);
    disk(p, w, h, x1, y1, o.pointRadius);
    if ((x1 - x0) * (y1 - y0) <= o.smallRect) {
      box(p, w, h, x0 - half, y0 - half, x1 + half, y1 + half);
    } else {
      line(p, w, h, x0, y0, x1, y0, half);
      line(p, w, h, x1, y0, x1, y1, half);
      line(p, w, h, x1, y1, x0, y1, half);
      line(p, w, h, x0, y1, x0, y0, half);
    }
  }
  for (const poly of geom.polygons) {
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length]!;
      disk(p, w, h, a.x, a.y, o.pointRadius);
      line(p, w, h, a.x, a.y, b.x, b.y, half);
    });
  }
  // strong edges of the original, grown a little
  const e = edgeMap(original);
  const strong = new Float32Array(w * h);
  for (let i = 0; i < strong.length; i++) strong[i] = Math.min(1, Math.max(0, (e.data[i]! - o.edgeLow) / (o.edgeHigh - o.edgeLow)));
  const grown = o.edgeGrow > 0 ? dilate(strong, w, h, o.edgeGrow) : strong;
  for (let i = 0; i < p.length; i++) p[i] = Math.max(p[i]!, grown[i]!);
  // emissive regions of the original (monitors, glowing pads, lights) keep their glow
  const glow = emissiveMap(original, o);
  const glowGrown = o.emissiveGrow > 0 ? dilate(glow, w, h, o.emissiveGrow) : glow;
  for (let i = 0; i < p.length; i++) p[i] = Math.max(p[i]!, glowGrown[i]!);
  // a thin band loses height in the blur: a gain restores its core and keeps the feather
  const soft = blur(p, w, h, o.feather);
  for (let i = 0; i < soft.length; i++) soft[i] = Math.min(1, soft[i]! * 1.6);
  return { width: w, height: h, data: soft };
}

/** The denoise mask at `size` (the work size): `open` on open surfaces down to `protect` where the original must hold. */
export function denoiseMask(original: Rgba, geom: MaskGeometry, size: [number, number], o: MaskOptions = MASK_DEFAULTS): Gray {
  const p = bilinear(protection(original, geom, o), size[0], size[1]);
  const data = new Float32Array(p.data.length);
  for (let i = 0; i < data.length; i++) data[i] = o.open - (o.open - o.protect) * Math.min(1, p.data[i]!);
  // a kept rect is not repainted at all (the plate takes the upscale there): its pixels are 0, whatever the original shows
  const sx = size[0] / original.width;
  const sy = size[1] / original.height;
  for (const [kx, ky, kw, kh] of geom.keep ?? []) {
    for (let y = Math.max(0, Math.floor(ky * sy)); y < Math.min(size[1], Math.ceil((ky + kh) * sy)); y++) {
      for (let x = Math.max(0, Math.floor(kx * sx)); x < Math.min(size[0], Math.ceil((kx + kw) * sx)); x++) data[y * size[0] + x] = 0;
    }
  }
  const km = geom.keepMask;
  if (km) {
    for (let y = 0; y < size[1]; y++) {
      const oy = Math.min(km.height - 1, Math.floor(((y + 0.5) * km.height) / size[1]));
      for (let x = 0; x < size[0]; x++) if (km.mask[oy * km.width + Math.min(km.width - 1, Math.floor(((x + 0.5) * km.width) / size[0]))]) data[y * size[0] + x] = 0;
    }
  }
  return { width: size[0], height: size[1], data };
}

/** An 8-bit grey PNG's RGBA (ComfyUI's ImageToMask reads the red channel). */
export function maskToRgba(g: Gray): Rgba {
  const data = new Uint8Array(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, g.data[i]!)) * 255);
    data.set([v, v, v, 255], i * 4);
  }
  return { width: g.width, height: g.height, data };
}
