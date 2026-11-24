// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { answer, drive, engageCourse, quiet, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/game.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

/** The playtest: the story's first mission hail comes in while the ship is in transit, and the caller, not the warp, is on the viewscreen. */
test('the first mission hail shows its caller on the viewscreen, in transit', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=60&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.locator('.au-ship-item[title="Astrogation"]').click();
  const panel = page.locator('.au-astro');
  await panel.getByRole('combobox', { name: 'Sector' }).selectOption('156');
  await panel.getByLabel('Star').selectOption('3');
  await panel.getByLabel('Planet').selectOption('3');
  await engageCourse(page);
  // (the emergency transmission from Cymkoe IV: "On screen" is the menu's second option, and puts the chancellor's hail on the viewscreen
  // while the ship is still in transit; each line is then seen with the picture behind it)
  await answer(page, 1, 'ship.c007@1');
  const onViewscreen = async () => (await page.evaluate(() => window.__au!.art().ship.station)) === 'viewscreen';
  await drive(page, onViewscreen);
  for (let line = 0; line < 8 && (await onViewscreen()); line++) {
    const at = await page.evaluate(() => ({ transit: window.__au!.state().ship.transit !== null, art: window.__au!.art().ship.viewscreen }));
    expect(at.transit).toBe(true);
    expect(at.art).toBe('sprite');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${process.env.HOME}/pcode/unity-raw/runs/playtest/hail-line${line}.png` });
    await page.evaluate(() => window.__au!.skipLine());
    await page.waitForTimeout(500);
    if (await page.locator('.au-menu').isVisible()) await page.locator('.au-menu').getByRole('button').first().click();
  }
  expect(errors).toEqual([]);
});
