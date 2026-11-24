// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, button, clickObject, dragToInventory, expectFrames, heard, hold, settled, state, watchConsole } from './helpers';

async function boot(page: Page): Promise<void> {
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
}

test('smoke: the first room renders and answers look, use and talk', async ({ page }) => {
  const errors = watchConsole(page);
  await boot(page);
  // (?speed=4 reaches presentation time, not only the sim)
  expect(await page.evaluate(() => window.__au!.speed())).toBe(4);
  await expectFrames(page);
  // (the original's four modes: things are got by dragging them onto the inventory)
  await expect(page.locator('.au-verbs button')).toHaveText(['Walk', 'Look', 'Use', 'Talk']);

  await act(page, async () => {
    await button(page, 'Look').click();
    await clickObject(page, 'panel');
  });
  await heard(page, 'An alien control panel. It is dark.');

  await act(page, async () => {
    await button(page, 'Use').click();
    await clickObject(page, 'panel');
  });
  await heard(page, 'We need to understand it first.');

  // (the panel has nothing to say: the failure line)
  await act(page, async () => {
    await button(page, 'Talk').click();
    await clickObject(page, 'panel');
  });
  await heard(page, "There's no answer.");

  await settled(page);
  await expectFrames(page);
  expect(errors).toEqual([]);
});

test('walkthrough: the demo plays from start to finish', async ({ page }) => {
  const errors = watchConsole(page);
  await boot(page);

  // Data works the panel with the tricorder, and the power is rerouted
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  await act(page, async () => {
    await hold(page, 'Tricorder');
    await clickObject(page, 'panel');
  });
  const reroute = page.getByRole('dialog', { name: 'Reroute the power?' });
  await expect(reroute).toBeVisible({ timeout: 30_000 });
  await reroute.getByRole('button', { name: 'Reroute it' }).click();
  await heard(page, 'Well done, Mr. Data.');
  await settled(page);
  expect((await state(page)).regions.corridor.doorway).toBe(true);

  // Picard walks through the door to the lab
  await act(page, () => button(page, 'Picard').click(), async () => (await state(page)).currentActor === 'picard');
  await act(page, async () => {
    await button(page, 'Walk').click();
    await clickObject(page, 'door');
  });
  await page.waitForFunction(() => window.__au!.state().screen === 'lab', undefined, { timeout: 30_000 });
  await settled(page);
  await expectFrames(page);

  // the chip, dragged onto the inventory
  await act(page, () => dragToInventory(page, 'chip'));
  await page.waitForFunction(() => window.__au!.state().objects.chip.inventory, undefined, { timeout: 30_000 });

  // the guard: "Who goes there?", then the line that is left
  await act(page, async () => {
    await button(page, 'Talk').click();
    await clickObject(page, 'guard');
  });
  const menu = page.getByRole('dialog', { name: 'Say' });
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await menu.getByRole('button', { name: 'Who goes there?' }).click();
  await heard(page, 'I keep the lab.');
  await heard(page, 'Then pass.');
  await settled(page);
  expect((await state(page)).objects.guard.state).toBe(1);

  // the combadge asks first (and holds the game while it asks)
  await act(page, async () => {
    await button(page, 'Combadge').click();
    const prompt = page.getByRole('dialog', { name: 'Do you wish to contact the ship?' });
    if (await prompt.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
      await prompt.getByRole('button', { name: 'Hail' }).click();
    }
  });
  await heard(page, 'Away team to bridge. Stand by.');

  // the tricorder on the guard
  await act(page, async () => {
    await hold(page, 'Tricorder');
    await clickObject(page, 'guard');
  });
  const reading = page.getByRole('dialog', { name: 'Tricorder' });
  await expect(reading).toContainText('Tricorder reading 12', { timeout: 30_000 });
  await reading.getByRole('button', { name: 'Close' }).click();

  // the phaser on medium stuns him
  await act(page, () => page.getByLabel('Phaser setting').selectOption('2').then(() => {}), async () => (await state(page)).phaserSetting === 2);
  await act(page, async () => {
    await hold(page, 'Phaser');
    await clickObject(page, 'guard');
  });
  await page.waitForFunction(() => window.__au!.state().objects.guard.state === 2, undefined, { timeout: 30_000 });
  await settled(page);

  await button(page, 'Log').click();
  await expect(page.getByRole('log')).toContainText('Then pass.');
  expect(errors).toEqual([]);
});

test('saves: a game saved in the corridor loads after a reload', async ({ page }) => {
  const errors = watchConsole(page);
  await boot(page);
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  // (the admin console's SAVE: a slot, and Enter keeps its name, Save Game 1)
  const padd = page.getByRole('dialog', { name: 'Admin console' });
  await button(page, 'Admin').click();
  await button(page, 'SAVE').click();
  await button(page, 'Slot 1').click();
  await page.keyboard.press('Enter');
  await expect(padd).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.__au?.ready === true);
  expect((await state(page)).currentActor).toBe('picard');
  await button(page, 'Admin').click();
  await button(page, 'LOAD').click();
  await expect(padd.locator('button[data-slot="1"]')).toHaveText('Save Game 1');
  await act(page, () => button(page, 'Slot 1').click(), async () => (await state(page)).currentActor === 'data');
  expect(errors).toEqual([]);
});

test('the loading screen is up from the first paint, shows progress, and is gone when the game is', async ({ page }) => {
  // (the app's script held back, so the screen is caught mid-load)
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/main\.ts/, async route => { await held; await route.continue(); });
  await page.goto('/play/afu/?game=demo&mute', { waitUntil: 'commit' });
  const loading = page.locator('#loading');
  await expect(loading).toBeVisible();
  await expect(loading.getByRole('progressbar')).toBeVisible();
  await expect(loading).toContainText('Loading');
  release();
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(loading).toHaveCount(0);
  await expect(page.locator('#game')).toBeVisible();
});

test('a game that will not load shows why on the loading screen', async ({ page }) => {
  await page.route(/\/src\/games\/demo\.ts/, route => route.abort());
  await page.goto('/play/afu/?game=demo&mute');
  const loading = page.locator('#loading');
  await expect(loading).toHaveClass(/au-loading-failed/);
  await expect(loading.locator('.au-loading-status')).toContainText('Could not start');
});

test('the loading bar advances in several steps before the screen goes away', async ({ page }) => {
  // (every module held back a little, so the load takes a second or two and the bar is seen on its way)
  await page.route(/\/(src|node_modules|@fs|@vite)\//, async route => {
    await new Promise(resolve => setTimeout(resolve, 25));
    await route.continue();
  });
  await page.addInitScript(() => {
    const widths: number[] = [];
    (window as unknown as { __loadingWidths: number[] }).__loadingWidths = widths;
    setInterval(() => {
      const fill = document.querySelector<HTMLElement>('#loading .au-loading-fill');
      if (fill) widths.push(fill.getBoundingClientRect().width);
    }, 50);
  });
  await page.goto('/play/afu/?game=demo&mute', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(page.locator('#loading')).toHaveCount(0);
  const widths = await page.evaluate(() => (window as unknown as { __loadingWidths: number[] }).__loadingWidths);
  const distinct = [...new Set(widths.map(w => Math.round(w)))];
  // (never backwards, and at least three different widths on the way)
  expect(widths.every((w, i) => i === 0 || w >= widths[i - 1]! - 0.5)).toBe(true);
  expect(distinct.length).toBeGreaterThanOrEqual(3);
});

test('the percentage is whole, never goes back, is under 100 until it says Ready, and moves in small steps', async ({ page }) => {
  await page.route(/\/(src|node_modules|@fs|@vite)\//, async route => {
    await new Promise(resolve => setTimeout(resolve, 25));
    await route.continue();
  });
  await page.addInitScript(() => {
    const seen: { percent: number; width: number }[] = [];
    Object.assign(window, { __loadingSeen: seen });
    setInterval(() => {
      const fill = document.querySelector<HTMLElement>('#loading .au-loading-fill');
      const status = document.querySelector('#loading .au-loading-status')?.textContent ?? '';
      const percent = /^(\d+)% (?!Ready)/.exec(status)?.[1];
      if (fill && percent !== undefined) seen.push({ percent: Number(percent), width: parseFloat(fill.style.width) });
    }, 40);
  });
  await page.goto('/play/afu/?game=demo&mute', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__au?.ready === true);
  const seen = await page.evaluate(() => (window as unknown as { __loadingSeen: { percent: number; width: number }[] }).__loadingSeen);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s, i) => i === 0 || s.percent >= seen[i - 1]!.percent)).toBe(true);
  // (the number is the bar's, rounded down, and 100 waits for the end)
  for (const { percent, width } of seen) {
    expect(percent).toBeLessThanOrEqual(99);
    expect(Math.abs(percent - width)).toBeLessThan(1.1);
  }
  // (finer than one seventh at a time: more than the 7 values the old step count gave)
  expect(new Set(seen.map(s => s.percent)).size).toBeGreaterThan(7);
});

test('without autostart the loaded game waits behind a Start button, and shows when it is pressed', async ({ page }) => {
  // (an automated browser starts at once; this one says it is not)
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.goto('/play/afu/?game=demo&mute');
  const loading = page.locator('#loading');
  const start = loading.getByRole('button', { name: 'Start' });
  await expect(start).toBeVisible();
  await expect(start).toBeFocused();
  await expect(loading).toHaveClass(/au-loading-ready/);
  await start.press('Enter');
  await expect(loading).toHaveCount(0);
  await expect(page.locator('#game')).toBeVisible();
});

// (the subtitle was always 76% of the frame wide, a short line floating in a long box: it fits its line, up to that width, centred)
test('the subtitle box fits its line, grows to a limit, and stays centred', async ({ page }) => {
  const errors = watchConsole(page);
  await boot(page);
  await settled(page);
  const measure = async (text: string) => {
    await page.evaluate(t => window.__au!.say('picard', 'Picard', t), text);
    const box = await page.locator('.au-subtitle').boundingBox();
    const frame = (await page.locator('#game').boundingBox())!;
    return { width: box!.width, centre: box!.x + box!.width / 2 - frame.x, frame: frame.width };
  };
  const short = await measure('Engage.');
  const long = await measure('Mister Data, '.repeat(60));
  expect(short.width).toBeLessThan(short.frame * 0.4);
  expect(long.width).toBeGreaterThan(short.width * 2);
  expect(long.width).toBeLessThanOrEqual(long.frame * 0.76 + 1);
  expect(Math.abs(short.centre - short.frame / 2)).toBeLessThan(2);
  expect(Math.abs(long.centre - long.frame / 2)).toBeLessThan(2);
  expect(errors).toEqual([]);
});
