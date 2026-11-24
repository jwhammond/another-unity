// SPDX-License-Identifier: GPL-3.0-or-later
// A tiny .spr for tests: blocks as the file spells them, and a sprite whose LIST starts its animations at given entries.
/** A block of a .spr as the file spells it: the tag reversed, then the size with the header, then the body. */
export function block(tag: string, body: number[]): number[] {
  const out: number[] = [...[...tag].reverse().map(c => c.charCodeAt(0)), 0, 0, 0, 0, ...body];
  const size = out.length;
  out[4] = size & 0xff; out[5] = (size >> 8) & 0xff; out[6] = (size >> 16) & 0xff;
  return out;
}
export const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
export const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
/** A 2x1 picture of colours 5 and 6 in the second encoding (two bits of kind, one pixel each: 01 00000101 01 00000110). */
export const comp = (): number[] => block('COMP', [...u32(2), ...u32(1), ...u16(0xd), ...u16(2), 0x41, 0x50, 0x60]);
/** The same picture as a speech picture (SCOM: sprite.cpp reads it as COMP, marked as speech), as the admin console's pages are. */
export const scom = (): number[] => block('SCOM', [...u32(2), ...u32(1), ...u16(0xd), ...u16(2), 0x41, 0x50, 0x60]);
/** The same picture again, as the block `back` bytes earlier (type 3). */
export const again = (back: number): number[] => block('COMP', [...u32(2), ...u32(1), ...u16(0xd), ...u16(3), ...u32(back)]);

/** A sprite whose LIST has `entries` and an animation starting at each of the entry numbers in `starts` (null for none). */
export function sprite(entries: number[][], starts: (number | null)[]): Uint8Array {
  const headerLength = 8 + 4 + starts.length * 4;
  // (offsets are from the start of the LIST block)
  const offsets: (number | null)[] = [];
  let at = headerLength;
  const positions = entries.map(e => { const p = at; at += e.length; return p; });
  for (const s of starts) offsets.push(s === null ? 0 : positions[s]!);
  const list = block('LIST', [...u32(starts.length), ...offsets.flatMap(o => u32(o!)), ...entries.flat()]);
  return new Uint8Array([...block('SPRT', [...u32(0x1000), ...list])]);
}


/** A `width` by `height` picture of `indices` as a COMP (or, with tag SCOM, a speech picture) in the second encoding: a literal per pixel (01, then the colour). */
export function picture(width: number, height: number, indices: ArrayLike<number>, tag: 'COMP' | 'SCOM' = 'COMP'): number[] {
  const bytes = new Uint8Array(Math.ceil((width * height * 10) / 8));
  let bit = 0;
  const put = (value: number, count: number): void => {
    for (let k = count - 1; k >= 0; k--, bit++) if ((value >> k) & 1) bytes[bit >> 3] = bytes[bit >> 3]! | (0x80 >> (bit & 7));
  };
  for (let i = 0; i < width * height; i++) { put(1, 2); put(indices[i]!, 8); }
  return block(tag, [...u32(width), ...u32(height), ...u16(0xd), ...u16(2), ...bytes]);
}
