// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { GAME_DIR, gameLifted, goTo, NEEDS_GAME, quiet, station, watchConsole } from './helpers';

test.skip(!gameLifted, NEEDS_GAME);

// docs/unity-ship-buttons.md "Engineering": the original's own screen (eng00a.pic and eng01b.mrg, drawn from indices with the original's palette and
// fonts onto a canvas), the sliders that allocate power and ask for repairs, the tabs, Delegate and its two voice lines, Bridge and Tactical; and with the
// art off a plain list of the same sliders.

const published = ((): boolean => {
  if (!existsSync(`${GAME_DIR}game.yaml`) || !existsSync(`${GAME_DIR}presentation.yaml`)) return false;
  const art = (parse(readFileSync(`${GAME_DIR}presentation.yaml`, 'utf8')) as { art?: { engineering?: { pack: string }; fonts?: unknown } }).art;
  return !!art?.engineering && !!art.fonts && existsSync(`${GAME_DIR}${art.engineering.pack}`);
})();
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/.claude/jobs/988a7092/tmp/ship2`;
const sounds = (page: Page) => page.evaluate(() => window.__au!.sounds());
const systems = (page: Page) => page.evaluate(() => window.__au!.state().ship.systems);
/** The screen's canvas, read back: its 640 x 480 pixels as RGBA. */
const pixels = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>('.au-eng-canvas')!;
  return Array.from(c.getContext('2d')!.getImageData(0, 0, 640, 480).data);
});
const at = (data: number[], x: number, y: number): number[] => data.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 3);

async function open(page: Page, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(`/play/afu/?game=unity&speed=4&mute&dev${query}`);
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 180_000 });
  await quiet(page);
  await goTo(page, 'Engineering', 'engineering');
}

/** A point of the 640 x 480 screen on the page. */
async function onScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.au-eng-screen').boundingBox())!;
  return { x: box.x + (x / 640) * box.width, y: box.y + (y / 480) * box.height };
}

test.describe('with the original\'s pictures', () => {
  test.skip(!published, 'needs npm run art -- engineering publish');

  test('draws the original\'s screen, and the sliders, tabs, Delegate and the exits work', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page);
    await open(page);
    const screen = page.locator('.au-eng-screen');
    await expect(screen).toBeVisible();
    await expect(page.locator('.au-eng-canvas')).toHaveAttribute('data-frames', /\d+/);

    // the picture is the original's: the title bar's blue, a black panel, and the Power tab lit
    const first = await pixels(page);
    // (the same colours as ScummVM's own screen at these places: the title bar, the schematics' black, the panel's frame)
    expect(at(first, 60, 8)).toEqual([16, 68, 108]);
    expect(at(first, 5, 100)).toEqual([0, 0, 0]);
    expect(at(first, 560, 10)).toEqual([28, 116, 184]);
    mkdirSync(shots, { recursive: true });
    await page.waitForTimeout(400);
    await screen.screenshot({ path: `${shots}/engineering-power-ours.png` });

    // a slider is set where the pointer goes: Port Warp's power (slider 0x37, at 511, 60) a quarter of the way
    const before = (await systems(page)).units[27]!;
    expect(before.target).toBe(before.max);
    const p = await onScreen(page, 511 + 30, 68);
    await page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await systems(page)).units[27]!.target).toBe(Math.trunc(before.max * 30 / 119));
    // ... and the system follows it down, handing power back to the pool
    await expect.poll(async () => (await systems(page)).units[27]!.current, { timeout: 60_000 }).toBeLessThan(before.max);

    // the info box names what the pointer is over
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('[data-unit-info]')).toContainText('Port warp engine');
    await page.waitForTimeout(300);
    const info = await pixels(page);
    // (the info box, 100 to 230 by 397 to 476, now has the unit's name and figures in it)
    let changed = 0;
    for (let y = 397; y < 476; y++) for (let x = 100; x < 230; x++) if (at(info, x, y).join() !== at(first, x, y).join()) changed++;
    expect(changed).toBeGreaterThan(200);
    await screen.screenshot({ path: `${shots}/engineering-hover-ours.png` });

    // the Weapons tab draws the torpedoes, and Total Power stays
    await page.getByRole('button', { name: 'Weapons', exact: true }).click();
    await expect(page.locator('.au-eng-screen[data-page="weapons"]')).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await screen.screenshot({ path: `${shots}/engineering-weapons-ours.png` });
    expect(await page.getByRole('slider').count()).toBe(16);

    // Delegate: La Forge takes over, saying so, and answers once Picard has finished
    const heard = async () => (await sounds(page)).filter(s => s.bus === 'voice').map(s => s.url.match(/(fe[0-9a-f]{6})/)?.[1]);
    const delegating = await page.getByRole('button', { name: 'Delegate', exact: true }).getAttribute('aria-pressed');
    await page.getByRole('button', { name: 'Delegate', exact: true }).click();
    if (delegating === 'true') {
      // (on at the default difficulty: the first press turns it off, the second takes over)
      await expect(page.getByRole('button', { name: 'Delegate', exact: true })).toHaveAttribute('aria-pressed', 'false');
      expect(await heard()).not.toContain('fe00029d');
      await page.getByRole('button', { name: 'Delegate', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: 'Delegate', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await heard()).filter(h => h === 'fe00029d' || h === 'fe0602c7'), { timeout: 30_000 }).toEqual(['fe00029d', 'fe0602c7']);

    // Bridge goes back after the button has been down a moment
    await page.getByRole('button', { name: 'Bridge', exact: true }).click();
    await expect(station(page, 'bridge')).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  test('Tactical goes to the battle screen', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page);
    await page.getByRole('button', { name: 'Tactical', exact: true }).click();
    await expect(page.locator('[data-station="tactical"], [data-station="bridge"]').first()).toBeVisible({ timeout: 30_000 });
    expect((await page.evaluate(() => window.__au!.state().ship.station))).not.toBe('engineering');
  });
});

test('with the art off it is a plain list of the same sliders', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await open(page, '&art=0');
  await expect(page.locator('.au-eng-plain')).toBeVisible();
  await expect(page.locator('canvas.au-eng-canvas')).toHaveCount(0);
  const warp = page.locator('[data-unit-row="27"] input[data-kind="power"]');
  const max = (await systems(page)).units[27]!.max;
  await warp.fill('40');
  await expect.poll(async () => (await systems(page)).units[27]!.target).toBe(Math.trunc(max * 40 / 119));
  await page.getByRole('button', { name: 'Weapons', exact: true }).click();
  await expect(page.locator('[data-unit-row="19"] input[data-kind="torpedoes"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Bridge', exact: true }).click();
  await expect(station(page, 'bridge')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
