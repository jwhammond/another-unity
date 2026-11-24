// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, type Rgba } from './image';

/** `(cmd, args)` -> a child that has exited when `close` fires; tests give a fake. */
export type SpawnLike = (cmd: string, args: string[]) => ChildProcess;
const real: SpawnLike = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

function wait(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr?.on('data', d => (err += d));
    child.on('error', e => reject(new Error(`${what}: ${e.message} (is it installed? brew install webp)`)));
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${what} exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))));
  });
}

/** The argv of R10: plates `-q 90 -m 6 -mt`; with `alpha` (masks, strips) also `-alpha_q 100 -exact`, so transparent pixels keep their colour. */
export function cwebpArgs(png: string, out: string, o: { quality: number; alpha?: boolean; lossless?: boolean; nearLossless?: number; resize?: [number, number] }): string[] {
  // (pixel art is lossless: `-exact` keeps the colour under a transparent pixel, and nothing is blurred)
  if (o.nearLossless !== undefined) return ['-near_lossless', String(o.nearLossless), '-m', '6', '-mt', ...(o.resize ? ['-resize', String(o.resize[0]), String(o.resize[1])] : []), '-quiet', png, '-o', out];
  if (o.lossless) return ['-lossless', '-z', '9', '-exact', '-mt', ...(o.resize ? ['-resize', String(o.resize[0]), String(o.resize[1])] : []), '-quiet', png, '-o', out];
  return ['-q', String(o.quality), '-m', '6', '-mt', ...(o.alpha ? ['-alpha_q', '100', '-exact'] : []), ...(o.resize ? ['-resize', String(o.resize[0]), String(o.resize[1])] : []), '-quiet', png, '-o', out];
}

/** PNG to WebP with Homebrew's cwebp. */
export async function toWebp(png: string, out: string, opts: { quality: number; alpha?: boolean; lossless?: boolean; nearLossless?: number; resize?: [number, number]; spawnFn?: SpawnLike }): Promise<void> {
  await wait((opts.spawnFn ?? real)('cwebp', cwebpArgs(png, out, opts)), 'cwebp');
}

/** A WebP's pixels, through dwebp (the check that a plate survived compression). */
export async function readWebp(webp: string, spawnFn: SpawnLike = real): Promise<Rgba> {
  const dir = await mkdtemp(join(tmpdir(), 'webp-'));
  try {
    const png = join(dir, 'out.png');
    await wait(spawnFn('dwebp', [webp, '-o', png, '-quiet']), 'dwebp');
    return decodePng(new Uint8Array(await readFile(png)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A WebP's pixel size, from its header (lossy VP8, lossless VP8L or extended VP8X); null for anything else. */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
  const kind = String.fromCharCode(...bytes.subarray(12, 16));
  const u16 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const u24 = (at: number) => u16(at) | (bytes[at + 2]! << 16);
  if (kind === 'VP8 ') return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
  return null;
}
