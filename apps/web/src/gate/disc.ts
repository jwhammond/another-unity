// SPDX-License-Identifier: GPL-3.0-or-later
// Reading the player's CD in the browser: a picked folder, an ISO 9660 image, or a BIN/CUE. Blob/File and WebCrypto
// only, so the same code runs in the page and under Node. Images are read lazily, with Blob.slice.
import { GateError } from './crypto';
import type { GateParams } from './params';
import { CHECK_PLAINTEXT, deriveGateKey, open } from './crypto';

export interface CdSource {
  label: string;
  has(path: string): boolean;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

const SECTOR = 2048;
const RAW_SECTOR = 2352;
const RAW_DATA_AT = 16;
const MAX_DIRS = 20000;

/** Upper-case, `/` separators, no `;1` version suffix and no one trailing dot. `dropFirst` drops the picked folder's name. */
export function normalizeCdPath(p: string, dropFirst = false): string {
  let segs = p.toUpperCase().replace(/\\/g, '/').split('/').filter(s => s !== '');
  if (dropFirst) segs = segs.slice(1);
  if (segs.length) {
    let last = segs[segs.length - 1].replace(/;\d+$/, '');
    if (last.endsWith('.')) last = last.slice(0, -1);
    segs[segs.length - 1] = last;
  }
  return segs.join('/');
}

async function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

export function folderSource(files: File[]): CdSource {
  const byPath = new Map<string, File>();
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    byPath.set(normalizeCdPath(rel, !!f.webkitRelativePath), f);
  }
  // The player may pick a parent of the CD's folder; then the CD's paths are found under a prefix.
  const find = (path: string): File | undefined => {
    const want = normalizeCdPath(path);
    const exact = byPath.get(want);
    if (exact) return exact;
    const hits = [...byPath.entries()].filter(([k]) => k.endsWith('/' + want));
    return hits.length === 1 ? hits[0][1] : undefined;
  };
  const first = files[0]?.webkitRelativePath.split('/')[0] ?? '';
  return {
    label: first || 'folder',
    has: path => find(path) !== undefined,
    async read(path, offset, length) {
      const f = find(path);
      if (!f) throw new GateError('missing-file', normalizeCdPath(path));
      return bytesOf(f.slice(offset, offset + length));
    },
  };
}

interface Extent { lba: number; size: number }

const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at, true);

/** Walks every directory once, up front (`has` is synchronous), over `readLogical`, the 2048-byte-sector user data. */
async function discSource(readLogical: (pos: number, len: number) => Promise<Uint8Array>, label: string): Promise<CdSource> {
  const pvd = await readLogical(16 * SECTOR, SECTOR);
  if (pvd.length < SECTOR || pvd[0] !== 1 || String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') throw new GateError('unreadable', 'no ISO 9660 volume');
  const root: Extent = { lba: u32(pvd, 156 + 2), size: u32(pvd, 156 + 10) };
  const files = new Map<string, Extent>();
  const seen = new Set<number>([root.lba]);
  const queue: { dir: Extent; prefix: string }[] = [{ dir: root, prefix: '' }];
  for (let q = 0; q < queue.length; q++) {
    if (q > MAX_DIRS) throw new GateError('unreadable', 'too many directories');
    const { dir, prefix } = queue[q];
    const data = await readLogical(dir.lba * SECTOR, dir.size);
    if (data.length < dir.size) throw new GateError('unreadable', 'short directory');
    let at = 0;
    while (at < data.length) {
      const len = data[at];
      // Records never straddle a sector; zero padding ends a sector's records.
      if (len === 0) { at = (Math.floor(at / SECTOR) + 1) * SECTOR; continue; }
      if (at + len > data.length || len < 34) break;
      const idLen = data[at + 32];
      const id = data.subarray(at + 33, at + 33 + idLen);
      const isDir = (data[at + 25] & 2) !== 0;
      if (!(idLen === 1 && (id[0] === 0 || id[0] === 1))) {
        const name = normalizeCdPath(String.fromCharCode(...id));
        const path = prefix ? `${prefix}/${name}` : name;
        const ext: Extent = { lba: u32(data, at + 2), size: u32(data, at + 10) };
        if (isDir) {
          if (!seen.has(ext.lba)) { seen.add(ext.lba); queue.push({ dir: ext, prefix: path }); }
        } else {
          files.set(path, ext);
        }
      }
      at += len;
    }
  }
  return {
    label,
    has: path => files.has(normalizeCdPath(path)),
    async read(path, offset, length) {
      const norm = normalizeCdPath(path);
      const f = files.get(norm);
      if (!f) throw new GateError('missing-file', norm);
      const end = Math.min(offset + length, f.size);
      if (end <= offset) return new Uint8Array(0);
      return readLogical(f.lba * SECTOR + offset, end - offset);
    },
  };
}

export async function isoSource(image: Blob, label: string): Promise<CdSource> {
  return discSource(async (pos, len) => bytesOf(image.slice(pos, pos + len)), label);
}

/** The first MODE1/2352 track of the CUE's first FILE (audio tracks and later FILEs are ignored). */
function firstDataTrackStart(cueText: string): number {
  let fileCount = 0;
  let inTrack = false;
  for (const line of cueText.split(/\r?\n/)) {
    const t = line.trim();
    if (/^FILE\s/i.test(t)) { if (++fileCount > 1) break; continue; }
    if (fileCount !== 1) continue;
    if (/^TRACK\s/i.test(t)) { inTrack = /^TRACK\s+\d+\s+MODE1\/2352\b/i.test(t); continue; }
    const idx = /^INDEX\s+01\s+(\d+):(\d+):(\d+)/i.exec(t);
    if (inTrack && idx) return (Number(idx[1]) * 60 + Number(idx[2])) * 75 + Number(idx[3]);
    if (inTrack && /^TRACK\s/i.test(t)) break;
  }
  if (!inTrack) throw new GateError('unreadable', 'no MODE1/2352 track in the cue');
  return 0;
}

export async function binCueSource(bin: Blob, cueText: string, label: string): Promise<CdSource> {
  const start = firstDataTrackStart(cueText) * RAW_SECTOR;
  return discSource(async (pos, len) => {
    const first = Math.floor(pos / SECTOR);
    const last = Math.floor((pos + len - 1) / SECTOR);
    const raw = await bytesOf(bin.slice(start + first * RAW_SECTOR, start + (last + 1) * RAW_SECTOR));
    const out = new Uint8Array(len);
    let written = 0;
    for (let s = first; s <= last; s++) {
      const base = (s - first) * RAW_SECTOR + RAW_DATA_AT;
      if (base >= raw.length) break;
      const from = s === first ? pos - first * SECTOR : 0;
      const to = Math.min(SECTOR, pos + len - s * SECTOR, raw.length - base);
      if (to <= from) break;
      out.set(raw.subarray(base + from, base + to), written);
      written += to - from;
    }
    return written === len ? out : out.subarray(0, written);
  }, label);
}

const ext = (f: File, e: string): boolean => f.name.toLowerCase().endsWith(e);

export async function sourceFromFiles(files: File[]): Promise<CdSource> {
  // Image files are picked one by one; a picked folder (webkitRelativePath set) is a folder of the CD's files.
  const loose = files.filter(f => !f.webkitRelativePath);
  const iso = loose.find(f => ext(f, '.iso'));
  if (iso) return isoSource(iso, iso.name);
  const bin = loose.find(f => ext(f, '.bin'));
  const cue = loose.find(f => ext(f, '.cue'));
  if (bin && !cue) throw new GateError('no-cue');
  if (cue && !bin) throw new GateError('no-bin');
  if (bin && cue) return binCueSource(bin, await cue.text(), bin.name);
  return folderSource(files);
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b as BufferSource));
}

/** Each range's SHA-256, over exactly its bytes. A short read means the bytes aren't the CD's. */
export async function rangeDigests(src: CdSource, p: GateParams): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const r of p.ranges) {
    if (!src.has(r.path)) throw new GateError('missing-file', r.path);
    let bytes: Uint8Array;
    try { bytes = await src.read(r.path, r.offset, r.length); }
    catch (e) { throw e instanceof GateError ? e : new GateError('unreadable', r.path); }
    if (bytes.length !== r.length) throw new GateError('wrong-files');
    out.push(await sha256(bytes));
  }
  return out;
}

/** The gate's key from the CD, proved by opening the sealed check. */
export async function unlock(src: CdSource, p: GateParams, check: Uint8Array): Promise<CryptoKey> {
  const key = await deriveGateKey(await rangeDigests(src, p), p.salt);
  let plain: Uint8Array;
  try { plain = await open(key, check); }
  catch (e) { throw e instanceof GateError && e.code === 'wrong-key' ? new GateError('wrong-files') : e; }
  if (new TextDecoder().decode(plain) !== CHECK_PLAINTEXT) throw new GateError('wrong-files');
  return key;
}
