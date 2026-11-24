// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { addItem, newManifest, serialize } from './manifest';

const entry = { src: '/site-media/a.webp', w: 10, h: 5, alt: 'a', kind: 'shot' as const };

describe('site media manifest', () => {
  it('rejects a src outside /site-media/', () => {
    const m = newManifest('t');
    expect(() => addItem(m, 'a', { ...entry, src: '/play/a.webp' })).toThrow(/site-media/);
    expect(() => addItem(m, 'a', { ...entry, src: '/site-media/../x.webp' })).toThrow(/site-media/);
    expect(() => addItem(m, 'a', { ...entry, pairSrc: 'https://x/y.webp' })).toThrow(/site-media/);
  });
  it('rejects a duplicate id', () => {
    const m = newManifest('t');
    addItem(m, 'a', entry);
    expect(() => addItem(m, 'a', entry)).toThrow(/duplicate/);
  });
  it('serializes with sorted keys, whatever the insertion order', () => {
    const a = newManifest('t');
    addItem(a, 'b', entry);
    addItem(a, 'a', { ...entry, kind: 'pair', pairSrc: '/site-media/p.webp' });
    const b = newManifest('t');
    addItem(b, 'a', { pairSrc: '/site-media/p.webp', kind: 'pair', alt: 'a', h: 5, w: 10, src: '/site-media/a.webp' });
    addItem(b, 'b', entry);
    expect(serialize(a)).toBe(serialize(b));
    expect(Object.keys(JSON.parse(serialize(a)).items)).toEqual(['a', 'b']);
  });
});
