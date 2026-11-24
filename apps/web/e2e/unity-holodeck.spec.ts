// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { bridgeItem, clickWhenIdle, drive, GAME_DIR, gameLifted, goTo, NEEDS_GAME, quiet, station, watchConsole } from './helpers';

test.skip(!gameLifted, NEEDS_GAME);

// docs/unity-ship-buttons.md "The holodeck": with the art on it is holodeck.rm with the original's choice dialog over it (dialog.mrg's frame, fonts 2 and 3, the
// round scroll buttons) drawn onto a canvas, with clear controls over the movies and the painted Bridge button; and when the computer is below the 80 percent it
// needs, the refusal is said to its end before the bridge comes back.

const published = ((): boolean => {
  if (!existsSync(`${GAME_DIR}game.yaml`) || !existsSync(`${GAME_DIR}presentation.yaml`)) return false;
  const art = (parse(readFileSync(`${GAME_DIR}presentation.yaml`, 'utf8')) as { art?: { holodeck?: { pack: string }; fonts?: unknown } }).art;
  return !!art?.holodeck && !!art.fonts && existsSync(`${GAME_DIR}${art.holodeck.pack}`);
})();
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/ship2`;
const sounds = (page: Page) => page.evaluate(() => window.__au!.sounds());
const pixels = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>('.au-holo .au-eng-canvas')!;
  return Array.from(c.getContext('2d')!.getImageData(0, 0, 640, 480).data);
});

async function open(page: Page, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(`/play/afu/?game=unity&speed=4&mute&dev${query}`);
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 180_000 });
  await quiet(page);
}
/** The turbolift's Holodeck entry, until the holodeck shows. */
async function toHolodeck(page: Page): Promise<void> {
  const holodeck = station(page, 'holodeck');
  await drive(page, async () => {
    if ((await holodeck.count()) > 0) return true;
    const lift = page.getByRole('list', { name: 'Turbolift' });
    if ((await lift.count()) > 0) await clickWhenIdle(lift.getByRole('button', { name: 'Holodeck', exact: true }));
    else await clickWhenIdle(bridgeItem(page, 'Turbolift'));
    return (await holodeck.count()) > 0;
  });
}

test.describe('with the original\'s pictures', () => {
  test.skip(!published, 'needs npm run art -- holodeck publish');

  test('draws holodeck.rm and the original\'s choice dialog, and the movies, scroll buttons and Bridge work', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page);
    await open(page);
    await toHolodeck(page);
    const screen = page.locator('.au-holo .au-eng-screen');
    await expect(screen).toBeVisible();
    await expect(page.locator('.au-holo .au-eng-canvas')).toHaveAttribute('data-drawn', /.+/);
    mkdirSync(shots, { recursive: true });

    // the picture is the original's: the same pixels as ScummVM's own screen when its capture is here (the harness's `shot`). That capture has the one movie
    // (the ship's tour) in the dialog; here the opening movies have been seen too, so the dialog's own box is left out unless it is the tour alone
    const first = await pixels(page);
    await screen.screenshot({ path: `${shots}/holodeck-ours.png` });
    const reference = `${shots}/holodeck-scummvm.png`;
    if (existsSync(reference)) {
      const png = PNG.sync.read(readFileSync(reference));
      const alone = (await page.locator('[data-movie]').count()) === 1;
      const differ: number[] = [];
      for (let i = 0; i < 640 * 480; i++) {
        const x = i % 640, y = Math.floor(i / 640);
        if (!alone && x >= 60 && x < 400 && y >= 240 && y < 420) continue;
        for (let k = 0; k < 3; k++) if (png.data[i * 4 + k] !== first[i * 4 + k]) { differ.push(i); break; }
      }
      const xs = differ.map(i => i % 640), ys = differ.map(i => Math.floor(i / 640));
      expect(differ.length === 0 ? 'identical' : `${differ.length} pixels differ, x ${Math.min(...xs)}-${Math.max(...xs)}, y ${Math.min(...ys)}-${Math.max(...ys)}`).toBe('identical');
    }

    // the movie pointed at is drawn in the highlighted font
    await page.locator('[data-movie="shiptour"]').hover();
    await expect(page.locator('[data-movie="shiptour"]')).toHaveAttribute('data-selected', '');
    await page.waitForTimeout(300);
    const lit = await pixels(page);
    // (the row's own place on the canvas: the button's box in the screen's)
    const box = (await screen.boundingBox())!, row = (await page.locator('[data-movie="shiptour"]').boundingBox())!;
    const [x0, y0, x1, y1] = [(row.x - box.x) / box.width * 640, (row.y - box.y) / box.height * 480, (row.x + row.width - box.x) / box.width * 640, (row.y + row.height - box.y) / box.height * 480].map(Math.round) as [number, number, number, number];
    let changed = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (lit.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 3).join() !== first.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 3).join()) changed++;
    expect(changed).toBeGreaterThan(100);
    await screen.screenshot({ path: `${shots}/holodeck-hover-ours.png` });
    await page.mouse.move(5, 5);

    // the round buttons are greyed (nothing to scroll with one movie seen)
    await expect(page.locator('[data-scroll="up"]')).toBeDisabled();
    await expect(page.locator('[data-scroll="down"]')).toBeDisabled();

    // a movie seen is played again (its title card stands in for the film: it is not in the export), then Bridge leaves
    await page.locator('[data-movie="shiptour"]').click();
    const movie = page.locator('.au-movie');
    await expect(movie).toBeVisible();
    await movie.getByRole('button', { name: 'Skip' }).click();
    await expect(movie).toHaveCount(0);
    await drive(page, async () => { await clickWhenIdle(page.locator('[data-holodeck-bridge]')); return (await station(page, 'holodeck').count()) === 0; });
    await expect(station(page, 'bridge')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test('below the computer percent the holodeck needs, its refusal is spoken and the bridge comes back', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchConsole(page);
  // (the plain engineering screen: its sliders take the three computer cores down below 80 percent)
  await open(page, '&art=0');
  await goTo(page, 'Engineering', 'engineering');
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  for (const unit of [24, 25, 26]) await page.locator(`[data-unit-row="${unit}"] input[data-kind="power"]`).fill('0');
  await expect.poll(async () => (await page.evaluate(() => window.__au!.state().ship.systems.units)).slice(24, 27).map(u => u.current < 80), { timeout: 120_000 }).toEqual([true, true, true]);
  await page.getByRole('button', { name: 'Bridge', exact: true }).click();
  await expect(station(page, 'bridge')).toBeVisible({ timeout: 30_000 });
  const before = (await sounds(page)).length;
  await drive(page, async () => {
    if ((await sounds(page)).slice(before).some(s => s.bus === 'voice' && s.url.includes('fe090098'))) return true;
    const lift = page.getByRole('list', { name: 'Turbolift' });
    if ((await lift.count()) > 0) await clickWhenIdle(lift.getByRole('button', { name: 'Holodeck', exact: true }));
    else await clickWhenIdle(bridgeItem(page, 'Turbolift'));
    return (await sounds(page)).slice(before).some(s => s.bus === 'voice' && s.url.includes('fe090098'));
  });
  // (it did not open: the ship is on the bridge once the voice is done)
  await expect(station(page, 'holodeck')).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.__au!.state().ship.station)), { timeout: 30_000 }).toBe('bridge');
  expect(errors).toEqual([]);
});
