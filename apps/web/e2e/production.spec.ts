// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { goTo, quiet, station } from './helpers';

const PRODUCTION = `http://localhost:${Number(process.env.E2E_PORT ?? 5174) + 1}`;

/** Waits until Preact has run its effects (the overlay's key listener is one), which it does after a frame. */
async function afterEffects(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => setTimeout(resolve)))));
}

test('production: players get no dev tools or debug handle unless they ask with ?dev', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(`${PRODUCTION}/play/afu/?game=demo&speed=4&mute`);
  await expect(page.getByRole('button', { name: 'Look', exact: true })).toBeVisible({ timeout: 30_000 });
  // (main.ts would set window.__au in the same task that renders the HUD: once the HUD's effects have run, it would be there)
  await afterEffects(page);
  expect(await page.evaluate(() => window.__au === undefined)).toBe(true);
  await page.keyboard.press('`');
  await expect(page.getByRole('region', { name: 'Dev tools' })).toHaveCount(0);

  await page.goto(`${PRODUCTION}/play/afu/?game=demo&speed=4&mute&dev`);
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__au!.speed())).toBe(4);
  await afterEffects(page);
  await page.keyboard.press('`');
  await expect(page.getByRole('region', { name: 'Dev tools' })).toBeVisible();
  expect(errors).toEqual([]);
});

// (no production fixture's save reaches a hail without the dev tools, and a player's page has no `window.__au` to read the session's
// worldOptions from: so the built bundle is read through what the options decide, which tactical draws. Without ?combat=dialog a ?dev page
// fights in the combat sim, the console up and the dialog's Win, Flee and Lose behind the dev view; with it, the M4 dialog's three buttons
// are the panel. devGate.test.ts holds the rest: a player's page, with no ?dev, resolves `realCombat` true)
const lifted = existsSync(new URL('../../../games/unity/combat.yaml', import.meta.url));

for (const [query, real] of [['', true], ['&combat=dialog', false]] as const) {
  test(`production: tactical ${real ? 'fights the combat sim' : 'shows the M4 dialog with ?dev&combat=dialog'}`, async ({ page }) => {
    test.skip(!lifted, 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');
    await page.goto(`${PRODUCTION}/play/afu/?game=unity&speed=4&mute&dev&art=0${query}`);
    await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 60_000 });
    await quiet(page);
    await page.evaluate(() => window.__au!.battleScenario(8));
    await goTo(page, 'Tactical', 'tactical');
    const tactical = station(page, 'tactical');
    await expect(tactical.getByRole('group', { name: 'Console' })).toHaveCount(real ? 1 : 0, { timeout: 30_000 });
    await expect(tactical.getByRole('button', { name: 'Win', exact: true })).toHaveCount(real ? 0 : 1);
  });
}
