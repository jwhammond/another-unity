// SPDX-License-Identifier: GPL-3.0-or-later
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { deriveGateKey, deriveIvKey, open, seal } from './crypto';
import { clearKey, loadKey, saveKey } from './keyStore';

// (made-up digests and salt: no real gate parameters)
const digests = [1, 2, 3].map(i => new Uint8Array(32).fill(i * 7));
const salt = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

describe('gate key store', () => {
  it('a saved key loads back and can decrypt', async () => {
    const idb = new IDBFactory();
    const key = await deriveGateKey(digests, salt);
    const sealed = await seal(key, await deriveIvKey(digests, salt), 'x/y.bin', new TextEncoder().encode('made-up bytes'));
    await saveKey(key, idb);
    const back = await loadKey(idb);
    expect(back).toBeDefined();
    expect(back!.extractable).toBe(false);
    expect(new TextDecoder().decode(await open(back!, sealed))).toBe('made-up bytes');
  });

  it('clearKey leaves nothing', async () => {
    const idb = new IDBFactory();
    expect(await loadKey(idb)).toBeUndefined();
    await saveKey(await deriveGateKey(digests, salt), idb);
    await clearKey(idb);
    expect(await loadKey(idb)).toBeUndefined();
  });
});
