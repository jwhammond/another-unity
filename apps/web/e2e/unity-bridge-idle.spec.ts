// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { quiet, shipArtPresent, station, watchConsole } from './helpers';

const GAME = new URL('../../../games/unity/', import.meta.url);
const published = (): boolean => {
  if (!existsSync(new URL('presentation.yaml', GAME))) return false;
  const art = (parse(readFileSync(new URL('presentation.yaml', GAME), 'utf8')) as { art?: { cards?: Record<string, { anims?: Record<string, unknown> }> } }).art;
  return art?.cards?.['bridge.picard']?.anims?.['0'] !== undefined;
};
test.skip(!shipArtPresent(['bridge']).present || !published(), 'needs the bridge plate and the crew strips (art ship publish bridge, GAMEDATA_DIR)');

// Plan 16 follow-up: the bridge's crew play the original's idle animation, as a card strip.
test('the bridge crew move: the same region of the bridge, looked at over a few seconds, is not always the same picture', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=8&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await expect(station(page, 'bridge')).toBeVisible();
  const screen = (await page.locator('.au-ship-art .au-ship-screen').boundingBox())!;
  // (the left half of the plate, Riker and Picard's feet to heads, off the strip)
  const clip = { x: screen.x, y: screen.y, width: screen.width / 2, height: screen.height * 0.75 };
  const seen = new Set<string>();
  for (let i = 0; i < 24; i++) {
    seen.add(createHash('sha1').update(await page.screenshot({ clip })).digest('hex'));
    await page.waitForTimeout(250);
  }
  expect(seen.size).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});
