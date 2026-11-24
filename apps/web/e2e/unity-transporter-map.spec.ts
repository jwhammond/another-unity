// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { button, GAME_DIR, goTo, quiet, shipArtPresent, station, watchConsole } from './helpers';

// docs/unity-ship-buttons.md "The transporter map": the room opens on the map as the original's does (TransporterScreen::start's showMap(true)):
// tmaps.spr's picture of the target's world, the scan's row line then column line crossing to the target, the blip where they meet, and Energize
// held until it has locked on. Lists puts the map away; Map starts the scan again.

const published = existsSync(`${GAME_DIR}/art/transporter/map_world_2.webp`) && existsSync(`${GAME_DIR}/art/transporter/blip_0.webp`);
const art = shipArtPresent(['bridge', 'transporter']);
test.skip(!published || !art.present, `needs ${art.present ? 'npm run art -- transporter publish' : art.why}`);
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/transp`;

test('the transporter room opens on the map, scans to the target and locks on; Lists and Map switch the view', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=1&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  // (world 2's target is on the map, at (213, 339))
  await page.evaluate(() => window.__au!.beam(2));
  await goTo(page, 'Transporter room', 'transporter');
  const room = station(page, 'transporter');
  const screen = room.locator('.au-ship-screen');
  await expect(screen).toBeVisible();
  const map = room.locator('section[aria-label="Map"]');
  const at = (id: string) => room.locator(`[data-map="${id}"]`);
  const box = (await screen.boundingBox())!;
  /** A rectangle in the original's pixels, as the page lays it out (within a pixel: the box is scaled). */
  const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(1));
  const original = async (id: string) => {
    const b = (await at(id).boundingBox())!;
    return [(b.x - box.x) / box.width * 640, (b.y - box.y) / box.height * 480, b.width / box.width * 640, b.height / box.height * 480].map(Math.round);
  };

  // opens on the map: the world's picture over the lists, which are put away; the scan has begun and Energize waits for it
  await expect(at('picture').locator('img')).toHaveAttribute('src', /map_world_2/);
  near(await original('picture'), [50, 294, 368, 120]);
  await expect(map).toHaveAttribute('data-map-state', /scanning|locked/);
  await expect(room.locator('section[aria-label="Crew"]')).toBeHidden();
  await expect(room.locator('section[aria-label="Equipment"]')).toBeHidden();
  await expect(room.locator('[data-painted="map"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(room.locator('[data-painted="lists"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(room.locator('[data-sprite="lists"] img')).toHaveAttribute('src', /lists\.webp/);
  await expect(room.locator('[data-sprite="map"] img')).toHaveAttribute('src', /map_on\.webp/);
  // (the easier levels choose the team at the start: a team on the pads, and Energize still waits)
  await expect(button(page, 'Energize')).toBeDisabled();
  mkdirSync(shots, { recursive: true });
  await screen.screenshot({ path: `${shots}/map-scanning-ours.png` });

  // the row line first, then the column line crossing to the target's column
  await expect(at('down')).toBeVisible({ timeout: 30_000 });
  const row = await original('across');
  near(row, [51, 339, 366, 2]);
  await expect(button(page, 'Energize')).toBeDisabled();
  await screen.screenshot({ path: `${shots}/map-crossing-ours.png` });

  // locked on: the column at the target's, the blip over the target (centred, 38 square), Energize free (the team has walked on by now)
  await expect(map).toHaveAttribute('data-map-state', 'locked', { timeout: 30_000 });
  near(await original('down'), [213, 296, 2, 118]);
  await expect(at('blip')).toBeVisible();
  near(await original('blip'), [194, 320, 38, 38]);
  await expect(button(page, 'Energize')).toBeEnabled({ timeout: 60_000 });
  // (the blip turns: its frame changes while it is up)
  const frame0 = await at('blip').getAttribute('data-frame');
  await expect.poll(async () => at('blip').getAttribute('data-frame'), { timeout: 5_000 }).not.toBe(frame0);
  await screen.screenshot({ path: `${shots}/map-locked-ours.png` });
  // (the computer says it has found the target: the lock's line is in the sound log)
  expect(await page.evaluate(() => window.__au!.sounds().map(s => s.url))).toEqual(expect.arrayContaining([expect.stringContaining('fe0900b3'), expect.stringContaining('scann')]));

  // Lists: the map goes, the lists are back with their arrow, and Energize is free whatever the scan did
  await room.locator('[data-painted="lists"]').click();
  await expect(room.locator('section[aria-label="Crew"]')).toBeVisible();
  await expect(room.locator('[data-map]')).toHaveCount(0);
  await expect(room.locator('[data-sprite="listUp"] img')).toHaveCount(1);
  await expect(room.locator('[data-sprite="lists"] img')).toHaveAttribute('src', /lists_on\.webp/);
  await screen.screenshot({ path: `${shots}/map-lists-ours.png` });

  // Map again: the scan starts over from the top, and holds the energize again
  await room.locator('[data-painted="map"]').click();
  await expect(map).toHaveAttribute('data-map-state', 'scanning');
  expect((await original('across'))[1]).toBeLessThan(330);
  await expect(at('down')).toHaveCount(0);
  await expect(button(page, 'Energize')).toBeDisabled();
  // (and Lists lets it go before the scan has finished)
  await room.locator('[data-painted="lists"]').click();
  await expect(button(page, 'Energize')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('with no target the map says so, keeps scanning and never locks on', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await goTo(page, 'Transporter room', 'transporter');
  const room = station(page, 'transporter');
  await expect(room.locator('[data-map="picture"] img')).toHaveAttribute('src', /map_world_0/);
  await expect(room.locator('section[aria-label="Map"]')).toHaveAttribute('data-map-state', 'none');
  await page.waitForTimeout(2_500);
  await expect(room.locator('[data-map="down"]')).toHaveCount(0);
  await expect(room.locator('[data-map="blip"]')).toHaveCount(0);
  await room.locator('[data-map="picture"]').screenshot({ path: `${shots}/map-none-ours.png` });
  expect(errors).toEqual([]);
});

test('with the art off the map is a CSS panel with the same scan', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.evaluate(() => window.__au!.beam(2));
  await goTo(page, 'Transporter room', 'transporter');
  const room = station(page, 'transporter');
  await expect(room.locator('section[aria-label="Map"]')).toHaveAttribute('data-map-state', /scanning|locked/);
  await expect(room.locator('[data-map] img, [data-sprite]')).toHaveCount(0);
  await expect(room.locator('section[aria-label="Map"]')).toHaveAttribute('data-map-state', 'locked', { timeout: 30_000 });
  await expect(button(page, 'Lists')).toBeVisible();
  await button(page, 'Lists').click();
  await expect(room.locator('[data-crew]').first()).toBeVisible();
});
