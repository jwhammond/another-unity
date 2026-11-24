// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An image pack (M8 spec Decision 19): many encoded pictures (WebP) in one file, so the deploy's file count stays down as
 * `engineering.pack` keeps it down for indexed pictures. The magic "AUIP", a u32 header length, the header as UTF-8 JSON
 * (`ImagePackHeader`), then each entry's bytes at its offset from the end of the header. The art publishes them
 * (tools/art/src/spacepublish.ts); the battle's set reads them (view/combat/assets.ts). Pure: no DOM.
 */

const MAGIC = 0x50495541; // "AUIP", little endian
export const IMAGE_PACK_VERSION = 1;

/** One picture of a pack: its name, its media type, its size in pixels and anything the reader needs beside (a sheet's layout). */
export interface ImagePackEntry {
  name: string;
  type: string;
  width: number;
  height: number;
  meta?: Record<string, unknown>;
  bytes: Uint8Array;
}

interface ImagePackHeader {
  version: number;
  entries: (Omit<ImagePackEntry, 'bytes'> & { offset: number; length: number })[];
}

/** Writes a pack; the names must be unique. */
export function writeImagePack(entries: readonly ImagePackEntry[]): Uint8Array {
  const seen = new Set<string>();
  let offset = 0;
  const header: ImagePackHeader = { version: IMAGE_PACK_VERSION, entries: [] };
  for (const e of entries) {
    if (seen.has(e.name)) throw new Error(`an image pack names "${e.name}" twice`);
    seen.add(e.name);
    header.entries.push({ name: e.name, type: e.type, width: e.width, height: e.height, ...(e.meta ? { meta: e.meta } : {}), offset, length: e.bytes.length });
    offset += e.bytes.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  let at = 8 + json.length;
  for (const e of entries) {
    out.set(e.bytes, at);
    at += e.bytes.length;
  }
  return out;
}

/** Reads a pack: each entry's bytes are a view into `bytes`, not a copy. Throws on anything that isn't a whole pack of this version. */
export function parseImagePack(bytes: Uint8Array): ImagePackEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not an image pack');
  const length = dv.getUint32(4, true);
  if (8 + length > bytes.length) throw new Error('the image pack ends inside its header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as ImagePackHeader;
  if (header.version !== IMAGE_PACK_VERSION) throw new Error(`an image pack of version ${header.version}, not ${IMAGE_PACK_VERSION}`);
  const base = 8 + length;
  return header.entries.map(e => {
    if (base + e.offset + e.length > bytes.length) throw new Error(`the image pack ends inside "${e.name}"`);
    const { offset, length: n, ...rest } = e;
    return { ...rest, bytes: bytes.subarray(base + offset, base + offset + n) };
  });
}
