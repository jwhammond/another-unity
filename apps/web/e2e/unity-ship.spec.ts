// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
import { answer, clickWhenIdle, comms, quiet, drive, energize, expectFrames, goTo, importSave, lounge, settled, state, station, watchConsole } from './helpers';

const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
const lifted = existsSync(`${game}game.yaml`) && existsSync(`${game}models/rooms`);
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

test.setTimeout(300_000);
const ids = () => parse(readFileSync(`${game}ids.yaml`, 'utf8')) as { objects: Record<string, string>; screens: Record<string, string> };

/**
 * The opening's first conversation menus, answered by index as ship-opening.walk's `pick` does (each the second option,
 * the way that avoids the battle hail). A new game meets six, the sixth being the first mission's hail; `toTransporter`
 * answers it the same way. The story's scripted warps take the ship on from there (Plan 12 Task 4).
 */
async function openingMenus(page: Page, count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await answer(page, 1);
}

/** Answers one menu after another, each by its index, as a walk's `pick`s do, checking each is the menu `<conversation>@<situation>` meant. */
async function picks(page: Page, options: [number, string][]): Promise<void> {
  for (const [option, at] of options) await answer(page, option, at);
}

/** To the transporter room once the arrival's chain has set the beam target (`target`, if given) and nothing is pending. Menus meet their second option. */
async function toTransporter(page: Page, target: string | null = null, option = 1): Promise<void> {
  await drive(page, async () => {
    const s = await state(page);
    return (target === null ? s.beamTarget !== null : s.beamTarget === target) && s.pendingHail === null && s.ship.transit === null;
  }, 180_000, false, option);
  // (from astrogation the bar has no transporter button: back to the bridge first, as the player does)
  if ((await station(page, 'astrogation').count()) > 0) {
    await drive(page, async () => {
      await clickWhenIdle(page.getByRole('button', { name: 'Back to the bridge' }));
      return (await station(page, 'bridge').count()) > 0;
    });
  }
  await goTo(page, 'Transporter room', 'transporter');
}

// (the original's playMovie blocks: the bridge crew's lines and voices wait for the opening movies to end or be skipped)
test('during the opening movie no subtitle is visible, and skipping it does not skip the first line', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&mute&dev&art=0&speed=4');
  await page.waitForFunction(() => window.__au?.ready === true);
  const movie = page.getByRole('dialog', { name: 'Movie' });
  await expect(movie).toBeVisible();
  const subtitle = page.locator('.au-subtitle');
  const lines = () => page.evaluate(() => window.__au!.heard().length);
  // (several seconds of game time at 4x: the crew would have spoken by now)
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    if (!(await movie.isVisible())) test.skip(true, 'the movie ended or failed to decode in this browser');
    await expect(subtitle).toBeHidden();
    expect(await lines()).toBe(0);
  }
  // (skipped, each in turn: no line yet, and then the first line is said whole, not skipped by the click that ended the movie)
  await movie.getByRole('button', { name: 'Skip' }).click();
  while (await movie.isVisible().catch(() => false)) {
    await expect(subtitle).toBeHidden();
    await movie.getByRole('button', { name: 'Skip' }).click().catch(() => {});
  }
  await expect(subtitle).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

// (a click ends the line being said, on the ship's screens too, and presses nothing under it)
test('a click on a bridge button during the opening\'s lines skips the line and leaves the button unpressed', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(station(page, 'bridge')).toBeVisible();
  const subtitle = page.locator('.au-subtitle');
  // (the opening's own lines, until one is up with no menu over it)
  await drive(page, async () => (await subtitle.isVisible()) || (await page.locator('.au-menu').isVisible()), 60_000, true);
  test.skip(!(await subtitle.isVisible()), 'the opening showed a menu before any line');
  const before = (await subtitle.textContent()) ?? '';
  await page.locator('.au-ship-item[title="Astrogation"]').click({ force: true });
  // (the line is gone or has moved on to the next, and the bridge never went to astrogation)
  await expect.poll(async () => (await subtitle.isVisible()) ? ((await subtitle.textContent()) ?? '') !== before : true).toBe(true);
  expect(await station(page, 'astrogation').count()).toBe(0);
  await expect(station(page, 'bridge')).toBeVisible();
  expect(errors).toEqual([]);
});

// (R8: the first mission is world 4, the lab's first screen; world 7 follows world 5 in the original)
test('a new game plays from the bridge to the first beam-down (the lab), through the UI', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=60&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(station(page, 'bridge')).toBeVisible();
  expect((await state(page)).onShip).not.toBeNull();
  await openingMenus(page);
  // (the story's scripted warps take the ship to the first mission's planet themselves, and the arrival's chain sets the beam target)
  await toTransporter(page);
  await energize(page);
  await settled(page);
  const s = await state(page);
  expect(s.onShip).toBeNull();
  expect(s.screen).toBe(ids().screens.s_0401);
  expect(s.awayTeam.length).toBeGreaterThan(0);
  await expectFrames(page);
  expect(errors).toEqual([]);
});

// (R12: the walk's checkpoints are the route's own saves, written by tools/play's live-route test: local, never committed)
const routeDir = `${process.env.HOME}/pcode/unity-raw/runs/plan12-route/`;
const checkpoint = (name: string) => `${routeDir}${name}.json`;

/** Opens the game, imports a route checkpoint through the save menu, and waits for the bridge. */
async function fromCheckpoint(page: Page, name: string): Promise<void> {
  await page.goto('/play/afu/?game=unity&speed=8&mute&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  // (a new game opens with its movies and its first hail: past them first, since a load waits for nothing to be happening, and a
  // later movie would play over the loaded game)
  await quiet(page);
  await importSave(page, checkpoint(name));
  await expect(station(page, 'bridge')).toBeVisible();
  expect((await state(page)).onShip).not.toBeNull();
}

test('a save after world 4 plays the ship to world 3\'s beam-down, through the UI', async ({ page }) => {
  test.skip(!existsSync(checkpoint('after-mertens')), 'needs plan12-route/after-mertens.json (RAW_DIR=... npx vitest run tools/play/src/live-route.test.ts)');
  const errors = watchConsole(page);
  await fromCheckpoint(page, 'after-mertens');
  // (the walk's picks, in order: the t27 hail (c020@3) is answered with option 0, then the lounge's six menus (c027), o_5f0121's
  // two (c011), the five of c003@0, and c003@4's, the last of which sets the beam target)
  await picks(page, [[0, 'ship.c022@4']]);
  await lounge(page, ids().objects['5f0401']);
  await picks(page, [[1, 'ship.c027@3'], [0, 'ship.c027@3'], [0, 'ship.c027@3'], [0, 'ship.c027@3'], [1, 'ship.c027@2'], [1, 'ship.c027@2']]);
  await comms(page, ids().objects['5f0121']);
  await picks(page, [[1, 'ship.c011@3'], [0, 'ship.c011@3']]);
  await picks(page, [[0, 'ship.c022@4'], [0, 'ship.c003@1'], [0, 'ship.c003@7'], [0, 'ship.c003@7'], [0, 'ship.c003@7']]);
  await picks(page, [[1, 'ship.c003@4']]);
  await toTransporter(page, ids().screens.s_0303, 0);
  await energize(page);
  // (the first talk plays itself on the beam-in, menus and all: answered until the game stays idle)
  await quiet(page, 1);
  const s = await state(page);
  expect(s.onShip).toBeNull();
  expect(s.screen).toBe(ids().screens.s_0303);
  await expectFrames(page);
  expect(errors).toEqual([]);
});

test('a save after world 8 plays the ship to world 7\'s beam-down, through the UI', async ({ page }) => {
  test.skip(!existsSync(checkpoint('after-frigis2')), 'needs plan12-route/after-frigis2.json (RAW_DIR=... npx vitest run tools/play/src/live-route.test.ts)');
  const errors = watchConsole(page);
  await fromCheckpoint(page, 'after-frigis2');
  // (the transit, then the t78 hail is ignored: the first option)
  await toTransporter(page, ids().screens.s_0701, 0);
  await energize(page);
  await settled(page);
  const s = await state(page);
  expect(s.onShip).toBeNull();
  expect(s.screen).toBe(ids().screens.s_0701);
  await expectFrames(page);
  expect(errors).toEqual([]);
});
