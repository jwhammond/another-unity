// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { GAME_DIR, goTo, quiet, shipArtPresent, watchConsole } from './helpers';

// docs/unity-ship-buttons.md "The transporter room's own pictures": with the art on, the console's arrows, the Lists and Map buttons and the kit's
// eight slots are transp.mrg's sprites at the original's places, the kit and the preview box show the items' icons, and with the art off all of it is CSS.

const published = existsSync(`${GAME_DIR}/art/transporter/kit_slot.webp`) && existsSync(`${GAME_DIR}/art/icons/phaser.webp`);
const art = shipArtPresent(['bridge', 'transporter']);
test.skip(!published || !art.present, `needs ${art.present ? 'npm run art -- transporter publish and the item icons (art publish-kit)' : art.why}`);
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/ship`;

test('the transporter room draws its console sprites and the items\' icons, and is CSS with the art off', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await goTo(page, 'Transporter room', 'transporter');
  const room = page.locator('[data-station="transporter"]');
  await expect(room.locator('.au-ship-screen')).toBeVisible();
  // (the room opens on the map, as the original's does: the lists are behind the Lists button)
  await room.locator('[data-painted="lists"]').click();

  // the eight slots, the Lists and Map buttons, and the four arrows are the sprites (the arrows grey: nothing to scroll)
  await expect(room.locator('[data-sprite="kit_slot"]')).toHaveCount(8);
  for (const id of ['lists', 'map', 'listUp', 'listDown', 'kitLeft', 'kitRight']) await expect(room.locator(`[data-sprite="${id}"] img`)).toHaveCount(1);
  // (each at the original's rectangle: Lists is [7, 300] of the 640 x 480 box)
  const box = (await room.locator('.au-ship-screen').boundingBox())!;
  const lists = (await room.locator('[data-sprite="lists"]').boundingBox())!;
  expect(Math.abs(lists.x - (box.x + (7 / 640) * box.width))).toBeLessThan(2);
  expect(Math.abs(lists.y - (box.y + (300 / 480) * box.height))).toBeLessThan(2);
  const slots = await room.locator('[data-sprite="kit_slot"]').evaluateAll(els => els.map(e => e.getBoundingClientRect().x));
  expect(slots.map(x => Math.round(((x - box.x) / box.width) * 640))).toEqual([71, 125, 179, 233, 357, 411, 465, 519]);

  // the kit's items are their icons (the name stays for the screen reader), and the equipment's chosen one is in the middle box
  const kit = room.locator('[data-kit] .au-transporter-icon');
  expect(await kit.count()).toBeGreaterThan(0);
  expect(await room.locator('[data-kit]').first().textContent()).not.toBe('');
  await expect(room.locator('[data-preview]')).toHaveCount(0);
  await room.locator('section[aria-label="Equipment"] [data-item]').first().hover();
  await expect(room.locator('[data-preview] img')).toHaveCount(1);
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(500);
  await room.locator('.au-ship-screen').screenshot({ path: `${shots}/transporter-art.png` });
  expect(errors).toEqual([]);

  // with the art off: the same controls, none of the sprites or icons
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await goTo(page, 'Transporter room', 'transporter');
  await page.locator('[data-station="transporter"] [data-painted="lists"]').click();
  await expect(page.locator('[data-station="transporter"] [data-item], [data-station="transporter"] [data-kit]').first()).toBeVisible();
  await expect(page.locator('[data-sprite], .au-transporter-icon, [data-preview]')).toHaveCount(0);
});
