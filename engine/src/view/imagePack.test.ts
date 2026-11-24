// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMAGE_PACK_VERSION, parseImagePack, writeImagePack } from './imagePack';

const entry = (name: string, n: number, meta?: Record<string, unknown>) => ({ name, type: 'image/webp', width: n, height: n + 1, ...(meta ? { meta } : {}), bytes: Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff) });

describe('image packs (M8 spec Decision 19; Plan 30 R14)', () => {
  it('reads back what it wrote: names, types, sizes, meta and bytes, in order', () => {
    const entries = [entry('tex:a', 5), entry('sheet:b.spr', 3, { columns: 2, cell: [40, 32] }), entry('7', 0)];
    const back = parseImagePack(writeImagePack(entries));
    expect(back.map(e => [e.name, e.type, e.width, e.height, e.meta ?? null, [...e.bytes]])).toEqual(entries.map(e => [e.name, e.type, e.width, e.height, e.meta ?? null, [...e.bytes]]));
  });

  it('starts with "AUIP" and the header\'s length, and says its version', () => {
    const bytes = writeImagePack([entry('x', 2)]);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('AUIP');
    const length = new DataView(bytes.buffer).getUint32(4, true);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)))).toMatchObject({ version: IMAGE_PACK_VERSION, entries: [{ name: 'x', offset: 0, length: 2 }] });
    expect(bytes.length).toBe(8 + length + 2);
  });

  it('refuses a name twice, a file that isn\'t a pack, a cut-off pack and another version', () => {
    expect(() => writeImagePack([entry('x', 1), entry('x', 2)])).toThrow('names "x" twice');
    expect(() => parseImagePack(new TextEncoder().encode('PACKxxxx'))).toThrow('not an image pack');
    const whole = writeImagePack([entry('x', 4)]);
    expect(() => parseImagePack(whole.subarray(0, whole.length - 1))).toThrow('ends inside "x"');
    expect(() => parseImagePack(whole.subarray(0, 12))).toThrow('ends inside its header');
    const v2 = new TextEncoder().encode(JSON.stringify({ version: 2, entries: [] }));
    const other = new Uint8Array(8 + v2.length);
    new DataView(other.buffer).setUint32(0, 0x50495541, true);
    new DataView(other.buffer).setUint32(4, v2.length, true);
    other.set(v2, 8);
    expect(() => parseImagePack(other)).toThrow('version 2, not 1');
  });
});
