// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, bridgeItem, button, clickWhenIdle, gameLifted, NEEDS_GAME, quiet, settled, state, station, stripButton, watchConsole } from './helpers';

// The admin console (Plan 32): the original's "RGCD" PADD, opened by the Admin buttons and by Esc, stopping the game while it is up. The
// demo's away mission needs no game data; the bridge needs the lifted game, and draws the original's pictures when `art admin publish` has
// run (else its CSS stand-ins, the same controls).

const padd = (page: Page) => page.getByRole('dialog', { name: 'Admin console' });
const inPadd = (page: Page, name: string) => padd(page).getByRole('button', { name, exact: true });
const tick = (page: Page) => page.evaluate(() => window.__au!.state().tick);

test('away: Esc and the Admin button open it, the clock stops behind it, Esc closes it; a named save loads back', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);

  await page.keyboard.press('Escape');
  await expect(padd(page)).toBeVisible();
  await expect(padd(page).getByRole('status')).toHaveText('Game paused');
  // (the world doesn't move while it is up)
  const at = await tick(page);
  await page.waitForTimeout(1_000);
  expect(await tick(page)).toBe(at);
  // (and no key reaches the game behind: L would be Look)
  await page.keyboard.press('l');
  await expect(page.locator('.au-verbs button[aria-pressed="true"]')).toHaveText('Walk');
  // (Tab stays on the console, past RESUME and round again; Enter there presses nothing behind it)
  for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.querySelector('.au-admin-console')!.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(padd(page)).toHaveCount(0);
  await expect(page.locator('.au-verbs button[aria-pressed="true"]')).toHaveText('Walk');
  expect((await state(page)).currentActor).toBe('picard');
  await page.waitForFunction(t => window.__au!.state().tick > t, at);

  // a save under a name, from the Admin button
  await act(page, () => button(page, 'Data').click(), async () => (await state(page)).currentActor === 'data');
  await button(page, 'Admin').click();
  await inPadd(page, 'SAVE').click();
  await expect(padd(page).getByRole('status')).toHaveText('Select slot to save');
  await inPadd(page, 'Slot 2').click();
  await expect(padd(page).getByRole('status')).toHaveText('Press Enter to save');
  for (let i = 0; i < 'Save Game 2'.length; i++) await page.keyboard.press('Backspace');
  // (a space is a letter of the name: it presses nothing and saves nothing yet)
  await page.keyboard.type('Main corridor');
  await expect(padd(page)).toBeVisible();
  await expect(padd(page).locator('button[data-slot="2"]')).toHaveText('Main corridor');
  await page.keyboard.press('Enter');
  await expect(padd(page)).toHaveCount(0);

  // a reload, and LOAD brings it back
  await page.reload();
  await page.waitForFunction(() => window.__au?.ready === true);
  expect((await state(page)).currentActor).toBe('picard');
  await button(page, 'Admin').click();
  await inPadd(page, 'LOAD').click();
  await expect(padd(page).locator('button[data-slot="2"]')).toHaveText('Main corridor');
  await act(page, () => inPadd(page, 'Slot 2').click(), async () => (await state(page)).currentActor === 'data');
  await expect(padd(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('SETTINGS: a change on each tab is kept over a reload; EXPORT gives a file IMPORT takes back; LOG opens the log', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('au.settings') ?? '{}') as { movies?: boolean; master?: number; assists?: { speed: number } });

  await button(page, 'Admin').click();
  await inPadd(page, 'SETTINGS').click();
  await expect(padd(page)).toHaveAttribute('data-page', 'settings');
  await expect(padd(page).getByRole('status')).toHaveText('Settings');
  // GAME: MOVIES, and the master bar by its keys
  await inPadd(page, 'MOVIES OFF').click();
  const master = padd(page).getByRole('slider', { name: 'MASTER' });
  const before = Number(await master.getAttribute('aria-valuenow'));
  await master.focus();
  await page.keyboard.press('ArrowRight');
  await expect(master).not.toHaveAttribute('aria-valuenow', String(before));
  // COMBAT: the battle's speed
  await inPadd(page, 'COMBAT').click();
  await inPadd(page, 'BATTLE SPEED 4X').click();
  // KEYS: the battle's keys, listed
  await inPadd(page, 'KEYS').click();
  await expect(padd(page).locator('button[data-action]')).toHaveCount(19);
  await expect(inPadd(page, 'PHASER SLASH')).toBeVisible();
  const kept = await stored();
  expect([kept.movies, kept.assists?.speed, (kept.master ?? 0) * 100 > before]).toEqual([false, 4, true]);

  // EXPORT offers the game as a file
  await inPadd(page, 'GAME').click();
  const download = page.waitForEvent('download');
  await inPadd(page, 'EXPORT').click();
  const file = await (await download).path();
  expect((await download).suggestedFilename()).toBe('demo-save.json');
  await page.keyboard.press('Escape');

  // a reload: the settings are as left, and IMPORT takes the file back (the console closes)
  await page.reload();
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await button(page, 'Admin').click();
  await inPadd(page, 'SETTINGS').click();
  await expect(inPadd(page, 'MOVIES OFF')).toHaveAttribute('aria-pressed', 'true');
  await inPadd(page, 'COMBAT').click();
  await expect(inPadd(page, 'BATTLE SPEED 4X')).toHaveAttribute('aria-pressed', 'true');
  await inPadd(page, 'GAME').click();
  await padd(page).locator('input[type=file]').setInputFiles(file);
  await expect(padd(page)).toHaveCount(0);

  // LOG: the log, and the console gone
  await button(page, 'Admin').click();
  await inPadd(page, 'SETTINGS').click();
  await inPadd(page, 'LOG').click();
  await expect(padd(page)).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveClass(/au-panel/);
  expect(errors).toEqual([]);
});

test('KEYS: a row takes the next key, which is kept; a used key is refused', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  const stored = () => page.evaluate(() => (JSON.parse(localStorage.getItem('au.settings') ?? '{}') as { keys?: Record<string, string> }).keys?.phasers);
  await button(page, 'Admin').click();
  await inPadd(page, 'SETTINGS').click();
  await inPadd(page, 'KEYS').click();
  await inPadd(page, 'PHASER SLASH').click();
  await expect(inPadd(page, 'PHASER PRESS A KEY')).toBeVisible();
  // a key another action has is refused, on the strip; the wait is over
  await page.keyboard.press('Tab');
  await expect(padd(page).getByRole('status')).toHaveText('That key is already in use');
  await inPadd(page, 'PHASER SLASH').click();
  await page.keyboard.press('k');
  await expect(inPadd(page, 'PHASER K')).toBeVisible();
  await expect.poll(stored).toBe('k');
  expect(errors).toEqual([]);
});

test('the bridge: its Admin button and Esc open it, Esc closes it, and its controls answer', async ({ page }) => {
  test.skip(!gameLifted, NEEDS_GAME);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await expect(station(page, 'bridge')).toBeVisible();

  await stripButton(page, 'admin').click();
  await expect(padd(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(padd(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(padd(page)).toBeVisible();

  // (the pages, by the original's buttons)
  await inPadd(page, 'LOAD').click();
  await expect(padd(page)).toHaveAttribute('data-page', 'load');
  await inPadd(page, 'CANCEL').click();
  await inPadd(page, 'QUIT').click();
  await expect(padd(page).getByRole('status')).toHaveText('Quit game');
  await inPadd(page, 'NO').click();
  await inPadd(page, 'SOUND LEVELS').click();
  await expect(padd(page).getByRole('slider', { name: 'VOICES/EFFECTS' })).toBeVisible();
  // (TEXT and DIFFICULTY change the settings record)
  const text = await page.evaluate(() => JSON.parse(localStorage.getItem('au.settings') ?? '{}').text as boolean | undefined);
  await padd(page).getByRole('button', { name: /^TEXT (ON|OFF)$/ }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('au.settings') ?? '{}').text as boolean)).toBe(!(text ?? true));
  await padd(page).getByRole('button', { name: /^TEXT (ON|OFF)$/ }).click();
  await inPadd(page, 'RESUME').click();
  await expect(padd(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('TEXT OFF: a voiced line shows no box, and a click still skips it', async ({ page }) => {
  test.skip(!gameLifted, NEEDS_GAME);
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  // TEXT OFF, on the console (after the opening, whose lines the helpers skip by their box)
  await stripButton(page, 'admin').click();
  await inPadd(page, 'TEXT ON').click();
  await expect(inPadd(page, 'TEXT OFF')).toBeVisible();
  await inPadd(page, 'RESUME').click();
  await expect(padd(page)).toHaveCount(0);
  // (whether the last press on the page was taken by the line-skip, which swallows it: seen from a capture listener above the game's)
  await page.evaluate(() => {
    const w = window as unknown as { lastPress?: PointerEvent };
    window.addEventListener('pointerdown', e => { w.lastPress = e; }, true);
  });
  const swallowed = () => page.evaluate(() => (window as unknown as { lastPress?: PointerEvent }).lastPress?.defaultPrevented ?? false);
  const count = () => page.evaluate(() => ({ voices: window.__au!.sounds().filter(s => s.bus === 'voice').length, lines: window.__au!.heard().length }));
  const before = await count();

  // a bridge officer's talk: its first line is voiced
  expect(await clickWhenIdle(page.locator('.au-ship-item[data-object="ship.data"]'))).toBe(true);
  await expect.poll(async () => { const now = await count(); return now.voices > before.voices && now.lines > before.lines; }, { timeout: 30_000, intervals: [50] }).toBe(true);
  // (said, and logged, with no box)
  await expect(page.locator('.au-subtitle')).toHaveCount(0);
  expect(await page.evaluate(() => window.__au!.idle())).toBe(false);
  // a click anywhere ends it, as with text on: the press is taken by the skip, and presses nothing under it
  const box = (await page.locator('#game').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await swallowed()).toBe(true);
  await expect(padd(page)).toHaveCount(0);
  // (the talk goes on to its end: menus answered, the hidden lines played out)
  await quiet(page);
  expect(errors).toEqual([]);
});
