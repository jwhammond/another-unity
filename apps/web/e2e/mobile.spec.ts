// SPDX-License-Identifier: GPL-3.0-or-later
import { devices, expect, test, type Page } from '@playwright/test';

// (the chromium project runs these: a descriptor's own browser type is dropped, its screen, touch and agent kept)
const phone = (name: string) => {
  const { defaultBrowserType: _ignored, ...rest } = devices[name]!;
  return rest;
};

const PHONES = ['iPhone 13', 'Pixel 7'] as const;
const url = '/play/afu/?game=demo&mute';
const rotate = (page: Page) => page.locator('#rotate');

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(page.locator('#loading')).toHaveCount(0);
}

for (const name of PHONES) {
  test.describe(`${name}, upright`, () => {
    test.use(phone(name));

    test('shows the rotate overlay, and the game is not reachable behind it', async ({ page }) => {
      await page.goto(url);
      await expect(rotate(page)).toBeVisible();
      await expect(rotate(page)).toContainText('Rotate your device');
      await ready(page);
      await expect(rotate(page)).toBeVisible();
    });
  });

  test.describe(`${name}, on its side`, () => {
    test.use(phone(`${name} landscape`));

    test('has no rotate overlay, and a landscape button on the loading screen and in the game', async ({ page }) => {
      // (the loading screen's button, while it is still up)
      let release: () => void = () => {};
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route(/\/src\/games\/demo\.ts/, async route => { await held; await route.continue(); });
      await page.goto(url, { waitUntil: 'commit' });
      await expect(page.locator('#loading .au-fs')).toBeVisible();
      release();
      await ready(page);
      await expect(rotate(page)).toBeHidden();
      await expect(page.locator('#game .au-fs')).toBeVisible();
    });

    test('a refused lock or fullscreen does not throw', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript(() => {
        const refused = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
        Element.prototype.requestFullscreen = refused;
        Object.defineProperty(screen, 'orientation', { value: { lock: refused, unlock() {}, type: 'landscape-primary', addEventListener() {}, removeEventListener() {} }, configurable: true });
        (window as unknown as { __locks: number }).__locks = 0;
        const orientation = screen.orientation as unknown as { lock: () => Promise<void> };
        orientation.lock = () => { (window as unknown as { __locks: number }).__locks++; return refused(); };
      });
      await page.goto(url);
      await ready(page);
      await page.locator('#game .au-fs').click();
      // (fullscreen is refused first; the lock is still asked for, and its rejection is caught too)
      await page.waitForFunction(() => (window as unknown as { __locks: number }).__locks === 1);
      await page.waitForTimeout(200);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('a desktop', () => {
  test('never shows the rotate overlay, even in a tall window, and has no landscape button', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 1000 });
    await page.goto(url);
    await ready(page);
    await expect(rotate(page)).toBeHidden();
    await expect(page.locator('#game .au-fs')).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(rotate(page)).toBeHidden();
  });
});

test('the manifest asks for fullscreen and landscape, and index.html links it', async ({ page, request }) => {
  await page.goto(url);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await request.get(href!)).json() as { display: string; orientation: string };
  expect(manifest.display).toBe('fullscreen');
  expect(manifest.orientation).toBe('landscape');
});
