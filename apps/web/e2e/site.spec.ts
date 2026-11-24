// SPDX-License-Identifier: GPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SITE_PAGES } from '../src/swRules';
import { MISSIONS } from '../src/site/pages/missions';

// (every page of the site: the list is the one the service worker precaches and the deploy check requires)
const PAGES = SITE_PAGES;

for (const path of PAGES) {
  test(`${path}: loads cleanly, passes axe, fits a phone`, async ({ page }) => {
    const errors: string[] = []; const failed: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => failed.push(r.url()));
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // (the side column is a top bar at this width: every pill is in view, wrapping onto a second line if it must)
    expect(await page.locator('.lc-side a').evaluateAll(as => as.filter(a => { const r = a.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; }).length)).toBe(0);
    expect(errors).toEqual([]); expect(failed).toEqual([]);
  });
}

for (const m of MISSIONS) {
  test(`mission ${m.world}: the worlds menu lists six, marks this one, and fits a phone`, async ({ page }) => {
    const errors: string[] = []; const failed: string[] = [];
    page.on('console', x => { if (x.type() === 'error') errors.push(x.text()); });
    page.on('requestfailed', r => failed.push(r.url()));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/engineering/afu/missions/${m.world}/`);
    const menu = page.getByRole('navigation', { name: 'Worlds' });
    await expect(menu.getByRole('link')).toHaveCount(6);
    await expect(menu.locator('[aria-current="page"]')).toHaveText(m.name);
    expect(await menu.getByRole('link').evaluateAll(as => as.map(a => a.getAttribute('href')))).toEqual(MISSIONS.map(x => `/engineering/afu/missions/${x.world}/`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await menu.evaluate(n => n.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(failed).toEqual([]);
  });
}

test('the A Final Unity "Missions" pill lands on the list of the worlds', async ({ page }) => {
  await page.goto('/engineering/afu/missions/zoo/');
  await page.getByRole('navigation', { name: 'A Final Unity' }).getByRole('link', { name: 'Missions' }).click();
  await page.waitForURL('**/engineering/afu/#missions');
  await expect(page.locator('#missions').getByRole('navigation', { name: 'Worlds' }).getByRole('link')).toHaveCount(6);
});

test('the Enterprise page shows the engineering, holodeck and astrogation screens when the media is built, placeholders otherwise', async ({ page }) => {
  const errors: string[] = []; const failed: string[] = [];
  page.on('console', x => { if (x.type() === 'error') errors.push(x.text()); });
  page.on('requestfailed', r => failed.push(r.url()));
  await page.goto('/engineering/afu/enterprise/');
  const manifest = await page.evaluate(() => fetch('/site-media/manifest.json').then(r => (r.ok ? r.json() : null)).catch(() => null)) as { items: Record<string, unknown> } | null;
  for (const [id, heading] of [['ship.engineering', 'Engineering'], ['ship.holodeck', 'Holodeck'], ['ship.astrogation.screen', 'Astrogation']] as const) {
    const panel = page.locator('.lc-panel', { has: page.getByRole('heading', { name: heading, exact: true }) });
    if (manifest?.items[id]) {
      const img = panel.locator('img[alt*="as a player sees it"]');
      await expect(img).toHaveCount(1);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    } else {
      await expect(panel.getByText(`No image · ${id}`)).toHaveCount(1);
    }
  }
  expect(errors).toEqual([]); expect(failed).toEqual([]);
});

test('sound is off by default and the toggle persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /sound off/i }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: /sound on/i })).toBeVisible();
});

test('mission pages: Tab reaches the slider of every room, rendered or not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/engineering/afu/missions/unity/');
  await page.waitForLoadState('networkidle');
  const rooms = await page.locator('.lc-room').count();
  test.skip(!(await page.locator('.lc-ba').count()), 'no site media built here');
  const seen = new Set<string>();
  for (let i = 0; i < 400 && seen.size < rooms; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => { const a = document.activeElement; return a?.getAttribute('role') === 'slider' || (a as HTMLInputElement | null)?.type === 'range' ? a!.closest('.lc-room')?.querySelector('h3')?.textContent ?? '' : ''; });
    if (id) seen.add(id);
  }
  expect(seen.size).toBe(rooms);
});


test('an old game link opens the game at /play/afu/', async ({ page }) => {
  await page.goto('/?game=demo&mute');
  await page.waitForURL('**/play/afu/?game=demo&mute');
  await expect(page.locator('#loading, canvas').first()).toBeAttached();
});

test('home: the game card opens its details and ENGAGE opens the game tab', async ({ page, context }) => {
  const errors: string[] = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Another Unity/i);
  await page.locator('[data-game="afu"]').click();
  await expect(page.getByText('It is currently in beta playtests.')).toBeVisible();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: /engage/i }).click()]);
  await tab.waitForURL('**/play/afu/', { waitUntil: 'commit' });
  await tab.close();
  // (force: Playwright waits forever for an aria-disabled button to become enabled; a visitor can click it, and it must stay shut)
  await page.locator('[data-game="ef"]').click({ force: true });
  await expect(page.locator('[aria-expanded="true"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('home: pressing ENGAGE twice focuses the game tab and does not restart it', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('[data-game="afu"]').click();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: /engage/i }).click()]);
  await tab.waitForURL('**/play/afu/', { waitUntil: 'commit' });
  await tab.waitForLoadState('domcontentloaded');
  // (a sentinel on the game tab's window: a reload or a navigation would drop it)
  await tab.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
  await page.bringToFront();
  await page.getByRole('button', { name: /engage/i }).click();
  await page.waitForTimeout(1000);
  expect(context.pages().filter(p => p.url().includes('/play/afu/'))).toHaveLength(1);
  expect(await tab.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);
  await tab.close();
});

test('engineering hub links to every sub-page, and the A Final Unity pages link to each other', async ({ page }) => {
  await page.goto('/engineering/');
  const hrefs = await page.locator('.lc-hub a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  for (const h of ['/engineering/engine/', '/engineering/afu/', '/engineering/afu/characters/', '/engineering/afu/enterprise/', ...['horst3', 'mertens', 'allanor', 'zoo', 'frigis', 'unity'].map(w => `/engineering/afu/missions/${w}/`)])
    expect(hrefs).toContain(h);
  for (const path of ['/engineering/afu/', '/engineering/afu/characters/', '/engineering/afu/enterprise/', '/engineering/afu/missions/zoo/']) {
    await page.goto(path);
    await expect(page.locator('.lc-subnav a')).toHaveCount(4);
  }
});

test('home: screenshots of the page, collapsed and expanded, wide and narrow', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'set SHOTS=<dir> to write screenshots');
  for (const [name, w, h] of [['1280', 1280, 900], ['390', 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.locator('[data-game="afu"]')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOTS}/home-${name}-collapsed.png`, fullPage: true });
    await page.locator('[data-game="afu"]').click();
    await expect(page.getByText('It is currently in beta playtests.')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOTS}/home-${name}-expanded.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('engineering pages: one h1 each, the AI note on the engine page, no console errors', async ({ page }) => {
  const errors: string[] = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`failed: ${r.url()}`));
  for (const path of ['/engineering/', '/engineering/engine/', '/engineering/afu/']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.lc-frame')).toHaveCount(1);
    if (path.endsWith('/engine/')) {
      await expect(page.getByText('I am not interested in discussions on the topic of AI usage.')).toBeVisible();
      await expect(page.locator('svg[role="img"]')).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('engineering pages: element screenshots, wide and narrow', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'set SHOTS=<dir> to write screenshots');
  for (const [name, w, h] of [['1280', 1280, 900], ['390', 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [slug, path] of [['engineering', '/engineering/'], ['engine', '/engineering/engine/'], ['afu', '/engineering/afu/'], ['characters', '/engineering/afu/characters/'], ['enterprise', '/engineering/afu/enterprise/'], ['mission', '/engineering/afu/missions/mertens/']]) {
      await page.goto(path);
      await expect(page.locator('.lc-frame')).toBeVisible();
      await page.evaluate(() => Promise.all([...document.images].map(i => { i.loading = 'eager'; return i.decode().catch(() => {}); })));
      // (a mission page is many rooms tall: its screenshot is the top of the page, where the menus are)
      if (slug === 'mission') await page.screenshot({ path: `${process.env.SHOTS}/${slug}-${name}.png` });
      else await page.locator('.lc-frame').screenshot({ path: `${process.env.SHOTS}/${slug}-${name}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test('characters page: one h1, no errors, no sideways scroll, the slider moves with the keyboard', async ({ page }) => {
  const errors: string[] = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`failed: ${r.url()}`));
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/engineering/afu/characters/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.lc-frame')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  // (with the media built, the sliders are there; without it the page shows placeholders and this part is skipped)
  const slider = page.getByRole('slider', { name: /^Compare original and remastered/ }).first();
  if (await slider.count()) {
    await slider.focus();
    const before = Number(await slider.inputValue());
    await page.keyboard.press('ArrowRight');
    expect(Number(await slider.inputValue())).toBe(before + 5);
  }
  expect(errors).toEqual([]);
});

test('enterprise page: one h1, five sections, no errors, no sideways scroll', async ({ page }) => {
  const errors: string[] = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`failed: ${r.url()}`));
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/engineering/afu/enterprise/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.lc-frame')).toHaveCount(1);
    await expect(page.locator('.lc-panel-h')).toHaveText(['Bridge', 'Astrogation', 'Transporter', 'Engineering', 'Holodeck']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('mission pages: one h1, no errors, no sideways scroll', async ({ page }) => {
  const errors: string[] = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`failed: ${r.url()}`));
  for (const world of ['horst3', 'mertens', 'allanor', 'zoo', 'frigis', 'unity']) {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/engineering/afu/missions/${world}/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('.lc-frame')).toHaveCount(1);
      await expect(page.locator('.lc-hotspots')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('mission pages: a long page asks for the rooms near the screen, not all of them', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const imgs: string[] = [];
  page.on('request', r => { if (/\/site-media\/room-/.test(r.url())) imgs.push(r.url()); });
  await page.goto('/engineering/afu/missions/unity/');
  await page.waitForLoadState('networkidle');
  // (pictures are two per room; only the rooms near the screen are rendered at first)
  const rooms = await page.locator('.lc-room').count();
  test.skip(!(await page.locator('.lc-ba').count()), 'no site media built here');
  {
    expect(await page.locator('.lc-ba img:not([loading="lazy"])').count()).toBe(0);
    expect(imgs.length).toBeLessThanOrEqual(rooms / 2 + 2);
  }
  await page.close();
});

test('room pairs: a dark room is shown whole (screenshots of the original and the plate)', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'set SHOTS=<dir> to write screenshots');
  for (const f of ['room-frigis-s0d-orig', 'room-frigis-s0d']) {
    const r = await page.goto(`/site-media/${f}.webp`);
    if (!r?.ok()) test.skip(true, 'no site media built here');
    await page.locator('img').screenshot({ path: `${process.env.SHOTS}/dark-${f}.png` });
  }
});
