// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { goTo, quiet, station, watchConsole } from './helpers';

const COMBAT = new URL('../../../games/unity/combat.yaml', import.meta.url);
test.skip(!existsSync(COMBAT), 'needs the lifted game with combat.yaml under games/unity (npm run unity:build, docs/unity-local.md)');
test.setTimeout(600_000);

test('reads combat.yaml when a battle scenario is set, not with the rest of the game (M8 spec §8)', async ({ page }) => {
  const errors = watchConsole(page);
  const reads: string[] = [];
  page.on('request', r => { if (/\/combat\.yaml/.test(r.url())) reads.push(r.url()); });
  // (away, no battle is near: the game plays without it)
  await page.goto('/play/afu/?game=unity&dev&mute&art=0&start=lab.s01');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  expect(reads).toEqual([]);
  // (a new game opens on the ship, where the opening's hail sets battle 16 (docs/unity-local.md): read then, once)
  await page.goto('/play/afu/?game=unity&dev&mute&art=0&speed=4');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  expect(await page.evaluate(() => window.__au!.state().ship.battleScenario)).toBe(16);
  await expect.poll(() => reads.length).toBe(1);
  // (tactical then has it: no second read. The default battle, 8: the Enterprise alone in a new game stands down at once)
  await page.evaluate(() => window.__au!.battleScenario(8));
  await goTo(page, 'Tactical', 'tactical');
  // (the dev view folds out over the console: Plan 27)
  await station(page, 'tactical').getByText('Dev tools', { exact: true }).click();
  await expect(station(page, 'tactical').getByRole('region', { name: 'Battle' }).getByLabel('Battle status')).toBeVisible();
  expect(reads).toHaveLength(1);
  expect(errors).toEqual([]);
});

const SPRITES = new URL('../../../games/unity/space/sprites.json', import.meta.url);
const MiB = 1048576;

test('every battle\'s models, sprites and stills load, and all of them are freed again (M8 spec §8)', async ({ page }) => {
  test.skip(!existsSync(SPRITES), 'needs the space build\'s stills and sprites under games/unity/space (npm run unity:build, after Plan 24\'s re-export)');
  const errors = watchConsole(page);
  const warnings: string[] = [];
  page.on('console', m => { if (m.type() === 'warning' && m.text().includes('combat:')) warnings.push(m.text()); });
  const scenarios = Object.keys((parse(readFileSync(COMBAT, 'utf8')) as { battles: Record<string, unknown> }).battles).map(Number).sort((a, b) => a - b);
  expect(scenarios).toHaveLength(40);
  await page.goto('/play/afu/?game=unity&dev&mute&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const base = await page.evaluate(() => window.__au!.memory().bytes);
  const seen: string[] = [];
  for (const scenario of scenarios) {
    const r = await page.evaluate(n => window.__au!.loadCombatAssets(n), scenario);
    expect(r.set, `battle ${scenario}`).toMatchObject({ scenario, state: 'ready', stills: true, missing: [] });
    expect(r.set!.models).toBeGreaterThan(10);
    expect(r.set!.sprites).toBeGreaterThanOrEqual(7);
    // (what the set holds is what the ledger gained; freed, the ledger is back where it was, within a MiB)
    expect(r.during - base).toBeGreaterThanOrEqual(r.set!.bytes);
    expect(Math.abs(r.after - base)).toBeLessThan(MiB);
    seen.push(`${scenario}: ${r.set!.models} models, ${r.set!.sprites} sprites, ${r.set!.textures} textures, ${(r.set!.bytes / MiB).toFixed(1)} MiB, loaded in ${r.loadMs} ms, freed in ${r.freeMs} ms`);
  }
  expect(await page.evaluate(() => window.__au!.combatAssets())).toBeNull();
  console.log(`[combat assets] ${seen.join('; ')}`);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});
