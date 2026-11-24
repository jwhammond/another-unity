// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { goTo, quiet, station, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/combat.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');

/**
 * The battle the controls fly: 16, as the console's e2e fights it, the Enterprise and two enemies at red alert. Left 20 s of its
 * clock it raises a hail of its own (Plan 23's Facts), so each test is short or paused. Auto-resolve is battle 8's, which stands
 * down, as unity-combat-game.spec.ts resolves it.
 */
const BATTLE = 16;
const START = '/play/afu/?game=unity&dev&mute&art=0';
/** FLIGHT's bits (sim/combat/flight.ts): the yaw keys and pitch down. */
const YAW_LEFT = 1 << 4, YAW_RIGHT = 1 << 5, PITCH_DOWN = 1 << 0;

/** The battle's state through the dev hook. */
const at = (page: Page) => page.evaluate(() => window.__au!.combatConsole()!);

/** Opens the game with the combat chunk already in, as the console's e2e does: a cold dev server reloads the page as it optimises the chunk. */
async function open(page: Page): Promise<void> {
  const ready = async () => {
    await page.goto(START);
    await page.waitForFunction(() => window.__au?.ready === true);
    await quiet(page);
  };
  await ready();
  // (asked once, and again only if the evaluate met the reload: each ask builds a new scene, whose warm-up (Plan 34 Task 8) then starts over,
  // so asking on every poll would never see it draw)
  let asked = false;
  await expect.poll(async () => {
    try {
      if (!asked) { await page.evaluate(() => window.__au!.previewBattle(8)); asked = true; }
      await page.waitForTimeout(100);
      return await page.evaluate(() => window.__au!.combatView().drawing);
    } catch {
      asked = false;
      return false;
    }
  }, { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => window.__au!.endPreview());
  await ready();
}

/** To tactical for `battle`, the console and the view drawing. */
async function fight(page: Page, battle = BATTLE): Promise<Locator> {
  await open(page);
  await page.evaluate(n => window.__au!.battleScenario(n), battle);
  await goTo(page, 'Tactical', 'tactical');
  const console = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => console.locator('canvas').getAttribute('data-frames').then(Number), { timeout: 30_000 }).toBeGreaterThan(2);
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 20_000 }).toBe(true);
  return console;
}

/** Where ship `index` is drawn on the page (CSS px) by the last frame, through the view's surface over `surface`'s box; null if it isn't drawn. */
async function shipOnPage(page: Page, surface: Locator, index: number): Promise<{ x: number; y: number } | null> {
  const box = (await surface.boundingBox())!;
  const v = await page.evaluate(() => window.__au!.combatView());
  const s = v.ships.find(d => d.index === index);
  if (!s || !v.window || s.x < 0 || s.y < 0 || s.x > v.window.width || s.y > v.window.height) return null;
  return { x: box.x + (s.x / v.window.width) * box.width, y: box.y + (s.y / v.window.height) * box.height };
}

/**
 * An enemy other than the target drawn on the view over `surface` (and, with `clear`, where that says), as the battle runs: the
 * camera as it is, then each of the cameras 1 to 8 in turn while none is. Null if none is in any. (Battle 16 opens with
 * its enemies off the view: they come into it as the battle runs, or under another camera.)
 */
async function enemyInView(page: Page, surface: Locator, clear?: (p: { x: number; y: number }) => Promise<boolean>): Promise<number | null> {
  for (const key of ['', '1', '2', '3', '4', '5', '6', '7', '8']) {
    if (key) await page.keyboard.press(key);
    for (let tries = 0; tries < 20; tries++) {
      const target = (await at(page)).target;
      for (const index of [1, 2, 3]) {
        const p = index === target ? null : await shipOnPage(page, surface, index);
        if (p && (!clear || await clear(p))) return index;
      }
      await page.waitForTimeout(150);
    }
  }
  return null;
}

/**
 * An enemy other than the target drawn on the view over `surface` (and where `clear` says), its place read with the battle paused
 * (`pause`), so it can't leave the view before it is clicked; if it left between the search and the pause, the battle goes on
 * (`resume`) and the search with it.
 */
async function pausedEnemy(page: Page, surface: Locator, o: { pause: () => Promise<void>; resume: () => Promise<void>; clear?: (p: { x: number; y: number }) => Promise<boolean> }): Promise<{ index: number; x: number; y: number } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await enemyInView(page, surface, o.clear) === null) return null;
    await o.pause();
    const target = (await at(page)).target;
    for (const index of [1, 2, 3]) {
      const p = index === target ? null : await shipOnPage(page, surface, index);
      if (p && (!o.clear || await o.clear(p))) return { index, ...p };
    }
    await o.resume();
  }
  return null;
}

test('the keys fly, fire, target and zoom, P pauses, `.` sets the speed and F6 reaches the console\'s controls (Plan 29)', async ({ page }) => {
  const errors = watchConsole(page);
  await fight(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const first = await at(page);
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await at(page)).target).not.toBe(first.target);
  await page.keyboard.press('z');
  await expect.poll(async () => (await at(page)).zoomLevel).toBe(first.zoomLevel + 1);
  // (a flight key held: the sim holds it until the key comes up)
  await page.keyboard.down('a');
  await expect.poll(async () => (await at(page)).held & YAW_LEFT).toBe(YAW_LEFT);
  await page.keyboard.up('a');
  await expect.poll(async () => (await at(page)).held).toBe(0);
  await page.keyboard.press('p');
  await expect.poll(async () => (await at(page)).paused).toBe(true);
  await page.keyboard.press('.');
  await expect.poll(async () => (await at(page)).speed).toBe(2);
  await page.keyboard.press('p');
  await expect.poll(async () => (await at(page)).paused).toBe(false);
  await page.keyboard.press('F6');
  expect(await page.evaluate(() => document.activeElement?.closest('.au-console-root') !== null && document.activeElement?.hasAttribute('data-control'))).toBe(true);
  await page.evaluate(() => localStorage.removeItem('au.settings'));
  expect(errors).toEqual([]);
});

test('the mouse on the view: the wheel zooms, a drag steers, and a click targets the ship drawn there (Decision 17; Plan 29)', async ({ page }) => {
  const errors = watchConsole(page);
  const console = await fight(page);
  const view = console.locator('.au-console-view');
  const box = (await view.boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const zoom = (await at(page)).zoomLevel;
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await at(page)).zoomLevel).toBe(zoom + 1);
  // (a drag right and up past 24 px: yaw right, and pitch down as the up arrow; let go, nothing)
  await page.mouse.down();
  await page.mouse.move(middle.x + 40, middle.y - 40, { steps: 4 });
  await expect.poll(async () => (await at(page)).held).toBe(YAW_RIGHT | PITCH_DOWN);
  await page.mouse.up();
  await expect.poll(async () => (await at(page)).held).toBe(0);
  // (paused, the ships hold still: an enemy drawn on the view that isn't the target, clicked; its order applied as the battle goes on)
  const pause = async (on: boolean) => {
    await page.keyboard.press('p');
    await expect.poll(async () => (await at(page)).paused).toBe(on);
  };
  const chosen = await pausedEnemy(page, view, { pause: () => pause(true), resume: () => pause(false) });
  expect(chosen, 'an enemy drawn on the view, paused').not.toBeNull();
  await page.mouse.click(chosen!.x, chosen!.y);
  await page.keyboard.press('p');
  await expect.poll(async () => (await at(page)).target).toBe(chosen!.index);
  expect(errors).toEqual([]);
});

test('Escape opens the assists panel over the console: pause, the speed, and auto-resolve, confirmed, to its result (M8 spec §6.2; Plan 29)', async ({ page }) => {
  const errors = watchConsole(page);
  await fight(page, 8);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const panel = station(page, 'tactical').getByRole('region', { name: 'Assists' });
  // (F1 is the Combat Options' (Plan 32 Task 11), not the assists panel: F1 again closes them, and Escape is the panel's again)
  const options = station(page, 'tactical').getByRole('dialog', { name: 'Combat Options' });
  await page.keyboard.press('F1');
  await expect(options).toBeVisible();
  await expect(panel).toBeHidden();
  await page.keyboard.press('F1');
  await expect(options).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Combat difficulty' })).toHaveAccessibleDescription(/the only assist that changes/);
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await at(page)).paused).toBe(true);
  await panel.getByRole('button', { name: '4×', exact: true }).click();
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => [(await at(page)).paused, (await at(page)).speed]).toEqual([false, 4]);
  await panel.getByRole('button', { name: 'Auto-resolve', exact: true }).click();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Auto-resolve', exact: true }).click();
  await panel.getByRole('button', { name: 'Resolve it', exact: true }).click();
  await expect(panel.getByLabel('Result')).toContainText('Stood down', { timeout: 60_000 });
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(station(page, 'bridge')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => localStorage.removeItem('au.settings'));
  expect(errors).toEqual([]);
});

test.describe('on a phone on its side (M8 spec Decision 16; Plan 29)', () => {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7 landscape']!;
  test.use(pixel);

  test('a tap on the wide view targets the ship drawn there, and the HUD\'s Assists opens the panel, its buttons 32 px or more', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
    await goTo(page, 'Tactical', 'tactical');
    await expect.poll(async () => (await at(page))?.wide, { timeout: 30_000 }).toBe(true);
    const hud = page.getByRole('group', { name: 'Wide view' });
    await expect(hud).toBeVisible();
    // (the wide view's box is the game frame: a ship's place on it is a fraction of the frame; one clear of the HUD's own parts,
    // where the element at the point is the view's surface, read again once the panel's Pause holds the ships still)
    const frame = page.locator('.au-console-wide');
    const clear = ({ x, y }: { x: number; y: number }) => page.evaluate(p => document.elementFromPoint(p.x, p.y)?.classList.contains('au-combat-hud-view') === true, { x, y });
    const panel = hud.getByRole('region', { name: 'Assists' });
    const byPanel = async (button: 'Pause' | 'Resume') => {
      await hud.getByRole('button', { name: 'Assists', exact: true }).tap();
      await expect(panel).toBeVisible();
      for (const b of await panel.getByRole('button').all()) {
        const r = (await b.boundingBox())!;
        expect(Math.min(r.width, r.height), await b.textContent() ?? '').toBeGreaterThanOrEqual(32);
      }
      await panel.getByRole('button', { name: button, exact: true }).tap();
      await expect.poll(async () => (await at(page)).paused).toBe(button === 'Pause');
      await panel.getByRole('button', { name: 'Close', exact: true }).tap();
    };
    const chosen = await pausedEnemy(page, frame, { pause: () => byPanel('Pause'), resume: () => byPanel('Resume'), clear });
    expect(chosen, 'an enemy drawn clear of the HUD, paused').not.toBeNull();
    await page.touchscreen.tap(chosen!.x, chosen!.y);
    await hud.getByRole('button', { name: 'Assists', exact: true }).tap();
    await panel.getByRole('button', { name: 'Resume', exact: true }).tap();
    await expect.poll(async () => (await at(page)).target).toBe(chosen!.index);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => localStorage.removeItem('au.settings'));
    expect(errors).toEqual([]);
  });
});

test.describe('a short screen, 800 by 360 (Plan 29 R12)', () => {
  test.use({ viewport: { width: 800, height: 360 } });

  test('in Wide the drawer stops short of the fire buttons, and in Split it lies wholly within the console\'s 4:3 box', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
    await goTo(page, 'Tactical', 'tactical');
    await expect.poll(async () => (await at(page))?.wide, { timeout: 30_000 }).toBe(true);
    const rect = (l: Locator) => l.evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width }; });
    const within = (inner: Awaited<ReturnType<typeof rect>>, outer: Awaited<ReturnType<typeof rect>>) =>
      inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    // (Wide: the drawer over the game frame from its left, stopping short of the fire buttons, which stay in reach with it open:
    // the user's ruling on Plan 29's hand-on)
    const hud = page.getByRole('group', { name: 'Wide view' });
    await hud.getByRole('button', { name: 'Console', exact: true }).click();
    const wideBody = hud.getByRole('region', { name: 'Console drawer' });
    await expect(wideBody).toBeVisible();
    const frame = await rect(page.locator('.au-console-wide'));
    const wb = await rect(wideBody);
    expect(within(wb, frame), 'the wide drawer within the frame').toBe(true);
    const fire = await rect(hud.locator('.au-combat-hud-fire'));
    expect(wb.right, 'the open drawer clear of the fire buttons').toBeLessThan(fire.left);
    expect(wb.width).toBeGreaterThan(0.4 * frame.width);
    // (Split: its button taken with the drawer open; then the drawer over the console, sized by the console's own box)
    await hud.getByRole('button', { name: 'Split view', exact: true }).click();
    await expect.poll(async () => (await at(page)).wide).toBe(false);
    const phone = page.locator('.au-console-phone');
    const handle = phone.getByRole('button', { name: 'Console', exact: true });
    if (await handle.getAttribute('aria-expanded') !== 'true') await handle.click();
    const body = phone.getByRole('region', { name: 'Console drawer' });
    await expect(body).toBeVisible();
    const screen = await rect(station(page, 'tactical').getByRole('group', { name: 'Console' }));
    const sb = await rect(body);
    expect(within(sb, screen), 'the Split drawer within the console').toBe(true);
    expect(await body.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
});
