// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtCache } from './cache';
import type { SpawnLike } from './comfy';
import { areaResize, encodePng, type Rgba } from './image';

/** The ship's own 640x480 backgrounds, members of the game's STTNG.ZIP. */
export const SHIP_BACKGROUNDS = ['bridge.rm', 'transp.rm', 'viewscr.rm', 'astropnl.ast', 'compupnl.ast'] as const;
export type ShipStem = 'bridge' | 'transp' | 'viewscr' | 'astropnl' | 'compupnl';

const W = 640;
const H = 480;

/**
 * graphics.cpp setBackgroundImage: 128 (or 256 for .pic) 6-bit RGB entries, then 640x480 indices; the rest of the palette is
 * STANDARD.PAL's first 128 entries (6-bit too). Every entry is shifted left by 2.
 */
export function decodeBackground(bytes: Uint8Array, standardPal: Uint8Array, name: string): Rgba {
  const colours = name.toLowerCase().endsWith('.pic') ? 256 : 128;
  const need = colours * 3 + W * H;
  if (bytes.length < need) throw new Error(`${name}: ${bytes.length} bytes, need ${need}`);
  if (colours === 128 && standardPal.length < 128 * 3) throw new Error(`STANDARD.PAL has ${standardPal.length} bytes, need ${128 * 3}`);
  const pal = new Uint8Array(256 * 3);
  pal.set(bytes.subarray(0, colours * 3));
  if (colours === 128) pal.set(standardPal.subarray(0, 128 * 3), 128 * 3);
  for (let i = 0; i < pal.length; i++) pal[i] = (pal[i]! << 2) & 0xff;
  const data = new Uint8Array(W * H * 4);
  const px = bytes.subarray(colours * 3, need);
  for (let i = 0; i < W * H; i++) {
    const c = px[i]! * 3;
    data[i * 4] = pal[c]!;
    data[i * 4 + 1] = pal[c + 1]!;
    data[i * 4 + 2] = pal[c + 2]!;
    data[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}

/** Reads one member of the game's STTNG.ZIP with `unzip -p` (argv only; no shell). */
export function readZipMember(zip: string, member: string, spawnFn?: SpawnLike): Promise<Uint8Array> {
  const sp: SpawnLike = spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
  return new Promise((resolve, reject) => {
    const child = sp('unzip', ['-p', zip, member], { cwd: process.cwd(), env: process.env });
    const out: Buffer[] = [];
    let err = '';
    child.stdout?.on('data', (d: Buffer | string) => out.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer | string) => (err += String(d)));
    child.once('error', reject);
    child.once('close', (code: number | null) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else reject(new Error(`unzip -p ${zip} ${member} exited ${code}: ${err.trim()}`));
    });
  });
}

export function shipOriginal(cache: ArtCache, stem: ShipStem): string {
  return join(cache.root, 'originals', 'ship', `${stem}.png`);
}

export interface ItemRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A copy of `img` with each rectangle outlined in yellow (2 px). */
export function drawRects(img: Rgba, rects: ItemRect[]): Rgba {
  const data = new Uint8Array(img.data);
  const put = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    data[o] = 255; data[o + 1] = 230; data[o + 2] = 0;
  };
  for (const r of rects) {
    for (let t = 0; t < 2; t++) {
      for (let x = r.x; x < r.x + r.width; x++) { put(x, r.y + t); put(x, r.y + r.height - 1 - t); }
      for (let y = r.y; y < r.y + r.height; y++) { put(r.x + t, y); put(r.x + r.width - 1 - t, y); }
    }
  }
  return { width: img.width, height: img.height, data };
}

/** The backgrounds in a grid, each half size. */
export function sheet(images: Rgba[]): Rgba {
  const cols = 2;
  const cw = W / 2;
  const ch = H / 2;
  const rows = Math.ceil(images.length / cols);
  const data = new Uint8Array(cols * cw * rows * ch * 4).fill(0);
  images.forEach((img, i) => {
    const small = areaResize(img, cw, ch);
    const ox = (i % cols) * cw;
    const oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) data.set(small.data.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * cols * cw + ox) * 4);
  });
  return { width: cols * cw, height: rows * ch, data };
}

/**
 * Writes $ART_CACHE/originals/ship/<stem>.png for each background and sheet.png; with `items` also bridge-items.png.
 * `gameData` is the game's folder (it holds STTNG.ZIP); nothing there is modified.
 */
export async function exportShipOriginals(gameData: string, cache: ArtCache, items?: ItemRect[], spawnFn?: SpawnLike): Promise<string[]> {
  const zip = join(gameData, 'STTNG.ZIP');
  const dir = join(cache.root, 'originals', 'ship');
  mkdirSync(dir, { recursive: true });
  const pal = await readZipMember(zip, 'standard.pal', spawnFn);
  const written: string[] = [];
  const decoded: Rgba[] = [];
  for (const member of SHIP_BACKGROUNDS) {
    const stem = member.slice(0, member.indexOf('.')) as ShipStem;
    const img = decodeBackground(await readZipMember(zip, member, spawnFn), pal, member);
    decoded.push(img);
    const file = shipOriginal(cache, stem);
    writeFileSync(file, encodePng(img));
    written.push(file);
    if (stem === 'bridge' && items) {
      const f = join(dir, 'bridge-items.png');
      writeFileSync(f, encodePng(drawRects(img, items)));
      written.push(f);
    }
  }
  const s = join(dir, 'sheet.png');
  writeFileSync(s, encodePng(sheet(decoded)));
  written.push(s);
  return written;
}
