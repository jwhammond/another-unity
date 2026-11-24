// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHECK_PLAINTEXT, deriveGateKey, deriveIvKey, open, seal } from './crypto';
import { folderSource, rangeDigests, unlock } from './disc';
import { fakeFiles } from './testDisc';
import type { GateParams } from './params';

const bytes = (n: number, k: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * k + 7) & 255);
const params: GateParams = {
  version: 1, salt: Uint8Array.from({ length: 32 }, (_, i) => i),
  ranges: [{ path: 'ONE.DAT', offset: 5000, length: 65536 }, { path: 'TWO.DAT', offset: 6000, length: 65536 }, { path: 'THREE.DAT', offset: 7000, length: 65536 }],
};
const disc = { 'one.dat': bytes(80000, 3), 'two.dat': bytes(80000, 5), 'three.dat': bytes(80000, 11) };

describe('unlock', () => {
  it('gives a key that opens what the right files sealed', async () => {
    const src = folderSource(fakeFiles(disc));
    const d = await rangeDigests(src, params);
    const sealed = await seal(await deriveGateKey(d, params.salt), await deriveIvKey(d, params.salt), 'check', new TextEncoder().encode(CHECK_PLAINTEXT));
    const key = await unlock(src, params, sealed);
    expect(new TextDecoder().decode(await open(key, bytes(0, 0).length ? sealed : sealed))).toBe(CHECK_PLAINTEXT);
  });

  it('other files say wrong-files', async () => {
    const good = folderSource(fakeFiles(disc));
    const d = await rangeDigests(good, params);
    const sealed = await seal(await deriveGateKey(d, params.salt), await deriveIvKey(d, params.salt), 'check', new TextEncoder().encode(CHECK_PLAINTEXT));
    const bad = folderSource(fakeFiles({ ...disc, 'two.dat': bytes(80000, 13) }));
    await expect(unlock(bad, params, sealed)).rejects.toMatchObject({ code: 'wrong-files' });
  });
});
