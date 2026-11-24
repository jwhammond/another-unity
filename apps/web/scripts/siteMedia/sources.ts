// SPDX-License-Identifier: GPL-3.0-or-later
// Readers and writers for the site-media build. The image work is tools/art's own (PNG decode, area resize, cwebp, the originals' readers);
// this file only picks files and draws the few things the site adds (nearest-neighbour scaling, hotspot boxes).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { areaResize, decodePng, encodePng, type Rgba } from '../../../../tools/art/src/image';
import { originalBackground } from '../../../../tools/art/src/originals';
import { basePng } from '../../../../tools/art/src/avatar';
import { readWebp, toWebp } from '../../../../tools/art/src/webp';

export const QUALITY = 82;
export const GOLD: [number, number, number] = [255, 204, 0];

export type Written = { src: string; w: number; h: number; bytes: number };

/** Scales to `width` pixels wide, keeping the aspect (a smaller picture is scaled up the same way). */
export function scaleTo(img: Rgba, width: number): Rgba {
  return img.width === width ? img : areaResize(img, width, Math.max(1, Math.round((img.height * width) / img.width)));
}

/** Integer enlargement with no smoothing (the game's 48x50 heads). */
export function nearest(img: Rgba, k: number): Rgba {
  const out: Rgba = { width: img.width * k, height: img.height * k, data: new Uint8Array(img.width * k * img.height * k * 4) };
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  return out;
}

/** Flattens transparency onto black, so a sprite's empty edge is not whatever colour the encoder keeps under it. */
export function onBlack(img: Rgba): Rgba {
  const out = { ...img, data: new Uint8Array(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(img.data[i * 4 + c]! * a);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Strokes the outline of a rectangle (x0, y0, x1, y1 in the picture's pixels), `thick` px wide, inside the picture. */
export function strokeRect(img: Rgba, [x0, y0, x1, y1]: [number, number, number, number], rgb: [number, number, number], thick: number): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    img.data.set([...rgb, 255], (y * img.width + x) * 4);
  };
  for (let t = 0; t < thick; t++) {
    for (let x = x0; x <= x1; x++) { put(x, y0 + t); put(x, y1 - t); }
    for (let y = y0; y <= y1; y++) { put(x0 + t, y); put(x1 - t, y); }
  }
}

/** Writes a picture as WebP into `outDir` and returns what the manifest needs. `name` is a flat file name. */
export async function writeWebp(img: Rgba, outDir: string, name: string): Promise<Written> {
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'site-media-'));
  try {
    const png = join(tmp, 'in.png');
    writeFileSync(png, encodePng(img));
    const out = join(outDir, name);
    await toWebp(png, out, { quality: QUALITY });
    return { src: `/site-media/${name}`, w: img.width, h: img.height, bytes: statSync(out).size };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A published (games/unity/...) WebP's pixels. */
export function readPublished(gameDir: string, rel: string): Promise<Rgba> {
  return readWebp(join(gameDir, rel));
}

/** The file-name-safe form of an id. */
export function flat(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** A room's original background (decoded), named by the `source.background` of its recipe; null when the recipe or the image is not there. */
export async function roomOriginal(recipesDir: string, imagesDir: string, room: string): Promise<Rgba | null> {
  try {
    const r = parse(readFileSync(join(recipesDir, `${room}.yaml`), 'utf8')) as { source?: { background?: string } };
    const screen = r.source?.background;
    return screen ? decodePng(await originalBackground(imagesDir, screen)) : null;
  } catch {
    return null;
  }
}

/** An avatar's game sprite head (decoded, on black), from `base: { sprite, frame }` of `avatar.<name>.yaml`; null when it is not there. */
export function avatarOriginal(recipesDir: string, imagesDir: string, name: string): Rgba | null {
  try {
    const r = parse(readFileSync(join(recipesDir, `avatar.${name}.yaml`), 'utf8')) as { base?: { sprite: string; frame: number } };
    return r.base ? onBlack(decodePng(new Uint8Array(readFileSync(basePng(imagesDir, r.base))))) : null;
  } catch {
    return null;
  }
}
