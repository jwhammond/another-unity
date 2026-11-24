// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/game.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

test('theatre mode: the page darkens while a movie plays, and lights again when it is skipped', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=6&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  const movie = page.locator('.au-movie');
  const skip = movie.getByRole('button', { name: 'Skip' });
  await skip.waitFor({ timeout: 30_000 });
  await expect(page.locator('body')).toHaveClass(/theatre/);
  // (the veil is dark, takes no input, and the movie is above it)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').opacity)).toBe('0.92');
  expect(await page.evaluate(() => getComputedStyle(document.body, '::before').pointerEvents)).toBe('none');
  expect(await movie.evaluate(el => getComputedStyle(el).zIndex)).toBe('41');
  // skipped by Escape, as a player may
  await page.keyboard.press('Escape');
  // (the opening has more than one movie: the class stays while the next plays, and goes when none does)
  while (await skip.isVisible().catch(() => false)) {
    await expect(page.locator('body')).toHaveClass(/theatre/);
    await skip.click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(page.locator('body')).not.toHaveClass(/theatre/);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').opacity)).toBe('0');
  expect(errors).toEqual([]);
});
