// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { goTo, quiet, station, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/combat.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');

/**
 * The battle the console is fought in: 16, the Enterprise and two Garidian ships at red alert, every ship active in a new game.
 * Left 20 s of its clock it raises a hail of its own (Plan 23's Facts), so the game runs at its own pace and each test is short.
 */
const BATTLE = 16;
const START = '/play/afu/?game=unity&dev&mute&art=0';

/** The console's state through the dev hook. */
const at = (page: Page) => page.evaluate(() => window.__au!.combatConsole()!);

/**
 * Opens the game with the combat chunk already in, as unity-combat-effects.spec.ts does: a cold dev server optimises the chunk's
 * dependencies as it first loads and reloads the page, which mid-test destroys it.
 */
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

/** To tactical for BATTLE, the console drawing: its canvas has drawn frames and the view draws under it. */
async function fight(page: Page): Promise<Locator> {
  await open(page);
  await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
  await goTo(page, 'Tactical', 'tactical');
  const console = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => console.locator('canvas').getAttribute('data-frames').then(Number), { timeout: 30_000 }).toBeGreaterThan(2);
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 20_000 }).toBe(true);
  return console;
}
/** A console control by its name. */
const control = (console: Locator, name: string) => console.getByRole('button', { name, exact: true });
/** The console's controls are the original's mouseClick: one at a time, each button held down 498 ms. */
const settle = (page: Page) => page.waitForTimeout(600);

test('the console\'s tabs turn its pages, and CONN\'s controls each give their order (Plan 27)', async ({ page }) => {
  const errors = watchConsole(page);
  const console = await fight(page);
  expect(await at(page)).toMatchObject({ page: 'conn', wide: false, warp: false, console: { radarShown: true, redAlert: true } });
  for (const [name, p] of [['Phaser banks', 'phasers'], ['Torpedoes', 'torpedoes'], ['Own damage', 'damage'], ['Maneuvers', 'tactics'], ['Target sensors', 'sensors'], ['Helm', 'conn']] as const) {
    await control(console, name).click();
    await expect.poll(async () => (await at(page)).page).toBe(p);
    expect(await console.locator('.au-console-root').getAttribute('data-page')).toBe(p);
  }
  // (a power level, before Delegate is on: Delegate's AI sets the level itself; then each toggle the other way, Delegate on and
  // off again)
  const before = (await at(page)).console;
  await control(console, 'Power level 2').click();
  await expect.poll(async () => (await at(page)).console.powerLevel).toBe(2);
  // (each read before the next: Delegate on locks weapons itself when an enemy is there, setDelegate, ai.ts:299)
  for (const [name, key] of [['Shields', 'shieldsRaised'], ['Weapons lock', 'weaponsLock'], ['Delegate', 'delegate']] as const) {
    await control(console, name).click();
    await expect.poll(async () => (await at(page)).console[key], name).toBe(!before[key]);
    await settle(page);
  }
  await control(console, 'Delegate').click();
  await expect.poll(async () => (await at(page)).console.delegate).toBe(before.delegate);
  expect(errors).toEqual([]);
});

test('the phasers\', torpedoes\' and maneuvers\' pages give their orders, and the radar targets a ship it shows (Plan 27)', async ({ page }) => {
  const errors = watchConsole(page);
  const console = await fight(page);
  // (a bank's slider dragged to its end, then None)
  await control(console, 'Phaser banks').click();
  const bank = console.getByRole('slider', { name: 'Phaser bank 1' });
  const box = (await bank.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await at(page)).banks[0]).toBe(100);
  await control(console, 'No banks').click();
  await expect.poll(async () => (await at(page)).banks.every(s => s === 0)).toBe(true);
  await settle(page);
  await control(console, 'Torpedoes').click();
  await control(console, 'Spread 25 degrees').click();
  await expect.poll(async () => (await at(page)).console.spreadDegrees).toBe(25);
  await settle(page);
  await control(console, 'Maneuvers').click();
  await console.locator('[data-control="maneuver-0"]').click();
  await expect.poll(async () => (await at(page)).console.menuSelected).toBe(0);
  // (the radar: a click on another ship's blip targets it)
  await control(console, 'Helm').click();
  const target = (await at(page)).target;
  const blips = JSON.parse((await console.locator('canvas').getAttribute('data-blips'))!) as { ship: number; x: number; y: number }[];
  const other = blips.find(b => b.ship > 0 && b.ship !== target)!;
  expect(other).toBeDefined();
  const c = (await console.locator('canvas').boundingBox())!;
  await page.mouse.click(c.x + ((other.x + 0.5) * c.width) / 640, c.y + ((other.y + 0.5) * c.height) / 480);
  await expect.poll(async () => (await at(page)).target).toBe(other.ship);
  expect(errors).toEqual([]);
});

test('Engineering waits its 498 ms, and the console costs the view no draw call (Plan 27 R8, R12)', async ({ page }) => {
  const errors = watchConsole(page);
  const console = await fight(page);
  // (the console is a picture over the canvas: the frame's calls are the view's alone, within the budget)
  const frame = await page.evaluate(() => window.__au!.combatFrame());
  expect(frame.calls).toBeLessThanOrEqual(150);
  const pressed = Date.now();
  await control(console, 'Engineering').click();
  expect(await station(page, 'tactical').count()).toBe(1);
  await expect(station(page, 'engineering')).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - pressed).toBeGreaterThanOrEqual(450);
  expect(errors).toEqual([]);
});

test('F1 brings up the original\'s Combat Options over the battle, paused: its values are the settings\', the Enterprise drawn in its preview; Esc gives the battle back (Plan 32 Task 11)', async ({ page }) => {
  const errors = watchConsole(page);
  await fight(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const options = station(page, 'tactical').getByRole('dialog', { name: 'Combat Options' });
  await page.keyboard.press('F1');
  await expect(options).toBeVisible();
  await expect.poll(async () => (await at(page)).paused).toBe(true);
  // (the game's bar, its Admin button with it, is inert behind the screen: no PADD over it by the mouse)
  expect(await page.getByRole('button', { name: 'Admin', exact: true }).evaluate(el => el.closest('[inert]') !== null)).toBe(true);
  // (the battle's keys rest under it: an arrow held is no steer)
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(200);
  expect((await at(page)).held).toBe(0);
  await page.keyboard.up('ArrowLeft');
  // (the preview is drawn in the screen's window, the Enterprise alone)
  await expect.poll(async () => (await page.evaluate(() => window.__au!.combatView())).preview).not.toBeNull();
  const hole = (await options.getByRole('img', { name: 'Preview' }).boundingBox())!;
  const shown = (await page.evaluate(() => window.__au!.combatView())).preview!;
  expect(Math.abs(shown.width / hole.width - shown.height / hole.height)).toBeLessThan(0.05);
  await options.getByRole('button', { name: 'STARS OFF', exact: true }).click();
  await options.getByRole('button', { name: 'DETAIL HIGH', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('au.settings') ?? '{}').combat)).toMatchObject({ stars: false, detail: 'medium' });
  // (Tab stays on the screen)
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  expect(await options.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(options).toBeHidden();
  await expect.poll(async () => (await at(page)).paused).toBe(false);
  await expect.poll(async () => (await page.evaluate(() => window.__au!.combatView())).preview).toBeNull();
  await page.evaluate(() => localStorage.removeItem('au.settings'));
  expect(errors).toEqual([]);
});

test('Full fills the game frame with the view and the HUD, whose buttons are the console\'s; the warp overlay hides the HUD, and the console; Split comes back (Plan 27 R10, R13)', async ({ page }) => {
  const errors = watchConsole(page);
  const console = await fight(page);
  await control(console, 'Full view').click();
  await expect.poll(async () => (await at(page)).wide).toBe(true);
  const hud = page.getByRole('group', { name: 'Wide view' });
  await expect(hud).toBeVisible();
  // (the view fills the frame: the canvas's own box, in its pixels)
  const canvas = (await page.locator('#game canvas').first().boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);
  await expect.poll(async () => (await page.evaluate(() => window.__au!.combatView())).viewport?.width).toBe(Math.round(canvas.width * dpr));
  expect(await console.locator('canvas').count()).toBe(0);
  await expect(hud.locator('[data-hud="target"]')).toBeVisible();
  // (the warp overlay while wide: no HUD while it shows, the HUD again after)
  const overlay = () => page.evaluate(() => window.__au!.combatView()).then(v => v.overlay);
  expect(await page.evaluate(() => window.__au!.battleWarp())).toBe(true);
  await expect.poll(overlay).toBe('warp');
  await expect(hud).toHaveCount(0);
  await expect.poll(overlay, { timeout: 10_000 }).toBeNull();
  await expect(hud).toBeVisible();
  await settle(page);
  await hud.getByRole('button', { name: 'Split view' }).click();
  await expect.poll(async () => (await at(page)).wide).toBe(false);
  await expect(console.locator('canvas')).toBeVisible();
  // (the warp overlay in Split: no console while it shows, the console again after)
  expect(await page.evaluate(() => window.__au!.battleWarp())).toBe(true);
  await expect.poll(overlay).toBe('warp');
  expect(await console.locator('[data-control]').count()).toBe(0);
  await expect.poll(overlay, { timeout: 10_000 }).toBeNull();
  await expect(console.locator('canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('on a phone on its side (M8 spec Decision 16)', () => {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7 landscape']!;
  test.use(pixel);

  test('opens the battle wide with the HUD and the console as a drawer: no sideways scroll, every tap target 32 px or more', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
    await goTo(page, 'Tactical', 'tactical');
    await expect.poll(async () => (await at(page))?.wide, { timeout: 30_000 }).toBe(true);
    const hud = page.getByRole('group', { name: 'Wide view' });
    await expect(hud).toBeVisible();
    // (the fullscreen button, shown on a touch phone not yet fullscreen, isn't over the HUD's target: its top line is the target's)
    await expect(page.locator('.au-fs-hud')).toBeVisible();
    expect(await hud.locator('[data-hud="target"]').evaluate(el => {
      const r = el.getBoundingClientRect();
      return [0.1, 0.5, 0.9].every(f => el.contains(document.elementFromPoint(r.x + r.width * f, r.y + 1)));
    }), 'target').toBe(true);
    // (on a 360 px-high screen the drawer's handle clears the log and the fire buttons, however wide they grow: each box at its
    // max-width, the log from the left and the fire buttons from the right, beside the handle)
    const handle = hud.getByRole('button', { name: 'Console' });
    const h = (await handle.boundingBox())!;
    const widest = (l: Locator) => l.evaluate(el => {
      const e = el as HTMLElement;
      e.style.width = getComputedStyle(e).maxWidth;
      const r = e.getBoundingClientRect();
      e.style.width = '';
      return { left: r.left, right: r.right };
    });
    const log = await widest(hud.locator('[data-hud="log"]'));
    expect(log.right, 'log').toBeLessThanOrEqual(h.x);
    const fire = await widest(hud.locator('.au-combat-hud-fire'));
    expect(fire.left, 'fire buttons').toBeGreaterThanOrEqual(h.x + h.width);
    // (the HUD's buttons take taps through the console box around them: each is the element at its own centre)
    for (const b of await hud.locator('.au-combat-hud-fire button').all()) {
      expect(await b.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), await b.textContent() ?? '').toBe(true);
    }
    await handle.click();
    const drawer = hud.getByRole('region', { name: 'Console drawer' });
    await expect(drawer).toBeVisible();
    // (the open drawer is whole on the screen)
    const d = (await drawer.boundingBox())!;
    const screen = page.viewportSize()!;
    expect(d.x >= 0 && d.y >= 0 && d.x + d.width <= screen.width && d.y + d.height <= screen.height, JSON.stringify(d)).toBe(true);
    for (const b of await hud.getByRole('button').all()) {
      const r = (await b.boundingBox())!;
      expect(Math.min(r.width, r.height), await b.textContent() ?? '').toBeGreaterThanOrEqual(32);
    }
    const shields = (await at(page)).console.shieldsRaised;
    await drawer.getByRole('button', { name: 'Shields' }).click();
    await expect.poll(async () => (await at(page)).console.shieldsRaised).toBe(!shields);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    // (and with the drawer shut, Split, tapped through the box, gives its order)
    await settle(page);
    await handle.click();
    await expect(drawer).toBeHidden();
    await hud.getByRole('button', { name: 'Split view' }).click();
    await expect.poll(async () => (await at(page)).wide).toBe(false);
    // (and back: Full's control in Split is 32 px or more, under nothing (the fullscreen button is elsewhere), and a tap on it is Full)
    await settle(page);
    const full = station(page, 'tactical').getByRole('group', { name: 'Console' }).getByRole('button', { name: 'Full view', exact: true });
    const f = (await full.boundingBox())!;
    expect(Math.min(f.width, f.height), JSON.stringify(f)).toBeGreaterThanOrEqual(32);
    expect(await full.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; })).toBe(true);
    await page.touchscreen.tap(f.x + f.width / 2, f.y + f.height * 0.75);
    await expect.poll(async () => (await at(page)).wide).toBe(true);
    await expect(hud).toBeVisible();
    expect(errors).toEqual([]);
  });
});
