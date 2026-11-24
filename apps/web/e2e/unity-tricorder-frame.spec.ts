// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { artSpritesPresent, gameLifted, NEEDS_GAME, button, panelPresent, portraitsPresent, settled, watchConsole } from './helpers';

test.skip(!gameLifted, NEEDS_GAME);

// The tricorder's readout is drawn on the original's tricorder (tricord.spr's frame and tricord.mrg's buttons, `art tricorder publish`), where the
// original draws it: the frame 115 of 640 across and the frame's height down, the text on its black screen. Without the art it is the plain dialog.

const TEAM = ['picard', 'riker', 'data', 'troi'];
const ITEMS = ['tricorder', 'phaser', 'med_kit', 'med_tricorder', 'communicator'];
const START = `/play/afu/?game=unity&dev&start=lab.s01&team=${TEAM.join(',')}&mute&speed=8`;
const tricorder = artSpritesPresent('tricorder', 'tricorder publish');
const panel = panelPresent();
const kit = portraitsPresent(TEAM, ITEMS);

async function open(page: Page, query: string): Promise<string[]> {
  const errors = watchConsole(page);
  await page.goto(`${START}${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  return errors;
}

/** Looks at the tricorder, which opens it on all its readings. */
async function lookAtTricorder(page: Page, lookButton: () => Promise<void>): Promise<void> {
  await lookButton();
  await page.locator('[data-item="tricorder"]').or(page.getByRole('button', { name: 'tricorder', exact: true })).first().click();
  await page.getByRole('dialog', { name: 'Tricorder' }).waitFor();
}

test.describe('with the frame published', () => {
  test.skip(!tricorder.present || !panel.present || !kit.present, `needs ${tricorder.why || panel.why || kit.why}`);

  test('the readout is inside the tricorder\'s frame, at the original\'s place, and the buttons work', async ({ page }) => {
    const errors = await open(page, '');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.au-awaypanel img')].every(i => i.complete && i.naturalWidth > 0));
    await lookAtTricorder(page, () => button(page, 'Look').click());
    const dialog = page.getByRole('dialog', { name: 'Tricorder' });
    await expect(dialog).toHaveClass(/au-tricorder-art/);
    await expect.poll(() => dialog.locator('img.au-tricorder-frame').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(410 * 4);
    const geometry = await page.evaluate(() => {
      const g = document.querySelector('#game')!.getBoundingClientRect();
      const d = document.querySelector('.au-tricorder-art')!.getBoundingClientRect();
      const s = document.querySelector('.au-tricorder-screen')!.getBoundingClientRect();
      return { g: [g.left, g.top, g.width, g.height], d: [d.left, d.top, d.width, d.height], s: [s.left, s.top, s.width, s.height] };
    });
    const k = geometry.g[2]! / 640;
    // (drawn with its top left at 115, 0 of the 640 by 480 screen, 410 by 478)
    expect(geometry.d[0]! - geometry.g[0]!).toBeCloseTo(115 * k, 0);
    expect(geometry.d[1]! - geometry.g[1]!).toBeCloseTo(0, 0);
    expect(geometry.d[2]).toBeCloseTo(410 * k, 0);
    expect(geometry.d[3]).toBeCloseTo(478 * k, 0);
    // (its text screen, 121, 97 from the frame's corner, 223 by 191, wholly inside the frame)
    expect(geometry.s[0]! - geometry.d[0]!).toBeCloseTo(121 * k, 0);
    expect(geometry.s[1]! - geometry.d[1]!).toBeCloseTo(97 * k, 0);
    expect(geometry.s[2]).toBeCloseTo(223 * k, 0);
    expect(geometry.s[3]).toBeCloseTo(191 * k, 0);
    // (what it says is a reading's page or the reading's number, on that screen)
    expect((await dialog.locator('.au-tricorder-screen').textContent())!.trim().length).toBeGreaterThan(0);
    // (its buttons keep their names and Close puts the viewer away)
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Previous' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('with the art off the viewer is the plain dialog', async ({ page }) => {
  const errors = await open(page, '&art=0');
  await lookAtTricorder(page, () => button(page, 'Look').click());
  const dialog = page.getByRole('dialog', { name: 'Tricorder' });
  await expect(dialog).not.toHaveClass(/au-tricorder-art/);
  await expect(dialog.locator('img')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
