// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { clickWhenIdle, drive, goTo, quiet, shipArtPresent, watchConsole } from './helpers';

// docs/unity-ship-buttons.md, "Astrogation, what the original draws": the map as the original's three views, the chosen thing's name and info,
// the plate's fields and the Display tab. Each view is shot (element only) to ~/pcode/unity-raw/runs/ui-astro-map, or ASTRO_SHOTS.

const art = shipArtPresent(['astrogation']);
test.skip(!art.present, `needs ${art.why}`);
test.use({ actionTimeout: 30_000 });

const shots = process.env.ASTRO_SHOTS ?? `${homedir()}/pcode/unity-raw/runs/ui-astro-map`;
const painted = (page: Page, id: string) => page.locator(`.au-ship [data-painted="${id}"]`);
const readout = (page: Page, id: string) => page.locator(`.au-astro [data-readout="${id}"]`);

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  mkdirSync(shots, { recursive: true });
  await page.locator('.au-astro-plate .au-ship-screen').screenshot({ path: `${shots}/${name}.png` });
}
async function press(page: Page, id: string): Promise<void> {
  await drive(page, () => clickWhenIdle(painted(page, id)));
}
/** The fraction of the canvas that is not its background: a map with stars on it is not empty. */
const lit = (page: Page) => page.evaluate(() => window.__au!.coverage().nonBackground);

test('the astrogation map draws the original\'s views and selects as it does', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await goTo(page, 'Astrogation', 'astrogation');
  await quiet(page, 1);
  const panel = page.locator('.au-astro');

  // it opens on the Info tab, with the sector the ship is in chosen and written at the top, and the coordinates in the plate's two fields
  await expect(painted(page, 'tab-info')).toHaveAttribute('aria-pressed', 'true');
  await expect(readout(page, 'title')).not.toHaveText('');
  await expect(readout(page, 'title')).toHaveText(/ \d-\d-\d$/);
  for (const axis of ['x', 'y', 'z']) {
    await expect(readout(page, `cursor-${axis}`)).toHaveText(/^\d\d$/);
    await expect(readout(page, `ship-${axis}`)).toHaveText(/^\d\d$/);
  }
  expect(await lit(page)).toBeGreaterThan(0.001);
  await drive(page, () => clickWhenIdle(painted(page, 'pad-stop')));
  await shoot(page, 'galaxy');

  // a star the ship has scanned: in the sector view it is a sprite that picks, and chosen it is boxed and its name and info are written
  await page.evaluate(() => window.__au!.astroKnow(292, 1));
  await panel.locator('select').nth(0).selectOption('292');
  await panel.locator('select').nth(1).selectOption('1');
  await press(page, 'view-sector');
  await expect(painted(page, 'view-sector')).toHaveAttribute('aria-pressed', 'true');
  await shoot(page, 'sector');
  await expect(page.locator('.au-astro-detail h3')).not.toHaveText('');
  const picked = await page.evaluate(() => window.__au!.astroPoint(292, 2));
  expect(picked).not.toBeNull();
  await quiet(page, 1);
  await page.mouse.click(picked!.x, picked!.y);
  await expect(panel.locator('select').nth(1)).toHaveValue('2');
  await panel.locator('select').nth(1).selectOption('1');

  // the system view: the planets in a row with their orbits, picked by clicking, the chosen one's globe below
  await press(page, 'view-system');
  await shoot(page, 'system-star');
  const planet = await page.evaluate(() => window.__au!.astroPoint(292, 1, 2));
  expect(planet).not.toBeNull();
  await page.mouse.click(planet!.x, planet!.y);
  await expect(panel.locator('select').nth(2)).toHaveValue('2');
  await expect(page.locator('.au-astro-detail h3')).not.toHaveText('');
  await shoot(page, 'system-planet');
  const moon = await page.evaluate(() => window.__au!.astroPoint(292, 1, 2, 0));
  if (moon) {
    await page.mouse.click(moon.x, moon.y);
    await shoot(page, 'system-moon');
  }

  // the Display tab: a bar for each of the nine switches, lit or not, which switch the stars and the grid
  await press(page, 'tab-display');
  await expect(page.locator('.au-astro [data-switch]')).toHaveCount(9);
  await expect(page.locator('.au-astro [data-switch="0"] .au-astro-bar')).toHaveAttribute('data-on', '');
  await shoot(page, 'display');
  await page.locator('.au-astro [data-switch="1"]').click();
  await expect(page.locator('.au-astro [data-switch="1"] .au-astro-bar')).not.toHaveAttribute('data-on', '');
  await page.locator('.au-astro [data-switch="1"]').click();
  await press(page, 'view-galaxy');
  await press(page, 'tab-info');
  await press(page, 'tab-course');
  // (the original's course panel and the engine running on it, when published: the frames change)
  if (existsSync(new URL('../../../games/unity/art/astro/engine_warp0.webp', import.meta.url))) {
    await expect(page.locator('img[data-panel="course_warp"]')).toHaveCount(1);
    // (the panel's picture is fetched when it appears: wait for it, which beside other browsers takes more than the moment this once was given)
    await expect.poll(() => page.locator('img[data-panel]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
    const frame = () => page.locator('img[data-engine]').getAttribute('data-engine');
    const first = await frame();
    await expect.poll(frame, { timeout: 5_000 }).not.toBe(first);
    await press(page, 'impulse');
    await expect(page.locator('img[data-panel="course_impulse"]')).toHaveCount(1);
    await press(page, 'warp');
  }
  await shoot(page, 'course');
  await press(page, 'tab-info');
  await expect(page.locator('img[data-panel="info_tab"]')).toHaveCount(existsSync(new URL('../../../games/unity/art/astro/info_tab.webp', import.meta.url)) ? 1 : 0);
  expect(errors).toEqual([]);
});
