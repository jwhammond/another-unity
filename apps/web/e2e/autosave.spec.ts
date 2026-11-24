// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, button, clickObject, dragToInventory, hold, settled, state, watchConsole } from './helpers';

// ?autosave asks for the player's autosave and Continue in a browser that Playwright drives (navigator.webdriver), where it is otherwise off.
const URL = '/play/afu/?game=demo&speed=4&mute&autosave';

/** The page goes to the background, as a phone's does before the OS kills the tab. */
async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The autosave slot's save, once it is written (slot 0 of the game's saves in IndexedDB). */
async function autosaved(page: Page): Promise<{ screen: string }> {
  const handle = await page.waitForFunction(() => new Promise<string | null>(resolve => {
    const open = indexedDB.open('another-unity', 1);
    open.onsuccess = () => {
      const get = open.result.transaction('saves').objectStore('saves').get('demo/0');
      get.onsuccess = () => resolve((get.result as { text?: string } | undefined)?.text ?? null);
      get.onerror = () => resolve(null);
    };
    open.onerror = () => resolve(null);
  }).then(text => text ?? false), undefined, { timeout: 30_000 });
  return JSON.parse((await handle.jsonValue()) as string) as { screen: string };
}

async function start(page: Page, label: 'Start' | 'Continue'): Promise<void> {
  await page.waitForFunction(() => window.__au?.ready === true);
  const press = page.locator('#loading .lc-start');
  await expect(press).toBeVisible({ timeout: 30_000 });
  await expect(press).toHaveText(label);
  await press.click();
  await expect(page.locator('#loading')).toHaveCount(0);
}

/** The state the player would notice: where they are, who is on the team, what they carry, what the world is like. */
const picture = (page: Page) => page.evaluate(() => {
  const s = window.__au!.state();
  return {
    screen: s.screen,
    currentActor: s.currentActor,
    awayTeam: s.awayTeam,
    carrying: Object.entries(s.objects).filter(([, o]) => o.inventory).map(([id]) => id).sort(),
    regions: s.regions,
  };
});

test('play to a later screen, reload, press Continue: the same screen, team, inventory and world', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(URL);
  // (no autosave yet: the plain Start)
  await start(page, 'Start');
  const first = (await state(page)).screen;

  // Data reroutes the power, Picard walks through the door to the lab, and takes the chip
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  await act(page, async () => {
    await hold(page, 'Tricorder');
    await clickObject(page, 'panel');
  });
  const reroute = page.getByRole('dialog', { name: 'Reroute the power?' });
  await expect(reroute).toBeVisible({ timeout: 30_000 });
  await reroute.getByRole('button', { name: 'Reroute it' }).click();
  await settled(page);
  await act(page, () => button(page, 'Picard').click(), async () => (await state(page)).currentActor === 'picard');
  await act(page, async () => {
    await button(page, 'Walk').click();
    await clickObject(page, 'door');
  });
  await page.waitForFunction(() => window.__au!.state().screen === 'lab', undefined, { timeout: 30_000 });
  await settled(page);
  await act(page, () => dragToInventory(page, 'chip'));
  await page.waitForFunction(() => window.__au!.state().objects.chip.inventory, undefined, { timeout: 30_000 });
  await settled(page);
  const before = await picture(page);
  expect(before.screen).not.toBe(first);
  expect(before.carrying).toContain('chip');

  // the tab goes to the background: the game is written down
  await hide(page);
  expect((await autosaved(page)).screen).toBe('lab');

  await page.reload();
  await start(page, 'Continue');
  await expect(page.locator('.au-verbs')).toBeVisible();
  expect(await picture(page)).toEqual(before);
  await settled(page);
  expect(errors).toEqual([]);
});

test('New game, the smaller option, starts over from the beginning', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(URL);
  await start(page, 'Start');
  const first = await picture(page);
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  await settled(page);
  await hide(page);
  await autosaved(page);

  await page.reload();
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(page.locator('#loading .lc-start')).toHaveText('Continue', { timeout: 30_000 });
  const fresh = page.locator('#loading .lc-new');
  await expect(fresh).toBeVisible();
  await fresh.click();
  await expect(page.locator('#loading')).toHaveCount(0);
  expect(await picture(page)).toEqual(first);
  expect(errors).toEqual([]);
});

test('a test browser (no ?autosave) never resumes: it always starts a new game, with no Continue', async ({ page }) => {
  await page.goto(URL);
  await start(page, 'Start');
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  await settled(page);
  await hide(page);
  await autosaved(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(page.locator('#loading')).toHaveCount(0);
  expect((await state(page)).currentActor).toBe('picard');
});
