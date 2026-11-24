// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CONTENT_UNREADABLE, parseContentPack } from './contentPack';

describe('parseContentPack', () => {
  it('reads the map of path to yaml', () => {
    expect(parseContentPack('{"made/up.yaml":"a: 1\\n"}')).toEqual({ 'made/up.yaml': 'a: 1\n' });
  });

  it('a file still sealed (or damaged) is an error that says Reload, never the parser\'s', () => {
    // (a made-up sealed header and bytes, as a worker of another build passes it through)
    const sealedLike = 'AUGT\u0001\u0000\u0007made-up ciphertext';
    expect(() => parseContentPack(sealedLike)).toThrow(CONTENT_UNREADABLE);
    expect(() => parseContentPack('[1, 2]')).toThrow(CONTENT_UNREADABLE);
    expect(() => parseContentPack('null')).toThrow(CONTENT_UNREADABLE);
    expect(CONTENT_UNREADABLE).toMatch(/Reload/);
  });
});
