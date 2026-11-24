// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { SITE_PAGES } from '../src/swRules';
import { GAMEDATA_DIR, importCdFolder } from './gate';

// The deploy output as `wrangler pages dev` serves it (its _headers, so its CSP, and its Functions): the game starts, and nothing the
// CSP forbids is needed (the unity game once its CD unlocks it: deploy-gate.spec.ts has the gate itself). The existing unity e2e specs
// drive the game through window.__au, which a deploy build removes on purpose.
const lifted = existsSync(fileURLToPath(new URL('../../../games/unity/game.yaml', import.meta.url)));

/** Collects what a player's console would show as broken: errors, page errors, CSP violations and failed requests. */
async function watch(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => console.error(`CSP: ${e.violatedDirective} blocked ${e.blockedURI}`));
  });
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
  return problems;
}

async function firstScreen(page: Page): Promise<void> {
  // (the demo opens on a room with the verbs; a new game of the unity game opens on the ship's bridge)
  await expect(page.getByRole('button', { name: 'Look', exact: true }).or(page.getByRole('region', { name: 'Bridge' }))).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('canvas#view')).toBeVisible();
}

for (const game of lifted ? ['demo', 'unity'] : ['demo']) {
  test(`${game}: starts from the deploy output with no console errors, CSP violations or failed requests`, async ({ page }) => {
    test.skip(game === 'unity' && !GAMEDATA_DIR, 'the sealed game opens only with its CD: set GAMEDATA_DIR');
    const problems = await watch(page);
    await page.goto(`/play/afu/?game=${game}&mute`);
    // (the deploy's unity game is sealed: the import screen first, given the CD's folder, as a player would)
    if (game === 'unity') await importCdFolder(page);
    await firstScreen(page);
    // (the worker installs and precaches the shell under the same CSP)
    await page.waitForFunction(async () => (await caches.keys()).some(n => n.startsWith('au-shell-')), undefined, { timeout: 30_000 });
    expect(problems).toEqual([]);
  });
}

test('every site page loads under the CSP: fonts, styles, scripts and pictures, with no console errors or failed requests', async ({ page }) => {
  const problems = await watch(page);
  let pictures = 0;
  for (const path of SITE_PAGES) {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1);
    // (the pictures come in after the load, once the client has read the media manifest: wait for the first one, then ask for all of them)
    const first = await page.locator('.lc-ba img, .lc-figure img, .lc-frame img').first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (!first) continue;
    await page.evaluate(() => { for (const i of document.images) i.loading = 'eager'; });
    await page.waitForLoadState('networkidle');
    pictures += await page.evaluate(() => [...document.images].filter(i => i.complete && i.naturalWidth > 0).length);
    expect(await page.evaluate(() => [...document.images].filter(i => i.complete && i.naturalWidth === 0).length), `${path}: a picture failed to load`).toBe(0);
  }
  expect(problems).toEqual([]);
  test.skip(pictures === 0 && !existsSync(fileURLToPath(new URL('../public/site-media/manifest.json', import.meta.url))), 'no site media built here: the pictures were not exercised');
  expect(pictures, 'the site pictures were never loaded under the CSP').toBeGreaterThan(0);
});

test('?dev gives a player nothing: no test handle, no dev tools', async ({ page }) => {
  const problems = await watch(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute&dev');
  await firstScreen(page);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => setTimeout(resolve)))));
  expect(await page.evaluate(() => (window as unknown as { __au?: unknown }).__au === undefined)).toBe(true);
  await page.keyboard.press('`');
  await expect(page.getByRole('region', { name: 'Dev tools' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('headers: security headers on the page, no-cache on the page and worker, immutable on hashed files, the right types', async ({ request }) => {
  const page = await request.get('/');
  const h = page.headers();
  expect(h['cache-control']).toBe('no-cache');
  expect(h['x-robots-tag']).toContain('noindex');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).toContain("object-src 'none'");
  expect(h['referrer-policy']).toBe('no-referrer');
  for (const p of ['/sw.js', '/au-manifest.json', '/index.html', '/play/afu/', '/play/afu/index.html']) expect((await request.get(p)).headers()['cache-control'], p).toBe('no-cache');

  const manifest = (await (await request.get('/au-manifest.json')).json()) as { assets: { url: string }[]; shell: string[] };
  const want: Record<string, RegExp> = { webp: /^image\/webp/, opus: /^audio\//, glb: /^model\/gltf-binary/, webm: /^video\/webm/ };
  for (const [ext, type] of Object.entries(want)) {
    const a = manifest.assets.find(x => x.url.endsWith(`.${ext}`));
    if (!a) continue;
    const r = await request.get(a.url);
    expect(r.headers()['cache-control'], a.url).toBe('public, max-age=31536000, immutable');
    expect(r.headers()['content-type'], a.url).toMatch(type);
  }
  const js = manifest.shell.find(u => u.endsWith('.js'))!;
  expect((await request.get(js)).headers()['content-type']).toMatch(/javascript/);
  // (a missing file is a 404, not the game's page: a stale link never gets HTML in place of a script or image)
  const missing = await request.get('/assets/not-there.webp');
  expect(missing.status()).toBe(404);
});
