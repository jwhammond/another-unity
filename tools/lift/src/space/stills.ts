// SPDX-License-Identifier: GPL-3.0-or-later
import type { IndexedImage } from '../../../../engine/src/view/indexed';

/** A .pic's size: graphics.cpp setBackgroundImage (graphics.cpp:311-342) reads 256 6-bit colours, then 640x480 indices. */
export const PIC_WIDTH = 640;
export const PIC_HEIGHT = 480;
const PIC_COLOURS = 256;

/**
 * A .pic still (`spc00a.pic`, the console; `cheap.pic`, the warp's background): Graphics::setBackgroundImage (graphics.cpp:311-342).
 * The file's 256 palette entries are 6-bit, shifted left by two as the original does; then the 640x480 indices. Null for a file too
 * short to hold them.
 */
export function decodePic(bytes: Uint8Array): { image: IndexedImage; palette: Uint8Array } | null {
  const need = PIC_COLOURS * 3 + PIC_WIDTH * PIC_HEIGHT;
  if (bytes.length < need) return null;
  const palette = Uint8Array.from(bytes.subarray(0, PIC_COLOURS * 3), v => (v << 2) & 0xff);
  return { image: { width: PIC_WIDTH, height: PIC_HEIGHT, pixels: bytes.slice(PIC_COLOURS * 3, need) }, palette };
}

/**
 * An .mrg file's entries (`space.mrg`): Graphics::loadMRG (graphics.cpp:262-286), a u16 count, a u32 offset each, then at each
 * offset a u16 width, a u16 height and width x height indices, little-endian. Null for a file whose entries run past its end.
 */
export function decodeMrg(bytes: Uint8Array): IndexedImage[] | null {
  if (bytes.length < 2) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(0, true);
  if (2 + count * 4 > bytes.length) return null;
  const out: IndexedImage[] = [];
  for (let i = 0; i < count; i++) {
    const at = dv.getUint32(2 + i * 4, true);
    if (at + 4 > bytes.length) return null;
    const width = dv.getUint16(at, true), height = dv.getUint16(at + 2, true);
    if (at + 4 + width * height > bytes.length) return null;
    out.push({ width, height, pixels: bytes.slice(at + 4, at + 4 + width * height) });
  }
  return out;
}
