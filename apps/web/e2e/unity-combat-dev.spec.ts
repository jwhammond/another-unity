// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { quiet, watchConsole } from './helpers';

const lifted = existsSync(new URL('../../../games/unity/combat.yaml', import.meta.url));
test.skip(!lifted, 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');

test('the ?dev combat view fights the default battle from the lifted data, on the battle clock', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  // (the ship's clock runs on under the dev tab, so its times move. A battle could change the rest; and the times must
  // stay on the ship's clock, within a minute (3600 ticks) of the world's tick, not retimed to the battle's ms, ~17x more)
  const systems = () => page.evaluate(() => {
    const { ship, tick } = window.__au!.state();
    const { units, lastTick, lastReactorTick, ...rest } = ship.systems;
    const times = [lastTick, lastReactorTick, ...units.map(u => u.nextStep), ...units.map(u => u.nextRepair)];
    return JSON.stringify({ units: units.map(({ nextStep, nextRepair, ...u }) => u), ...rest, shipClock: times.every(t => t <= tick + 3600) });
  });
  const before = await systems();
  await page.keyboard.press('`');
  const dev = page.getByRole('region', { name: 'Dev tools' });
  await dev.getByRole('button', { name: 'combat', exact: true }).click();
  const battle = dev.getByRole('combobox', { name: 'Battle' });
  // (the default battle, 8, whose Enterprise is active in a new game; combat.yaml has 40)
  await expect(battle).toHaveValue('8');
  expect(await battle.locator('option').count()).toBe(40);
  await dev.getByRole('button', { name: 'Start', exact: true }).click();
  const status = dev.getByLabel('Battle status');
  await expect(status).toContainText('step 0');
  await expect(dev.locator('canvas')).toBeVisible();
  // (held for five steps: 5 * 2.2)
  const faster = dev.getByRole('button', { name: 'Faster', exact: true });
  const step = dev.getByRole('button', { name: 'Step', exact: true });
  await faster.dispatchEvent('pointerdown');
  for (let i = 0; i < 5; i++) await step.click();
  await faster.dispatchEvent('pointerup');
  await expect(status).toContainText('step 5');
  await expect(dev.getByLabel('Enterprise')).toContainText('throttle 11.0');
  // (all stop takes throttle * dt off a step: 11 - 11 * 0.066 = 10.274, combat.cpp:606)
  await dev.getByRole('button', { name: 'All stop', exact: true }).click();
  await step.click();
  await expect(status).toContainText('step 6');
  await expect(dev.getByLabel('Enterprise')).toContainText('throttle 10.3');
  await dev.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await status.getAttribute('data-steps')), { timeout: 10_000 }).toBeGreaterThan(30);
  await dev.getByRole('button', { name: 'Pause', exact: true }).click();

  // (battle 8 has only the Enterprise active in a new game; battle 1 has seven ships, targeting the last. Target ▶
  // wraps to the first, ◀ back: combat.cpp:732-748. Without the AI and tactics, the AI button, so the ships sit still)
  const aiButton = dev.getByRole('button', { name: 'AI', exact: true });
  await aiButton.click();
  await expect(aiButton).toHaveAttribute('aria-pressed', 'false');
  await battle.selectOption('1');
  await dev.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dev.locator('table[aria-label=Ships] tr')).toHaveCount(7);
  await expect(status).toContainText('target 6');
  await dev.getByRole('button', { name: 'Target ▶', exact: true }).click();
  await expect(status).toContainText('target 1');
  await dev.getByRole('button', { name: 'Target ◀', exact: true }).click();
  await expect(status).toContainText('target 6');
  for (let i = 0; i < 10; i++) await step.click();
  // (weapons and damage, Plan 20: a salvo at the target, through the lifted data's frame counts and rolls)
  const effects = dev.getByLabel('Effects');
  await expect(effects).toContainText('torpedoes 0');
  await dev.getByRole('button', { name: 'Both', exact: true }).click();
  await expect(effects).not.toContainText('torpedoes 0');
  await expect(effects).not.toContainText('rolls 0');
  // (measured on the lifted battle 1, the same each run: two banks bear, a salvo of two, and 14 rolls to fire them)
  await expect(effects).toHaveText('beams 2 · torpedoes 2 · debris 0 · rolls 14');
  for (let i = 0; i < 10; i++) await step.click();
  // (measured: the rolls go on from the eighth step, and one of the target's shields takes the hits and holds; its name is the game's, so not pinned)
  await expect(effects).toHaveText('beams 2 · torpedoes 2 · debris 0 · rolls 24');
  await dev.getByRole('button', { name: 'Log of ship 6', exact: true }).click();
  await expect(dev.getByLabel('Ship log')).toHaveText(/^Shield .+ holding at 298\.35$/);

  // (the AI and tactics, Plan 21, on again for the next battle: the Enterprise's script builds its seven maneuver
  // headings in the first step, all at once, and makes the kernel ready (measured on the lifted battle 1). Their names
  // and the scripts' pages are the game's, so not pinned)
  await aiButton.click();
  await dev.getByRole('button', { name: 'Start', exact: true }).click();
  const tactics = dev.getByLabel('Tactics');
  await expect(tactics).toHaveText('no delegate · no kernel ready · no script lock · engage lock · no engage button · menu 0 headings, 0 rows');
  await step.click();
  await expect(tactics).toHaveText('no delegate · kernel ready · no script lock · no engage lock · no engage button · menu 7 headings, 7 rows');
  await expect(dev.locator('[aria-label="Maneuvers"] li')).toHaveCount(7);
  await dev.getByRole('button', { name: 'Delegate', exact: true }).click();
  await expect(tactics).toHaveText(/^delegate · kernel ready · /);
  for (let i = 0; i < 10; i++) await step.click();
  await expect(dev.locator('[aria-label="Scripts"] li').first()).toHaveText(/^0 · engaged · \S+\.bin .+ pc 0x[0-9a-f]+ /);
  // (the game's scripts use nothing the port doesn't know)
  await expect(dev.getByLabel('Warnings')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/au-combat-dev.png' });

  // (the battles ran on a copy: the game's Enterprise is as it was)
  expect(await systems()).toBe(before);
  expect(errors).toEqual([]);
});
