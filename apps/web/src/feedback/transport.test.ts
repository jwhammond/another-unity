// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport } from '@another-unity/engine/web';
import { clearErrorLog, ERROR_LOG_MAX, logError, recentErrors } from './errorLog';
import { FEEDBACK_ACTION, feedbackTransport, NOT_HERE, OFFLINE, type Turnstile } from './transport';

const report: FeedbackReport = { message: 'Hi', email: '', save: null, saveNote: null, game: { game: 'unity', screen: 'horst3.s01', onShip: false, station: null, gameOver: false, awayTeam: [], currentActor: 'picard', beamWorld: null, combat: null, difficulty: 1, settings: null, recentLines: [] } };

function deps(over: { config?: Response | Error; post?: Response | Error; online?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = init?.method === 'POST' ? over.post ?? Response.json({ id: 'abcd1234' }, { status: 201 }) : over.config ?? Response.json({ siteKey: 'site-key' });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let options: Record<string, unknown> = {};
  const api: Turnstile = { render: vi.fn((_el, o) => { options = o; return 'w1'; }), reset: vi.fn(), remove: vi.fn() };
  const nav = { ...navigator, onLine: over.online ?? true, userAgent: 'test-agent', language: 'en-GB', maxTouchPoints: 0 } as Navigator;
  const t = feedbackTransport({ fetch: fetchFn as unknown as typeof fetch, turnstile: async () => api, doc: document, nav, win: window });
  return { t, calls, api, options: () => options };
}

afterEach(() => { clearErrorLog(); document.head.innerHTML = ''; });

describe('the feedback transport', () => {
  it("draws Turnstile with the function's site key and the feedback action, shown only when needed, and hands over its token", async () => {
    const d = deps();
    const box = document.createElement('div');
    const check = await d.t.check(box);
    expect(d.calls[0]!.url).toBe('/api/feedback');
    expect(d.api.render).toHaveBeenCalledWith(box, expect.objectContaining({ sitekey: 'site-key', action: FEEDBACK_ACTION, appearance: 'interaction-only' }));
    expect(check.token()).toBeUndefined();
    (d.options().callback as (t: string) => void)('tok');
    expect(check.token()).toBe('tok');
    check.reset();
    expect(check.token()).toBeUndefined();
    expect(d.api.reset).toHaveBeenCalledWith('w1');
    check.dispose();
    expect(d.api.remove).toHaveBeenCalledWith('w1');
  });

  it('says feedback needs a connection when offline, and cannot be sent from here when the site has none', async () => {
    await expect(deps({ online: false }).t.check(document.createElement('div'))).rejects.toThrow(OFFLINE);
    await expect(deps({ config: new TypeError('Failed to fetch') }).t.check(document.createElement('div'))).rejects.toThrow(OFFLINE);
    await expect(deps({ config: Response.json({ error: 'off' }, { status: 503 }) }).t.check(document.createElement('div'))).rejects.toThrow(NOT_HERE);
    // (the dev server answers with the game's page)
    await expect(deps({ config: new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) }).t.check(document.createElement('div'))).rejects.toThrow(NOT_HERE);
  });

  it("posts the report as JSON with the browser's details, the recent errors, the token and the trap, and answers the id", async () => {
    const d = deps();
    logError('error', [new Error('boom')], new Date('2026-11-24T00:00:00Z'));
    expect(await d.t.send(report, 'tok', '')).toBe('abcd1234');
    const post = d.calls.find(c => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/feedback');
    expect((post.init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = JSON.parse(post.init!.body as string);
    expect(body).toMatchObject({ message: 'Hi', token: 'tok', trap: '', game: { screen: 'horst3.s01' }, client: { build: 'dev', userAgent: 'test-agent', language: 'en-GB', touch: false } });
    expect(body.errors[0]).toMatchObject({ level: 'error', at: '2026-11-24T00:00:00.000Z' });
    expect(body.errors[0].text).toContain('Error: boom');
  });

  it("reads the build from the page's version meta", async () => {
    document.head.innerHTML = '<meta name="au-version" content="0123456789ab">';
    const d = deps();
    await d.t.send(report, 'tok', '');
    expect(JSON.parse(d.calls[0]!.init!.body as string).client.build).toBe('0123456789ab');
  });

  it("says the function's reason when a send is refused, and that it needs a connection when it can't reach it", async () => {
    await expect(deps({ post: Response.json({ error: 'The check against bots did not pass: try again' }, { status: 403 }) }).t.send(report, 'tok', '')).rejects.toThrow('The check against bots did not pass');
    await expect(deps({ post: new Response('oops', { status: 500 }) }).t.send(report, 'tok', '')).rejects.toThrow('(500)');
    await expect(deps({ post: new TypeError('Failed to fetch') }).t.send(report, 'tok', '')).rejects.toThrow(OFFLINE);
  });
});

describe('the error log', () => {
  it('keeps the last ERROR_LOG_MAX errors and warnings, each cut to length', () => {
    for (let i = 0; i < ERROR_LOG_MAX + 5; i++) logError('warn', [`w${i}`, { n: i }]);
    const all = recentErrors();
    expect(all).toHaveLength(ERROR_LOG_MAX);
    expect(all[0]!.text).toBe('w5 {"n":5}');
    logError('error', ['x'.repeat(5000)]);
    expect(recentErrors().at(-1)!.text).toHaveLength(1000);
  });
});
