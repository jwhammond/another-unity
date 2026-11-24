// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { goTo, quiet, station, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/combat.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');

/**
 * The battle a hail's script leaves behind (`scenario`, by default 8, whose only active ship in a new game is the Enterprise: no red alert. A new
 * game has 16 set, which t03 leaves: docs/unity-local.md), fought at tactical under ?dev, the speed 4. Returns the page's console errors.
 */
async function fight(page: Page, scenario = 8, speed = 4): Promise<string[]> {
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&speed=${speed}&mute&dev&art=0`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.evaluate(n => window.__au!.battleScenario(n), scenario);
  await goTo(page, 'Tactical', 'tactical');
  return errors;
}

/** What a battle that has ended through endCombat leaves: no battle, no tactical, the world's way on (the game's end or the ship). */
async function expectEnded(page: Page, gameOver: boolean): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__au!.state().ship.combat), { timeout: 60_000 }).toBeNull();
  await expect(station(page, 'tactical')).toHaveCount(0);
  const after = await page.evaluate(() => {
    const st = window.__au!.state();
    return { combat: st.ship.combat, gameOver: st.onShip?.gameOver ?? null, onShip: st.onShip !== null, battle: window.__au!.combatConsole() };
  });
  expect(after.combat).toBeNull();
  expect(after.battle).toBeNull();
  expect(after.onShip).toBe(true);
  expect(after.gameOver !== null).toBe(gameOver);
  if (!gameOver) {
    await expect(station(page, 'bridge')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => window.__au!.state().ship.station)).toBe('bridge');
  }
}

test('with ?dev the bridge\'s Tactical fights the world\'s battle: the console, the dev view folded over it, pause, fast-forward, auto-resolve and its end', async ({ page }) => {
  const errors = await fight(page);
  const tactical = station(page, 'tactical');
  // (the console, with the dev view folded over its corner: Plan 27)
  await expect(tactical.getByRole('group', { name: 'Console' })).toBeVisible();
  await tactical.getByText('Dev tools', { exact: true }).click();
  const battle = tactical.getByRole('region', { name: 'Battle' });
  await expect(battle).toBeVisible();
  const status = battle.getByLabel('Battle status');
  const steps = async () => Number(await status.getAttribute('data-steps'));
  await expect.poll(steps, { timeout: 20_000 }).toBeGreaterThan(5);
  // (the M4 dialog's ways out stay beside it, as a test shortcut)
  for (const name of ['Win', 'Flee', 'Lose']) await expect(tactical.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(battle.getByRole('combobox', { name: 'Combat difficulty' })).toHaveAccessibleDescription(/the only assist that changes/);

  // pause: the steps stand; resume at 8x: they run on
  await battle.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await steps();
  await page.waitForTimeout(1_000);
  expect(await steps()).toBe(paused);
  await battle.getByRole('button', { name: '8×', exact: true }).click();
  await battle.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(steps, { timeout: 20_000 }).toBeGreaterThan(paused + 30);

  // auto-resolve: nothing to fight, so it stands down at once; Continue leaves by the Bridge button, for the bridge
  await battle.getByRole('button', { name: 'Auto-resolve', exact: true }).click();
  await expect(battle.getByLabel('Result')).toContainText('Stood down');
  await battle.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(station(page, 'bridge')).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => window.__au!.state().ship.combat)).toBeNull();
  // (the speed is a setting: put back for the next test)
  await page.evaluate(() => localStorage.removeItem('au.settings'));
  expect(errors).toEqual([]);
});

/** The console's buttons are the original's mouseClick: one at a time, each held down 498 ms. */
const press = async (page: Page, name: string) => {
  await station(page, 'tactical').getByRole('group', { name: 'Console' }).getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(600);
};

/** Battle 34's objects, which its hooks alter (ids only): the enter hook sets the commander active, the warp hook clears it, the exit hook wakes the Romulan, clears the commander and hails. */
const ROMULAN = 'space.romulan.2201';
const COMMANDER = 'ship.romulan_commander';
const active = (page: Page) => page.evaluate(([r, c]) => {
  const o = window.__au!.state().objects;
  return { romulan: o[r!]?.active ?? null, commander: o[c!]?.active ?? null };
}, [ROMULAN, COMMANDER]);
/** Whether a conversation is on the screen (a spoken line or a menu) or the world has a hail pending. */
const talking = (page: Page) => page.evaluate(() => document.querySelector('.au-subtitle') !== null || document.querySelector('.au-menu') !== null || window.__au!.state().pendingHail !== null);

test('a won battle ends through endCombat', async ({ page }) => {
  const errors = await fight(page);
  const tactical = station(page, 'tactical');
  await tactical.getByText('Dev tools', { exact: true }).click();
  const battle = tactical.getByRole('region', { name: 'Battle' });
  // (nothing to fight, so auto-resolve stands down at once; Continue leaves, through endCombat. Battle 8 has no hooks to read:
  // the hook's effect is the fled test's, on battle 34)
  await battle.getByRole('button', { name: 'Auto-resolve', exact: true }).click();
  await expect(battle.getByLabel('Result')).toContainText('Stood down');
  await battle.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectEnded(page, false);
  expect(errors).toEqual([]);
});

test('a hail\'s conversation on 34 holds the battle, which goes on after without catching up (runViewscreen blocks, tactical.cpp:386-390; combat.cpp:411-419)', async ({ page }) => {
  const errors = await fight(page, 34);
  const con = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => con.locator('canvas').getAttribute('data-frames').then(Number), { timeout: 30_000 }).toBeGreaterThan(2);
  const steps = () => page.evaluate(() => window.__au!.combatConsole()!.steps);
  // (the steps, then whether the conversation is still up, in one read: the world stays busy from its first line to its last,
  // between lines too, where no subtitle shows. Steps read while it was still up after are held steps)
  const sample = () => page.evaluate(() => {
    const steps = window.__au!.combatConsole()!.steps;
    return { steps, up: !window.__au!.idle() };
  });
  // (the Romulan answers the Hail with a conversation, its menu up until the player picks)
  await press(page, 'Hail');
  const menu = page.locator('.au-menu');
  await expect(menu).toBeVisible({ timeout: 20_000 });
  const held = await steps();
  // (two seconds at 4x, 120 steps had it run on)
  await page.waitForTimeout(2_000);
  expect(await steps()).toBe(held);
  await menu.getByRole('button').nth(0).click();
  // (the rest of the conversation: still held, line by line)
  let checked = 0;
  for (let s = await sample(); s.up; s = await sample()) {
    expect(s.steps).toBe(held);
    checked++;
    await page.waitForTimeout(100);
  }
  expect(checked).toBeGreaterThan(0);
  // (and the time it took is skipped, not caught up: one step, then the frames' own, not the seconds' worth)
  await expect.poll(() => page.evaluate(() => window.__au!.idle()), { timeout: 20_000, intervals: [20] }).toBe(true);
  const after = await steps();
  expect(after - held).toBeLessThan(20);
  await expect.poll(steps, { timeout: 20_000 }).toBeGreaterThan(after);
  expect(errors).toEqual([]);
});

test('a won battle on 34 runs its Exit hook through endCombat, the dev Win\'s way', async ({ page }) => {
  // (the battle's own win needs its Romulan's hail answered while the fight goes on, which can end the Enterprise first: so the dev
  // Win, the dialog's way, destroys the enemy and ends the battle through resolveCombat and endCombat)
  const errors = await fight(page, 34);
  // (the battle's hook runs when its clock starts, which waits for the view's first draw: Plan 34 Task 8)
  await expect.poll(() => active(page), { timeout: 30_000 }).toEqual({ romulan: true, commander: true });
  const tactical = station(page, 'tactical');
  await tactical.getByText('Dev tools', { exact: true }).click();
  await tactical.getByRole('button', { name: 'Win', exact: true }).click();
  // (the Exit hook ran: the Romulan, destroyed, is active again; the commander is cleared. The Warp hook alone
  // would have left the Romulan as it was)
  await expect.poll(() => active(page), { timeout: 30_000 }).toEqual({ romulan: true, commander: false });
  await expectEnded(page, false);
  expect(errors).toEqual([]);
});

test('a fled battle ends through endCombat', async ({ page }) => {
  // (battle 34 again, its hail left unanswered: the Enterprise warps away, and the Warp hook, not the Exit, runs)
  const errors = await fight(page, 34);
  const con = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => con.locator('canvas').getAttribute('data-frames').then(Number), { timeout: 30_000 }).toBeGreaterThan(2);
  // (the battle's hook runs when its clock starts, which waits for the view's first draw: Plan 34 Task 8)
  await expect.poll(() => active(page), { timeout: 30_000 }).toEqual({ romulan: true, commander: true });
  // (the Enterprise's maneuvers: the Warp heading is the fifth of seven, opened by a click, its one button the row below; Engage runs
  // its script's WARP, the overlay shows, and the Bridge button then leaves, the red alert being over)
  await press(page, 'Maneuvers');
  await con.locator('[data-control="maneuver-4"]').click();
  await page.waitForTimeout(600);
  await con.locator('[data-control="maneuver-5"]').click();
  await page.waitForTimeout(600);
  await press(page, 'Engage');
  await expect.poll(() => page.evaluate(() => window.__au!.combatConsole()?.warp === true), { timeout: 30_000, intervals: [20] }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__au!.combatConsole()?.warp === false), { timeout: 20_000 }).toBe(true);
  await press(page, 'Helm');
  await expect.poll(() => page.evaluate(() => window.__au!.combatConsole()?.console.redAlert), { timeout: 20_000 }).toBe(false);
  await press(page, 'Bridge');
  await expectEnded(page, false);
  // (the Warp hook ran: the commander is cleared, and the Exit hook's did not: the Romulan is as it was and no hail follows)
  expect(await active(page)).toEqual({ romulan: true, commander: false });
  await page.waitForTimeout(3_000);
  expect(await talking(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('a lost battle ends through endCombat', async ({ page }) => {
  const errors = await fight(page);
  const con = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => con.locator('canvas').getAttribute('data-frames').then(Number), { timeout: 30_000 }).toBeGreaterThan(2);
  const armed = async () => (await page.evaluate(() => window.__au!.combatConsole()!)).console.selfDestructTime !== 0;
  // (selfdestruct.inputs: armed, disarmed, the Phasers page, armed again, which runs out. The button is CONN's, so a player arms it
  // the second time from Helm, where the script's `set selfdestruct` is the sim's order from any page)
  await press(page, 'Self-destruct');
  await expect.poll(armed).toBe(true);
  await press(page, 'Self-destruct');
  await expect.poll(armed).toBe(false);
  await press(page, 'Phaser banks');
  await expect.poll(async () => (await page.evaluate(() => window.__au!.combatConsole()!)).page).toBe('phasers');
  await press(page, 'Helm');
  await press(page, 'Self-destruct');
  await expect.poll(armed).toBe(true);
  await expectEnded(page, true);
  expect(errors).toEqual([]);
});
