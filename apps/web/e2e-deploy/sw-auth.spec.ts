// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The service worker behind a gate (Cloudflare Access redirects to a sign-in page when a session expires; Basic Auth answers 401).
// The fixture server (scripts/deploy/authsim.ts) answers as the gate would, switched by /__mode. Whatever the gate says must never
// be stored as the game's files, and an online navigation must reach the gate so the sign-in appears.

const mode = (request: APIRequestContext, m: 'ok' | '401' | 'login' | 'html') => request.get(`/__mode?m=${m}`);
const LOOK = (page: Page) => page.getByRole('button', { name: 'Look', exact: true });

/** Every request URL in every au-* cache, and whether any cached body looks like a sign-in page or a gate's answer. */
async function cacheState(page: Page): Promise<{ urls: string[]; bad: string[] }> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    const bad: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        urls.push(req.url);
        const res = (await cache.match(req))!;
        const type = res.headers.get('content-type') ?? '';
        const isPage = /\/(index\.html)?$/.test(new URL(req.url).pathname);
        if (res.status !== 200 || res.redirected || res.type !== 'basic' || (!isPage && type.startsWith('text/html'))) bad.push(`${req.url} ${res.status} ${type}`);
        if (res.redirected || (await res.clone().text().then(t => t.includes('Sign in to continue'), () => false))) bad.push(`${req.url} holds a sign-in page`);
      }
    }
    return { urls, bad };
  });
}

test('behind a gate: a 401, a redirect to sign-in or a sign-in page in place of a file is never cached, and a navigation reaches the gate', async ({ page, request, context }) => {
  await mode(request, 'ok');
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await expect(LOOK(page)).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const shell = (await caches.keys()).find(n => n.startsWith('au-shell-'));
    return !!shell && (await (await caches.open(shell)).keys()).length > 3;
  }, undefined, { timeout: 30_000 });

  const before = await cacheState(page);
  expect(before.bad).toEqual([]);
  const manifest = (await (await request.get('/au-manifest.json')).json()) as { assets: { url: string }[]; data: string[] };
  // (files the page hasn't loaded yet: whatever the gate says about them must not be stored)
  const fresh = [...manifest.assets.map(a => a.url), ...manifest.data].filter(u => !before.urls.some(c => c.endsWith(u))).slice(0, 3);
  expect(fresh.length).toBeGreaterThan(0);

  for (const m of ['401', 'login', 'html'] as const) {
    await mode(request, m);
    for (const url of fresh) {
      const out = await page.evaluate(async u => {
        const r = await fetch(u);
        return { status: r.status, redirected: r.redirected, type: r.headers.get('content-type') };
      }, url);
      // (the page sees the gate's answer, as it would without the worker)
      if (m === '401') expect(out.status).toBe(401);
      if (m === 'login') expect(out.redirected).toBe(true);
      if (m === 'html') expect(out.type).toContain('text/html');
    }
    const after = await cacheState(page);
    expect(after.bad, m).toEqual([]);
    for (const url of fresh) expect(after.urls.some(c => c.endsWith(url)), `${m}: ${url}`).toBe(false);
    expect(after.urls.length, m).toBe(before.urls.length);
  }

  // (an expired session, online: the page load goes to the network and the sign-in appears, not the cached game)
  await mode(request, 'login');
  await page.goto('/play/afu/?game=demo&mute');
  await expect(page.locator('#login')).toBeVisible();
  await expect(LOOK(page)).toHaveCount(0);
  expect(page.url()).toContain('/login');
  await mode(request, '401');
  await page.goto('/play/afu/?game=demo&mute');
  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await expect(LOOK(page)).toHaveCount(0);
  // (and the cached game page is still the game's)
  const index = await page.evaluate(async () => {
    const name = (await caches.keys()).find(n => n.startsWith('au-shell-'))!;
    return (await (await (await caches.open(name)).match('/play/afu/index.html'))!.text());
  });
  expect(index).toContain('id="game"');
  expect((await cacheState(page)).bad).toEqual([]);

  // (the session is renewed: the game loads again; and with no network at all it starts from the cache)
  await mode(request, 'ok');
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await expect(LOOK(page)).toBeVisible({ timeout: 60_000 });
  await context.setOffline(true);
  await page.reload();
  await expect(LOOK(page)).toBeVisible({ timeout: 60_000 });
  await context.setOffline(false);
});
