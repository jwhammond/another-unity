// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { button, GAME_DIR, goTo, quiet, shipArtPresent, station, watchConsole } from './helpers';

// docs/unity-ship-buttons.md "The crew on the pads": a crew member chosen walks in from the door at the left and stands on their pad (the original's
// walk and updateWalkers, transporter.cpp), and walks out again when dismissed; Energize waits for them, and the beam's effect still plays on the figures.

const art = shipArtPresent(['bridge', 'transporter']);
const published = existsSync(`${GAME_DIR}/art/cards/picard/27.webp`) && existsSync(`${GAME_DIR}/art/cards/picard/0.webp`);
test.skip(!published || !art.present, `needs ${art.present ? 'the crew\'s card strips (npm run art -- strips picard)' : art.why}`);
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/transp`;

test('the crew walk in from the door onto their pads, walk out when dismissed, and the beam still dissolves them', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=1&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__au!.beam(2));
  await goTo(page, 'Transporter room', 'transporter');
  const room = station(page, 'transporter');
  const screen = room.locator('.au-ship-screen');
  await expect(screen).toBeVisible();
  const walks = () => page.evaluate(() => window.__au!.padWalks());
  mkdirSync(shots, { recursive: true });

  // the easier levels choose the team at the start: they walk in one at a time, the first from the door at once
  await expect.poll(async () => (await walks()).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const first = (await walks()).find(w => w.visible)!;
  expect(first.leaving).toBe(false);
  expect(first.at[0]).toBeLessThan(200);
  expect(first.at[1]).toBeGreaterThan(240);
  expect(first.scale).toBeGreaterThan(240);
  // (Energize waits while anyone walks, and the pads' buttons are not for clicking)
  await expect(button(page, 'Energize')).toBeDisabled();
  await expect(room.locator('[data-pad]:disabled').first()).toBeVisible();
  // (a shot every 0.6 s, as ScummVM's)
  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(600);
    await screen.screenshot({ path: `${shots}/walk-${String(i).padStart(2, '0')}-ours.png` });
  }
  // (and one at a time: the second set off 1.33 s after the first, so the first has moved on by then)
  await expect.poll(async () => (await walks()).length, { timeout: 30_000 }).toBe(0);
  const pads = await room.locator('[data-pad]').count();
  expect(pads).toBeGreaterThan(0);
  await expect(room.locator('[data-pad]:disabled')).toHaveCount(0);
  await expect(button(page, 'Energize')).toBeEnabled({ timeout: 60_000 });
  await screen.screenshot({ path: `${shots}/walk-pads-ours.png` });

  // dismissed: still on the pad, walking out by the door; back in the crew list once they have gone
  const crew = await room.locator('[data-pad="0"]').textContent();
  await room.locator('[data-pad="0"]').click();
  const out = (await walks()).find(w => w.pad === 0)!;
  expect(out.leaving).toBe(true);
  expect(out.at[0]).toBeGreaterThan(200);
  await expect(button(page, 'Energize')).toBeDisabled();
  await expect(room.locator('[data-pad="0"]')).toBeDisabled();
  await page.waitForTimeout(1200);
  await screen.screenshot({ path: `${shots}/walk-off-ours.png` });
  const mid = (await walks()).find(w => w.pad === 0)!;
  expect(mid.at[0]).toBeLessThan(out.at[0]);
  // (walking off they face the door: the direction 9 or 3 of the legs)
  expect([3, 9]).toContain(mid.anim);
  await expect.poll(async () => (await walks()).length, { timeout: 30_000 }).toBe(0);
  await expect(room.locator('[data-pad="0"]')).toHaveCount(0);
  await room.locator('[data-painted="lists"]').click();
  await expect(room.locator('[data-crew]', { hasText: crew! })).toHaveCount(1);

  // chosen again by hand: at once from the door, to the pad it left
  await room.locator('[data-crew]', { hasText: crew! }).click();
  await expect.poll(async () => (await walks()).some(w => w.pad === 0), { timeout: 10_000 }).toBe(true);
  const back = (await walks()).find(w => w.pad === 0)!;
  expect(back).toMatchObject({ leaving: false, visible: true });
  expect(back.at[0]).toBeLessThan(120);
  await expect.poll(async () => (await walks()).length, { timeout: 30_000 }).toBe(0);
  await expect(room.locator('[data-pad="0"]')).toHaveText(crew!);

  // the beam's effect plays on the figures on the pads, as before
  await room.locator('[data-painted="map"]').click();
  await expect(room.locator('section[aria-label="Map"]')).toHaveAttribute('data-map-state', 'locked', { timeout: 30_000 });
  await page.evaluate(() => window.__au!.setSpeed(0.5));
  await expect(button(page, 'Energize')).toBeEnabled();
  await button(page, 'Energize').click();
  await expect.poll(async () => page.evaluate(() => window.__au!.art().ship.beam.cards.length + window.__au!.art().ship.beam.sparkles.length), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('with the art off the crew are on their pads at once and nothing walks', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.evaluate(() => window.__au!.beam(2));
  await goTo(page, 'Transporter room', 'transporter');
  const room = station(page, 'transporter');
  await expect(room.locator('[data-pad]').first()).toBeVisible();
  expect(await page.evaluate(() => window.__au!.padWalks())).toEqual([]);
  await expect(room.locator('[data-pad]:disabled')).toHaveCount(0);
});
