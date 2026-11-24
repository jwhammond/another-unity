// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3 } from '@another-unity/engine';

/** Little-endian bytes, growing. */
class Bin {
  readonly out: number[] = [];
  get length(): number { return this.out.length; }
  u8(n: number): this { this.out.push(n & 0xff); return this; }
  u16(n: number): this { return this.u8(n).u8(n >>> 8); }
  u32(n: number): this { return this.u16(n & 0xffff).u16((n >>> 16) & 0xffff); }
  f32(x: number): this {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, x, true);
    for (let i = 0; i < 4; i++) this.u8(d.getUint8(i));
    return this;
  }
  text(s: string, n: number): this { for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0); return this; }
  setU32(at: number, n: number): this { for (let i = 0; i < 4; i++) this.out[at + i] = (n >>> (8 * i)) & 0xff; return this; }
  pad4(): this { while (this.out.length % 4) this.u8(0); return this; }
  bytes(): Uint8Array { return Uint8Array.from(this.out); }
}

export interface MakePart {
  vertices: Vec3[]; uv?: [number, number][];
  faces: { material: number; twoSided?: boolean; v: [number, number, number] }[];
  vertexNormals?: Vec3[]; faceNormals?: Vec3[]; faceD?: number[]; billboard?: boolean; faceType?: number;
}

/** A synthetic .3dv: the 0x1e-byte header, then the block SpaceModel::load reads by offsets from 0x1e (space3d.cpp:117-195). */
export function makeSpaceModel(o: { name?: string; size?: Vec3; centre?: Vec3; hidden?: number[]; parts: MakePart[]; version?: number }): Uint8Array {
  const head = new Bin().u32(0).u16(o.version ?? 0x6e).u32(0).text(o.name ?? 'MODEL.TXT', 20);
  const b = new Bin();
  const n = o.parts.length;
  b.u32(0).u32(n);
  const partTableAt = b.length;
  b.u32(0).u32(0);
  for (const x of [...(o.size ?? [1, 1, 1]), ...(o.centre ?? [0, 0, 0])]) b.f32(x);
  const hiddenAt = b.length;
  b.u32(0);
  b.setU32(hiddenAt, b.length);
  for (let i = 0; i < n; i++) b.u8(o.hidden?.[i] ?? 0);
  b.pad4();
  const table = b.length;
  b.setU32(partTableAt, table);
  for (let i = 0; i < n * 0x2c; i++) b.u8(0);
  o.parts.forEach((p, i) => {
    const row = table + i * 0x2c;
    b.setU32(row, p.billboard ? -p.vertices.length : p.vertices.length).setU32(row + 4, p.faces.length).setU32(row + 8, p.faceType ?? 2);
    const offset = (k: number) => b.setU32(row + 12 + 4 * k, b.length);
    offset(0);
    for (const v of p.vertices) for (const x of v) b.f32(x);
    if (p.uv) {
      offset(1);
      for (const [u, v] of p.uv) b.u32(u).u32(v);
    }
    offset(4);
    for (const f of p.faces) {
      b.u16(f.material | (f.twoSided ? 0x8000 : 0));
      for (const v of f.v) b.u16(v);
    }
    b.pad4();
    offset(5);
    for (const v of p.vertexNormals ?? p.vertices.map((): Vec3 => [0, 0, -1])) for (const x of v) b.f32(x);
    offset(6);
    for (const v of p.faceNormals ?? p.faces.map((): Vec3 => [0, 0, -1])) for (const x of v) b.f32(x);
    offset(7);
    for (const d of p.faceD ?? p.faces.map(() => 0)) b.f32(d);
  });
  return Uint8Array.from([...head.out, ...b.out]);
}

/** A synthetic .mtl: the count at 4, each material's 0x24 bytes at 0x1e + 0x24i (SpaceResources::materials, space3d.cpp:537-567). */
export function makeSpaceMaterials(defs: { colour?: number; alpha?: number; flags: number; texture?: string }[]): Uint8Array {
  const b = new Bin().u32(0x24).u32(defs.length).text('MATS.TXT', 0x1e - 8);
  for (const d of defs) b.u32(d.colour ?? 0).u32(d.alpha ?? 0).u32(d.flags).u32(0).text(d.texture ?? '', 20);
  return b.bytes();
}

/** A standard GIF LZW compressor (8-bit symbols): a clear code first, codes that widen from 9 bits as the table grows, then the end code. */
function lzwCodes(pixels: number[], emit: (code: number, size: number) => void): void {
  const table = new Map<string, number>();
  let next = 258;
  let size = 9;
  emit(256, size);
  let run = '';
  for (const p of pixels) {
    const key = run + String.fromCharCode(p);
    if (!run || table.has(key)) { run = key; continue; }
    emit(run.length === 1 ? run.charCodeAt(0) : table.get(run)!, size);
    if (next < 4096) {
      table.set(key, next);
      if (next === 1 << size && size < 12) size++;
      next++;
    }
    run = String.fromCharCode(p);
  }
  if (run) emit(run.length === 1 ? run.charCodeAt(0) : table.get(run)!, size);
  emit(257, size);
}

/**
 * A synthetic GIF87a with a global palette, one extension, and LZW codes the decoder must follow: a clear code before every
 * pixel, so the table never grows, then the end code (9-bit codes, least significant bit first). With `interlaced`, `pixels`
 * is in the file's row order (passes 0, 4, 2, 1). With `lzw`, the pixels are really compressed, so the table grows.
 */
export function makeGif(width: number, height: number, pixels: number[], palette: Uint8Array, interlaced = false, lzw = false): Uint8Array {
  const b = new Bin().text('GIF87a', 6).u16(width).u16(height).u8(0x80 | 7).u8(0).u8(0);
  for (let i = 0; i < 768; i++) b.u8(palette[i] ?? 0);
  b.u8(0x21).u8(0xf9).u8(4).u8(0).u8(0).u8(0).u8(0).u8(0);
  b.u8(0x2c).u16(0).u16(0).u16(width).u16(height).u8(interlaced ? 0x40 : 0).u8(8);
  const data: number[] = [];
  let bits = 0;
  let count = 0;
  const emit = (code: number, size: number): void => {
    bits |= code << count;
    count += size;
    while (count >= 8) { data.push(bits & 0xff); bits >>>= 8; count -= 8; }
  };
  if (lzw) lzwCodes(pixels, emit);
  else for (const p of pixels) { emit(256, 9); emit(p, 9); }
  if (!lzw) emit(257, 9);
  if (count > 0) data.push(bits & 0xff);
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    b.u8(chunk.length);
    for (const x of chunk) b.u8(x);
  }
  b.u8(0).u8(0x3b);
  return b.bytes();
}

/** A synthetic IFF PBM (loadPBM, space3d.cpp:704-750). Compressed rows are one ByteRun1 run each: a repeat if the row is one colour, else a literal. */
export function makePbm(width: number, height: number, pixels: number[], palette: Uint8Array, compressed = false): Uint8Array {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const tag = (s: string) => [...s].map(c => c.charCodeAt(0));
  const chunk = (name: string, data: number[]) => [...tag(name), ...be32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
  const rowBytes = (width + 1) & ~1;
  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = Array.from({ length: rowBytes }, (_, x) => (x < width ? pixels[y * width + x]! : 0));
    if (!compressed) body.push(...row);
    else if (row.every(p => p === row[0])) body.push((1 - rowBytes) & 0xff, row[0]!);
    else body.push(rowBytes - 1, ...row);
  }
  const bmhd = [width >> 8, width & 0xff, height >> 8, height & 0xff, 0, 0, 0, 0, 8, 0, compressed ? 1 : 0, 0, 0, 0, 1, 1, width >> 8, width & 0xff, height >> 8, height & 0xff];
  const inner = [...tag('PBM '), ...chunk('BMHD', bmhd), ...chunk('CMAP', [...palette]), ...chunk('BODY', body)];
  return Uint8Array.from([...tag('FORM'), ...be32(inner.length), ...inner]);
}

/** A .pic: 256 palette entries (6-bit, as `palette` gives them) and 640x480 indices, `fill` everywhere but `pixels` at the start. */
export function makePic(palette: Uint8Array, fill: number, pixels: number[] = []): Uint8Array {
  const out = new Uint8Array(768 + 640 * 480).fill(fill, 768);
  out.set(palette.subarray(0, 768));
  out.set(pixels, 768);
  return out;
}

/** An .mrg: a u16 count, a u32 offset each, then each entry's u16 width, u16 height and indices. */
export function makeMrg(entries: { width: number; height: number; pixels: number[] }[]): Uint8Array {
  const head = 2 + entries.length * 4;
  const out = new Uint8Array(head + entries.reduce((n, e) => n + 4 + e.width * e.height, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, entries.length, true);
  let at = head;
  entries.forEach((e, i) => {
    dv.setUint32(2 + i * 4, at, true);
    dv.setUint16(at, e.width, true);
    dv.setUint16(at + 2, e.height, true);
    out.set(e.pixels, at + 4);
    at += 4 + e.width * e.height;
  });
  return out;
}
