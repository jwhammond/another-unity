// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { quiet, shipArtPresent, station, watchConsole } from './helpers';

const GAME = new URL('../../../games/unity/', import.meta.url);
type Anim = { scale?: number; cell: [number, number] };
const cards = (): Record<string, { anims?: Record<string, Anim> }> | undefined => {
  if (!existsSync(new URL('presentation.yaml', GAME))) return undefined;
  return (parse(readFileSync(new URL('presentation.yaml', GAME), 'utf8')) as { art?: { cards?: Record<string, { anims?: Record<string, Anim> }> } }).art?.cards;
};
const CREW = ['picard', 'riker', 'worf', 'troi', 'data'];
const published = (): boolean => CREW.every(c => cards()?.[`bridge.${c}`]?.anims?.['0'] !== undefined);
test.skip(!shipArtPresent(['bridge']).present || !published(), 'needs the bridge plate and the crew strips (art ship publish bridge, GAMEDATA_DIR)');

// The sprites are 1x pixels with dither; shown at 2-4x they were blocks over a smooth plate. They are published through the card upscaler (4x) now.
test('the bridge crew are drawn from 4x strips, as smooth as the plate, and the bridge loads without errors', async ({ page }) => {
  const errors = watchConsole(page);
  for (const c of CREW) {
    for (const [index, a] of Object.entries(cards()![`bridge.${c}`]!.anims!)) {
      expect(a.scale, `${c} anim ${index} is a 4x strip`).toBe(4);
      // (the cell is the sprite's pixels times 4: a crew member is at least 100 original pixels high)
      expect(a.cell[1], `${c} anim ${index} cell height`).toBeGreaterThanOrEqual(4 * 100);
    }
  }
  await page.goto('/play/afu/?game=unity&speed=8&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await expect(station(page, 'bridge')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});
