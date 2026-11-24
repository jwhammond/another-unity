// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { loadMedia } from './media';

describe('loadMedia', () => {
  it('is empty when there is no manifest', async () => {
    const m = await loadMedia(vi.fn(async () => new Response('nope', { status: 404 })));
    expect(m.items).toEqual({});
  });
  it('is empty when the manifest is not JSON (e.g. a login page)', async () => {
    const m = await loadMedia(vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    expect(m.items).toEqual({});
  });
  it('is empty when the request fails', async () => {
    const m = await loadMedia(vi.fn(async () => { throw new Error('offline'); }));
    expect(m.items).toEqual({});
  });
  it('reads the items', async () => {
    const body = { version: 1, built: 'x', items: { 'home.afu': { src: '/site-media/home-afu.webp', w: 1280, h: 720, alt: 'a', kind: 'shot' } } };
    const m = await loadMedia(vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })));
    expect(m.items['home.afu']!.w).toBe(1280);
  });
});
