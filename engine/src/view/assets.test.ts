// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from './assets';

describe('AssetIndex.fromGlob', () => {
  const glob = {
    '../games/mini/audio/voice/a.opus': '/a.opus',
    '../games/mini2/audio/voice/b.opus': '/b.opus',
  };

  it('keeps only files under the base, relative to it', () => {
    const index = AssetIndex.fromGlob('../games/mini/', glob);
    expect(index.voice('a')).toBe('/a.opus');
    expect(index.voice('b')).toBeUndefined();
  });

  it('adds a missing trailing slash, so ../games/mini does not match ../games/mini2/...', () => {
    const index = AssetIndex.fromGlob('../games/mini', glob);
    expect(index.voice('a')).toBe('/a.opus');
    expect(index.url('2/audio/voice/b.opus')).toBeUndefined();
    expect(index.voice('b')).toBeUndefined();
  });
});

describe('AssetIndex.spaceModel', () => {
  it('finds a space combat model by its combat.yaml url (Plan 18)', () => {
    const index = new AssetIndex([['space/chodak.3dv.glb', '/assets/chodak.3dv-abc.glb']]);
    expect(index.spaceModel('space/chodak.3dv.glb')).toBe('/assets/chodak.3dv-abc.glb');
    expect(index.spaceModel('space/gone.3dv.glb')).toBeUndefined();
  });
});
