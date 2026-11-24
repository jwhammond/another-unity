// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { devices, expect, test, type Page } from '@playwright/test';
import { GAMEDATA_DIR, gateMessage, gateScreen, hasHdiutil, importCdFolder, importCdImage, makeIsoOnce, makeWrongCd, removeIso } from './gate';

// The CD gate on the deploy output (docs/deploy.md): the sealed game opens only with the player's CD. The CD is GAMEDATA_DIR, the folder
// the build sealed the game with; the made-up folders and the ISO are written under test-results (git-ignored) and removed.
const lifted = existsSync(fileURLToPath(new URL('../../../games/unity/game.yaml', import.meta.url)));
test.skip(!lifted || !GAMEDATA_DIR, 'needs the lifted game (games/unity) and its CD folder (GAMEDATA_DIR)');

const GAME = '/play/afu/?game=unity&mute';
const WRONG_FILES = "These don't look like the A Final Unity CD.";

async function firstScreen(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Bridge' })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('canvas#view')).toBeVisible();
}

/** The worker controls the page and has the shell: a reload can start offline. */
async function workerReady(page: Page): Promise<void> {
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller && (await caches.keys()).some(n => n.startsWith('au-shell-')), undefined, { timeout: 60_000 });
}

/** Movie responses seen (status and Range): a first screen that plays one shows the worker's answer for a sealed movie. */
function watchMovies(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', r => {
    if (/\.(webm|mp4)(\?|$)/.test(r.url())) seen.push(`${r.status()}${r.request().headers().range ? ' range' : ''}`);
  });
  return seen;
}

test.afterAll(() => removeIso());

test('wrong files get the message', async ({ page }, info) => {
  const wrong = makeWrongCd(info.outputPath('wrong-cd'));
  await page.goto(GAME);
  await expect(gateScreen(page)).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-gate=folder]').setInputFiles(wrong.folder);
  await expect(gateMessage(page)).toHaveText(WRONG_FILES, { timeout: 60_000 });
  await expect(page.locator('[data-gate=given]')).toContainText('NOT_THE_CD/');
  await page.locator('[data-gate=image]').setInputFiles(wrong.iso);
  await expect(gateMessage(page)).toHaveText(WRONG_FILES, { timeout: 60_000 });
  await expect(page.locator('[data-gate=given]')).toContainText('not-a-disc.iso');
  // (still locked: the game never started)
  await expect(gateScreen(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bridge' })).toHaveCount(0);
  rmSync(info.outputPath('wrong-cd'), { recursive: true, force: true });
});

test('the folder unlocks and the first screen draws', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
  const movies = watchMovies(page);
  await page.goto(GAME);
  const ms = await importCdFolder(page);
  await firstScreen(page);
  console.log(`folder import: ${ms} ms; movie responses: ${movies.join(', ') || 'none'}`);
  expect(problems).toEqual([]);
});

test('a reload plays without the import screen, offline too', async ({ page, context }) => {
  await page.goto(GAME);
  await importCdFolder(page);
  await firstScreen(page);
  await workerReady(page);
  await page.reload();
  await firstScreen(page);
  await expect(gateScreen(page)).toHaveCount(0);
  await context.setOffline(true);
  await page.reload();
  await firstScreen(page);
  await expect(gateScreen(page)).toHaveCount(0);
  await context.setOffline(false);
});

test('a cleared key brings the import screen back', async ({ page }) => {
  await page.goto(GAME);
  await importCdFolder(page);
  await firstScreen(page);
  await page.evaluate(() => new Promise<void>(resolve => {
    const r = indexedDB.deleteDatabase('au-gate');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  }));
  await page.reload();
  await expect(gateScreen(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Bridge' })).toHaveCount(0);
});

test.describe('a phone', () => {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7']!;
  test.use(pixel);

  test('a phone viewport unlocks from the ISO', async ({ page }) => {
    test.skip(!hasHdiutil(), 'no hdiutil to make the ISO with');
    const iso = makeIsoOnce();
    await page.goto(GAME);
    await expect(gateScreen(page)).toBeVisible({ timeout: 60_000 });
    // (a phone has no folders to pick: only the disc image)
    await expect(page.locator('[data-gate=folder]')).toHaveCount(0);
    const ms = await importCdImage(page, iso);
    console.log(`ISO import (phone): ${ms} ms`);
    await firstScreen(page);
  });
});
