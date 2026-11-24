// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHECK_PLAINTEXT, GateError, HEADER_BYTES, deriveGateKey, deriveIvKey, hkdfBits, isSealed, open, seal } from './crypto';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));
const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const digests = (n: number) => [1, 2, 3].map(i => new Uint8Array(32).fill(i + n));
const salt = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const plain = new TextEncoder().encode(CHECK_PLAINTEXT);

describe('gate crypto', () => {
  it('derives the RFC 5869 test case 1 key', async () => {
    const ikm = hex('0b'.repeat(22));
    const s = hex('000102030405060708090a0b0c');
    const info = hex('f0f1f2f3f4f5f6f7f8f9');
    const okm = await hkdfBits(ikm, s, info, 336);
    expect(toHex(okm.slice(0, 32))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
    // the same bits as a made-extractable key
    const base = await globalThis.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const key = await globalThis.crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    expect(toHex(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key)))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
  });

  it('seal then open round-trips', async () => {
    const key = await deriveGateKey(digests(0), salt);
    const ivKey = await deriveIvKey(digests(0), salt);
    const sealed = await seal(key, ivKey, 'a/b.bin', plain);
    expect(sealed.length).toBe(HEADER_BYTES + plain.length + 16);
    expect(await open(key, sealed)).toEqual(plain);
  });

  it('the same input seals to the same bytes', async () => {
    const key = await deriveGateKey(digests(0), salt);
    const ivKey = await deriveIvKey(digests(0), salt);
    expect(await seal(key, ivKey, 'x', plain)).toEqual(await seal(key, ivKey, 'x', plain));
  });

  it('a different path seals differently', async () => {
    const key = await deriveGateKey(digests(0), salt);
    const ivKey = await deriveIvKey(digests(0), salt);
    expect(await seal(key, ivKey, 'x', plain)).not.toEqual(await seal(key, ivKey, 'y', plain));
  });

  it('open with another key throws wrong-key', async () => {
    const key = await deriveGateKey(digests(0), salt);
    const other = await deriveGateKey(digests(10), salt);
    const sealed = await seal(key, await deriveIvKey(digests(0), salt), 'x', plain);
    await expect(open(other, sealed)).rejects.toMatchObject({ code: 'wrong-key' });
    await expect(open(other, sealed)).rejects.toBeInstanceOf(GateError);
  });

  it('open of plain bytes throws not-sealed', async () => {
    const key = await deriveGateKey(digests(0), salt);
    await expect(open(key, new Uint8Array(100))).rejects.toMatchObject({ code: 'not-sealed' });
  });

  it('isSealed sees the header', async () => {
    const key = await deriveGateKey(digests(0), salt);
    const sealed = await seal(key, await deriveIvKey(digests(0), salt), 'x', plain);
    expect(isSealed(sealed)).toBe(true);
    expect(isSealed(plain)).toBe(false);
    expect(isSealed(sealed.slice(0, HEADER_BYTES - 1))).toBe(false);
  });
});
