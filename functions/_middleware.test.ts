// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { authorized, challenge, onRequest, parseBasic, safeEqual } from './_middleware';

const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`;
const passed = new Response('game');
const run = (env: { SITE_PASSWORD?: string; SITE_USER?: string }, auth?: string) =>
  onRequest({ request: new Request('https://x.test/', { headers: auth ? { Authorization: auth } : {} }), env, next: async () => passed });

describe('functions/_middleware', () => {
  it('is a no-op without SITE_PASSWORD (an Access-only site is not affected)', async () => {
    expect(await run({})).toBe(passed);
    expect(await run({ SITE_PASSWORD: '' })).toBe(passed);
    expect(await run({}, 'Basic garbage')).toBe(passed);
  });

  it('challenges a request with no, wrong or malformed credentials', async () => {
    for (const auth of [undefined, basic('u', 'wrong'), 'Basic !!!', 'Bearer abc', 'Basic ' + btoa('no-colon')]) {
      const res = await run({ SITE_PASSWORD: 's3cret' }, auth);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toMatch(/^Basic realm=/);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('lets the right password through, with any user name unless SITE_USER is set', async () => {
    expect(await run({ SITE_PASSWORD: 's3cret' }, basic('anyone', 's3cret'))).toBe(passed);
    expect(await run({ SITE_PASSWORD: 's3cret' }, basic('', 's3cret'))).toBe(passed);
    expect(await run({ SITE_PASSWORD: 's3cret', SITE_USER: 'tester' }, basic('tester', 's3cret'))).toBe(passed);
    expect((await run({ SITE_PASSWORD: 's3cret', SITE_USER: 'tester' }, basic('other', 's3cret'))).status).toBe(401);
  });

  it('takes passwords with colons and non-ASCII characters', async () => {
    const pw = 'pa:ss wörd ✓';
    const bytes = new TextEncoder().encode(`u:${pw}`);
    const header = `Basic ${btoa(String.fromCharCode(...bytes))}`;
    expect(parseBasic(header)).toEqual({ user: 'u', password: pw });
    expect(await authorized(header, { SITE_PASSWORD: pw })).toBe(true);
  });

  it('compares without early exit (equal, prefix, longer, empty)', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', 'a')).toBe(false);
    expect(await safeEqual('', '')).toBe(true);
  });

  it('the challenge is never cached or indexed', () => {
    const c = challenge();
    expect(c.status).toBe(401);
    expect(c.headers.get('X-Robots-Tag')).toContain('noindex');
  });
});
