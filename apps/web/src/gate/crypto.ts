// SPDX-License-Identifier: GPL-3.0-or-later
// The CD gate's cryptography: a key from the CD's own bytes, and the sealed-file format. WebCrypto only
// (globalThis.crypto.subtle), so the page, the service worker and Node all run this same code.

export type GateErrorCode = 'not-sealed' | 'wrong-key' | 'wrong-files' | 'missing-file' | 'no-cue' | 'no-bin' | 'unreadable';

export class GateError extends Error {
  readonly code: GateErrorCode;
  readonly detail?: string;
  constructor(code: GateErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GateError';
    this.code = code;
    this.detail = detail;
  }
}

/** The ASCII `AUGT`, the version byte, then the 12-byte IV. */
export const HEADER_BYTES = 17;
/** What the check file seals; opening it is how a CD is told right from wrong. */
export const CHECK_PLAINTEXT = 'another-unity gate check v1';

const MAGIC = [0x41, 0x55, 0x47, 0x54];
const VERSION = 1;
const IV_BYTES = 12;
const KEY_INFO = 'au-gate-v1';
const IV_INFO = 'au-gate-v1-iv';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** HKDF-SHA-256 (RFC 5869) to `bits` raw bits. */
export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const out = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, base, bits);
  return new Uint8Array(out);
}

/** The AES-GCM 256 key from the SHA-256 of each range, in order. */
export async function deriveGateKey(digests: Uint8Array[], salt: Uint8Array, extractable = false): Promise<CryptoKey> {
  const raw = await hkdfBits(concat(digests), salt, utf8(KEY_INFO), 256);
  return subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

/** The HMAC key the IVs come from, so sealing the same file twice gives the same bytes. */
export async function deriveIvKey(digests: Uint8Array[], salt: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdfBits(concat(digests), salt, utf8(IV_INFO), 256);
  return subtle().importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Header, then AES-GCM of `plain`; the IV is the first 12 bytes of HMAC(ivKey, path, 0, plain). */
export async function seal(key: CryptoKey, ivKey: CryptoKey, path: string, plain: Uint8Array): Promise<Uint8Array> {
  const mac = new Uint8Array(await subtle().sign('HMAC', ivKey, concat([utf8(path), new Uint8Array(1), plain]) as BufferSource));
  const iv = mac.slice(0, IV_BYTES);
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource));
  return concat([new Uint8Array([...MAGIC, VERSION]), iv, body]);
}

export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  return MAGIC.every((b, i) => bytes[i] === b) && bytes[4] === VERSION;
}

/** The plaintext of a sealed file; 'not-sealed' if it has no header, 'wrong-key' if the key doesn't open it. */
export async function open(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (!isSealed(sealed)) throw new GateError('not-sealed');
  const iv = sealed.slice(5, HEADER_BYTES);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, sealed.slice(HEADER_BYTES) as BufferSource));
  } catch {
    throw new GateError('wrong-key');
  }
}
