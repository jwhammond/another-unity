// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { clickWhenIdle, drive, engageCourse, quiet, station, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/game.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

const OUT = `${process.env.HOME}/pcode/unity-raw/runs/playtest`;

/** The window's box against the plate's strip: the strip is the bottom 116 of 480 rows of the plate's box. */
async function expectOnStrip(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const box = (e: Element | null) => { const b = e?.getBoundingClientRect(); return b ? [b.left, b.top, b.right, b.bottom] : null; };
    const plate = document.querySelector('.au-ship-art .au-ship-screen');
    const win = document.querySelector('.au-subtitle, .au-menu');
    return { plate: box(plate), win: box(win), opaque: win ? getComputedStyle(win).backgroundColor : null };
  });
  const [pl, pt, pr, pb] = r.plate!;
  const [wl, wt, wr, wb] = r.win!;
  const top = pt + (pb - pt) * (364 / 480);
  expect(Math.abs(wl - pl)).toBeLessThan(2);
  expect(Math.abs(wr - pr)).toBeLessThan(2);
  expect(Math.abs(wt - top)).toBeLessThan(2);
  expect(Math.abs(wb - pb)).toBeLessThan(2);
  expect(r.opaque).toMatch(/^rgb\(/);
}

test('the subtitle and the choice window cover the plate\'s interface strip, on the bridge and on the viewscreen station', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=6&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);

  // the opening's movies play first, and nothing else runs under them: skipped, as a player may
  const skip = page.locator('.au-movie').getByRole('button', { name: 'Skip' });
  await skip.waitFor({ timeout: 30_000 }).catch(() => {});
  while (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 2_000 }).catch(() => {});

  // the opening's first line is said on the bridge
  await page.locator('.au-subtitle').waitFor({ timeout: 60_000 });
  await expect(station(page, 'bridge')).toBeVisible();
  await page.waitForTimeout(600);
  await expectOnStrip(page);
  await page.screenshot({ path: `${OUT}/dialog-bridge-subtitle.png` });

  await quiet(page);
  await page.locator('.au-ship-item[title="Astrogation"]').click();
  const panel = page.locator('.au-astro');
  await panel.getByRole('combobox', { name: 'Sector' }).selectOption('156');
  await panel.getByLabel('Star').selectOption('3');
  await panel.getByLabel('Planet').selectOption('3');
  await engageCourse(page);

  // back on the bridge, the emergency hail's menu comes up there
  const menu = page.locator('.au-menu');
  const sub = page.locator('.au-subtitle');
  let shot = false;
  await drive(page, async () => {
    if (await menu.isVisible()) {
      if ((await station(page, 'bridge').count()) > 0) {
        await page.waitForTimeout(400);
        await expectOnStrip(page);
        await page.screenshot({ path: `${OUT}/dialog-bridge-choice.png` });
        shot = true;
      }
      return true;
    }
    if ((await station(page, 'bridge').count()) === 0 && !(await sub.isVisible())) {
      const exit = page.locator('.au-ship').getByRole('button', { name: 'Back to the bridge', exact: true }).first();
      if ((await exit.count()) > 0) await clickWhenIdle(exit);
    }
    return false;
  }, 90_000, true);
  expect(shot).toBe(true);

  // "On screen": the chancellor's hail on the viewscreen station, a line and then a menu
  await menu.getByRole('button').nth(1).click();
  await drive(page, async () => (await station(page, 'viewscreen').count()) > 0 && (await sub.isVisible()), 60_000, true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/dialog-viewscreen-subtitle.png` });
  await expectOnStrip(page);

  // a choice on the viewscreen station: the contacts are hailed in turn until one has a menu for the captain
  await quiet(page);
  const contacts = await page.evaluate(() => Object.keys(window.__au!.state().objects).filter(id => id.startsWith('ship.')));
  let choice = false;
  for (const id of contacts) {
    await page.evaluate(o => window.__au!.hail(o), id);
    const seen = await drive(page, async () => (await menu.isVisible()) || (await page.evaluate(() => window.__au!.idle())), 20_000, true).then(() => menu.isVisible(), () => false);
    if (seen && (await station(page, 'viewscreen').count()) > 0) {
      await page.waitForTimeout(400);
      await expectOnStrip(page);
      await page.screenshot({ path: `${OUT}/dialog-viewscreen-choice.png` });
      choice = true;
      break;
    }
    await quiet(page).catch(() => {});
  }
  expect(choice).toBe(true);
  expect(errors).toEqual([]);
});
