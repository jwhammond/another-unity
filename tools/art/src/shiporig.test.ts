// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { decodeBackground, drawRects, readZipMember } from './shiporig';
import type { SpawnLike } from './comfy';

/** A "file": a palette of `colours` 6-bit entries (entry i = i, i+1, i+2 mod 64), then 640x480 indices (a 4x2 pattern, rest 0). */
function fake(colours: number): Uint8Array {
  const out = new Uint8Array(colours * 3 + 640 * 480);
  for (let i = 0; i < colours; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = (i + c) % 64;
  const px = [0, 1, 2, 127, 128, 129, 200, 255];
  px.forEach((v, i) => (out[colours * 3 + Math.floor(i / 4) * 640 + (i % 4)] = v));
  return out;
}
const std = new Uint8Array(128 * 3).map((_, i) => 63 - (i % 64));
const at = (img: { data: Uint8Array }, x: number, y: number): number[] => [...img.data.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 4)];

describe('decodeBackground', () => {
  it('decodes 128 6-bit entries shifted left by 2, the rest from the standard palette, and 640x480 indices', () => {
    const img = decodeBackground(fake(128), std, 'bridge.rm');
    expect([img.width, img.height]).toEqual([640, 480]);
    expect(at(img, 1, 0)).toEqual([4, 8, 12, 255]);
    // index 127: entry (127, 128, 129) mod 64 = (63, 0, 1)
    expect(at(img, 3, 0)).toEqual([63 << 2, 0, 1 << 2, 255]);
    // index 128: standard entry 0; index 255 is standard entry 127
    expect(at(img, 0, 1)).toEqual([63 << 2, 62 << 2, 61 << 2, 255]);
    expect(at(img, 3, 1)).toEqual([std[381]! << 2, std[382]! << 2, std[383]! << 2, 255]);
  });
  it('a .pic takes all 256 entries from the file', () => {
    const img = decodeBackground(fake(256), std, 'ENG00A.PIC');
    // index 255: entry (255, 256, 257) mod 64 = (63, 0, 1)
    expect(at(img, 3, 1)).toEqual([63 << 2, 0, 1 << 2, 255]);
  });
  it('rejects a short file', () => {
    expect(() => decodeBackground(new Uint8Array(100), std, 'x.rm')).toThrow(/need/);
  });
});

describe('readZipMember', () => {
  function mock(code: number, data: string): { spawnFn: SpawnLike; calls: { cmd: string; args: string[] }[] } {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
      setTimeout(() => {
        (child.stdout as PassThrough).emit('data', Buffer.from(data));
        (child.stderr as PassThrough).emit('data', Buffer.from(code ? 'caution: filename not matched' : ''));
        child.emit('close', code);
      }, 1);
      return child;
    };
    return { spawnFn, calls };
  }
  it('passes zip and member as argv to unzip -p and rejects on a non-zero exit', async () => {
    const ok = mock(0, 'abc');
    expect([...(await readZipMember('/g/STTNG.ZIP', 'bridge.rm; rm -rf', ok.spawnFn))]).toEqual([97, 98, 99]);
    expect(ok.calls).toEqual([{ cmd: 'unzip', args: ['-p', '/g/STTNG.ZIP', 'bridge.rm; rm -rf'] }]);
    await expect(readZipMember('/g/STTNG.ZIP', 'nope', mock(11, '').spawnFn)).rejects.toThrow(/exited 11.*not matched/);
  });
});

describe('drawRects', () => {
  it('outlines in yellow without touching the original', () => {
    const img = { width: 10, height: 10, data: new Uint8Array(400) };
    const out = drawRects(img, [{ x: 2, y: 2, width: 5, height: 5 }]);
    expect([...out.data.subarray((2 * 10 + 2) * 4, (2 * 10 + 2) * 4 + 3)]).toEqual([255, 230, 0]);
    expect(img.data[(2 * 10 + 2) * 4]).toBe(0);
    expect(out.data[(4 * 10 + 4) * 4]).toBe(0);
  });
});
