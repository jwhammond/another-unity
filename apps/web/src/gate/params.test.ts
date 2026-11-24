// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gateParamsJson, parseGateParams } from './params';

const salt = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const b64 = btoa(String.fromCharCode(...salt));
const range = (o: Partial<{ path: string; offset: number; length: number }> = {}) => ({ path: 'A.DAT', offset: 8192, length: 65536, ...o });
const json = (o: { salt?: string; ranges?: unknown[] } = {}) =>
  JSON.stringify({ version: 1, salt: b64, ranges: [range(), range({ path: 'B.DAT' }), range({ path: 'C.DAT' })], ...o });

describe('parseGateParams', () => {
  it('parses a valid set', () => {
    const p = parseGateParams(json());
    expect(p.version).toBe(1);
    expect(p.salt).toEqual(salt);
    expect(p.ranges[1]).toEqual({ path: 'B.DAT', offset: 8192, length: 65536 });
  });

  it('reads JSON and YAML alike', () => {
    const yaml = `version: 1\nsalt: ${b64}\nranges:\n` + ['A', 'B', 'C'].map(n => `  - { path: ${n}.DAT, offset: 8192, length: 65536 }\n`).join('');
    expect(parseGateParams(yaml)).toEqual(parseGateParams(json()));
  });

  it('round-trips through gateParamsJson', () => {
    const p = parseGateParams(json());
    expect(parseGateParams(gateParamsJson(p))).toEqual(p);
  });

  it('rejects a range under offset 5000', () => {
    expect(() => parseGateParams(json({ ranges: [range({ offset: 4999 }), range(), range()] }))).toThrow(/offset 5000/);
  });

  it('rejects a length outside 65536..1048576', () => {
    expect(() => parseGateParams(json({ ranges: [range({ length: 65535 }), range(), range()] }))).toThrow(/65536 to 1048576/);
    expect(() => parseGateParams(json({ ranges: [range({ length: 1048577 }), range(), range()] }))).toThrow(/65536 to 1048576/);
  });

  it('rejects fewer than 3 or more than 6 ranges', () => {
    expect(() => parseGateParams(json({ ranges: [range(), range()] }))).toThrow(/3 to 6 ranges/);
    expect(() => parseGateParams(json({ ranges: Array.from({ length: 7 }, () => range()) }))).toThrow(/3 to 6 ranges/);
  });

  it('rejects a salt that is not 32 bytes', () => {
    expect(() => parseGateParams(json({ salt: btoa('short') }))).toThrow(/32 bytes/);
  });
});
