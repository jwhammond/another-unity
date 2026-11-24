// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkManifest } from './manifest';

const good = {
  format: 'another-unity/raw-ir',
  version: 1,
  generator: 'scummvm unity-export',
  objects: ['000000', '070103'],
  conversations: ['w007c000'],
  screens: ['s_0701'],
  worlds: ['w_07'],
  files: ['objects/o_000000.json', 'objects/o_070103.json'],
};

describe('checkManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(checkManifest(good)).toEqual([]);
  });

  it('rejects an unknown key', () => {
    expect(checkManifest({ ...good, extra: 1 })[0]).toMatch(/extra/);
  });

  it('rejects a malformed id', () => {
    expect(checkManifest({ ...good, objects: ['70103'] })[0]).toMatch(/^objects\.0: /);
  });

  it('rejects a list out of order, or with a duplicate', () => {
    expect(checkManifest({ ...good, objects: ['070103', '000000'] })).toEqual(['objects: not sorted and unique']);
    expect(checkManifest({ ...good, worlds: ['w_07', 'w_07'] })).toEqual(['worlds: not sorted and unique']);
  });
});
