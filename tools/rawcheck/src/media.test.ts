// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { pngInfo, wavInfo } from './media';

function wav(channels: number, rate: number, frames: number): Buffer {
  const size = frames * channels * 2;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + size, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(size, 40);
  return b;
}

describe('wavInfo', () => {
  it('reads a 16-bit PCM header', () => {
    const b = wav(2, 22050, 100);
    expect(wavInfo(b.subarray(0, 44), b.length)).toEqual({ channels: 2, rate: 22050, frames: 100 });
  });

  it('rejects a truncated file', () => {
    const b = wav(1, 22050, 100);
    expect(wavInfo(b.subarray(0, 44), b.length - 2)).toBe('sizes disagree');
  });

  it('rejects something that isn\'t a WAV', () => {
    expect(wavInfo(Buffer.alloc(44), 44)).toBe('not a canonical WAV');
  });
});

describe('pngInfo', () => {
  it('reads the size from IHDR', () => {
    const b = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(640, 16); b.writeUInt32BE(480, 20);
    expect(pngInfo(b)).toEqual({ width: 640, height: 480 });
  });

  it('rejects something that isn\'t a PNG', () => {
    expect(pngInfo(Buffer.alloc(24))).toBe('not a PNG');
  });
});
