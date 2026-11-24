// SPDX-License-Identifier: GPL-3.0-or-later
import { ByteReader, orNull } from './reader';

/** An 8-bit texture and the palette its file carries (SpaceTexture, space3d.h). Combat draws every texture in the space palette instead (palette.ts). */
export interface SpaceTexture { width: number; height: number; pixels: Uint8Array; palette: Uint8Array }

/** loadGIF (space3d.cpp:588-700): the first image, its LZW decoded and its interlace undone. */
export function decodeGif(bytes: Uint8Array): SpaceTexture | null {
  return orNull(() => {
    const r = new ByteReader(bytes);
    if (String.fromCharCode(...r.bytesOf(6)).slice(0, 4) !== 'GIF8') return null;
    r.u16();
    r.u16();
    const flags = r.u8();
    r.skip(2);
    const palette = new Uint8Array(768);
    if (flags & 0x80) palette.set(r.bytesOf(3 * (2 << (flags & 7))));
    for (;;) {
      const block = r.u8();
      if (block === 0x21) {
        // an extension, which we don't need
        r.u8();
        for (let size = r.u8(); size !== 0; size = r.u8()) r.skip(size);
        continue;
      }
      if (block !== 0x2c) return null;
      r.skip(4);
      const width = r.u16();
      const height = r.u16();
      const imageFlags = r.u8();
      if (imageFlags & 0x80) palette.set(r.bytesOf(3 * (2 << (imageFlags & 7))));
      const interlaced = (imageFlags & 0x40) !== 0;
      const minCodeSize = r.u8();
      const data: number[] = [];
      for (let size = r.u8(); size !== 0; size = r.u8()) data.push(...r.bytesOf(size));

      const clearCode = 1 << minCodeSize;
      const endCode = clearCode + 1;
      const prefix = new Uint16Array(4096);
      const suffix = new Uint8Array(4096);
      const stack = new Uint8Array(4097);
      const total = width * height;
      const out: number[] = [];
      let codeSize = minCodeSize + 1;
      let nextCode = endCode + 1;
      let previous = -1;
      let first = 0;
      let bits = 0;
      let numBits = 0;
      let pos = 0;
      while (out.length < total) {
        while (numBits < codeSize && pos < data.length) {
          bits |= data[pos++]! << numBits;
          numBits += 8;
        }
        if (numBits < codeSize) break;
        const code = bits & ((1 << codeSize) - 1);
        bits >>>= codeSize;
        numBits -= codeSize;
        if (code === clearCode) {
          codeSize = minCodeSize + 1;
          nextCode = endCode + 1;
          previous = -1;
          continue;
        }
        if (code === endCode) break;
        let top = 0;
        let current = code;
        if (previous !== -1 && code >= nextCode) {
          stack[top++] = first;
          current = previous;
        }
        while (current > endCode && top < 4096) {
          stack[top++] = suffix[current]!;
          current = prefix[current]!;
        }
        // (a byte in the C++)
        first = current & 0xff;
        stack[top++] = first;
        while (top) out.push(stack[--top]!);
        if (previous !== -1 && nextCode < 4096) {
          prefix[nextCode] = previous;
          suffix[nextCode] = first;
          nextCode++;
          if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
        }
        previous = code;
      }
      // (resized to the image, zero filled, as pixels.resize does)
      const pixels = new Uint8Array(total);
      pixels.set(out.slice(0, total));
      if (!interlaced) return { width, height, pixels, palette };
      // rows come in four passes
      const rows = new Uint8Array(total);
      const start = [0, 4, 2, 1];
      const step = [8, 8, 4, 2];
      let row = 0;
      for (let pass = 0; pass < 4; pass++) {
        for (let y = start[pass]!; y < height; y += step[pass]!) {
          rows.set(pixels.subarray(row * width, (row + 1) * width), y * width);
          row++;
        }
      }
      return { width, height, pixels: rows, palette };
    }
  });
}

/** loadPBM (space3d.cpp:704-750): an IFF "PBM " file, chunky, maybe ByteRun1. */
export function decodePbm(bytes: Uint8Array): SpaceTexture | null {
  return orNull(() => {
    const r = new ByteReader(bytes);
    if (r.tag() !== 'FORM') return null;
    r.u32be();
    if (r.tag() !== 'PBM ') return null;
    let width = 0;
    let height = 0;
    let compression = 0;
    const palette = new Uint8Array(768);
    while (r.pos + 8 <= r.size) {
      const tag = r.tag();
      const size = r.u32be();
      const next = r.pos + size + (size & 1);
      if (tag === 'BMHD') {
        width = r.u16be();
        height = r.u16be();
        // (then the position, planes and masking)
        r.skip(6);
        compression = r.u8();
      } else if (tag === 'CMAP') {
        palette.set(r.bytesOf(Math.min(size, 768)));
      } else if (tag === 'BODY') {
        const rowBytes = (width + 1) & ~1;
        const row = new Uint8Array(rowBytes);
        const pixels = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
          if (compression) {
            let x = 0;
            while (x < rowBytes && r.pos < r.size) {
              const n = r.s8();
              if (n >= 0) {
                for (let i = 0; i <= n && x < rowBytes; i++) row[x++] = r.u8();
              } else if (n !== -128) {
                const value = r.u8();
                for (let i = 0; i <= -n && x < rowBytes; i++) row[x++] = value;
              }
            }
          } else {
            row.set(r.bytesOf(rowBytes));
          }
          pixels.set(row.subarray(0, width), y * width);
        }
        return { width, height, pixels, palette };
      }
      r.seek(next);
    }
    return null;
  });
}

/** As SpaceResources::texture picks the reader (space3d.cpp:575): PBM for .lbm, GIF otherwise. */
export function decodeTexture(name: string, bytes: Uint8Array): SpaceTexture | null {
  return name.toLowerCase().endsWith('.lbm') ? decodePbm(bytes) : decodeGif(bytes);
}
