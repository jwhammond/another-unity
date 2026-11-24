// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { SITE_PAGES } from '../src/swRules';

// (the production preview: playwright.config.ts starts it on E2E_PORT + 1, 5291 with E2E_PORT=5290)
const PRODUCTION = `http://localhost:${Number(process.env.E2E_PORT ?? 5174) + 1}`;
const FIRST_SCREEN = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Look', exact: true });

test('offline: after one load, the game boots from the service worker cache with no network', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(`${PRODUCTION}/play/afu/?game=demo&speed=4&mute`);
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });

  // (the worker installs, claims the page, and is told what the page loaded: the shell and the game's package are then cached)
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const names = await caches.keys();
    const shell = names.find(n => n.startsWith('au-shell-'));
    const data = names.find(n => n.startsWith('au-data-'));
    if (!shell || !data) return false;
    return (await (await caches.open(data)).keys()).length > 0 && (await (await caches.open(shell)).keys()).length > 3;
  }, undefined, { timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });
  // (the same page, offline, with other parameters: a navigation is answered by the cached index whatever its query)
  await page.goto(`${PRODUCTION}/play/afu/?game=demo&mute`);
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('?sw=0 removes the worker and its caches', async ({ page }) => {
  await page.goto(`${PRODUCTION}/play/afu/?game=demo&speed=4&mute`);
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
  await page.goto(`${PRODUCTION}/play/afu/?game=demo&mute&sw=0`);
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0 && (await caches.keys()).length === 0, undefined, { timeout: 15_000 });
});

test('dev server: the worker is the dev variant, which keeps no code (HMR is untouched)', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/play/afu/?game=demo&speed=4&mute`);
  await expect(FIRST_SCREEN(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
  const script = await page.evaluate(async () => (await fetch('/sw.js')).text());
  expect(script).toContain('au-dev-assets');
  const names = await page.evaluate(() => caches.keys());
  expect(names.filter(n => n !== 'au-dev-assets')).toEqual([]);
  // (code and module requests reach the dev server: a changed module would otherwise never show)
  const code = await page.evaluate(async () => {
    const cache = await caches.open('au-dev-assets');
    return (await cache.keys()).map(r => new URL(r.url).pathname).filter(p => !/\.(webp|png|jpe?g|ogg|opus|mp3|wav|webm|mp4|glb|gltf|ktx2|fon|pack)$/.test(p));
  });
  expect(code).toEqual([]);
});

test('offline: after one visit, the site pages and the game shell load with no network', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${PRODUCTION}/`);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.goto(`${PRODUCTION}/engineering/`);
  await expect(page.locator('h1')).toHaveCount(1);
  // (the install caches every page of the site and the game's shell, whatever was visited: wait for all of them)
  const want = [...SITE_PAGES.filter(p => p !== '/').map(p => `${p}index.html`), '/index.html', '/play/afu/index.html'];
  // (polled from here: a waitForFunction with an async predicate can pass before the install has finished)
  await expect.poll(() => page.evaluate(async (want: string[]) => {
    if (!navigator.serviceWorker.controller) return false;
    const shell = (await caches.keys()).find(n => n.startsWith('au-shell-'));
    if (!shell) return false;
    const have = (await (await caches.open(shell)).keys()).map(r => new URL(r.url).pathname);
    return want.every(w => have.includes(w));
  }, want), { timeout: 30_000 }).toBe(true);

  await context.setOffline(true);
  await page.goto(`${PRODUCTION}/`);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText(/Another Unity/);
  await page.goto(`${PRODUCTION}/engineering/`);
  await expect(page.locator('h1')).toHaveText(/^Engineering$/i);
  await page.reload();
  await expect(page.locator('h1')).toHaveText(/^Engineering$/i);
  await page.goto(`${PRODUCTION}/engineering/afu/missions/zoo/`);
  await expect(page.locator('h1')).toHaveText(/^The zoo$/i);
  await page.goto(`${PRODUCTION}/play/afu/`);
  await expect(page.locator('#loading, canvas').first()).toBeAttached();
  expect(errors).toEqual([]);
});
