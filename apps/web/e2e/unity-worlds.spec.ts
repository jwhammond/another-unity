// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, beamDown, button, clickObject, missionSelectUrl, settled, watchConsole } from './helpers';

// (the rooms are independent pages: the workers share the file's tests, so a file of many rooms is not the tail of the run)
test.describe.configure({ mode: 'parallel' });

const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
const lifted = existsSync(`${game}game.yaml`) && existsSync(`${game}models/rooms`);
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

const read = <T>(file: string, empty: T): T => (lifted ? parse(readFileSync(`${game}${file}`, 'utf8')) as T : empty);
const ids = read<{ screens: Record<string, string>; objects: Record<string, string> }>('ids.yaml', { screens: {}, objects: {} });
// (the away worlds' screens: IR keys s_02xx to s_07xx)
const screens = Object.entries(ids.screens).filter(([key]) => /^s_0[2-7]/.test(key)).map(([, slug]) => slug).sort();
const missions = read<{ missions?: { world: string; screen: string }[] }>('game.yaml', {}).missions ?? [];

for (const screen of screens) {
  test(`${screen} loads with no console errors`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&speed=4&mute&art=0&start=${encodeURIComponent(screen)}`);
    await page.waitForFunction(() => window.__au?.ready === true);
    // (some frames: the room, its markers and hotspots, and the startup's first moments)
    await page.waitForTimeout(500);
    expect((await page.evaluate(() => window.__au!.coverage())).width).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

for (const m of missions) {
  test(`the mission select beams down to ${m.screen}`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(missionSelectUrl());
    await page.waitForFunction(() => window.__au?.ready === true);
    await page.getByRole('dialog', { name: 'Bridge' }).locator(`button[data-world="${m.world}"]`).click();
    // (before the loop runs, the new game stands on the mission's screen)
    await page.waitForFunction(s => window.__au!.state().screen === s, m.screen);
    const arrival = page.getByRole('dialog', { name: 'Arrival' });
    if (await arrival.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
      await arrival.getByRole('button', { name: 'Skip' }).click().catch(() => {});
    }
    await page.waitForTimeout(1_000);
    expect(errors).toEqual([]);
  });
}

test('the finale ends the game on the bridge, and a new game goes back to the mission select', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(missionSelectUrl());
  await page.waitForFunction(() => window.__au?.ready === true);
  await beamDown(page, 'unity');
  await settled(page);

  // (the dev overlay's jump to the finale's screen: its startup runs the finale's movies, then ends the game)
  await page.keyboard.press('Backquote');
  await page.getByRole('button', { name: 'view', exact: true }).click();
  await page.getByLabel('Screen', { exact: true }).selectOption('unity.s10');
  await page.getByLabel('Entrance').selectOption('entrance_0');
  await page.getByRole('button', { name: 'Jump', exact: true }).click();
  await page.keyboard.press('Backquote');

  // (the finale's own timer runs its get rule; no wording is checked, only the panel's shape)
  const panel = page.getByRole('dialog', { name: 'Game over' });
  // (headless Chromium may not decode the movies: each one is skipped as it comes)
  const movie = page.getByRole('dialog', { name: 'Movie' });
  for (let i = 0; i < 600 && !(await panel.isVisible()); i++) {
    if (await movie.isVisible()) await movie.getByRole('button', { name: 'Skip' }).click().catch(() => {});
    await page.waitForTimeout(100);
  }
  await expect(panel).toBeVisible();
  expect(((await panel.locator('p').first().textContent()) ?? '').trim().length).toBeGreaterThan(0);
  // (a restart while a line is still on screen or a wait is left is refused: the panel stays and says to wait. Once nothing
  // is left, as when the voice's give-up wait no longer outlives the line, it goes through)
  await panel.getByRole('button', { name: 'Start a new game' }).click();
  const wait = page.getByRole('alert').getByRole('button', { name: 'OK' });
  if (await wait.isVisible()) {
    await expect(panel).toBeVisible();
    await wait.click();
  }
  // (a line still on screen refuses it too, until it clears)
  for (let i = 0; i < 20 && (await panel.isVisible()); i++) {
    await panel.getByRole('button', { name: 'Start a new game' }).click();
    await page.waitForTimeout(250);
  }

  const bridge = page.getByRole('dialog', { name: 'Bridge' });
  await expect(bridge.locator('button[data-world]').first()).toBeVisible();
  expect(await bridge.locator('button[data-world]').count()).toBe(missions.length);
  expect(errors).toEqual([]);
});

test('a tricorder reading opens the viewer on a reading with text, and pages through the others', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(missionSelectUrl());
  await page.waitForFunction(() => window.__au?.ready === true);
  await beamDown(page, 'allanor');
  await settled(page);

  // (object 02010e takes a reading, once the tricorder is in hand: use mode, the item, then the object)
  await button(page, 'Use').click();
  const name = await page.evaluate(() => window.__au!.state().objects.tricorder.name);
  await button(page, name).click();
  const viewer = page.getByRole('dialog', { name: 'Tricorder' });
  await act(page, async () => { await clickObject(page, ids.objects['02010e']); }, () => viewer.isVisible());
  const text = viewer.locator('.au-reading');
  expect(((await text.textContent()) ?? '').trim().length).toBeGreaterThan(0);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();

  // (a second reading, on object 020104, which stays in hand: the viewer then has two to page through)
  await act(page, async () => { await clickObject(page, ids.objects['020104']); }, () => viewer.isVisible());
  expect(((await text.textContent()) ?? '').trim().length).toBeGreaterThan(0);
  const counter = viewer.locator('p:not(.au-reading)');
  const before = await counter.textContent();
  const previous = viewer.getByRole('button', { name: 'Previous' });
  const next = viewer.getByRole('button', { name: 'Next' });
  // (it opens at the one just taken, the newest, so the older one is a page back)
  const move = (await next.isEnabled()) ? next : previous;
  await expect(move).toBeEnabled();
  await move.click();
  expect(await counter.textContent()).not.toBe(before);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
  expect(errors).toEqual([]);
});

// (a flat close-up's camera used to be fitted to the floor, not to the original's pixels: its hotspots were slivers, off from where
// they are drawn, and the exit lay under the HUD)
test("Mertens' transporter console: a click on a drawn rectangle picks it, and the exit leaves", async ({ page }) => {
  const errors = watchConsole(page);
  const room = JSON.parse(readFileSync(`${game}rooms/lab/s0a.json`, 'utf8')) as { hotspots: { object: string; rect: [number, number, number, number] }[] };
  await page.goto('/play/afu/?game=unity&dev&start=lab.s0a&team=picard,riker,data,worf&mute&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  for (const object of ['lab.lock_on.0a01', 'lab.energize.0a02', 'lab.exit.0a00']) {
    const [x0, y0, x1, y1] = room.hotspots.find(h => h.object === object)!.rect;
    const picked = await page.evaluate(([x, y]) => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      return window.__au!.objectAt(c.left + (x! / 640) * c.width, c.top + (y! / 480) * c.height);
    }, [(x0 + x1) / 2, (y0 + y1) / 2]);
    expect(picked).toBe(object);
  }
  // (the exit is used, as the original has it: its rule is on Use)
  await button(page, 'Use').click();
  const [x0, y0, x1, y1] = room.hotspots.find(h => h.object === 'lab.exit.0a00')!.rect;
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + (((x0 + x1) / 2) / 640) * box.width, box.y + (((y0 + y1) / 2) / 480) * box.height);
  await page.waitForFunction(() => window.__au!.state().screen === 'lab.s01');
  expect(errors).toEqual([]);
});

// (the script's `^0` is text drawn on the console itself, from the screen's t_WWSS00.bst: it used to open a "Screen text 0" menu
// with one Close button first)
test("Mertens' transporter console: lock-on draws its screen text on the console and opens no \"Screen text\" menu", async ({ page }) => {
  const errors = watchConsole(page);
  const room = JSON.parse(readFileSync(`${game}rooms/lab/s0a.json`, 'utf8')) as { hotspots: { object: string; rect: [number, number, number, number] }[] };
  await page.goto('/play/afu/?game=unity&dev&start=lab.s0a&team=picard,riker,data,worf&mute&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await button(page, 'Use').click();
  const [x0, y0, x1, y1] = room.hotspots.find(h => h.object === 'lab.lock_on.0a01')!.rect;
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + (((x0 + x1) / 2) / 640) * box.width, box.y + (((y0 + y1) / 2) / 480) * box.height);
  const text = page.locator('.au-screentext');
  await expect(text.first()).toBeVisible({ timeout: 20_000 });
  expect((await text.allTextContents()).join('').trim().length).toBeGreaterThan(0);
  // (nothing asks to be closed: the text is the console's own, and the game goes on)
  await settled(page);
  await expect(page.getByRole('dialog', { name: 'Screen text' })).toHaveCount(0);
  await expect(page.getByText(/Screen text \d/)).toHaveCount(0);
  await expect(page.locator('.au-dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an away screen shows no hotspot labels until H or the Hotspots button turns them on', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=lab.s0a&team=picard,riker,data,worf&mute&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  const spots = page.locator('#labels .au-hotspot');
  await page.waitForTimeout(300);
  await expect(spots).toHaveCount(0);
  await page.keyboard.press('h');
  await expect(spots.first()).toBeVisible();
  await expect(spots.filter({ hasText: 'Exit' })).not.toHaveCount(0);
  await expect(button(page, 'Hotspots')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Hotspots').click();
  await expect(spots).toHaveCount(0);
  expect(errors).toEqual([]);
});
