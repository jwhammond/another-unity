// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { goTo, quiet, spaceArtPresent, station, watchConsole } from './helpers';

// Plan 30 Task 10: combat with its art on (M8 spec §7, §9.2: "locally with art on"). The battle's set takes the art's packs, the console
// lays its frame over the repaint, and the art changes nothing the battle does: the console has the same controls, and a control gives the
// same order, art on and off. Every battle's set with the art within §8's 160 MiB, freed. Local only: it needs the published art.
const art = spaceArtPresent();
test.skip(!art.present, `needs ${art.why}`);
test.setTimeout(600_000);

const BATTLE = 16;
const MiB = 1048576;
const shots = `${homedir()}/pcode/unity-raw/runs/art-combat`;
const COMBAT = new URL('../../../games/unity/combat.yaml', import.meta.url);

/** The game at tactical for BATTLE, its console drawing (as unity-combat-console.spec.ts' fight, with or without the art). */
async function fight(page: Page, artOn: boolean): Promise<Locator> {
  await page.goto(`/play/afu/?game=unity&dev&mute${artOn ? '' : '&art=0'}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
  await goTo(page, 'Tactical', 'tactical');
  const console = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect.poll(() => console.locator('canvas.au-console-canvas').getAttribute('data-frames').then(Number), { timeout: 60_000 }).toBeGreaterThan(2);
  await expect.poll(() => page.evaluate(() => window.__au?.combatAssets()?.state), { timeout: 60_000 }).toBe('ready');
  return console;
}
/** The console's controls, in order: their names and their data. */
const controls = (console: Locator) => console.locator('[data-control]').evaluateAll(els => els.map(el => [el.getAttribute('aria-label'), (el as HTMLElement).dataset.control]));

test('a battle takes the art\'s packs, its console lays its frame over the repaint, and the art changes nothing it does (Plan 30)', async ({ page }) => {
  const errors = watchConsole(page);
  const on = await fight(page, true);
  const set = (await page.evaluate(() => window.__au!.combatAssets()))!;
  expect(set.art!.packs).toBeGreaterThan(1);
  expect(set.art!.swapped).toBeGreaterThan(0);
  expect(set.art!.sheets).toBeGreaterThan(0);
  expect(set.missing).toEqual([]);
  expect(set.bytes).toBeLessThan(160 * MiB);
  // (the repaint fetches and decodes its pack and plate on first draw: the spec's 60 s, as its polls)
  await expect(on.locator('.au-console-root')).toHaveAttribute('data-art', 'repaint', { timeout: 60_000 });
  await expect.poll(() => on.locator('img.au-console-plate').evaluate(im => (im as HTMLImageElement).naturalWidth)).toBeGreaterThan(640);
  // (the frame is clear where the repaint shows: the view's rectangle and more)
  const clear = await on.locator('canvas.au-console-canvas').evaluate(c => {
    const d = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 640, 480).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] === 0) n++;
    return n;
  });
  expect(clear).toBeGreaterThan(320 * 220);
  mkdirSync(shots, { recursive: true });
  await on.screenshot({ path: `${shots}/console-art.png` });
  const withArt = await controls(on);
  await on.getByRole('button', { name: 'Shields', exact: true }).click();
  const shieldsOn = await page.evaluate(() => window.__au!.combatConsole()!.console.shieldsRaised);
  const off = await fight(page, false);
  await expect(off.locator('img.au-console-plate')).toHaveCount(0);
  expect(await page.evaluate(() => window.__au!.combatAssets()!.art)).toBeNull();
  await off.screenshot({ path: `${shots}/console-original.png` });
  expect(await controls(off)).toEqual(withArt);
  await off.getByRole('button', { name: 'Shields', exact: true }).click();
  expect(await page.evaluate(() => window.__au!.combatConsole()!.console.shieldsRaised)).toBe(shieldsOn);
  expect(errors).toEqual([]);
});

test('every battle\'s set loads with the art, within 160 MiB, and is freed (M8 spec §8; Plan 30 R15)', async ({ page }) => {
  const errors = watchConsole(page);
  const warnings: string[] = [];
  page.on('console', m => { if (m.type() === 'warning' && m.text().includes('combat:')) warnings.push(m.text()); });
  const scenarios = Object.keys((parse(readFileSync(COMBAT, 'utf8')) as { battles: Record<string, unknown> }).battles).map(Number).sort((a, b) => a - b);
  await page.goto('/play/afu/?game=unity&dev&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const base = await page.evaluate(() => window.__au!.memory().bytes);
  const seen: string[] = [];
  let largest = 0;
  for (const scenario of scenarios) {
    const r = await page.evaluate(n => window.__au!.loadCombatAssets(n), scenario);
    expect(r.set, `battle ${scenario}`).toMatchObject({ scenario, state: 'ready', missing: [] });
    expect(r.set!.art!.swapped, `battle ${scenario}`).toBeGreaterThan(0);
    expect(r.set!.bytes, `battle ${scenario}`).toBeLessThan(160 * MiB);
    expect(r.loadMs, `battle ${scenario}`).toBeLessThan(3000);
    expect(Math.abs(r.after - base)).toBeLessThan(MiB);
    largest = Math.max(largest, r.set!.bytes);
    seen.push(`${scenario}: ${r.set!.textures} textures, ${(r.set!.bytes / MiB).toFixed(1)} MiB, ${r.set!.art!.swapped} swapped, fit ${r.set!.art!.fit.toFixed(2)}, loaded in ${r.loadMs} ms`);
  }
  console.log(`[combat art] largest ${(largest / MiB).toFixed(1)} MiB at full resolution; ${seen.join('; ')}`);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});

test('every battle\'s set at low resolution (res=half) is under 80 MiB (Plan 31 R3)', async ({ page }) => {
  const errors = watchConsole(page);
  const scenarios = Object.keys((parse(readFileSync(COMBAT, 'utf8')) as { battles: Record<string, unknown> }).battles).map(Number).sort((a, b) => a - b);
  await page.goto('/play/afu/?game=unity&dev&mute&res=half');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const seen: string[] = [];
  let largest = 0;
  for (const scenario of scenarios) {
    const r = await page.evaluate(n => window.__au!.loadCombatAssets(n), scenario);
    expect(r.set, `battle ${scenario}`).toMatchObject({ scenario, state: 'ready', missing: [] });
    expect(r.set!.bytes, `battle ${scenario}`).toBeLessThan(80 * MiB);
    largest = Math.max(largest, r.set!.bytes);
    seen.push(`${scenario}: ${(r.set!.bytes / MiB).toFixed(1)} MiB, fit ${r.set!.art?.fit.toFixed(2)}`);
  }
  console.log(`[combat art half] largest ${(largest / MiB).toFixed(1)} MiB at half resolution; ${seen.join('; ')}`);
  expect(errors).toEqual([]);
});
