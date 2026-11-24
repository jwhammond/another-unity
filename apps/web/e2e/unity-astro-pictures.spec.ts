// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { clickWhenIdle, drive, GAME_DIR, goTo, quiet, shipArtPresent, watchConsole } from './helpers';

// docs/unity-ship-buttons.md, "Astrogation: what the original draws": the original's pictures of a pad button, a cursor arrow and an exit while it is held and
// of the view the map shows lit, the screen's text in the game's own bitmap fonts, warp 5.0 to start, and the lit use pointer over the exits.

const ship = shipArtPresent(['astrogation']);
const published = ((): boolean => {
  if (!ship.present) return false;
  const art = (parse(readFileSync(`${GAME_DIR}presentation.yaml`, 'utf8')) as { art?: { fonts?: { files: string[] }; astro?: { palette?: string; sprites?: Record<string, unknown> } } }).art;
  return !!art?.fonts && !!art.astro?.palette && !!art.astro.sprites?.pad_up_down && existsSync(`${GAME_DIR}${art.astro.palette}`);
})();
test.skip(!published, `needs ${ship.why || 'npm run art -- astro publish (the held pictures, the palette and the fonts)'}`);
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/ship2`;
const painted = (page: Page, id: string) => page.locator(`.au-ship [data-painted="${id}"]`);
const screen = (page: Page) => page.locator('.au-astro-plate .au-ship-screen');

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  mkdirSync(shots, { recursive: true });
  await screen(page).screenshot({ path: `${shots}/${name}.png` });
}
/** The middle of a button, on the page. */
async function middle(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = (await painted(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('draws the original\'s fonts and held pictures, starts at warp 5.0, and shows the lit use pointer over the exits', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 180_000 });
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await goTo(page, 'Astrogation', 'astrogation');
  await quiet(page, 1);

  // the screen's text is the game's own fonts' pictures, once they are loaded, with the words still in the page
  await expect(page.locator('.au-astro[data-bitmap]')).toHaveCount(1, { timeout: 30_000 });
  const texts = await page.locator('canvas.au-bt').evaluateAll(els => els.map(e => e.getAttribute('data-bitmap-text')));
  expect(texts.some(t => /^@E: \d{3}$/.test(t ?? ''))).toBe(true);
  expect(texts.some(t => / \d-\d-\d$/.test(t ?? ''))).toBe(true);
  await expect(page.locator('.au-astro [data-readout="title"]')).toHaveText(/ \d-\d-\d$/);
  // (a canvas with pixels in it: the glyphs of the title)
  const inked = await page.locator('canvas.au-bt').first().evaluate(c => { const d = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  expect(inked).toBeGreaterThan(20);

  // the Course tab: warp 5.0, as the original starts it, whatever the engines can do
  await drive(page, () => clickWhenIdle(painted(page, 'tab-course')));
  await expect(page.locator('.au-astro [data-readout="speed"]')).toHaveText('5.0');
  expect(await page.locator('canvas.au-bt[data-bitmap-text="5.0"]').count()).toBe(1);

  // the view the map shows is lit with the original's picture, at its own button
  await expect(page.locator('[data-sprite="view-galaxy-lit"] img')).toHaveCount(1);
  await expect(page.locator('[data-sprite="view-sector-lit"]')).toHaveCount(0);

  // the pad's button, held: the original's picture of it, at the executable's rectangle, and not when it is let go
  const box = (await screen(page).boundingBox())!;
  const pad = await middle(page, 'pad-up');
  await page.mouse.move(pad.x, pad.y);
  await page.mouse.down();
  await expect(page.locator('[data-sprite="pad-up-held"] img')).toHaveCount(1);
  const held = (await page.locator('[data-sprite="pad-up-held"]').boundingBox())!;
  expect(Math.abs(held.x - (box.x + (9 / 640) * box.width))).toBeLessThan(2);
  expect(Math.abs(held.y - (box.y + (374 / 480) * box.height))).toBeLessThan(2);
  expect(Math.abs(held.width - (99 / 640) * box.width)).toBeLessThan(3);
  await shoot(page, 'astrogation-pad-held-ours');
  await page.mouse.up();
  await expect(page.locator('[data-sprite="pad-up-held"]')).toHaveCount(0);

  // a cursor arrow
  const arrow = await middle(page, 'cursor-x-up');
  await page.mouse.move(arrow.x, arrow.y);
  await page.mouse.down();
  await expect(page.locator('[data-sprite="cursor-x-up-held"] img')).toHaveCount(1);
  await shoot(page, 'astrogation-arrow-held-ours');
  await page.mouse.up();

  // an exit: held, it has the original's picture; over it the pointer is the lit use pointer, and over the rest of the screen it is the page's
  const exit = await middle(page, 'exit-bridge');
  await page.mouse.move(exit.x, exit.y);
  const over = await painted(page, 'exit-bridge').evaluate(el => getComputedStyle(el).cursor);
  const elsewhere = await painted(page, 'tab-info').evaluate(el => getComputedStyle(el).cursor);
  expect(over).toContain('url(');
  expect(over).not.toBe(elsewhere);
  // (the picture published from cursor.dat's frame 3 when it is, else the drawn lit use pointer)
  const pointers = existsSync(`${GAME_DIR}art/cursors/use_lit.webp`);
  expect(over).toContain(pointers ? 'data:image/png' : 'data:image/svg+xml');
  await page.mouse.down();
  await expect(page.locator('[data-sprite="exit-bridge-held"] img')).toHaveCount(1);
  await shoot(page, 'astrogation-exit-held-ours');
  // (let go away from it: nothing is clicked)
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.up();
  await expect(page.locator('[data-sprite="exit-bridge-held"]')).toHaveCount(0);
  await expect(page.locator('[data-station="astrogation"]')).toBeVisible();

  await page.mouse.move(box.x + box.width / 2, box.y + 5);
  await shoot(page, 'astrogation-course-ours');
  expect(errors).toEqual([]);
});

test('with the art off the text, the pad and the exits are CSS as before, and the speed still starts at 5.0', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 180_000 });
  await quiet(page);
  await goTo(page, 'Astrogation', 'astrogation');
  await quiet(page, 1);
  await expect(page.locator('canvas.au-bt, [data-sprite$="-held"], [data-sprite$="-lit"]')).toHaveCount(0);
  await drive(page, () => clickWhenIdle(page.locator('.au-astro [data-painted="tab-course"], .au-astro').getByRole('button', { name: 'Course' }).first()));
  await expect(page.locator('.au-astro [data-readout="speed"]')).toHaveText('5.0');
});
