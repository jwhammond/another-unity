// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { clickWhenIdle, drive, engageCourse, quiet, state, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/game.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

test('a new game opens on the bridge, and the turbolift goes to a station and back', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  // (a new game opens with the story's first hail: answered, since a hail in progress refuses the ship's buttons)
  await quiet(page);
  const bridge = page.getByRole('region', { name: 'Bridge' });
  await expect(bridge).toBeVisible();
  expect(await bridge.locator('.au-ship-item').count()).toBeGreaterThan(0);
  expect((await page.evaluate(() => window.__au!.state())).onShip).not.toBeNull();
  await bridge.locator('.au-ship-item[title="Turbolift"]').click();
  const lift = bridge.getByRole('list', { name: 'Turbolift' });
  await expect(lift).toBeVisible();
  expect(await lift.getByRole('button').count()).toBeGreaterThan(0);
  await lift.getByRole('button', { name: 'Transporter', exact: true }).click();
  await expect(page.locator('[data-station="transporter"]')).toBeVisible();
  // (the room's exits come from content: the first one is the way back to the bridge)
  await page.locator('.au-transporter-exits button').first().click();
  await expect(page.locator('[data-station="bridge"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/au-ship-bridge.png' });
  expect(errors).toEqual([]);
});

test('the turbolift list opens by the pointer, and stays on screen near the edges (runChoice)', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const bridge = page.getByRole('region', { name: 'Bridge' });
  const door = bridge.locator('.au-ship-item[title="Turbolift"]');
  const box = (await door.boundingBox())!;
  // (a click at the door's top left, then at its bottom right: the list is by the pointer both times, and inside the bridge's box)
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.9]] as const) {
    const at = { x: box.x + box.width * fx, y: box.y + box.height * fy };
    await page.mouse.click(at.x, at.y);
    const lift = bridge.getByRole('list', { name: 'Turbolift' });
    await expect(lift).toBeVisible();
    const list = (await lift.boundingBox())!;
    const inside = (await bridge.locator('.au-ship-bridge').boundingBox())!;
    expect(list.x).toBeGreaterThanOrEqual(inside.x);
    expect(list.y).toBeGreaterThanOrEqual(inside.y);
    expect(list.x + list.width).toBeLessThanOrEqual(inside.x + inside.width + 1);
    expect(list.y + list.height).toBeLessThanOrEqual(inside.y + inside.height + 1);
    // (near the pointer: the corner of the screen it used to open in is far from a door in the middle of the room)
    const dx = Math.max(list.x - at.x, at.x - (list.x + list.width), 0);
    const dy = Math.max(list.y - at.y, at.y - (list.y + list.height), 0);
    expect(Math.hypot(dx, dy)).toBeLessThan(40);
    await page.mouse.click(at.x, at.y);
    await expect(lift).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('the holodeck opens from the turbolift and from the transporter room, plays a movie seen again, and the Bridge button leaves it', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const bridge = page.getByRole('region', { name: 'Bridge' });
  const holodeck = page.locator('[data-station="holodeck"]');
  // (the turbolift's third entry; the ship's tour counts as seen from the start, so there is always something to see again)
  await drive(page, async () => {
    if ((await holodeck.count()) > 0) return true;
    const lift = bridge.getByRole('list', { name: 'Turbolift' });
    if ((await lift.count()) > 0) await clickWhenIdle(lift.getByRole('button', { name: 'Holodeck', exact: true }));
    else await clickWhenIdle(bridge.locator('.au-ship-item[title="Turbolift"]'));
    return (await holodeck.count()) > 0;
  });
  await expect(holodeck.locator('[data-movie="shiptour"]')).toBeVisible();
  expect((await state(page)).ship?.station).toBe('holodeck');
  // (a movie seen is played again: the film is not in the export, so its title card stands in, and Skip ends it)
  await holodeck.locator('[data-movie="shiptour"]').click();
  const movie = page.locator('.au-movie');
  await expect(movie).toBeVisible();
  await movie.getByRole('button', { name: 'Skip' }).click();
  await expect(movie).toHaveCount(0);
  // (the Bridge button is refused until the movie's own step is over: tried again until it takes)
  await drive(page, async () => { await clickWhenIdle(holodeck.locator('[data-holodeck-bridge]')); return (await holodeck.count()) === 0; });
  await expect(page.locator('[data-station="bridge"]')).toBeVisible();
  // (and by the transporter room's own exit for it)
  await drive(page, async () => {
    if ((await page.locator('[data-station="transporter"]').count()) > 0) return true;
    const lift = bridge.getByRole('list', { name: 'Turbolift' });
    if ((await lift.count()) > 0) await clickWhenIdle(lift.getByRole('button', { name: 'Transporter', exact: true }));
    else await clickWhenIdle(bridge.locator('.au-ship-item[title="Turbolift"]'));
    return (await page.locator('[data-station="transporter"]').count()) > 0;
  });
  await page.locator('.au-transporter-exits button[data-code="10"]').click();
  await expect(holodeck).toBeVisible();
  await drive(page, async () => { await clickWhenIdle(holodeck.locator('[data-holodeck-bridge]')); return (await holodeck.count()) === 0; });
  await expect(page.locator('[data-station="bridge"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('plots a course in astrogation, engages, and arrives', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=60&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.locator('.au-ship-item[title="Astrogation"]').click();
  const panel = page.locator('.au-astro');
  await expect(panel).toBeVisible();
  // (the original's first leg: the sector, star and planet by their ids, not by name)
  await panel.getByRole('combobox', { name: 'Sector' }).selectOption('156');
  await panel.getByLabel('Star').selectOption('3');
  await panel.getByLabel('Planet').selectOption('3');
  // (a timer's hail can come in meanwhile, and refuses the click: Engage is clicked only while the game is idle)
  await engageCourse(page);
  await page.screenshot({ path: '/tmp/au-astro-transit.png' });
  // (the arrival is held until what it starts is answered: a conversation menu takes its first option, a movie its Skip, as `plot` does)
  await drive(page, async () => (await state(page)).ship.transit === null, 90_000);
  await expect(panel.getByRole('progressbar', { name: 'Journey' })).toBeHidden();
  const ship = (await page.evaluate(() => window.__au!.state())) as { ship: { location: { sector: number; star: number; planet: number }; transit: unknown } };
  expect(ship.ship.transit).toBeNull();
  expect(ship.ship.location).toMatchObject({ sector: 156, star: 3, planet: 3 });
  await page.screenshot({ path: '/tmp/au-astro-arrived.png' });
  expect(errors).toEqual([]);
});
