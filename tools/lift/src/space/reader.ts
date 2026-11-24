// SPDX-License-Identifier: GPL-3.0-or-later
/** A reader that throws a RangeError past the end, where a ScummVM stream's err() would turn a load false. Little-endian unless named `be`. */
export class ByteReader {
  pos = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get size(): number { return this.bytes.length; }
  seek(pos: number): this { this.pos = pos; return this; }
  skip(n: number): this { this.pos += n; return this; }

  private take(n: number): number {
    const at = this.pos;
    if (at < 0 || at + n > this.bytes.length) throw new RangeError(`a read of ${n} at ${at} is past the end (${this.bytes.length})`);
    this.pos += n;
    return at;
  }

  u8(): number { return this.view.getUint8(this.take(1)); }
  s8(): number { return this.view.getInt8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  s32(): number { return this.view.getInt32(this.take(4), true); }
  f32(): number { return this.view.getFloat32(this.take(4), true); }
  u16be(): number { return this.view.getUint16(this.take(2), false); }
  u32be(): number { return this.view.getUint32(this.take(4), false); }
  bytesOf(n: number): Uint8Array { const at = this.take(n); return this.bytes.subarray(at, at + n); }
  /** n bytes as a C string: up to the first NUL, one character a byte. */
  cstring(n: number): string {
    const raw = this.bytesOf(n);
    const nul = raw.indexOf(0);
    return String.fromCharCode(...(nul < 0 ? raw : raw.subarray(0, nul)));
  }
  tag(): string { return String.fromCharCode(...this.bytesOf(4)); }
}

/** Runs a parse, giving null where it read past the end. */
export function orNull<T>(parse: () => T | null): T | null {
  try {
    return parse();
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}
