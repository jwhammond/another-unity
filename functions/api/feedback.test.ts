// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { handleFeedback, LIMITS, onRequestGet, siteverify, TEST_SECRET, type Deps, type FeedbackEnv, type Verdict } from './feedback';

const ORIGIN = 'https://another-unity.pages.dev';
const good = { message: 'The door on Horst III would not open', email: '', save: '{"version":4}', saveNote: null, game: { screen: 'horst3.s01' }, client: { build: 'abc' }, errors: [], token: 'tok', trap: '' };

function setup(over: { env?: Partial<FeedbackEnv>; verdict?: Verdict | Error } = {}) {
  const put = vi.fn(async () => undefined);
  const env: FeedbackEnv = { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', FEEDBACK: { put }, ...over.env };
  const verdict = over.verdict ?? { success: true, hostname: 'another-unity.pages.dev', action: 'feedback' };
  const deps: Deps = {
    verify: vi.fn(async () => { if (verdict instanceof Error) throw verdict; return verdict; }),
    now: () => new Date('2026-11-24T10:20:30.400Z'),
    id: () => '0123456789abcdef',
    notify: vi.fn(async () => undefined),
  };
  return { env, deps, put };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/feedback`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('GET /api/feedback', () => {
  it('hands out the site key once feedback is set up, and is off (503) without either key or the bucket', async () => {
    const { env } = setup();
    expect(await onRequestGet({ request: new Request(`${ORIGIN}/api/feedback`), env }).json()).toEqual({ siteKey: 'site' });
    for (const missing of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'FEEDBACK'] as const)
      expect(onRequestGet({ request: new Request(`${ORIGIN}/api/feedback`), env: { ...env, [missing]: undefined } }).status).toBe(503);
  });
  it('never hands out the secret', async () => {
    const { env } = setup();
    expect(await onRequestGet({ request: new Request(`${ORIGIN}/api/feedback`), env }).text()).not.toContain('secret');
  });
});

describe('POST /api/feedback', () => {
  it('keeps a good report in the bucket under its day, and answers its short id', async () => {
    const { env, deps, put } = setup();
    const res = await handleFeedback({ request: post(good, { 'cf-connecting-ip': '203.0.113.9' }), env }, deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '01234567' });
    expect(deps.verify).toHaveBeenCalledWith('secret', 'tok', '203.0.113.9');
    const [key, value] = put.mock.calls[0]! as unknown as [string, string];
    expect(key).toBe('reports/2026-11-24/2026-11-24T10-20-30-400Z-01234567.json');
    const stored = JSON.parse(value);
    expect(stored).toMatchObject({ id: '0123456789abcdef', receivedAt: '2026-11-24T10:20:30.400Z', message: good.message, save: good.save, game: good.game, client: good.client });
    // (neither the token nor the trap nor the player's address is kept)
    expect(value).not.toContain('tok');
    expect(value).not.toContain('203.0.113.9');
  });

  it('refuses a token Turnstile does not pass, one for another hostname or action, and a siteverify that fails', async () => {
    for (const verdict of [{ success: false }, { success: true, hostname: 'evil.example', action: 'feedback' }, { success: true, hostname: 'another-unity.pages.dev', action: 'login' }, new Error('down')]) {
      const { env, deps, put } = setup({ verdict });
      const res = await handleFeedback({ request: post(good), env }, deps);
      expect(res.status).toBe(403);
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("takes Turnstile's always-passing test secret without its hostname and action (deploy:preview)", async () => {
    const { env, deps, put } = setup({ env: { TURNSTILE_SECRET_KEY: TEST_SECRET }, verdict: { success: true, hostname: 'example.com', action: '' } });
    expect((await handleFeedback({ request: post(good), env }, deps)).status).toBe(201);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('drops a report whose trap field is filled, telling the bot it worked, and asks Turnstile nothing', async () => {
    const { env, deps, put } = setup();
    const res = await handleFeedback({ request: post({ ...good, trap: 'http://spam.example' }), env }, deps);
    expect(res.status).toBe(201);
    expect(put).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it('refuses a request from another site or with no Origin, and anything but JSON', async () => {
    const { env, deps } = setup();
    expect((await handleFeedback({ request: post(good, { origin: 'https://evil.example' }), env }, deps)).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) });
    expect((await handleFeedback({ request: noOrigin, env }, deps)).status).toBe(403);
    expect((await handleFeedback({ request: post('message=hi', { 'content-type': 'application/x-www-form-urlencoded' }), env }, deps)).status).toBe(415);
    expect((await handleFeedback({ request: post('{not json'), env }, deps)).status).toBe(400);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it('refuses an empty or overlong message, a bad email, an oversized save or body, and a missing token', async () => {
    const { env, deps, put } = setup();
    const bad = [
      { ...good, message: '   ' },
      { ...good, message: 'x'.repeat(LIMITS.message + 1) },
      { ...good, email: 'not an email' },
      { ...good, save: 'x'.repeat(LIMITS.save + 1) },
      { ...good, game: 'horst3' },
      { ...good, errors: Array.from({ length: LIMITS.errors + 1 }, () => ({})) },
      { ...good, token: '' },
      [good],
    ];
    for (const body of bad) expect((await handleFeedback({ request: post(body), env }, deps)).status).toBe(400);
    expect((await handleFeedback({ request: post(good, { 'content-length': String(LIMITS.body + 1) }), env }, deps)).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it('is off (503) until set up, before it reads anything', async () => {
    const { env, deps } = setup({ env: { FEEDBACK: undefined } });
    expect((await handleFeedback({ request: post(good), env }, deps)).status).toBe(503);
  });

  it('tells the webhook of a kept report, with the start of its message, and keeps it even if the webhook fails', async () => {
    const { env, deps, put } = setup({ env: { FEEDBACK_WEBHOOK: 'https://hooks.example/x' } });
    vi.mocked(deps.notify).mockRejectedValueOnce(new Error('down'));
    const res = await handleFeedback({ request: post(good), env }, deps);
    expect(res.status).toBe(201);
    expect(put).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('https://hooks.example/x', 'New feedback 01234567: The door on Horst III would not open');
  });
});

describe('siteverify', () => {
  it('posts the secret, the token and the address to Cloudflare, and reads its answer', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect([form.get('secret'), form.get('response'), form.get('remoteip')]).toEqual(['s', 't', '198.51.100.1']);
      return new Response(JSON.stringify({ success: true, hostname: 'h', action: 'feedback' }));
    });
    expect(await siteverify('s', 't', '198.51.100.1', fetchFn as unknown as typeof fetch)).toEqual({ success: true, hostname: 'h', action: 'feedback' });
    expect(fetchFn.mock.calls[0]![0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  });
  it('a failed request is a failed check', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 500 }));
    expect((await siteverify('s', 't', null, fetchFn as unknown as typeof fetch)).success).toBe(false);
  });
});
